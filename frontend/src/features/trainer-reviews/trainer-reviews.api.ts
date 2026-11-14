// Tầng giao diện – gọi API (US-31 bước 3): PT xem đánh giá học viên gửi cho mình qua /api/me/trainer-reviews (chỉ GET).
// Không gửi trainerId/accountId: server lấy PT từ phiên đăng nhập (US-31-F01). Gọi backend qua apiClient (api/client.ts).
import { apiClient } from '../../api/client';

// GET /api/me/trainer-reviews/:id và mỗi dòng danh sách: đúng 6 field, không có điện thoại/email (US-31-F03).
export interface TrainerReview {
  id: string;
  rating: number;
  comment: string;
  // Thời điểm học viên GỬI đánh giá, khác giờ buổi tập (US-31-F02).
  createdAt: string;
  booking: { id: string; startAt: string; endAt: string };
  // Tên học viên chụp lại lúc gửi (snapshot).
  memberDisplayName: string;
}

// US-31-F05: tổng trên TOÀN BỘ tập lọc do server tính; không có review thì averageRating=null.
export interface TrainerReviewSummary {
  reviewCount: number;
  averageRating: number | null;
}

// Spec mục 2: {items, page, limit, total, totalPages, asOf} + summary; profileLinked=false khi PT chưa có hồ sơ (US-31-TC04).
export interface TrainerReviewPage {
  profileLinked: boolean;
  items: TrainerReview[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  asOf: string;
  summary: TrainerReviewSummary;
}

// Bộ lọc người dùng chọn: chuỗi rỗng = không lọc theo field đó.
export interface TrainerReviewFilter {
  fromDate: string;
  toDate: string;
  rating: string;
  page: number;
}

export const trainerReviewsApi = {
  // US-31-TC05, TC06: field để trống thì không gửi, server tự dùng mặc định (30 ngày gần nhất, mọi điểm).
  list(filter: TrainerReviewFilter) {
    const params = new URLSearchParams();
    if (filter.fromDate) params.set('fromDate', filter.fromDate);
    if (filter.toDate) params.set('toDate', filter.toDate);
    if (filter.rating) params.set('rating', filter.rating);
    params.set('page', String(filter.page));
    return apiClient.request<TrainerReviewPage>(`/me/trainer-reviews?${params.toString()}`);
  },

  // US-31-TC12: mỗi lần mở chi tiết đều hỏi lại server; server kiểm owner, review không còn thuộc PT này → 404.
  detail(id: string) {
    return apiClient.request<TrainerReview>(`/me/trainer-reviews/${encodeURIComponent(id)}`);
  },
};
