// Tầng nghiệp vụ (US-31 bước 1–2): TrainerReviewQueryService – PT xem điểm và nhận xét học viên gửi cho các buổi mình dạy (chỉ đọc).
// Nguồn duy nhất là trainer_reviews của US-65; PT lấy từ account đang đăng nhập, không bao giờ nhận trainerId từ client.
// Bước 2: lọc kỳ theo ngày VN, lọc điểm, phân trang và summary {reviewCount, averageRating} trên toàn tập lọc.
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { PtBookingStatus } from '../bookings/schemas/pt-booking.schema';
import { TrainerReviewsQueryDto } from './review.dto';
import { reviewPeriod } from './review-period';
import { toTrainerReviewView } from './review.mapper';
import { ReviewRepository } from './review.repository';
import { TrainerReviewListResponse, TrainerReviewSummary, TrainerReviewView } from './review.types';

const VALID_BOOKING_STATUS: PtBookingStatus = 'COMPLETED';

// US-31-TC02, TC04: review không có, của PT khác, hoặc PT chưa có hồ sơ đều trả CÙNG một lỗi để không lộ review nào tồn tại.
const notFound = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy đánh giá');

@Injectable()
export class TrainerReviewQueryService {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly clock: ServerClock,
  ) {}

  // GET /api/me/trainer-reviews: US-31-TC01, TC02, TC04 đến TC08.
  async listOwn(accountId: string, query: TrainerReviewsQueryDto): Promise<TrainerReviewListResponse> {
    // Kiểm kỳ TRƯỚC khi đọc DB: kỳ sai luôn 400, kể cả với PT chưa có hồ sơ.
    const period = reviewPeriod(this.clock.today(), query.fromDate, query.toDate);
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
}
