import { Injectable } from '@nestjs/common';
import { ClientSession, Types } from 'mongoose';
import { ServerClock, addCalendarDays } from '../../common/utils/business-date';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { NotificationsService } from '../notifications/notifications.service';
import { ReminderOccurrence } from './reminder-occurrence.schema';
import { ReminderCandidate, RemindersRepository } from './reminders.repository';
import { bookingIneligibility, bookingWindow, membershipIneligibility, membershipWindow, reminderDecision, reminderEventKey } from './reminder.policy';

type Snapshot = ReminderOccurrence['source_snapshot'];
interface SourceDecision { memberId: Types.ObjectId; window: { dueAt: Date; until: Date }; snapshot: Snapshot;
  ineligible?: string; title: string; body: string; trainerAccount?: Types.ObjectId }

@Injectable()
export class RemindersService {
  constructor(private readonly repository: RemindersRepository, private readonly transactions: TransactionRunner,
    private readonly guards: DataGuardsService, private readonly notifications: NotificationsService, private readonly clock: ServerClock) {}

  // Chỉ DI nội bộ, không controller hoặc actor SYSTEM do client cung cấp.
  process(candidate: ReminderCandidate) {
    return this.transactions.run(async session => {
      if (candidate.sourceType === 'PT_BOOKING') await this.guards.acquire(session, { schedule: true });
      // Đọc trước chỉ để xác định member cần khóa; tất cả điều kiện được đọc lại sau tăng revision thật.
      const memberId = await this.owner(candidate, session);
      if (!memberId) throw new Error('REMINDER_SOURCE_MISSING');
      await this.guards.acquire(session, { members: [memberId] });
      if (await this.repository.findOccurrence(candidate, session)) return { outcome: 'EXISTING' as const, lagMs: 0 };
      const now = this.clock.now(); // đọc lại trong mỗi callback/retry, sau khi lấy gate.
      const source = candidate.sourceType === 'MEMBERSHIP'
        ? await this.membershipDecision(candidate, now, session) : await this.bookingDecision(candidate, session);
      if (!source || !source.memberId.equals(memberId)) throw new Error('REMINDER_SOURCE_CHANGED');
      const decision = reminderDecision(now, source.window, source.ineligible);
      if (!decision) return { outcome: 'NOT_DUE' as const, lagMs: 0 };
      const eventKey = reminderEventKey(candidate.sourceType, candidate.sourceId.toHexString(), candidate.milestone);
      let notificationId: Types.ObjectId | undefined;
      let reason = decision.reason;
      if (decision.status === 'STORED') {
        const memberAccount = await this.repository.linkedMemberAccount(memberId, session);
        const recipients: string[] = [];
        if (memberAccount) recipients.push(memberAccount.toHexString());
        else reason = 'NO_LINKED_ACCOUNT';
        if (source.trainerAccount) recipients.push(source.trainerAccount.toHexString());
        const event = await this.notifications.persistBusinessEvent(session, { eventKey, title: source.title, body: source.body,
          memberId: memberId.toHexString(), sourceType: candidate.sourceType, sourceId: candidate.sourceId.toHexString(), dueAt: source.window.dueAt }, recipients);
        notificationId = new Types.ObjectId(event.notificationId);
      }
      await this.repository.insert({ event_key: eventKey, source_type: candidate.sourceType, source_id: candidate.sourceId,
        milestone: candidate.milestone, due_at: source.window.dueAt, status: decision.status, reason_code: reason,
        notification_id: notificationId, source_snapshot: source.snapshot, created_at: now }, session);
      return { outcome: decision.status, reason, lagMs: Math.max(0, now.getTime() - source.window.dueAt.getTime()) };
    });
  }

  private async owner(candidate: ReminderCandidate, session: ClientSession) {
    if (candidate.sourceType === 'PT_BOOKING') return (await this.repository.booking(candidate.sourceId, session))?.member_id;
    const membership = await this.repository.membership(candidate.sourceId, session);
    return membership && (await this.repository.sale(membership.service_sale_id, session))?.member_id;
  }

  private async membershipDecision(candidate: ReminderCandidate, now: Date, session: ClientSession): Promise<SourceDecision | undefined> {
    const membership = await this.repository.membership(candidate.sourceId, session);
    if (!membership) return;
    const sale = await this.repository.sale(membership.service_sale_id, session);
    if (!sale) return;
    const transaction = await this.repository.transaction(sale.transaction_id, session);
    const window = membershipWindow(sale.end_date, candidate.milestone as '3D' | '1D');
    const eligibility = { status: membership.status, createdAt: membership.created_at, startDate: sale.start_date,
      endDate: sale.end_date, transaction: transaction ?? undefined, now, dueAt: window.dueAt };
    let ineligible = membershipIneligibility(eligibility);
    if (!ineligible) ineligible = membershipIneligibility({ ...eligibility,
      hasContinuation: await this.repository.hasContinuation(sale, transaction!.kind, addCalendarDays(sale.end_date, 1), session) });
    return { memberId: sale.member_id, window, ineligible, snapshot: { member_id: sale.member_id,
      end_date: sale.end_date, plan_name: sale.plan_name_snapshot }, title: 'Nhắc gói sắp hết hạn',
      body: `Gói ${sale.plan_name_snapshot} hết hạn ngày ${sale.end_date} (bao gồm ngày sử dụng). Mã gói: ${membership._id.toHexString()}.` };
  }

  private async bookingDecision(candidate: ReminderCandidate, session: ClientSession): Promise<SourceDecision | undefined> {
    const booking = await this.repository.booking(candidate.sourceId, session);
    if (!booking) return;
    const window = bookingWindow(booking.start_at, candidate.milestone as '24H' | '2H');
    const trainer = await this.repository.trainer(booking.trainer_id, session);
    const time = booking.start_at.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    return { memberId: booking.member_id, window,
      ineligible: bookingIneligibility(booking.status, booking.created_at, window.dueAt),
      snapshot: { member_id: booking.member_id, membership_id: booking.membership_id, start_at: booking.start_at,
        trainer_name: booking.trainer_name_snapshot, location: booking.location_snapshot }, trainerAccount: trainer?.account_id,
      title: 'Nhắc lịch tập PT', body: `Buổi PT lúc ${time} (giờ Việt Nam), PT: ${booking.trainer_name_snapshot ?? 'Chưa có tên'}, địa điểm: ${booking.location_snapshot ?? 'Chưa có địa điểm'}. Mã buổi: ${booking._id.toHexString()}.` };
  }
}
