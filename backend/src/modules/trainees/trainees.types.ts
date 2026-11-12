// Tầng kiểu dữ liệu (US-30 bước 1): dữ liệu danh sách học viên trả cho PT (camelCase, thời điểm ISO UTC).
// Chỉ có mã và tên hội viên; KHÔNG có số điện thoại, email, địa chỉ, tiền (US-30-F02).
import { Types } from 'mongoose';
import { PtBookingStatus } from '../bookings/schemas/pt-booking.schema';

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

// Một dòng repository trả về sau khi gom booking theo member_id và nối tên từ members.
export interface TraineeRow {
  _id: Types.ObjectId;
  member_code: string;
  full_name: string;
  related_booking_count: number;
  next_booking_at: Date | null;
  last_completed_at: Date | null;
}

// Bộ lọc service đã kiểm xong, repository chỉ việc chạy truy vấn.
export interface TraineeFilter {
  trainerId: Types.ObjectId;
  // Trạng thái booking tạo quan hệ học viên, do service quyết định (US-30-F01).
  relationStatuses: PtBookingStatus[];
  // Buổi "sắp tới" = buổi có trạng thái upcomingStatus và start_at >= upcomingFrom (service quyết định).
  upcomingStatus: PtBookingStatus;
  upcomingFrom: Date;
  // Buổi "đã hoàn tất" = buổi có trạng thái completedStatus (service quyết định).
  completedStatus: PtBookingStatus;
  search?: string;
  hasUpcoming?: boolean;
  page: number;
  limit: number;
}
