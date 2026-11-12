// Tầng nghiệp vụ (US-64 bước 2): PT xác nhận buổi đã dạy BOOKED → COMPLETED và trừ đúng một buổi của gói.
// Trong CÙNG transaction: khóa lịch → đọc booking → khóa member → đọc gói, quota → CAS booking → sessions_used +1 → audit.
// Chạy qua IdempotencyService (EN-02): gửi lại cùng Idempotency-Key trả kết quả gốc, operation_requests cùng commit.
import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { IdempotencyService, transactionRequestKey, WorkResult } from '../operations/idempotency.service';
import { toCompletedPtBooking } from './booking.mapper';
import { BookingRepository } from './booking.repository';
import { CompletedPtBooking } from './booking.types';
import { PtBooking } from './schemas/pt-booking.schema';

export interface CompleteBookingInput {
  // Account id (chuỗi hex, lấy từ JWT) của PT bấm xác nhận.
  actorId: string;
  bookingId: string;
  // Version client đang thấy; khác version trong DB → 409 VERSION_CONFLICT.
  version: number;
  // Idempotency-Key (UUID v4): chống xử lý lặp (EN-02) và băm request_key của audit.
  idempotencyKey: string;
}

const OPERATION = 'PT_BOOKING_COMPLETE';

const conflict = (code: string, message: string) => new ApplicationError(409, code, message);
// US-64-TC02: booking không tồn tại và booking của PT khác trả CÙNG một lỗi, không lộ booking có tồn tại hay không.
const notFound = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy lịch tập');
// US-64-TC05: dữ liệu gói/quota sai thì dừng, không tự chữa; người vận hành đối chiếu và sửa.
const dataIntegrityError = () => new ApplicationError(409, 'DATA_INTEGRITY_ERROR', 'Dữ liệu gói tập không nhất quán. Vui lòng liên hệ quản trị');

@Injectable()
export class CompleteBookingService {
  constructor(
    private readonly repository: BookingRepository,
    private readonly idempotency: IdempotencyService,
    // Khóa lịch và khóa member theo thứ tự cố định schedule_guards → members (US-64-F04).
    private readonly guards: DataGuardsService,
    private readonly clock: ServerClock,
  ) {}

