// Tầng nghiệp vụ (US-27 bước 1): AvailabilityService – Member xem danh mục PT khả dụng và slot trống 60 phút của PT.
// Chỉ đọc, không giữ chỗ (US-27-TC09); quy tắc slot và overlap dùng chung ShiftIntervalService với US-24/US-28.
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { MemberOwnerReader } from '../members/member-owner.reader';
import { PublicSessionsRepository } from '../public-sessions/public-sessions.repository';
import { ShiftIntervalService } from '../shifts/shift-interval.service';
import { ShiftsRepository } from '../shifts/shifts.repository';
import { DateRange, ShiftStatus, TimeInterval } from '../shifts/shifts.types';
import { SessionStatus } from '../public-sessions/public-sessions.types';
import { PtAvailabilityQueryDto, PtTrainersQueryDto } from './pt-availability.dto';
import { toPtSlot, toPtTrainerItem } from './pt-availability.mapper';
import { PtAvailabilityRepository } from './pt-availability.repository';
import { PtAvailability, PtSlot, PtTrainerPage, TrainerAvailabilityRule } from './pt-availability.types';
import { PtBookingStatus } from './schemas/pt-booking.schema';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

// US-27-F01, US-27-TC02: PT khả dụng = hồ sơ ACTIVE + account ACTIVE + còn role TRAINER.
const AVAILABLE_TRAINER: TrainerAvailabilityRule = { trainerStatus: 'ACTIVE', accountStatus: 'ACTIVE', roleCode: 'TRAINER' };

// US-27-F02, US-27-TC02: chỉ ca đã công bố (CONFIRMED) mới sinh slot; SCHEDULED/CANCELLED thì không.
const SLOT_SHIFT_STATUS: ShiftStatus = 'CONFIRMED';

// US-27-F03, US-27-TC03: chỉ lớp đã công bố (PUBLISHED) mới chặn giờ PT; DRAFT/CANCELLED thì không.
const BUSY_CLASS_STATUS: SessionStatus = 'PUBLISHED';

// US-27-F03: BOOKED và COMPLETED đều là giờ đã dùng; CANCELLED không chặn (US-27-TC10).
const BUSY_BOOKING_STATUSES: PtBookingStatus[] = ['BOOKED', 'COMPLETED'];

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly repository: PtAvailabilityRepository,
    private readonly shifts: ShiftsRepository,
    private readonly classes: PublicSessionsRepository,
    private readonly owners: MemberOwnerReader,
    private readonly interval: ShiftIntervalService,
    private readonly clock: ServerClock,
  ) {}

  // GET /api/me/pt-trainers: US-27-F01, US-27-TC02 – chỉ PT khả dụng, sắp tên rồi id.
  async listTrainers(query: PtTrainersQueryDto): Promise<PtTrainerPage> {
    const q = query.q?.trim() || undefined;
    const { items, total } = await this.repository.listTrainers(AVAILABLE_TRAINER, q, query.page, query.limit);
    return {
      items: items.map(toPtTrainerItem),
      page: query.page,
      limit: query.limit,
      total,
      // Danh sách rỗng thì totalPages = 0.
      totalPages: Math.ceil(total / query.limit),
    };
  }

  // GET /api/me/pt-trainers/:id/availability: slot trống của một PT trong khoảng ngày Việt Nam.
  async getAvailability(accountId: string, trainerIdText: string, query: PtAvailabilityQueryDto): Promise<PtAvailability> {
    // Giờ server; không nhận "now" từ client.
    const now = this.clock.now();
    if (!OBJECT_ID.test(trainerIdText)) throw new ApplicationError(400, 'INVALID_ID', 'Mã PT không hợp lệ');
    const trainerId = new Types.ObjectId(trainerIdText);
    // US-27-TC11: ngày Việt Nam → khoảng UTC [from, to); ngày sai hoặc quá 31 ngày → 400.
    const range = this.interval.vietnamDateRange(query.fromDate, query.toDate, now);

    // US-27-TC02: PT INACTIVE, account LOCKED, không còn role TRAINER hoặc không tồn tại → 404.
    const trainer = await this.repository.findTrainer(trainerId, AVAILABLE_TRAINER);
    if (!trainer) throw new ApplicationError(404, 'TRAINER_NOT_AVAILABLE', 'PT hiện không nhận lịch');

    // Chủ thể lấy từ account đang đăng nhập (US-17 resolver); chưa link thì null, vẫn xem giờ tham khảo (US-27-F01).
    const memberId = await this.owners.findMemberIdOfAccount(accountId);

    const shifts = await this.shifts.findShiftsByStatus(trainerId, SLOT_SHIFT_STATUS, range.from, range.to);
    const busyTimes = await this.findBusyTimes(trainerId, memberId, range);

    const slots: PtSlot[] = [];
    for (const shift of shifts) {
      // US-27-F02, US-27-TC01: slot 60 phút tính từ đầu ca, phần dư dưới 60 phút không thành slot.
      for (const slot of this.interval.previewSlots(shift.start_at, shift.end_at).slots) {
        // US-27-F02: chỉ slot bắt đầu sau thời điểm hiện tại.
        if (slot.startAt.getTime() <= now.getTime()) continue;
        // US-27-TC03, US-27-TC04: giao với bất kỳ khoảng bận nào thì loại; tiếp giáp không tính là giao.
        if (busyTimes.some(busy => this.interval.overlaps(slot, busy))) continue;
        // US-27-F04 (tạm ở bước 1): chưa đánh giá membershipId nên mọi slot chỉ là giờ tham khảo.
        // Phần đánh giá gói sẽ làm khi có test TC05–TC08.
        slots.push(toPtSlot(shift, slot, 'MEMBERSHIP_REQUIRED'));
      }
    }
    return { trainerId: trainerId.toHexString(), memberLinked: memberId !== null, asOf: now.toISOString(), slots };
  }

  // Gom mọi khoảng bận: lớp PUBLISHED và buổi BOOKED/COMPLETED của PT (F03), buổi của chính Member trên mọi PT (F04).
  private async findBusyTimes(trainerId: Types.ObjectId, memberId: Types.ObjectId | null, range: DateRange): Promise<TimeInterval[]> {
    const classTimes = await this.classes.findClassTimesByStatus(trainerId, BUSY_CLASS_STATUS, range.from, range.to);
    const trainerBookings = await this.repository.findBusyTimesOfTrainer(trainerId, BUSY_BOOKING_STATUSES, range.from, range.to);
    const memberBookings = memberId
      ? await this.repository.findBusyTimesOfMember(memberId, BUSY_BOOKING_STATUSES, range.from, range.to)
      : [];
    return [...classTimes, ...trainerBookings, ...memberBookings]
      .map(busy => ({ startAt: busy.start_at, endAt: busy.end_at }));
  }
}
