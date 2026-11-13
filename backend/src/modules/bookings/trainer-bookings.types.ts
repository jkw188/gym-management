// Tầng kiểu dữ liệu (US-64 bước 4): dữ liệu danh sách buổi dạy trả cho PT (camelCase, thời điểm ISO UTC).
// Chỉ có tên hội viên; KHÔNG có số điện thoại, tiền hay gói của Member (spec mục 3 bản 1.1).
import { Types } from 'mongoose';
import { PtBooking, PtBookingStatus } from './schemas/pt-booking.schema';

// Hành động PT được làm với buổi, server tính theo giờ server (UI không tự tính bằng đồng hồ máy người dùng).
export type TrainerBookingAction = 'COMPLETE';

export interface TrainerBookingItem {
  id: string;
  memberName: string;
  startAt: string;
  endAt: string;
  status: PtBookingStatus;
  // Gửi kèm khi xác nhận (CAS).
  version: number;
  // Chỉ có khi đang COMPLETED: giờ xác nhận, khác giờ kết thúc buổi.
  completedAt?: string;
  permittedActions: TrainerBookingAction[];
}

// Một booking repository đọc kèm tên Member (nối từ collection members).
export interface TrainerBookingRow extends PtBooking {
  member_name?: string;
}

// Bộ lọc service đã kiểm: PT, khoảng UTC [from, to) theo ngày VN và trạng thái tùy chọn.
export interface TrainerBookingFilter {
  trainerId: Types.ObjectId;
  from: Date;
  to: Date;
  status?: PtBookingStatus;
}