  async complete(input: CompleteBookingInput): Promise<CompletedPtBooking> {
    // actorId lấy từ JWT; sai định dạng nghĩa là không biết ai đang gọi → 401 (giống lệnh hủy US-29).
    if (!Types.ObjectId.isValid(input.actorId)) throw new ApplicationError(401, 'UNAUTHENTICATED', 'Cần đăng nhập lại');
    const actorId = new Types.ObjectId(input.actorId);
    const bookingId = new Types.ObjectId(input.bookingId);

    // US-64-TC06 (EN-02): payload chuẩn hóa gồm id booking và version. Cùng key + cùng payload → trả lại 200/body gốc,
    // không trừ buổi lần hai; khác payload → 409 IDEMPOTENCY_CONFLICT.
    const payload = { bookingId: bookingId.toHexString(), version: input.version };

    const result = await this.idempotency.execute({ actorId: input.actorId, operation: OPERATION, clientKey: input.idempotencyKey, payload },
      async (session): Promise<WorkResult> => {
        // US-64-F01: giờ server lấy ở MỖI lần driver chạy lại callback, không tin giờ client.
        const now = this.clock.now();

        // US-64-F04, US-64-TC07: khóa lịch TRƯỚC khi đọc booking, cùng thứ tự với lệnh đặt (US-28) và hủy (US-29):
        // xác nhận và hủy hỗ trợ cùng lúc phải xếp hàng, nên chỉ một bên chuyển được trạng thái.
        await this.guards.acquire(session, { schedule: true });

        // US-64-F01, US-64-TC02: chỉ PT của buổi; PT khác hoặc booking không có → 404.
        const booking = await this.repository.findBookingById(bookingId, session);
        if (!booking) throw notFound();
        const trainerId = await this.repository.findTrainerIdOfAccount(actorId, session);
        if (!trainerId || !trainerId.equals(booking.trainer_id)) throw notFound();

        // Kiểm trạng thái trước version: buổi đã hoàn tất thì báo rõ BOOKING_ALREADY_COMPLETED dù version đúng.
        // US-64-F05, US-64-TC06: key mới trên buổi COMPLETED → 409, không trừ buổi lần hai.
        if (booking.status === 'COMPLETED') throw conflict('BOOKING_ALREADY_COMPLETED', 'Buổi tập đã được xác nhận hoàn tất');
        // US-64-F05, US-64-TC03: buổi CANCELLED không hoàn tất được.
        if (booking.status !== 'BOOKED') throw conflict('INVALID_BOOKING_STATE', 'Lịch tập không còn ở trạng thái có thể xác nhận');

        // US-64-F04, US-64-TC03: client giữ version cũ → 409 để tải lại.
        if (booking.version !== input.version) throw conflict('VERSION_CONFLICT', 'Lịch tập đã thay đổi. Vui lòng tải lại');

        // US-64-F01, US-64-TC01, US-64-TC03: chỉ xác nhận khi giờ server ≥ giờ kết thúc buổi (đúng bằng endAt vẫn được).
        if (now.getTime() < booking.end_at.getTime()) throw conflict('BOOKING_NOT_ENDED', 'Buổi tập chưa kết thúc, chưa thể xác nhận');

        // US-64-F04: khóa member chủ booking (members.service_revision +1) SAU khóa lịch, TRƯỚC khi đọc gói/quota.
        // Nâng cấp gói (US-16/20) cũng lấy khóa này nên hai lệnh xếp hàng, không cùng đọc một số liệu cũ.
        await this.guards.acquire(session, { members: [booking.member_id] });

        // US-64-F04, US-64-TC08: gói bị trừ là membership_id booking đang tham chiếu đọc TRONG transaction này
        // (nâng cấp đã commit trước thì là gói đích), không lấy từ client hay từ lần GET trước.
        // Nếu nâng cấp ghi xen vào sau khi transaction này bắt đầu đọc, bước khóa member hoặc CAS bên dưới bị
        // write conflict, driver chạy lại cả callback và đọc được booking mới.
        const usedBefore = await this.checkMembership(booking, session);

        // US-64-F02, US-64-TC01: BOOKED → COMPLETED, version+1, completion_revision+1; ghi người, loại người và gói bị trừ.
        // completed_at là giờ xác nhận (không giả là endAt).
        const completed = await this.repository.completeBooking({
          bookingId, version: booking.version, completedBy: actorId, completedActorType: 'TRAINER',
          membershipId: booking.membership_id, now,
        }, session);
        // CAS không khớp: booking vừa bị đổi giữa lúc đọc và lúc ghi.
        if (!completed) throw conflict('VERSION_CONFLICT', 'Lịch tập đã thay đổi. Vui lòng tải lại');

        // US-64-F02: sessions_used +1 cùng transaction. Số BOOKED tự giảm 1 vì booking vừa thành COMPLETED,
        // nên used + BOOKED (và số buổi còn có thể đặt) không đổi.
        const usedAfter = await this.repository.incrementSessionsUsed(booking.membership_id, session);
        if (usedAfter === null) throw dataIntegrityError();

        // US-64-C04, US-64-TC01: một dòng audit COMPLETE cùng transaction với revision, used và version trước–sau.
        await this.repository.insertBookingEvent({
          bookingId,
          memberId: booking.member_id,
          membershipId: booking.membership_id,
          actorId,
          actorRole: 'TRAINER',
          action: 'COMPLETE',
          occurredAt: now,
          beforeStatus: 'BOOKED',
          afterStatus: 'COMPLETED',
          requestKey: transactionRequestKey(input.actorId, OPERATION, input.idempotencyKey),
          completionRevision: completed.completion_revision,
          usedBefore,
          usedAfter,
          versionBefore: booking.version,
          versionAfter: completed.version,
        }, session);

        const body = toCompletedPtBooking(completed, usedAfter);
        // { ...body }: chép sang object thường để TypeScript chấp nhận kiểu Record<string, unknown> của WorkResult.
        return { status: 200, body: { ...body }, resultIds: { bookingId } };
      });
    // Body là kết quả vừa tạo hoặc kết quả gốc đã lưu khi gửi lại cùng key; cả hai đều do toCompletedPtBooking tạo ra.
    return result.body as unknown as CompletedPtBooking;
  }

  // US-64-F02, US-64-TC05: gói booking đang tham chiếu phải tồn tại, của đúng Member, loại PT, giao dịch SETTLED,
  // có sessions_used và used + số BOOKED ≤ quota. Sai → 409 DATA_INTEGRITY_ERROR, không tự chữa.
  // US-64-TC04: KHÔNG kiểm gói còn hạn hay còn ACTIVE, vì buổi có thể được xác nhận muộn sau hạn gói.
  // Trả sessions_used hiện tại (trước khi trừ).
  private async checkMembership(booking: PtBooking, session: ClientSession): Promise<number> {
    const membership = await this.repository.findMembership(booking.membership_id, session);
    if (!membership) throw dataIntegrityError();
    const sale = await this.repository.findOwnSale(booking.member_id, membership.service_sale_id, session);
    if (!sale) throw dataIntegrityError();
    const transaction = await this.repository.findOwnTransaction(booking.member_id, sale.transaction_id, session);
    if (transaction?.kind !== 'PT' || transaction.status !== 'SETTLED') throw dataIntegrityError();

    // sessions_used phải là số nguyên ≥ 0 (thiếu field thì Number(undefined) = NaN, không phải số nguyên).
    const used = Number(membership.sessions_used);
    if (!Number.isInteger(used) || used < 0) throw dataIntegrityError();

    // Số BOOKED đã gồm chính buổi đang xác nhận.
    const quota = Number(sale.sessions_snapshot);
    const booked = await this.repository.countBookingsOfMembership(booking.membership_id, 'BOOKED', session);
    if (used + booked > quota) throw dataIntegrityError();
    return used;
  }
}
