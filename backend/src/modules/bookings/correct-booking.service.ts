// Tầng nghiệp vụ (US-64 bước 3): Admin xử lý sai xác nhận buổi PT, có lý do 10–500 ký tự.
// COMPLETE (C01): xác nhận hỗ trợ, dùng CÙNG luật với PT qua CompleteBookingService.completeInSession.
// REOPEN (C02, C03): rút xác nhận sai COMPLETED → BOOKED, hoàn 1 buổi; bị chặn khi đã có đánh giá hoặc used đã qua nâng cấp.
// Chạy qua IdempotencyService (EN-02) với operation PT_BOOKING_CORRECT.
import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { IdempotencyService, transactionRequestKey, WorkResult } from '../operations/idempotency.service';
import { toReopenedPtBooking } from './booking.mapper';
import { BookingRepository } from './booking.repository';
import { CorrectedPtBooking } from './booking.types';
import { bookingNotFound, CompleteBookingService, dataIntegrityError, versionConflict } from './complete-booking.service';

export type CorrectionAction = 'COMPLETE' | 'REOPEN';

export interface CorrectBookingInput {
  // Account id (chuỗi hex, lấy từ JWT) của Admin.
  actorId: string;
  bookingId: string;
  version: number;
  action: CorrectionAction;
  reason: string;
  idempotencyKey: string;
}

const OPERATION = 'PT_BOOKING_CORRECT';
// US-64-C01: lý do sau khi trim dài 10–500 ký tự (giống lý do hủy US-29).
const REASON_MIN_LENGTH = 10;
const REASON_MAX_LENGTH = 500;

// US-64-C03: không tự xóa review hay trừ gói khác để qua kiểm tra; người có quyền phải đối chiếu nguồn.
const reconciliationRequired = (message: string) => new ApplicationError(409, 'COMPLETION_RECONCILIATION_REQUIRED', message);

@Injectable()
export class CorrectBookingService {
  constructor(
    private readonly repository: BookingRepository,
    private readonly completions: CompleteBookingService,
    private readonly idempotency: IdempotencyService,
    private readonly guards: DataGuardsService,
    private readonly clock: ServerClock,
  ) {}

  async correct(input: CorrectBookingInput): Promise<CorrectedPtBooking> {
    if (!Types.ObjectId.isValid(input.actorId)) throw new ApplicationError(401, 'UNAUTHENTICATED', 'Cần đăng nhập lại');
    // US-64-TC10: kiểm lý do TRƯỚC khi mở transaction, không cần đọc DB.
    const reason = this.normalizeReason(input.reason);
    const bookingId = new Types.ObjectId(input.bookingId);
    const actorId = new Types.ObjectId(input.actorId);
    const requestKey = transactionRequestKey(input.actorId, OPERATION, input.idempotencyKey);

    // US-64-TC11 (EN-02): payload chuẩn hóa gồm id booking, version, hành động và lý do ĐÃ trim.
    const payload = { bookingId: bookingId.toHexString(), version: input.version, action: input.action, reason };

    const result = await this.idempotency.execute({ actorId: input.actorId, operation: OPERATION, clientKey: input.idempotencyKey, payload },
      async (session): Promise<WorkResult> => {
        const body: CorrectedPtBooking = input.action === 'COMPLETE'
          // US-64-C01, US-64-TC10: cùng điều kiện quota/khóa với PT; lưu ADMIN_SUPPORT và lý do trong audit.
          ? await this.completions.completeInSession(session, bookingId, input.version,
            { accountId: actorId, type: 'ADMIN_SUPPORT', reason, requestKey })
          : await this.reopenInSession(session, bookingId, input.version, actorId, reason, requestKey);
        return { status: 200, body: { ...body }, resultIds: { bookingId } };
      });
    return result.body as unknown as CorrectedPtBooking;
  }

