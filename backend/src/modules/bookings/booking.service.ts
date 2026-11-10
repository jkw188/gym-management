// Tầng nghiệp vụ (US-28 bước 3): Member đặt một slot PT và được BOOKED ngay, trong MỘT transaction.
// Trình tự G04: khóa lịch schedule_guards → tìm member, khóa members.service_revision → đọc lại gói/quota/PT/ca/xung đột
// → insert booking → operation_requests (IdempotencyService). Toàn bộ luật F01–F04 nằm ở file này.
import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { IdempotencyService, OperationResult, transactionRequestKey, WorkResult } from '../operations/idempotency.service';
import { insidePeriod, TimeInterval, vietnamPeriod } from '../scheduling/interval.policy';
import { checkSlot } from '../scheduling/slot.policy';
import { ShiftIntervalService } from '../shifts/shift-interval.service';
import { ShiftsRepository } from '../shifts/shifts.repository';
import { CreatePtBookingDto } from './booking.dto';
import { toCreatedPtBooking } from './booking.mapper';
import { BookingRepository } from './booking.repository';
import { PtBookingStatus } from './schemas/pt-booking.schema';

// US-28-F04: buổi BOOKED và COMPLETED đều chiếm giờ của PT và của Member; CANCELLED không chặn (US-28-TC05).
const BUSY_BOOKING_STATUSES: PtBookingStatus[] = ['BOOKED', 'COMPLETED'];
// US-28-F03: chỉ buổi BOOKED đang giữ quota (kể cả đã qua giờ chưa xử lý).
const RESERVED_STATUS: PtBookingStatus = 'BOOKED';
// US-28-F04: chỉ lớp đã công bố mới chặn slot của PT.
const BUSY_CLASS_STATUS = 'PUBLISHED';

// Lỗi 409 chỉ có mã và câu chung, không kèm id/tên người đang chiếm lịch (spec mục 3).
const conflict = (code: string, message: string) => new ApplicationError(409, code, message);

@Injectable()
export class BookingService {
  constructor(
    private readonly repository: BookingRepository,
    // Đọc ca của PT trong cùng session (ca thuộc US-24/25).
    private readonly shifts: ShiftsRepository,
    // Luật đọc thời điểm ISO có thật dùng chung với ca US-24.
    private readonly interval: ShiftIntervalService,
    private readonly guards: DataGuardsService,
    private readonly idempotency: IdempotencyService,
    private readonly clock: ServerClock,
  ) {}

