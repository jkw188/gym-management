// Tầng nghiệp vụ (US-29 bước 1): hủy một buổi PT BOOKED → CANCELLED, dùng chung cho hai policy:
// OWN (Member tự hủy, phải còn ≥ 2 giờ) và SUPPORT (Staff/Admin hủy hỗ trợ, được vượt hạn). Toàn bộ luật F01–F03 nằm ở file này.
import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { toCancelledPtBooking } from './booking.mapper';
import { BookingRepository } from './booking.repository';
import { CancelledPtBooking } from './booking.types';
import { PtBooking } from './schemas/pt-booking.schema';

export type CancelPolicy = 'OWN' | 'SUPPORT';
export type CancelActorRole = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';

export interface CancelBookingInput {
  policy: CancelPolicy;
  // Account id (chuỗi hex, lấy từ JWT) của người bấm hủy.
  actorId: string;
  actorRole: CancelActorRole;
  bookingId: string;
  // Version client đang thấy; khác version trong DB → 409 VERSION_CONFLICT (US-29-F04).
  version: number;
  reason?: string;
}

// US-29-F01: Member chỉ được tự hủy khi startAt − giờ server ≥ 120 phút.
const OWN_CANCEL_MIN_MINUTES = 120;
const MINUTE_MS = 60 * 1000;
// US-29-F02, spec mục 2: lý do sau khi trim dài 10–500 ký tự.
const REASON_MIN_LENGTH = 10;
const REASON_MAX_LENGTH = 500;
// US-29-F02: chỉ nhân viên được hủy hỗ trợ; PT không được hủy thay học viên.
const SUPPORT_ROLES: CancelActorRole[] = ['STAFF', 'ADMIN'];

// Lỗi 409 chỉ có mã và câu chung, không kèm dữ liệu booking.
const conflict = (code: string, message: string) => new ApplicationError(409, code, message);
// US-29-TC03: booking không tồn tại và booking của người khác trả CÙNG một lỗi, không lộ booking có tồn tại hay không.
const notFound = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy lịch tập');

@Injectable()
export class CancelBookingService {
  constructor(
    private readonly repository: BookingRepository,
    private readonly transactions: TransactionRunner,
    private readonly clock: ServerClock,
  ) {}

  async cancel(input: CancelBookingInput): Promise<CancelledPtBooking> {
    // Kiểm quyền theo vai trò và lý do TRƯỚC khi mở transaction: không cần đọc DB.
    this.checkRole(input);
    const reason = this.normalizeReason(input.reason);
    // id sai định dạng thì chắc chắn không có booking nào → 404 như booking không tồn tại.
    if (!Types.ObjectId.isValid(input.bookingId)) throw notFound();
    const bookingId = new Types.ObjectId(input.bookingId);
    const actorId = new Types.ObjectId(input.actorId);

    // US-29-F04: mọi bước đọc – kiểm – ghi nằm trong MỘT transaction; lỗi nghiệp vụ thì không ghi gì.
    return this.transactions.run(async session => {
      // US-29-F01: lấy giờ server ở MỖI lần driver chạy lại callback, không tin giờ của browser hay lúc gửi request.
      const now = this.clock.now();

      // Đọc booking MỚI NHẤT trong session, không dùng dữ liệu client gửi lên.
      const booking = await this.repository.findBookingById(bookingId, session);
      if (!booking) throw notFound();
      // US-29-TC03, TC04: chủ booking xác định theo member_id (bất biến), không theo membership_id có thể đổi khi nâng cấp.
      if (input.policy === 'OWN') await this.checkOwner(actorId, booking, session);

      // US-29-F03, US-29-TC07: chỉ BOOKED mới hủy được; CANCELLED/COMPLETED → 409, không đổi lịch sử.
      // Kiểm trạng thái trước version: booking đã hủy thì báo INVALID_BOOKING_STATE dù client gửi đúng version (F05).
      if (booking.status !== 'BOOKED') throw conflict('INVALID_BOOKING_STATE', 'Lịch tập không còn ở trạng thái có thể hủy');

      // US-29-TC04, US-29-TC06: client giữ version cũ → 409 để tải lại; policy SUPPORT cũng không được bỏ qua.
      if (booking.version !== input.version) throw conflict('VERSION_CONFLICT', 'Lịch tập đã thay đổi. Vui lòng tải lại');

      // US-29-F01, US-29-TC02: Member tự hủy phải còn ít nhất 120 phút (đúng 2 giờ vẫn được).
      // US-29-F02, US-29-TC05: SUPPORT được hủy cả khi sát giờ, đang diễn ra hay đã qua giờ.
      if (input.policy === 'OWN') {
        const minutesLeft = (booking.start_at.getTime() - now.getTime()) / MINUTE_MS;
        if (minutesLeft < OWN_CANCEL_MIN_MINUTES) {
          throw conflict('CANCELLATION_WINDOW_CLOSED', 'Đã quá hạn tự hủy (trước giờ tập 2 giờ). Vui lòng liên hệ quầy');
        }
      }

      // US-29-F03, US-29-TC01: BOOKED → CANCELLED, ghi người hủy, lý do, version+1. Không sửa memberships/sale,
      // không tạo refund; reserved = số buổi BOOKED nên tự giảm 1, sessions_used giữ nguyên.
      const cancelled = await this.repository.cancelBooking({
        bookingId, fromStatus: 'BOOKED', version: booking.version, toStatus: 'CANCELLED',
        cancelledBy: actorId, reason, now,
      }, session);
      // CAS không khớp: booking vừa bị thay đổi giữa lúc đọc và lúc ghi.
      if (!cancelled) throw conflict('VERSION_CONFLICT', 'Lịch tập đã thay đổi. Vui lòng tải lại');
      return toCancelledPtBooking(cancelled);
    });
  }

  // US-29-TC03, US-29-TC06: SUPPORT chỉ dành cho STAFF/ADMIN; OWN chỉ dành cho MEMBER.
  // Member gọi SUPPORT để vượt hạn 2 giờ, hoặc PT gọi OWN/SUPPORT → 403.
  private checkRole(input: CancelBookingInput): void {
    const allowed = input.policy === 'SUPPORT' ? SUPPORT_ROLES.includes(input.actorRole) : input.actorRole === 'MEMBER';
    if (!allowed) throw new ApplicationError(403, 'FORBIDDEN', 'Bạn không có quyền hủy lịch tập này');
  }

  // US-29-TC06: reason bắt buộc, trim rồi kiểm 10–500 ký tự; trả bản đã trim để lưu.
  private normalizeReason(reason: string | undefined): string {
    const trimmed = (reason ?? '').trim();
    if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
      invalidField('reason', `Lý do hủy phải dài từ ${REASON_MIN_LENGTH} đến ${REASON_MAX_LENGTH} ký tự`);
    }
    return trimmed;
  }

  // US-29-F01, US-29-TC03: account phải liên kết đúng member của booking; khác hoặc chưa liên kết → 404.
  // Không đòi gói còn ACTIVE (US-29-TC04: gói SUPERSEDED sau nâng cấp vẫn hủy được lịch của mình).
  private async checkOwner(actorId: Types.ObjectId, booking: PtBooking, session: ClientSession): Promise<void> {
    const memberId = await this.repository.findMemberIdOfAccount(actorId, session);
    if (!memberId || !memberId.equals(booking.member_id)) throw notFound();
  }
}
