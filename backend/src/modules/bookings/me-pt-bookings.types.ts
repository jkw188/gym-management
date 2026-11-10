// Tầng kiểu dữ liệu (US-27 bước 2): dữ liệu lịch PT riêng trả cho Member (camelCase, thời điểm ISO UTC).
// Không có member_id, request_key, người tạo hay lý do hủy; không có tên Member khác (US-27-F05).
import { PtBookingStatus } from './schemas/pt-booking.schema';

// Một buổi PT trong danh sách lịch riêng.
export interface MePtBookingItem {
  id: string;
  membershipId: string;
  trainerId: string;
  trainerName: string;
  shiftId: string;
  startAt: string;
  endAt: string;
  location: string;
  status: PtBookingStatus;
  version: number;
  // Gợi ý theo giờ server; US-29 kiểm lại khi hủy thật.
  cancelAllowed: boolean;
}

// GET /api/me/pt-bookings/:id: thêm asOf là thời điểm server đọc.
export interface MePtBookingDetail extends MePtBookingItem {
  asOf: string;
}

// GET /api/me/pt-bookings: spec mục 2 {memberLinked, items, page, limit, total, totalPages} kèm asOf.
export interface MePtBookingPage {
  memberLinked: boolean;
  items: MePtBookingItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  asOf: string;
}
