// Tầng kiểu dữ liệu (US-65 bước 2, US-31 bước 1): đổi document trainer_reviews thành dữ liệu trả về cho Member và cho PT.
// Chỉ các field công khai; không trả member_id, created_by, điện thoại hay email (US-65-TC08, US-31-F03).
import { TrainerReview } from './schemas/trainer-review.schema';
import { ReviewResponse, TrainerReviewRow, TrainerReviewView } from './review.types';

// US-31-TC01: dữ liệu PT thấy – điểm, nhận xét, thời điểm gửi, giờ buổi và tên hội viên lấy từ snapshot lúc gửi.
export function toTrainerReviewView(row: TrainerReviewRow): TrainerReviewView {
  return {
    id: row._id.toHexString(),
    rating: row.rating,
    comment: row.comment,
    createdAt: row.created_at.toISOString(),
    booking: {
      id: row.booking._id.toHexString(),
      startAt: row.booking.start_at.toISOString(),
      endAt: row.booking.end_at.toISOString(),
    },
    // Review cũ có thể thiếu snapshot → chuỗi rỗng; không tra lại bảng members (US-31-F03).
    memberDisplayName: row.member_display_name_snapshot ?? '',
  };
}

export function toReviewResponse(review: TrainerReview): ReviewResponse {
  return {
    id: review._id.toHexString(),
    bookingId: review.booking_id.toHexString(),
    trainerId: review.trainer_id.toHexString(),
    rating: review.rating,
    comment: review.comment,
    createdAt: review.created_at.toISOString(),
  };
}
