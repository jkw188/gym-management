// Tầng kiểu dữ liệu (US-65 bước 2): đổi document trainer_reviews thành dữ liệu trả về cho Member.
// Chỉ 6 field công khai; không trả member_id, created_by hay tên snapshot (US-65-TC08).
import { TrainerReview } from './schemas/trainer-review.schema';
import { ReviewResponse } from './review.types';

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
