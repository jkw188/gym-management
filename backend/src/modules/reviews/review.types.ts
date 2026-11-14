// Tầng kiểu dữ liệu (US-65 bước 2): type dùng chung giữa service, repository và mapper của đánh giá buổi PT.
import { Types } from 'mongoose';
import { PtBookingStatus } from '../bookings/schemas/pt-booking.schema';

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

// US-31: một dòng trainer_reviews đã nối sang buổi tập (pt_bookings) qua booking_id.
export interface TrainerReviewRow {
  _id: Types.ObjectId;
  rating: number;
  comment: string;
  created_at: Date;
  member_display_name_snapshot?: string;
  booking: { _id: Types.ObjectId; start_at: Date; end_at: Date };
}

// US-31-F01: điều kiện đọc danh sách; trainerId luôn lấy từ account đang đăng nhập, không nhận từ client.
export interface TrainerReviewFilter {
  trainerId: Types.ObjectId;
  // Khoảng thời điểm GỬI đánh giá [from, to) (US-31-F02), không phải giờ buổi tập.
  from: Date;
  to: Date;
  // US-31-TC06: lọc điểm (không có = mọi điểm).
  rating?: number;
  page: number;
  limit: number;
  // US-31-F02: chỉ review của buổi ở trạng thái này mới hợp lệ (service truyền COMPLETED).
  bookingStatus: PtBookingStatus;
}

// US-31-F05: một trang dòng + số review và tổng điểm của TOÀN BỘ tập lọc, đọc trong cùng một truy vấn.
export interface TrainerReviewPage {
  rows: TrainerReviewRow[];
  reviewCount: number;
  ratingSum: number;
}

// US-31-F05: count=0 thì averageRating=null, không giả điểm 0.
export interface TrainerReviewSummary {
  reviewCount: number;
  averageRating: number | null;
}

// US-31 mục 2: dữ liệu PT thấy về một đánh giá – đúng 6 field, không có điện thoại/email hội viên (US-31-F03).
export interface TrainerReviewView {
  id: string;
  rating: number;
  comment: string;
  createdAt: string;
  booking: { id: string; startAt: string; endAt: string };
  memberDisplayName: string;
}

// US-31 mục 2: {items, page, limit, total, totalPages, asOf} + summary. profileLinked=false khi chưa có hồ sơ PT (US-31-TC04).
export interface TrainerReviewListResponse {
  profileLinked: boolean;
  items: TrainerReviewView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  // Thời điểm server đọc dữ liệu cho response này.
  asOf: string;
  summary: TrainerReviewSummary;
}
