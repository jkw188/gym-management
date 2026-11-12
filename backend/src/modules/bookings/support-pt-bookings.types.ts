// Tầng kiểu dữ liệu (US-29 bước 3): dữ liệu tra cứu lịch PT trả cho Staff/Admin để hỗ trợ (camelCase, thời điểm ISO UTC).
// Có mã/tên Member và tên PT; KHÔNG có mật khẩu, số điện thoại, request_key, số tiền hay giao dịch (spec mục 2).
// US-64 bước 3: thêm chi tiết Admin kèm thông tin hoàn tất, nguồn quota và lịch sử booking_events.
import { Types } from 'mongoose';
import { BookingEventAction, BookingEventActorRole } from './schemas/booking-event.schema';
import { CompletedActorType, PtBooking, PtBookingStatus } from './schemas/pt-booking.schema';

// Một buổi PT trong danh sách và trong chi tiết GET /api/pt-bookings/:id (cùng field).
export interface SupportPtBookingItem {
  id: string;
  memberId: string;
  memberCode: string;
  memberName: string;
  trainerId: string;
  trainerName: string;
  startAt: string;
  endAt: string;
  location: string;
  status: PtBookingStatus;
  // US-29-TC05: version hiện tại để Staff gửi kèm khi hủy (CAS).
  version: number;
}

// GET /api/pt-bookings: {items, page, limit, total, totalPages} theo quy ước US-27.
export interface SupportPtBookingPage {
  items: SupportPtBookingItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Một booking repository đọc kèm mã và tên Member (nối từ collection members).
export interface SupportPtBookingRow extends PtBooking {
  member_code?: string;
  member_name?: string;
}

// Bộ lọc service đã kiểm: khoảng UTC [from, to) theo ngày VN và các điều kiện tùy chọn.
export interface SupportBookingFilter {
  from: Date;
  to: Date;
  memberId?: Types.ObjectId;
  trainerId?: Types.ObjectId;
  status?: PtBookingStatus;
}

// US-64-C04: một dòng lịch sử của buổi trong chi tiết Admin (không có request_key).
export interface AdminPtBookingEvent {
  action: BookingEventAction;
  actorId: string;
  actorRole: BookingEventActorRole;
  reason?: string;
  occurredAt: string;
  beforeStatus: PtBookingStatus;
  afterStatus: PtBookingStatus;
  membershipId: string;
  // Chỉ có ở dòng COMPLETE/REOPEN.
  completionRevision?: number;
  usedBefore?: number;
  usedAfter?: number;
}

// Spec mục 3: nguồn quota của buổi – gói đang tham chiếu, số buổi đã dùng và tổng số buổi của gói; null nếu thiếu dữ liệu.
export interface AdminQuotaSource {
  membershipId: string;
  sessionsUsed: number | null;
  sessionsQuota: number | null;
}

// GET /api/admin/pt-bookings/:id (US-64 bước 3): dữ liệu tra cứu hỗ trợ + thông tin hoàn tất + nguồn quota + lịch sử.
export interface AdminPtBookingDetail extends SupportPtBookingItem {
  completedAt?: string;
  completedActorType?: CompletedActorType;
  completionRevision: number;
  completionMembershipId?: string;
  quotaSource: AdminQuotaSource;
  events: AdminPtBookingEvent[];
}
