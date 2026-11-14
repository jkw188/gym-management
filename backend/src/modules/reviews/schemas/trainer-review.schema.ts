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

// US-65-F03: đánh giá không sửa sau khi gửi → mọi field đều immutable, schema chặn đổi giá trị đã lưu.
export const TrainerReviewSchema = new Schema<TrainerReview>({
  // Báo cáo 4.2.16: id bắt buộc, unique và bằng _id (giống account.schema.ts).
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (value: Types.ObjectId) { return value.equals(this._id); } },
  booking_id: { type: Schema.Types.ObjectId, ref: 'PtBooking', required: true, immutable: true },
  // US-65-TC05, báo cáo 4.2.16: rating kiểu Int32, số nguyên 1–5; 0, 6, 1.5 bị chặn ngay ở schema.
  // Int32 của Mongoose không có validator min/max (chỉ Number có) nên kiểm khoảng 1–5 trong validate.
  rating: { type: Schema.Types.Int32, required: true, immutable: true,
    validate: (value: number) => Number.isInteger(value) && value >= 1 && value <= 5 },
  // US-65-TC05: comment quá 1000 ký tự bị chặn.
  comment: { type: String, default: '', immutable: true, maxlength: REVIEW_COMMENT_MAX },
  created_at: { type: Date, required: true, immutable: true },
  trainer_id: { type: Schema.Types.ObjectId, ref: 'Trainer', required: true, immutable: true },
  member_id: { type: Schema.Types.ObjectId, ref: 'Member', required: true, immutable: true },
  created_by: { type: Schema.Types.ObjectId, ref: 'Account', required: true, immutable: true },
  // US-65-TC08: tên snapshot tối đa 120 ký tự, giữ nguyên tên lúc gửi.
  trainer_name_snapshot: { type: String, immutable: true, maxlength: REVIEW_NAME_SNAPSHOT_MAX },
  member_display_name_snapshot: { type: String, immutable: true, maxlength: REVIEW_NAME_SNAPSHOT_MAX },
  // strict: 'throw' – field lạ gửi vào bị báo lỗi thay vì bị bỏ đi âm thầm (giống các schema khác).
}, { collection: 'trainer_reviews', id: false, versionKey: false, strict: 'throw' });

// Báo cáo 4.2.16: id unique.
TrainerReviewSchema.index({ id: 1 }, { unique: true, name: 'trainer_reviews_id_unique' });
// US-65-F03, US-65-TC09: bảo vệ cuối cùng – một buổi chỉ có một đánh giá.
TrainerReviewSchema.index({ booking_id: 1 }, { unique: true, name: 'trainer_reviews_booking_unique' });
// US-31: PT xem đánh giá của mình theo thời gian.
TrainerReviewSchema.index({ trainer_id: 1, created_at: 1, _id: 1 }, { name: 'trainer_reviews_trainer_time' });
// Member xem lại các đánh giá chính mình đã gửi theo thời gian.
TrainerReviewSchema.index({ member_id: 1, created_at: 1, _id: 1 }, { name: 'trainer_reviews_member_time' });
