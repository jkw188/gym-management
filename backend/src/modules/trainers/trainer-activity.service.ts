import { Injectable } from '@nestjs/common';
import { ClientSession, ObjectId } from 'mongodb';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { addCalendarDays, assertBusinessDate, ServerClock } from '../../common/utils/business-date';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { ActivityDetailQueryDto, ActivityListQueryDto } from './trainer-activity.dto';
import { activityBooking, activityShift, sourceDate, sourceId } from './trainer-activity.mapper';
import { TrainerActivityRepository } from './trainer-activity.repository';
import { ACTIVITY_METRICS, ActivityDetail, ActivityList, ActivityPage, ActivityRange, ActivityTrainer, emptyActivitySummary } from './trainer-activity.types';

@Injectable()
export class TrainerActivityService {
  constructor(private readonly repository: TrainerActivityRepository, private readonly transactions: TransactionRunner, private readonly clock: ServerClock) {}

  period(fromDate?: string, toDate?: string): ActivityRange {
    const toDay = assertBusinessDate(toDate ?? this.clock.today());
    const fromDay = assertBusinessDate(fromDate ?? addCalendarDays(toDay, -29));
    const days = (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1 || days > 366) invalidField(toDate === undefined ? 'fromDate' : 'toDate', 'Kỳ phải từ 1 đến 366 ngày');
    return { fromDate: fromDay, toDate: toDay, from: new Date(`${fromDay}T00:00:00+07:00`), to: new Date(`${addCalendarDays(toDay, 1)}T00:00:00+07:00`) };
  }

  private async overview(range: ActivityRange, session: ClientSession, trainerId?: ObjectId): Promise<ActivityTrainer[]> {
    const trainers = await this.repository.trainers(session, trainerId);
    const shifts = await this.repository.shiftStats(range, session, trainerId);
    const bookings = await this.repository.bookingStats(range, session, trainerId);
    const orphanAttendance = await this.repository.orphanAttendance(session, trainerId);
    const rows = new Map<string, ActivityTrainer>();
    for (const trainer of trainers) {
      const id = sourceId(trainer._id)!;
      rows.set(id, { id, displayName: trainer.displayName ?? null, status: trainer.status ?? null,
        dataIssue: trainer.displayName ? [] : ['ACCOUNT_MISSING'], summary: emptyActivitySummary() });
    }
    for (const stats of [...shifts, ...bookings]) {
      const id = sourceId(stats._id);
      // A missing trainer reference stays visible as an issue row, never inferred from phone/name.
      const key = id ?? 'MISSING_TRAINER_ID';
      const row = rows.get(key) ?? { id: key, displayName: null, status: null, dataIssue: ['TRAINER_MISSING'], summary: emptyActivitySummary() };
      for (const metric of ACTIVITY_METRICS) row.summary[metric] += stats[metric] ?? 0;
      if (stats.dataIssueCount) row.dataIssue.push('ATTENDANCE_DATA_INVALID');
      rows.set(key, row);
    }
    for (const attendance of orphanAttendance) {
      const key = sourceId(attendance._id) ?? 'MISSING_TRAINER_ID';
      const row = rows.get(key) ?? { id: key, displayName: null, status: null, dataIssue: ['TRAINER_MISSING'], summary: emptyActivitySummary() };
      row.dataIssue.push('ATTENDANCE_SHIFT_MISSING_UNDATED');
      rows.set(key, row);
    }
    const created = new Map(trainers.map(t => [sourceId(t._id), sourceDate(t.created_at) ?? '']));
    return [...rows.values()].sort((a, b) => (created.get(b.id) ?? '').localeCompare(created.get(a.id) ?? '') || b.id.localeCompare(a.id));
  }

  list(query: ActivityListQueryDto): Promise<ActivityList> {
    const range = this.period(query.fromDate, query.toDate);
    this.checkPage(query.page, query.limit);
    return this.transactions.run(async session => {
      const asOf = this.clock.now().toISOString();
      const rows = await this.overview(range, session, query.trainerId ? new ObjectId(query.trainerId) : undefined);
      const summary = emptyActivitySummary();
      for (const row of rows) for (const metric of ACTIVITY_METRICS) summary[metric] += row.summary[metric];
      return { ...this.page(rows.slice((query.page - 1) * query.limit, query.page * query.limit), rows.length, query.page, query.limit, asOf),
        range: { fromDate: range.fromDate, toDate: range.toDate }, summary };
    });
  }

  detail(id: string, query: ActivityDetailQueryDto): Promise<ActivityDetail> {
    const range = this.period(query.fromDate, query.toDate);
    this.checkPage(query.shiftPage, query.limit); this.checkPage(query.bookingPage, query.limit);
    return this.transactions.run(async session => {
      const asOf = this.clock.now().toISOString();
      const trainerId = new ObjectId(id);
      const [trainer] = await this.overview(range, session, trainerId);
      if (!trainer) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy PT hoặc lịch sử trong kỳ');
      const shifts = await this.repository.page('work_shifts', range, trainerId, query.shiftPage, query.limit, session);
      const bookings = await this.repository.page('pt_bookings', range, trainerId, query.bookingPage, query.limit, session);
      return { trainer, range: { fromDate: range.fromDate, toDate: range.toDate }, asOf, summary: trainer.summary,
        shiftsPage: this.page(shifts.items.map(activityShift), shifts.total, query.shiftPage, query.limit, asOf),
        bookingsPage: this.page(bookings.items.map(activityBooking), bookings.total, query.bookingPage, query.limit, asOf) };
    });
  }

  attendance(id: string, includeAudit = true) {
    return this.transactions.run(async session => {
      const asOf = this.clock.now().toISOString();
      const row = await this.repository.shift(new ObjectId(id), session);
      if (!row) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy ca');
      const shift = activityShift(row);
      const events = includeAudit ? await this.repository.attendanceEvents(new ObjectId(id), session) : [];
      const snapshot = (value: Record<string, unknown> | undefined) => value ? {
        checkInAt: sourceDate(value.check_in_at), checkOutAt: sourceDate(value.check_out_at), version: value.version ?? null,
      } : null;
      return { asOf, state: shift.attendance.state, shift, note: row.attendance?.[0]?.note ?? null, ...(includeAudit ? { events: events.map(event => ({
        id: sourceId(event._id), attendanceId: sourceId(event.attendance_id), action: event.action,
        actorId: sourceId(event.actor_id), occurredAt: sourceDate(event.occurred_at), reason: event.reason ?? null,
        before: snapshot(event.before), after: snapshot(event.after),
      })) } : {}) };
    });
  }
  private checkPage(page: number, limit: number) {
    if (!Number.isSafeInteger(page * limit)) invalidField('page', 'Trang vượt giới hạn cho phép');
  }
  private page<T>(items: T[], total: number, page: number, limit: number, asOf: string): ActivityPage<T> {
    return { items, total, page, limit, totalPages: Math.ceil(total / limit), asOf };
  }
}
