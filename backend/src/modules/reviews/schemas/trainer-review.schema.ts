// Tầng dữ liệu (US-65 bước 1): cấu trúc collection trainer_reviews, mỗi document là đánh giá của Member cho một buổi PT.
// Một buổi chỉ có một đánh giá (unique booking_id) và đánh giá không sửa sau khi gửi (US-65-F03).
import { Schema, Types } from 'mongoose';

// US-65-F04: độ dài tối đa của tên chụp lại lúc gửi.
export const REVIEW_NAME_SNAPSHOT_MAX = 120;
// US-65-F02: nhận xét tối đa 1000 ký tự (sau khi trim).
export const REVIEW_COMMENT_MAX = 1000;

export interface TrainerReview {
  _id: Types.ObjectId;
  id: Types.ObjectId;
  booking_id: Types.ObjectId;
  // US-65-F02: điểm nguyên 1–5.
  rating: number;
  // US-65-F02: vắng hoặc rỗng thì lưu chuỗi rỗng.
  comment: string;
  // US-65-F04: giờ server lúc gửi, không phải giờ buổi tập.
  created_at: Date;
  // US-65-F04: chụp lại khi gửi để truy vết (lấy từ booking, không nhận từ client).
  trainer_id: Types.ObjectId;
  member_id: Types.ObjectId;
  // Account của Member đã gửi.
  created_by: Types.ObjectId;
  // US-65-F04: chỉ chụp tên hiển thị, không copy điện thoại/email/địa chỉ.
  trainer_name_snapshot?: string;
  member_display_name_snapshot?: string;
}

export const TrainerReviewSchema = new Schema<TrainerReview>({
  id: { type: Schema.Types.ObjectId, required: true },
  booking_id: { type: Schema.Types.ObjectId, ref: 'PtBooking', required: true },
  // US-65-TC05: 0, 6, 1.5 bị chặn ngay ở schema. Số nguyên nhỏ được driver lưu kiểu Int32.
  rating: { type: Number, required: true, min: 1, max: 5, validate: Number.isInteger },
  // US-65-TC05: comment quá 1000 ký tự bị chặn.
  comment: { type: String, default: '', maxlength: REVIEW_COMMENT_MAX },
  created_at: { type: Date, required: true },
  trainer_id: { type: Schema.Types.ObjectId, ref: 'Trainer', required: true },
  member_id: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
  created_by: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  // US-65-TC08: tên snapshot tối đa 120 ký tự.
  trainer_name_snapshot: { type: String, maxlength: REVIEW_NAME_SNAPSHOT_MAX },
  member_display_name_snapshot: { type: String, maxlength: REVIEW_NAME_SNAPSHOT_MAX },
}, { collection: 'trainer_reviews', id: false, versionKey: false });

// US-65-F03, US-65-TC09: bảo vệ cuối cùng – một buổi chỉ có một đánh giá.
TrainerReviewSchema.index({ booking_id: 1 }, { unique: true, name: 'trainer_reviews_booking_unique' });
// US-31: PT xem đánh giá của mình theo thời gian.
TrainerReviewSchema.index({ trainer_id: 1, created_at: 1, _id: 1 }, { name: 'trainer_reviews_trainer_time' });
// US-33 / Member xem lại đánh giá đã gửi theo thời gian.
TrainerReviewSchema.index({ member_id: 1, created_at: 1, _id: 1 }, { name: 'trainer_reviews_member_time' });
