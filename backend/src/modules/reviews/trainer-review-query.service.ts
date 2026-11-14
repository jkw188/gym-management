// Tầng nghiệp vụ (US-31 bước 1): TrainerReviewQueryService – PT xem điểm và nhận xét học viên gửi cho các buổi mình dạy (chỉ đọc).
// Nguồn duy nhất là trainer_reviews của US-65; PT lấy từ account đang đăng nhập, không bao giờ nhận trainerId từ client.
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { addCalendarDays, ServerClock } from '../../common/utils/business-date';
import { toTrainerReviewView } from './review.mapper';
import { ReviewRepository } from './review.repository';
import { TrainerReviewListResponse, TrainerReviewView } from './review.types';

// US-31 mục 2: mặc định xem 30 ngày gần nhất (tính cả hôm nay theo ngày Việt Nam).
const DEFAULT_DAYS = 30;
// US-31 mục 2: limit mặc định 20. Bước 2 mới cho chọn page/limit; bước này luôn trả trang đầu.
const DEFAULT_LIMIT = 20;

// US-31-TC02, TC04: review không có, của PT khác, hoặc PT chưa có hồ sơ đều trả CÙNG một lỗi để không lộ review nào tồn tại.
const notFound = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy đánh giá');

// Nửa đêm (00:00) giờ Việt Nam của một ngày YYYY-MM-DD, đổi ra thời điểm UTC.
const vietnamMidnight = (date: string) => new Date(`${date}T00:00:00+07:00`);

@Injectable()
export class TrainerReviewQueryService {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly clock: ServerClock,
  ) {}

  // GET /api/me/trainer-reviews: US-31-TC01, TC02, TC04.
  async listOwn(accountId: string): Promise<TrainerReviewListResponse> {
    const trainerId = await this.reviews.findTrainerIdOfAccount(new Types.ObjectId(accountId));
    // US-31-TC04: account TRAINER chưa có hồ sơ PT → danh sách rỗng kèm profileLinked=false, không lỗi.
    if (!trainerId) return { profileLinked: false, items: [] };

    // US-31-F02: lọc theo thời điểm GỬI review, khoảng [00:00 của 29 ngày trước, 00:00 ngày mai) giờ VN = 30 ngày.
    const today = this.clock.today();
    const from = vietnamMidnight(addCalendarDays(today, -(DEFAULT_DAYS - 1)));
    const to = vietnamMidnight(addCalendarDays(today, 1));

    // US-31-F01: trainer_id nằm trong điều kiện truy vấn DB, không lấy hết rồi lọc ở đây.
    // US-31-TC04: chỉ đọc trainer_reviews → buổi chưa có review không thành dòng rating=0.
    const rows = await this.reviews.findTrainerReviews({ trainerId, from, to, limit: DEFAULT_LIMIT });
    return { profileLinked: true, items: rows.map(toTrainerReviewView) };
  }

  // GET /api/me/trainer-reviews/:id: US-31-TC01, TC02, TC04.
  async getOwn(accountId: string, reviewId: string): Promise<TrainerReviewView> {
    const trainerId = await this.reviews.findTrainerIdOfAccount(new Types.ObjectId(accountId));
    // US-31 mục 2: hồ sơ PT chưa liên kết → chi tiết 404.
    if (!trainerId) throw notFound();
    // US-31-TC02: điều kiện trainer_id nằm trong truy vấn → review của PT khác trả null → 404.
    const row = await this.reviews.findTrainerReviewById(trainerId, new Types.ObjectId(reviewId));
    if (!row) throw notFound();
    return toTrainerReviewView(row);
  }
}
