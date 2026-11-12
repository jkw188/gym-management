// Tầng kiểu dữ liệu (US-30 bước 1–2): dữ liệu danh sách, hồ sơ tối thiểu, lịch và gói liên quan của học viên trả cho PT.
// Chỉ có mã và tên hội viên; KHÔNG có số điện thoại, email, địa chỉ, ngày sinh, tài khoản, tiền (US-30-F02).
import { Types } from 'mongoose';
import { PtBookingStatus } from '../bookings/schemas/pt-booking.schema';
import { MembershipStatus } from '../memberships/schemas/membership.schema';
import { TransactionKind } from '../payments/schemas/transaction.schema';

// Một dòng danh sách: mỗi hội viên đúng một dòng dù có nhiều buổi (US-30-F05).
export interface TraineeListItem {
  memberId: string;
  memberCode: string;
  fullName: string;
  // Buổi BOOKED sắp tới sớm nhất với chính PT; không có thì bỏ trống.
  nextBookingAt?: string;
  // Lúc xác nhận buổi COMPLETED gần nhất với chính PT; không có thì bỏ trống.
  lastCompletedAt?: string;
  // Số buổi BOOKED + COMPLETED với chính PT (không đếm CANCELLED).
  relatedBookingCount: number;
  hasUpcoming: boolean;
}

export interface TraineeListResponse {
  // false khi account TRAINER chưa có hồ sơ trainers (US-30-TC04).
  profileLinked: boolean;
  items: TraineeListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// US-30 bước 2 – GET /api/me/trainees/:memberId: đúng 4 field (US-30-TC08).
export interface TraineeDetail {
  memberId: string;
  memberCode: string;
  fullName: string;
  hasUpcoming: boolean;
}

// US-30 bước 2 – một buổi trong lịch học viên, chỉ buổi do chính PT dạy (US-30-TC05).
// Không có tên/id PT vì luôn là chính PT đang xem.
export interface TraineeBookingItem {
  id: string;
  membershipId: string;
  startAt: string;
  endAt: string;
  status: PtBookingStatus;
  location: string;
  // Chỉ có khi buổi đang COMPLETED.
  completedAt?: string;
}

// US-30 bước 2 – một gói liên quan kèm quota (US-30-F03). Không có tên gói, giá hay tên PT khác.
export interface TraineeMembershipItem {
  id: string;
  kind?: TransactionKind;
  storedStatus: MembershipStatus;
  startDate: string;
  endDate: string;
  // Số buổi theo sale đã bán (sessions_snapshot), không theo gói hiện tại.
  quota: number;
  sessionsUsed: number;
  // Số buổi BOOKED của TOÀN gói, gồm cả buổi với PT khác (US-30-TC06).
  reserved: number;
  available: number;
}

// Khuôn trang chung của spec mục 2: {items, page, limit, total, totalPages}.
export interface TraineePage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Trang gói có thêm asOf: thời điểm server tính quota (spec mục 2, bảng Quota).
export interface TraineeMembershipPage extends TraineePage<TraineeMembershipItem> {
  asOf: string;
}

// Một dòng repository trả về sau khi gom booking theo member_id và nối tên từ members.
export interface TraineeRow {
  _id: Types.ObjectId;
  member_code: string;
  full_name: string;
  related_booking_count: number;
  next_booking_at: Date | null;
  last_completed_at: Date | null;
}

// Luật quan hệ do service quyết định, repository chỉ chạy truy vấn. Dùng chung cho danh sách và kiểm quan hệ từng học viên.
export interface TraineeRelationFilter {
  trainerId: Types.ObjectId;
  // Trạng thái booking tạo quan hệ học viên, do service quyết định (US-30-F01).
  relationStatuses: PtBookingStatus[];
  // Buổi "sắp tới" = buổi có trạng thái upcomingStatus và start_at >= upcomingFrom (service quyết định).
  upcomingStatus: PtBookingStatus;
  upcomingFrom: Date;
  // Buổi "đã hoàn tất" = buổi có trạng thái completedStatus (service quyết định).
  completedStatus: PtBookingStatus;
}

// Bộ lọc danh sách học viên (bước 1): luật quan hệ + tìm kiếm, lọc, phân trang.
export interface TraineeFilter extends TraineeRelationFilter {
  search?: string;
  hasUpcoming?: boolean;
  page: number;
  limit: number;
}

// Bộ lọc lịch của một học viên với chính PT (bước 2); khoảng UTC [from, to) theo ngày VN.
export interface TraineeBookingFilter {
  trainerId: Types.ObjectId;
  memberId: Types.ObjectId;
  statuses: PtBookingStatus[];
  from: Date;
  to: Date;
}
