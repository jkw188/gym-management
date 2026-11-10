// Tầng nghiệp vụ (US-27 bước 1, 4): AvailabilityService – Member xem danh mục PT khả dụng, slot trống 60 phút của PT
// và slot nào đặt được theo gói Member chọn. Chỉ đọc, không giữ chỗ (US-27-TC09); slot/overlap dùng chung ShiftIntervalService.
import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { MemberOwnerReader } from '../members/member-owner.reader';
import { MeMembershipsRepository } from '../memberships/me-memberships.repository';
import { PublicSessionsRepository } from '../public-sessions/public-sessions.repository';
import { ShiftIntervalService } from '../shifts/shift-interval.service';
import { ShiftsRepository } from '../shifts/shifts.repository';
import { DateRange, ShiftStatus, TimeInterval } from '../shifts/shifts.types';
import { SessionStatus } from '../public-sessions/public-sessions.types';
import { PtAvailabilityQueryDto, PtTrainersQueryDto } from './pt-availability.dto';
import { toPtSlot, toPtTrainerItem } from './pt-availability.mapper';
import { PtAvailabilityRepository } from './pt-availability.repository';
import { PtAvailability, PtSlot, PtTrainerPage, SlotReason, TrainerAvailabilityRule } from './pt-availability.types';
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

// Spec mục 2 (cùng cách đếm US-17): chỉ buổi BOOKED đang giữ chỗ, kể cả buổi đã qua giờ; CANCELLED trả lại buổi.
const RESERVED_BOOKING_STATUS: PtBookingStatus = 'BOOKED';

const DAY_MS = 24 * 60 * 60 * 1000;

// Kết quả đánh giá gói Member chọn (US-27-F04).
// problem: lý do áp cho MỌI slot (gói không dùng được hoặc hết buổi); periodStart/periodEnd: kỳ gói [start, end) theo UTC.
interface MembershipCheck {
  problem?: SlotReason;
  periodStart: Date;
  periodEnd: Date;
}

// "YYYY-MM-DD" (ngày Việt Nam) → thời điểm 00:00 giờ Việt Nam của ngày đó.
const vietnamMidnight = (date: string) => new Date(`${date}T00:00:00+07:00`);

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly repository: PtAvailabilityRepository,
    private readonly shifts: ShiftsRepository,
    private readonly classes: PublicSessionsRepository,
    // US-27-F04: đọc gói, sale, giao dịch và đếm buổi BOOKED qua repository của US-17.
    private readonly memberships: MeMembershipsRepository,
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
    // US-27-F04: không gửi membershipId thì không tự chọn gói thay Member (null = chỉ xem giờ tham khảo).
    const membership = query.membershipId ? await this.checkMembership(memberId, query.membershipId) : null;

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
        slots.push(toPtSlot(shift, slot, this.slotReason(membership, slot)));
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

  // US-27-F04: đánh giá gói Member chọn. Gói không tồn tại, của người khác, hoặc Member chưa link → 404
  // cùng một mã lỗi, không trả lý do gói của người khác (US-27-TC07).
  private async checkMembership(memberId: Types.ObjectId | null, membershipIdText: string): Promise<MembershipCheck> {
    const notFound = new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy gói tập');
    if (!memberId) throw notFound;
    const membership = await this.memberships.findMembershipById(new Types.ObjectId(membershipIdText));
    if (!membership) throw notFound;
    // Chủ sở hữu gói đi qua sale (sale có member_id), giống US-17.
    const sale = await this.memberships.findOwnSale(memberId, membership.service_sale_id);
    if (!sale) throw notFound;
    const [transaction] = await this.memberships.findOwnTransactionsByIds(memberId, [sale.transaction_id]);

    // Kỳ gói theo ngày VN, ngày cuối vẫn dùng được: [00:00 ngày đầu, 00:00 ngày sau ngày cuối).
    const check: MembershipCheck = {
      periodStart: vietnamMidnight(sale.start_date),
      periodEnd: new Date(vietnamMidnight(sale.end_date).getTime() + DAY_MS),
    };

    // US-27-TC05, US-27-TC06, US-27-TC08: phải là gói PT (gói GYM không bao giờ coi là PT), giao dịch đã SETTLED,
    // kỳ gói còn ACTIVE (SUPERSEDED/CANCELLED không mở slot).
    if (transaction?.kind !== 'PT' || transaction.status !== 'SETTLED' || membership.status !== 'ACTIVE') {
      check.problem = 'MEMBERSHIP_NOT_ELIGIBLE';
      return check;
    }

    // Spec mục 2: available = quota − used − reserved; reserved = số buổi BOOKED của gói ở mọi thời điểm.
    const booked = await this.memberships.countBookingsByStatus([membership._id], RESERVED_BOOKING_STATUS);
    const reserved = booked.get(membership._id.toHexString()) ?? 0;
    const available = Number(sale.sessions_snapshot) - Number(membership.sessions_used) - reserved;
    // US-27-TC06: dữ liệu âm là bất thường – không cho đặt, ghi log cho vận hành, không làm tròn về 0 để cho đặt.
    if (available < 0) this.logger.warn(`Gói ${membership._id.toHexString()} có số buổi còn lại âm (${available})`);
    if (available < 1) check.problem = 'QUOTA_EXHAUSTED';
    return check;
  }

  // Lý do slot chưa đặt được; undefined nghĩa là bookable. Giờ tham khảo không bảo đảm quota hay chỗ (US-27-TC09).
  private slotReason(membership: MembershipCheck | null, slot: TimeInterval): SlotReason | undefined {
    // US-27-F04: chưa chọn gói (kể cả Member chưa link) → chỉ là giờ tham khảo.
    if (!membership) return 'MEMBERSHIP_REQUIRED';
    if (membership.problem) return membership.problem;
    // US-27-TC05, US-27-TC06: CẢ buổi phải nằm trong kỳ gói; gói tương lai dùng được cho buổi trong kỳ của nó.
    const insidePeriod = slot.startAt.getTime() >= membership.periodStart.getTime()
      && slot.endAt.getTime() <= membership.periodEnd.getTime();
    return insidePeriod ? undefined : 'MEMBERSHIP_NOT_ELIGIBLE';
  }
}
