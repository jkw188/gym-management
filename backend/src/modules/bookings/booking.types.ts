// Tầng kiểu dữ liệu (US-28 bước 3): dữ liệu trả về khi Member đặt slot PT thành công (camelCase, thời điểm ISO UTC)
// và các kiểu dùng chung giữa BookingService và BookingRepository. Không có request_key, created_by, tên Member hay dữ liệu liên hệ.
import { Types } from 'mongoose';

// Bước 3 chưa tạo thông báo EN-03 (bước 4 sẽ lưu event BOOKING_CREATED và trả STORED / NO_LINKED_ACCOUNT).
export type BookingNotificationState = 'NOT_CREATED';

// 201 của POST /api/me/pt-bookings (spec mục 3).
export interface CreatedPtBooking {
  id: string;
  memberId: string;
  membershipId: string;
  trainerId: string;
  shiftId: string;
  startAt: string;
  endAt: string;
  location: string;
  status: 'BOOKED';
  version: number;
  notificationState: BookingNotificationState;
}

// Hồ sơ PT kèm trạng thái account, mã role và tên hiển thị; đọc trong transaction để kiểm PT còn khả dụng (US-28-F02).
export interface TrainerForBooking {
  _id: Types.ObjectId;
  status: string;
  account_status: string;
  role_code: string;
  full_name: string;
}

// Giao dịch của sale: chỉ cần loại gói và trạng thái thanh toán (US-28-F01).
export interface TransactionForBooking {
  kind: string;
  status: string;
}

// Dữ liệu một booking mới, service đã kiểm xong mọi luật trước khi đưa xuống repository.
export interface NewPtBooking {
  memberId: Types.ObjectId;
  membershipId: Types.ObjectId;
  trainerId: Types.ObjectId;
  shiftId: Types.ObjectId;
  startAt: Date;
  endAt: Date;
  trainerName: string;
  location: string;
  requestKey: string;
  createdBy: Types.ObjectId;
  now: Date;
}
