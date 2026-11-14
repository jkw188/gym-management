// Tầng nghiệp vụ (US-31 bước 1–2): TrainerReviewQueryService – PT xem điểm và nhận xét học viên gửi cho các buổi mình dạy (chỉ đọc).
// Nguồn duy nhất là trainer_reviews của US-65; PT lấy từ account đang đăng nhập, không bao giờ nhận trainerId từ client.
// Bước 2: lọc kỳ theo ngày VN, lọc điểm, phân trang và summary {reviewCount, averageRating} trên toàn tập lọc.
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { addCalendarDays, assertBusinessDate, ServerClock } from '../../common/utils/business-date';
import { PtBookingStatus } from '../bookings/schemas/pt-booking.schema';
import { TrainerReviewsQueryDto } from './review.dto';
import { toTrainerReviewView } from './review.mapper';
import { ReviewRepository } from './review.repository';
import { TrainerReviewListResponse, TrainerReviewSummary, TrainerReviewView } from './review.types';

// US-31 mục 2: mặc định xem 30 ngày gần nhất (tính cả hôm nay theo ngày Việt Nam).
const DEFAULT_DAYS = 30;
// US-31-TC08: một lần xem tối đa 366 ngày, đếm cả ngày đầu và ngày cuối.
const MAX_DAYS = 366;
// US-31-F02: review chỉ hợp lệ khi buổi tập đang COMPLETED. Review của buổi BOOKED/CANCELLED là dữ liệu lỗi, không hiển thị.
const VALID_BOOKING_STATUS: PtBookingStatus = 'COMPLETED';
const DAY_MS = 24 * 60 * 60 * 1000;

// US-31-TC02, TC04: review không có, của PT khác, hoặc PT chưa có hồ sơ đều trả CÙNG một lỗi để không lộ review nào tồn tại.
const notFound = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy đánh giá');

// Nửa đêm (00:00) giờ Việt Nam của một ngày YYYY-MM-DD, đổi ra thời điểm UTC.
const vietnamMidnight = (date: string) => new Date(`${date}T00:00:00+07:00`);

// Số ngày từ ngày `from` đến ngày `to` (cùng ngày = 0). Hai ngày đều đã kiểm là ngày có thật.
const daysBetween = (from: string, to: string) =>
  (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS;

// US-31-TC08: ngày đúng dạng nhưng không có thật (30/02) → 400 kèm tên field.
function realDate(value: string, field: string): string {
  try {
    return assertBusinessDate(value);
  } catch {
    return invalidField(field, 'Ngày không có thật');
  }
}

@Injectable()
export class TrainerReviewQueryService {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly clock: ServerClock,
  ) {}

  // GET /api/me/trainer-reviews: US-31-TC01, TC02, TC04 đến TC08.
  async listOwn(accountId: string, query: TrainerReviewsQueryDto): Promise<TrainerReviewListResponse> {
    // Kiểm kỳ TRƯỚC khi đọc DB: kỳ sai luôn 400, kể cả với PT chưa có hồ sơ.
    const period = this.reviewPeriod(query.fromDate, query.toDate);
    const asOf = this.clock.now().toISOString();

    const trainerId = await this.reviews.findTrainerIdOfAccount(new Types.ObjectId(accountId));
    // US-31-TC04, TC07: account TRAINER chưa có hồ sơ PT → danh sách rỗng kèm profileLinked=false, summary null, không lỗi.
    if (!trainerId) {
      return {
        profileLinked: false, items: [], page: query.page, limit: query.limit, total: 0, totalPages: 0, asOf,
        summary: { reviewCount: 0, averageRating: null },
      };
    }

    // US-31-F01: trainer_id nằm trong điều kiện truy vấn DB, không lấy hết rồi lọc ở đây.
    // US-31-TC04: chỉ đọc trainer_reviews → buổi chưa có review không thành dòng rating=0.
    const page = await this.reviews.findTrainerReviewPage({
      trainerId,
      from: period.from,
      to: period.to,
      rating: query.rating,
      page: query.page,
      limit: query.limit,
      bookingStatus: VALID_BOOKING_STATUS,
    });

    // US-31-F05, TC06: total và summary cùng là số review của TOÀN BỘ tập lọc, không chỉ trang đang xem.
    const total = page.reviewCount;
    return {
      profileLinked: true,
      items: page.rows.map(toTrainerReviewView),
      page: query.page,
      limit: query.limit,
      total,
      // Rỗng → totalPages=0 (US-31 mục 2).
      totalPages: Math.ceil(total / query.limit),
      asOf,
      summary: this.summary(page.reviewCount, page.ratingSum),
    };
  }

  // GET /api/me/trainer-reviews/:id: US-31-TC01, TC02, TC04.
  async getOwn(accountId: string, reviewId: string): Promise<TrainerReviewView> {
    const trainerId = await this.reviews.findTrainerIdOfAccount(new Types.ObjectId(accountId));
    // US-31 mục 2: hồ sơ PT chưa liên kết → chi tiết 404.
    if (!trainerId) throw notFound();
    // US-31-TC02: điều kiện trainer_id nằm trong truy vấn → review của PT khác trả null → 404.
    // US-31-F02: buổi không COMPLETED cũng trả null → 404, giống danh sách không hiện review đó.
    const row = await this.reviews.findTrainerReviewById(trainerId, new Types.ObjectId(reviewId), VALID_BOOKING_STATUS);
    if (!row) throw notFound();
    return toTrainerReviewView(row);
  }

  // US-31-F05, TC07: averageRating = tổng điểm / số review; không có review → null (không giả điểm 0).
  // Trả số đầy đủ (4.333…); giao diện làm tròn 2 số lẻ khi hiển thị.
  private summary(reviewCount: number, ratingSum: number): TrainerReviewSummary {
    if (reviewCount === 0) return { reviewCount: 0, averageRating: null };
    return { reviewCount, averageRating: ratingSum / reviewCount };
  }

  // US-31-F02, TC05, TC08: kỳ theo ngày VN → khoảng thời điểm gửi review [00:00 fromDate, 00:00 ngày sau toDate).
  // Spec bản 1.3: không gửi toDate → hôm nay; không gửi fromDate → 29 ngày trước toDate (đủ 30 ngày).
  private reviewPeriod(fromDate: string | undefined, toDate: string | undefined): { from: Date; to: Date } {
    const toDay = toDate === undefined ? this.clock.today() : realDate(toDate, 'toDate');
    const fromDay = fromDate === undefined ? addCalendarDays(toDay, -(DEFAULT_DAYS - 1)) : realDate(fromDate, 'fromDate');

    // Spec bản 1.3, US-31-TC08: lỗi kỳ nêu đúng field người dùng ĐÃ gửi. Có gửi toDate → báo ở toDate;
    // chỉ gửi fromDate (toDate tự điền là hôm nay) → báo ở fromDate và không nhắc tới toDate.
    const onlyFromDate = toDate === undefined;
    const errorField = onlyFromDate ? 'fromDate' : 'toDate';
    const dayCount = daysBetween(fromDay, toDay) + 1;
    if (dayCount < 1) {
      invalidField(errorField, onlyFromDate ? 'fromDate không được sau hôm nay' : 'toDate không được trước fromDate');
    }
    if (dayCount > MAX_DAYS) invalidField(errorField, `Chỉ xem tối đa ${MAX_DAYS} ngày mỗi lần`);

    return { from: vietnamMidnight(fromDay), to: vietnamMidnight(addCalendarDays(toDay, 1)) };
  }
}