  // US-64-C02, C03, US-64-TC11, TC12: rút xác nhận COMPLETED → BOOKED, sessions_used −1, cùng một transaction.
  private async reopenInSession(session: ClientSession, bookingId: Types.ObjectId, version: number,
    actorId: Types.ObjectId, reason: string, requestKey: string): Promise<CorrectedPtBooking> {
    const now = this.clock.now();

    // Cùng thứ tự khóa với hoàn tất và với gửi đánh giá US-65 (S07-P01): khóa lịch → đọc booking → khóa member.
    // Đánh giá và rút xác nhận cùng lúc thì một bên phải chờ, bên sau đọc thấy kết quả của bên trước.
    await this.guards.acquire(session, { schedule: true });
    const booking = await this.repository.findBookingById(bookingId, session);
    if (!booking) throw bookingNotFound();

    // US-64-TC11: chỉ buổi đang COMPLETED mới rút được; BOOKED/CANCELLED → 409.
    if (booking.status !== 'COMPLETED') throw new ApplicationError(409, 'INVALID_BOOKING_STATE', 'Chỉ rút xác nhận được buổi đã hoàn tất');
    if (booking.version !== version) throw versionConflict();

    await this.guards.acquire(session, { members: [booking.member_id] });

    // US-64-C03, US-64-TC12: đã có đánh giá → không rút, giữ nguyên review.
    if (await this.repository.hasReview(bookingId, session)) {
      throw reconciliationRequired('Buổi tập đã có đánh giá, cần đối chiếu trước khi rút xác nhận');
    }
    // US-64-C02, US-64-TC12: booking phải còn tham chiếu đúng gói đã bị trừ lúc hoàn tất; đã chuyển gói (nâng cấp) → chặn.
    if (!booking.completion_membership_id || !booking.completion_membership_id.equals(booking.membership_id)) {
      throw reconciliationRequired('Buổi tập đã chuyển sang gói khác, cần đối chiếu trước khi rút xác nhận');
    }
    // US-64-C02, US-64-TC12: gói nguồn đã SUPERSEDED nghĩa là used đã được mang sang gói đích → chặn.
    const membership = await this.repository.findMembership(booking.membership_id, session);
    if (!membership) throw dataIntegrityError();
    if (membership.status === 'SUPERSEDED') {
      throw reconciliationRequired('Gói tập đã được nâng cấp, cần đối chiếu trước khi rút xác nhận');
    }
    // US-64-C02: dữ liệu nguồn nhất quán (gói đúng Member, PT, SETTLED, used + BOOKED ≤ quota) và sessions_used ≥ 1.
    const usedBefore = await this.completions.checkMembership(booking, session);
    if (usedBefore < 1) throw dataIntegrityError();

    // US-64-TC11: COMPLETED → BOOKED, version+1, completion_revision+1, bỏ completed_at/by hiện tại.
    // Buổi quá giờ quay lại giữ quota chờ hủy hỗ trợ hoặc xác nhận đúng lại; không mở lịch trống, không phạt Member.
    const reopened = await this.repository.reopenBooking({ bookingId, version: booking.version, now }, session);
    if (!reopened) throw versionConflict();

    // US-64-TC11: used −1; số BOOKED tăng 1 vì booking vừa quay lại BOOKED, nên số buổi còn có thể đặt không đổi.
    const usedAfter = await this.repository.addSessionsUsed(booking.membership_id, -1, session);
    if (usedAfter === null) throw dataIntegrityError();

    // US-64-C04, US-64-TC11: dòng REOPEN append-only; dòng COMPLETE cũ giữ nguyên.
    await this.repository.insertBookingEvent({
      bookingId,
      memberId: booking.member_id,
      membershipId: booking.membership_id,
      actorId,
      actorRole: 'ADMIN',
      action: 'REOPEN',
      reason,
      occurredAt: now,
      beforeStatus: 'COMPLETED',
      afterStatus: 'BOOKED',
      requestKey,
      completionRevision: reopened.completion_revision,
      usedBefore,
      usedAfter,
      versionBefore: booking.version,
      versionAfter: reopened.version,
    }, session);

    return toReopenedPtBooking(reopened, booking.membership_id, usedAfter);
  }

  // US-64-TC10: reason trim rồi kiểm 10–500 ký tự; trả bản đã trim để lưu.
  private normalizeReason(reason: string): string {
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
      invalidField('reason', `Lý do phải dài từ ${REASON_MIN_LENGTH} đến ${REASON_MAX_LENGTH} ký tự`);
    }
    return trimmed;
  }
}
