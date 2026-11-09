// Tầng nghiệp vụ (US-27 bước 1): AvailabilityService – Member xem danh mục PT khả dụng và slot trống 60 phút của PT.
// Chỉ đọc, không giữ chỗ (US-27-TC09); quy tắc slot và overlap dùng chung ShiftIntervalService với US-24/US-28.
import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { MemberOwnerReader } from '../members/member-owner.reader';
import { MeMembershipsRepository } from '../memberships/me-memberships.repository';
import { PublicSessionsRepository } from '../public-sessions/public-sessions.repository';
import { ShiftIntervalService } from '../shifts/shift-interval.service';
import { ShiftsRepository } from '../shifts/shifts.repository';
import { DateRange, TimeInterval } from '../shifts/shifts.types';
import { PtAvailabilityQueryDto, PtTrainersQueryDto } from './pt-availability.dto';
import { toPtSlot, toPtTrainerItem } from './pt-availability.mapper';
import { PtAvailabilityRepository } from './pt-availability.repository';
import { PtAvailability, PtSlot, PtTrainerPage, SlotReason } from './pt-availability.types';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
// Việt Nam dùng UTC+7 cố định.
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

// Kết quả đánh giá gói Member chọn (US-27-F04): problem là lý do áp cho mọi slot; kỳ gói dùng để kiểm từng slot.
interface MembershipCheck {
  problem?: SlotReason;
  startDate: string;
  endDate: string;
}

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly repository: PtAvailabilityRepository,
    private readonly shifts: ShiftsRepository,
    private readonly classes: PublicSessionsRepository,
    private readonly memberships: MeMembershipsRepository,
    private readonly owners: MemberOwnerReader,
    private readonly interval: ShiftIntervalService,
    private readonly clock: ServerClock,
  ) {}

  // GET /api/me/pt-trainers: US-27-F01, US-27-TC02 – chỉ PT khả dụng, sắp tên rồi id.
  async listTrainers(query: PtTrainersQueryDto): Promise<PtTrainerPage> {
    const q = query.q?.trim() || undefined;
    const { items, total } = await this.repository.listAvailableTrainers(q, query.page, query.limit);
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
    const trainer = await this.repository.findAvailableTrainer(trainerId);
    if (!trainer) throw new ApplicationError(404, 'TRAINER_NOT_AVAILABLE', 'PT hiện không nhận lịch');

    // Chủ thể lấy từ account đang đăng nhập (US-17 resolver); chưa link thì null, vẫn xem giờ tham khảo (US-27-F01).
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    const membership = query.membershipId ? await this.checkMembership(memberId, query.membershipId) : null;

    const shifts = await this.shifts.findConfirmedShifts(trainerId, range.from, range.to);
    const busyTimes = await this.findBusyTimes(trainerId, memberId, range);

    const slots: PtSlot[] = [];
    for (const shift of shifts) {
      // US-27-F02, US-27-TC01: slot 60 phút tính từ đầu ca, phần dư dưới 60 phút không thành slot.
      for (const slot of this.interval.previewSlots(shift.start_at, shift.end_at).slots) {
        // US-27-F02: chỉ slot bắt đầu sau thời điểm hiện tại.
        if (slot.startAt.getTime() <= now.getTime()) continue;
        // US-27-TC03, US-27-TC04: giao với bất kỳ khoảng bận nào thì loại; tiếp giáp không tính là giao.
        if (busyTimes.some(busy => this.interval.overlaps(slot, busy))) continue;
        slots.push(toPtSlot(shift, slot, this.slotReason(memberId, membership, slot)));
      }
    }
    return { trainerId: trainerId.toHexString(), memberLinked: memberId !== null, asOf: now.toISOString(), slots };
  }

  // Gom mọi khoảng bận: lớp PUBLISHED và buổi BOOKED/COMPLETED của PT (F03), buổi của chính Member trên mọi PT (F04).
  private async findBusyTimes(trainerId: Types.ObjectId, memberId: Types.ObjectId | null, range: DateRange): Promise<TimeInterval[]> {
    const classTimes = await this.classes.findPublishedTimesOfTrainer(trainerId, range.from, range.to);
    const trainerBookings = await this.repository.findBusyTimesOfTrainer(trainerId, range.from, range.to);
    const memberBookings = memberId ? await this.repository.findBusyTimesOfMember(memberId, range.from, range.to) : [];
    return [...classTimes, ...trainerBookings, ...memberBookings]
      .map(busy => ({ startAt: busy.start_at, endAt: busy.end_at }));
  }

  // US-27-F04: đánh giá gói Member chọn. Gói không tồn tại hoặc của người khác → 404, không trả lý do gói của họ.
  private async checkMembership(memberId: Types.ObjectId | null, membershipIdText: string): Promise<MembershipCheck> {
    const notFound = new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy gói tập');
    // Chưa link hồ sơ thì không sở hữu gói nào.
    if (!memberId) throw notFound;
    const membership = await this.memberships.findMembershipById(new Types.ObjectId(membershipIdText));
    if (!membership) throw notFound;
    // Chủ sở hữu đi qua sale (sale có member_id), giống US-17.
    const sale = await this.memberships.findOwnSale(memberId, membership.service_sale_id);
    if (!sale) throw notFound;
    const [transaction] = await this.memberships.findOwnTransactionsByIds(memberId, [sale.transaction_id]);
    const check: MembershipCheck = { startDate: sale.start_date, endDate: sale.end_date };

    // Phải là gói PT, đã thu tiền (SETTLED) và kỳ gói ACTIVE; gói GYM không bao giờ coi là PT.
    if (transaction?.kind !== 'PT' || transaction.status !== 'SETTLED' || membership.status !== 'ACTIVE') {
      check.problem = 'MEMBERSHIP_NOT_ELIGIBLE';
      return check;
    }
    // Spec mục 2: available = quota − used − reserved; reserved = số buổi BOOKED mọi thời điểm (cùng cách đếm US-17).
    const booked = await this.memberships.countBookingsByStatus([membership._id], 'BOOKED');
    const reserved = booked.get(membership._id.toHexString()) ?? 0;
    const available = Number(sale.sessions_snapshot) - Number(membership.sessions_used) - reserved;
    // Dữ liệu âm là bất thường: không cho đặt và ghi log cho vận hành, không làm tròn.
    if (available < 0) this.logger.warn(`Gói ${membership._id.toHexString()} có số buổi còn lại âm (${available})`);
    if (available < 1) check.problem = 'QUOTA_EXHAUSTED';
    return check;
  }

  // Lý do slot chưa đặt được; undefined nghĩa là bookable. Giờ tham khảo không bảo đảm quota hay chỗ.
  private slotReason(memberId: Types.ObjectId | null, membership: MembershipCheck | null, slot: TimeInterval): SlotReason | undefined {
    // US-27-F01: Member chưa link chỉ xem giờ tham khảo.
    if (!memberId) return 'PROFILE_REQUIRED';
    // US-27-F04: không gửi membershipId thì không tự chọn gói thay Member.
    if (!membership) return 'MEMBERSHIP_REQUIRED';
    if (membership.problem) return membership.problem;
    // US-27-F04: cả buổi phải nằm trong kỳ gói (gói tương lai vẫn dùng được cho buổi trong kỳ của nó).
    // Ca không qua nửa đêm nên chỉ cần ngày Việt Nam của giờ bắt đầu nằm trong [startDate, endDate].
    const slotDay = new Date(slot.startAt.getTime() + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
    if (slotDay < membership.startDate || slotDay > membership.endDate) return 'MEMBERSHIP_NOT_ELIGIBLE';
    return undefined;
  }
}
