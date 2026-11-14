// Tầng kiểu dữ liệu (US-65 bước 2): type dùng chung giữa service, repository và mapper của đánh giá buổi PT.
import { Types } from 'mongoose';

// Dữ liệu một đánh giá mới; service đã kiểm luật, repository chỉ ghi (US-65-F04).
export interface NewTrainerReview {
  bookingId: Types.ObjectId;
  rating: number;
  comment: string;
  createdAt: Date;
  trainerId: Types.ObjectId;
  memberId: Types.ObjectId;
  createdBy: Types.ObjectId;
  trainerName?: string;
  memberName?: string;
}

// Hồ sơ hội viên của account đang đăng nhập: id để kiểm chủ booking, tên để chụp snapshot.
export interface ReviewMember {
  _id: Types.ObjectId;
  full_name?: string;
}

// Spec mục 2: 201 {id, bookingId, trainerId, rating, comment, createdAt} – đúng 6 field.
export interface ReviewResponse {
  id: string;
  bookingId: string;
  trainerId: string;
  rating: number;
  comment: string;
  createdAt: string;
}

// Spec mục 2 (sinh viên chốt 14/11): GET trả dạng bọc; reason chỉ có khi chưa gửi được.
export interface OwnReviewResponse {
  review: ReviewResponse | null;
  canReview: boolean;
  reason?: string;
}
