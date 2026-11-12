// Tầng kiểu dữ liệu (US-28 bước 3): dữ liệu trả về khi Member đặt slot PT thành công (camelCase, thời điểm ISO UTC)
// và các kiểu dùng chung giữa BookingService và BookingRepository. Không có request_key, created_by, tên Member hay dữ liệu liên hệ.
// US-64 bước 2: thêm kết quả và lệnh ghi của PT xác nhận buổi đã dạy; dòng audit có thêm revision, used/version trước–sau.
// US-64 bước 3: thêm kết quả Admin xử lý sai (COMPLETE/REOPEN) và lệnh ghi rút xác nhận.
import { Types } from 'mongoose';
import { NotificationState } from '../notifications/notifications.types';
import { BookingEventAction, BookingEventActorRole } from './schemas/booking-event.schema';
import { CompletedActorType, PtBookingStatus } from './schemas/pt-booking.schema';

// US-28 bước 4: thông báo BOOKING_CREATED đã lưu cùng commit (STORED) hay không có account nhận (NO_LINKED_ACCOUNT) theo EN-03.
export type BookingNotificationState = NotificationState;

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
  // Account của PT: người nhận thông báo đặt lịch (US-28-G04).
  account_id: Types.ObjectId;
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

// US-29: kết quả hủy buổi PT (spec mục 2: {id, status, version, cancelledAt, notificationState}).
export interface CancelledPtBooking {
  id: string;
  status: 'CANCELLED';
  version: number;
  cancelledAt: string;
  // US-29 bước 2: thông báo BOOKING_CANCELLED đã lưu cùng commit (STORED) theo EN-03.
  notificationState: BookingNotificationState;
}

// US-29 bước 2: một dòng audit booking_events, service đã chuẩn bị đủ dữ liệu trước khi đưa xuống repository.
export interface NewBookingEvent {
  bookingId: Types.ObjectId;
  memberId: Types.ObjectId;
  membershipId: Types.ObjectId;
  actorId: Types.ObjectId;
  actorRole: BookingEventActorRole;
  action: BookingEventAction;
  // Bắt buộc với CANCELLED; PT xác nhận đã dạy (COMPLETE) không có lý do.
  reason?: string;
  occurredAt: Date;
  beforeStatus: PtBookingStatus;
  afterStatus: PtBookingStatus;
  requestKey: string;
  // US-64-C04: chỉ có ở dòng COMPLETE.
  completionRevision?: number;
  usedBefore?: number;
  usedAfter?: number;
  versionBefore?: number;
  versionAfter?: number;
}

// US-64 bước 2: kết quả PT xác nhận buổi đã dạy (spec mục 3: {id, status, version, completedAt, completionRevision, membershipId, sessionsUsed}).
// notificationState sẽ thêm ở bước 4 khi có thông báo PT_BOOKING_COMPLETED.
export interface CompletedPtBooking {
  id: string;
  status: 'COMPLETED';
  version: number;
  completedAt: string;
  completionRevision: number;
  // Gói đã bị trừ buổi (gói booking đang tham chiếu lúc xác nhận, kể cả sau nâng cấp).
  membershipId: string;
  // sessions_used của gói đó sau khi trừ.
  sessionsUsed: number;
}

// US-64 bước 2: lệnh hoàn tất service đã kiểm xong luật, đưa xuống repository để ghi có điều kiện (CAS).
export interface CompletePtBookingChange {
  bookingId: Types.ObjectId;
  // Version service vừa đọc; repository chỉ ghi khi booking VẪN là BOOKED với version này.
  version: number;
  completedBy: Types.ObjectId;
  completedActorType: CompletedActorType;
  membershipId: Types.ObjectId;
  now: Date;
}

// US-29 bước 1: lệnh hủy service đã kiểm xong luật, đưa xuống repository để ghi có điều kiện (CAS).
export interface CancelPtBookingChange {
  bookingId: Types.ObjectId;
  // Trạng thái và version service vừa đọc; repository chỉ ghi khi DB vẫn đúng như vậy.
  fromStatus: PtBookingStatus;
  version: number;
  toStatus: PtBookingStatus;
  cancelledBy: Types.ObjectId;
  reason: string;
  now: Date;
}

// US-64-C02: lệnh rút xác nhận service đã kiểm xong luật, đưa xuống repository để ghi có điều kiện (CAS).
export interface ReopenPtBookingChange {
  bookingId: Types.ObjectId;
  // Version service vừa đọc; repository chỉ ghi khi booking VẪN là COMPLETED với version này.
  version: number;
  now: Date;
}

// US-64 bước 3 (spec mục 3): 200 của POST /api/admin/pt-bookings/:id/corrections – trạng thái mới và nguồn quota.
export interface CorrectedPtBooking {
  id: string;
  status: 'COMPLETED' | 'BOOKED';
  version: number;
  completionRevision: number;
  // Gói bị trừ buổi (COMPLETE) hoặc được hoàn lại buổi (REOPEN).
  membershipId: string;
  // sessions_used của gói đó sau thao tác.
  sessionsUsed: number;
  // Chỉ có khi COMPLETE: giờ server lúc xác nhận.
  completedAt?: string;
}
