// Tầng nghiệp vụ (US-27 bước 2): Member xem lịch PT riêng của CHÍNH mình (danh sách và chi tiết).
// Chủ thể lấy từ account đang đăng nhập qua MemberOwnerReader (US-17); chủ buổi theo member_id, không theo gói hiện tại.
// Chỉ đọc, không đổi trạng thái buổi (BOOKED quá giờ vẫn BOOKED – US-27-TC10).
// US-65 bước 3: mỗi buổi có thêm gợi ý reviewState/reviewId; GET không ghi gì, không khóa.
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { MemberOwnerReader } from '../members/member-owner.reader';
import { ShiftIntervalService } from '../shifts/shift-interval.service';
import { MePtBookingsQueryDto } from './me-pt-bookings.dto';
import { toMePtBookingItem } from './me-pt-bookings.mapper';
import { MePtBookingsRepository } from './me-pt-bookings.repository';
import { MePtBookingDetail, MePtBookingPage, ReviewProjection } from './me-pt-bookings.types';
import { PT_BOOKING_STATUSES, PtBooking } from './schemas/pt-booking.schema';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
// US-29-F01: chỉ hủy được buổi BOOKED khi còn ít nhất 120 phút trước giờ bắt đầu (đúng 2 giờ vẫn được).
const CANCEL_MIN_LEAD_MS = 120 * 60 * 1000;

// US-27-TC07: "của người khác", "không tồn tại", "chưa link" trả CÙNG mã lỗi và thông điệp.
const notFound = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy buổi PT');

@Injectable()
export class MePtBookingsService {
  constructor(
    private readonly owners: MemberOwnerReader,
    private readonly repository: MePtBookingsRepository,
    // Dùng lại luật đổi ngày Việt Nam → khoảng UTC (ngày có thật, tối đa 31 ngày, mặc định tuần này).
    private readonly interval: ShiftIntervalService,
    private readonly clock: ServerClock,
  ) {}

  // GET /api/me/pt-bookings: US-27-F05 – lịch riêng theo ngày VN, gồm BOOKED/COMPLETED/CANCELLED, lọc status tùy chọn.
  async list(accountId: string, query: MePtBookingsQueryDto): Promise<MePtBookingPage> {
    const now = this.clock.now();
    // US-27-TC11: ngày sai, toDate trước fromDate hoặc quá 31 ngày → 400 (kiểm trước, kể cả khi chưa link).
    const range = this.interval.vietnamDateRange(query.fromDate, query.toDate, now);
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    // US-27-TC07: chưa link → 200 memberLinked=false, items rỗng; không tự nối hồ sơ theo phone.
    if (!memberId) return this.toPage(false, [], query, 0, now);

    // US-27-TC10: không gửi status thì lấy cả ba trạng thái; CANCELLED vẫn hiện trong lịch sử.
    const statuses = query.status ? [query.status] : PT_BOOKING_STATUSES;
    const filter = { memberId, statuses, from: range.from, to: range.to };
    const bookings = await this.repository.findOwnPage(filter, (query.page - 1) * query.limit, query.limit);
    const total = await this.repository.countOwn(filter);
    const reviewIds = await this.findReviewIds(bookings);
    return this.toPage(true, bookings, query, total, now, reviewIds);
  }

  // GET /api/me/pt-bookings/:id: US-27-TC07, US-27-TC08 – chỉ buổi có member_id là chính mình.
  async detail(accountId: string, bookingId: string): Promise<MePtBookingDetail> {
    // ID sai định dạng là dữ liệu sai → 400; đúng định dạng mà không có/của người khác → 404.
    if (!OBJECT_ID.test(bookingId)) throw new ApplicationError(400, 'INVALID_ID', 'Mã buổi PT không hợp lệ');
    const now = this.clock.now();
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    if (!memberId) throw notFound();
    const booking = await this.repository.findOwnById(memberId, new Types.ObjectId(bookingId));
    if (!booking) throw notFound();
    const reviewIds = await this.findReviewIds([booking]);
    return { ...toMePtBookingItem(booking, this.cancelAllowed(booking, now), this.reviewProjection(booking, reviewIds)), asOf: now.toISOString() };
  }

  // US-65-TC07: Map từ id buổi (chuỗi hex) sang id review đã gửi, đọc một lần cho cả trang.
  private async findReviewIds(bookings: PtBooking[]): Promise<Map<string, string>> {
    const reviews = await this.repository.findReviewsOfBookings(bookings.map(booking => booking._id));
    const reviewIds = new Map<string, string>();
    for (const review of reviews) reviewIds.set(review.booking_id.toHexString(), review._id.toHexString());
    return reviewIds;
  }

  // US-65 bước 3, US-65-TC04, TC07: đã có review → SUBMITTED (kể cả khi buổi không còn COMPLETED, vì review vẫn tồn tại);
  // COMPLETED chưa review → ELIGIBLE (không xét gói còn hạn); BOOKED/CANCELLED → NOT_ELIGIBLE.
  private reviewProjection(booking: PtBooking, reviewIds: Map<string, string>): ReviewProjection {
    const reviewId = reviewIds.get(booking._id.toHexString());
    if (reviewId) return { reviewState: 'SUBMITTED', reviewId };
    if (booking.status === 'COMPLETED') return { reviewState: 'ELIGIBLE' };
    return { reviewState: 'NOT_ELIGIBLE' };
  }

  // US-27-TC10: gợi ý hủy theo giờ server – BOOKED và còn ≥ 120 phút; buổi quá giờ hoặc đã hủy/hoàn tất → false.
  private cancelAllowed(booking: PtBooking, now: Date): boolean {
    return booking.status === 'BOOKED' && booking.start_at.getTime() - now.getTime() >= CANCEL_MIN_LEAD_MS;
  }

  // Spec mục 2: {memberLinked, items, page, limit, total, totalPages}; rỗng thì totalPages = 0.
  private toPage(memberLinked: boolean, bookings: PtBooking[], query: MePtBookingsQueryDto, total: number, now: Date,
    reviewIds: Map<string, string> = new Map()): MePtBookingPage {
    return {
      memberLinked,
      items: bookings.map(booking => toMePtBookingItem(booking, this.cancelAllowed(booking, now), this.reviewProjection(booking, reviewIds))),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
      asOf: now.toISOString(),
    };
  }
}