  // POST /api/me/pt-bookings: US-28-TC01 – 201 BOOKED; gửi lại cùng key trả lại 201/body gốc (US-28-TC10).
  async create(accountId: string, dto: CreatePtBookingDto, clientKey: string): Promise<OperationResult> {
    // Bước 1 của G04: chuẩn hóa payload. Hai cách viết cùng một thời điểm (+07:00 hay Z) phải ra cùng hash idempotency.
    // US-28-TC03: new Date() tự "tràn" 30/02 thành 02/03, 24:00 thành hôm sau; parseInstant đọc lại ngày/giờ theo
    // đúng offset gửi lên và so với chuỗi gốc, lệch thì 400 VALIDATION_ERROR (cùng luật với ca US-24).
    const startAt = this.interval.parseInstant(dto.startAt, 'startAt');
    const membershipId = new Types.ObjectId(dto.membershipId);
    const trainerId = new Types.ObjectId(dto.trainerId);
    const shiftId = new Types.ObjectId(dto.shiftId);
    const payload = {
      membershipId: membershipId.toHexString(), trainerId: trainerId.toHexString(), shiftId: shiftId.toHexString(), startAt,
    };

    return this.idempotency.execute(
      { actorId: accountId, operation: 'PT_BOOKING_CREATE', clientKey, payload },
      async (session): Promise<WorkResult> => {
        // G04: lấy giờ server ở MỖI lần driver chạy lại callback, không giữ "now" cũ.
        const now = this.clock.now();

        // Bước 2 G04 (US-28-G01): ghi tăng khóa lịch TRƯỚC mọi truy vấn xung đột, để hai request đặt cùng giờ
        // trên hai instance phải xếp hàng (US-28-TC05, TC06, TC08).
        await this.guards.acquire(session, { schedule: true });

        // Bước 3 G04 (US-28-G03): tìm member của account, rồi ghi tăng members.service_revision trước khi đọc gói/quota.
        // Gọi acquire lần hai vẫn đúng thứ tự schedule_guards → members, không quay lại khóa đứng trước.
        const memberId = await this.repository.findMemberIdOfAccount(new Types.ObjectId(accountId), session);
        // US-28-TC02: chưa liên kết hồ sơ → 409, không tự tạo member hay link theo phone.
        if (!memberId) throw conflict('PROFILE_REQUIRED', 'Tài khoản chưa được liên kết hồ sơ hội viên');
        await this.guards.acquire(session, { members: [memberId] });

        // Bước 4 G04: đọc lại mọi thứ trong cùng session.
        const { quota, used, period } = await this.loadEligibleMembership(memberId, membershipId, session);
        const trainerName = await this.requireAvailableTrainer(trainerId, session);

        // US-28-TC03: ca phải thuộc đúng PT gửi lên (server xác minh quan hệ), không thì coi như ca không dùng được.
        const shift = await this.shifts.findOwnShift(shiftId, trainerId, session);
        if (!shift) throw conflict('SHIFT_UNAVAILABLE', 'Ca không còn nhận đặt lịch');

        // US-28-F02, US-28-TC03: ca CONFIRMED, đúng mốc đầu ca + k×60 phút, nằm trọn trong ca, bắt đầu sau now.
        const slot = checkSlot({ startAt: shift.start_at, endAt: shift.end_at, status: shift.status }, startAt, now);
        if (!slot.ok) {
          if (slot.code === 'SHIFT_UNAVAILABLE') throw conflict('SHIFT_UNAVAILABLE', 'Ca không còn nhận đặt lịch');
          throw conflict('SLOT_UNAVAILABLE', 'Giờ này không còn trống');
        }
        const interval: TimeInterval = { startAt, endAt: slot.endAt };

        // US-28-F02, US-28-TC03, US-28-TC04, US-28-TC14: CẢ buổi nằm trong kỳ gói theo ngày VN (gói tương lai vẫn dùng được).
        if (!insidePeriod(interval, period)) throw conflict('MEMBERSHIP_NOT_ELIGIBLE', 'Buổi tập nằm ngoài thời hạn gói');

        // US-28-F03, US-28-TC07: còn lại = quota − used − reserved phải ≥ 1. Dữ liệu âm cũng chặn ghi.
        const reserved = await this.repository.countBookingsOfMembership(membershipId, RESERVED_STATUS, session);
        if (quota - used - reserved < 1) throw conflict('QUOTA_EXHAUSTED', 'Gói đã hết số buổi có thể đặt');

        // US-28-F04, US-28-TC05: PT đã có buổi BOOKED/COMPLETED hoặc lớp PUBLISHED giao giờ → slot không còn.
        if (await this.repository.trainerHasBooking(trainerId, BUSY_BOOKING_STATUSES, interval, session)
          || await this.repository.trainerHasClass(trainerId, BUSY_CLASS_STATUS, interval, session)) {
          throw conflict('SLOT_UNAVAILABLE', 'Giờ này không còn trống');
        }
        // US-28-F04, US-28-TC06: chính Member đã có buổi giao giờ trên mọi PT/gói.
        if (await this.repository.memberHasBooking(memberId, BUSY_BOOKING_STATUSES, interval, session)) {
          throw conflict('MEMBER_TIME_CONFLICT', 'Bạn đã có buổi tập khác trùng giờ này');
        }

        // Bước 5 G04, US-28-TC01: BOOKED ngay, version 0, không tăng sessions_used, không tạo payment/invoice.
        const booking = await this.repository.insertBooking({
          memberId, membershipId, trainerId, shiftId, startAt, endAt: slot.endAt,
          trainerName, location: shift.location,
          // Spec mục 3: request_key = SHA-256 của actor|operation|key theo EN-02, không lưu key thô.
          requestKey: transactionRequestKey(accountId, 'PT_BOOKING_CREATE', clientKey),
          createdBy: new Types.ObjectId(accountId), now,
        }, session);
        const body = toCreatedPtBooking(booking, 'NOT_CREATED');
        // { ...body }: chép sang object thường để TypeScript chấp nhận kiểu Record<string, unknown> của WorkResult.
        return { status: 201, body: { ...body }, resultIds: { bookingId: booking._id } };
      },
    );
  }

  // US-28-F01, US-28-TC02: gói phải của chính Member, gói PT, đã SETTLED, membership ACTIVE.
  // Trả quota, used và kỳ gói [00:00 ngày đầu, 00:00 ngày sau ngày cuối) theo giờ VN.
  private async loadEligibleMembership(memberId: Types.ObjectId, membershipId: Types.ObjectId, session: ClientSession) {
    // Gói không tồn tại hoặc của người khác → cùng 404, không lộ gói người khác có tồn tại hay không.
    const notFound = new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy gói tập');
    const membership = await this.repository.findMembership(membershipId, session);
    if (!membership) throw notFound;
    const sale = await this.repository.findOwnSale(memberId, membership.service_sale_id, session);
    if (!sale) throw notFound;
    const transaction = await this.repository.findOwnTransaction(memberId, sale.transaction_id, session);

    // US-28-TC02: gói GYM, giao dịch chưa SETTLED (PENDING), membership SUPERSEDED/CANCELLED → không đặt được.
    if (transaction?.kind !== 'PT' || transaction.status !== 'SETTLED' || membership.status !== 'ACTIVE') {
      throw conflict('MEMBERSHIP_NOT_ELIGIBLE', 'Gói tập không dùng được để đặt lịch PT');
    }
    return {
      quota: Number(sale.sessions_snapshot),
      used: Number(membership.sessions_used),
      period: vietnamPeriod(sale.start_date, sale.end_date),
    };
  }

  // US-28-F02, US-28-TC03: PT ACTIVE, account ACTIVE và còn role TRAINER; trả tên PT để lưu snapshot.
  private async requireAvailableTrainer(trainerId: Types.ObjectId, session: ClientSession): Promise<string> {
    const trainer = await this.repository.findTrainer(trainerId, session);
    if (!trainer || trainer.status !== 'ACTIVE' || trainer.account_status !== 'ACTIVE' || trainer.role_code !== 'TRAINER') {
      throw conflict('TRAINER_UNAVAILABLE', 'PT hiện không nhận lịch');
    }
    return trainer.full_name;
  }
}
