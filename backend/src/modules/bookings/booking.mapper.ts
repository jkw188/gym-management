// Tầng kiểu dữ liệu (US-28 bước 3–4): đổi document pt_bookings vừa tạo thành body 201 trả cho Member
// và thành tiêu đề/nội dung thông báo BOOKING_CREATED. Chỉ chép field trong hợp đồng; không trả request_key, created_by.
// US-29 bước 1–2: đổi booking vừa hủy thành kết quả {id, status, version, cancelledAt, notificationState}
// và thành tiêu đề/nội dung thông báo BOOKING_CANCELLED.
// US-64 bước 2: đổi booking vừa hoàn tất thành kết quả trả cho PT. Bước 3: đổi booking vừa được Admin rút xác nhận.
import { BookingNotificationState, CancelledPtBooking, CompletedPtBooking, CorrectedPtBooking, CreatedPtBooking } from './booking.types';
import { Types } from 'mongoose';
import { PtBooking } from './schemas/pt-booking.schema';

const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

export function toCreatedPtBooking(booking: PtBooking, notificationState: BookingNotificationState): CreatedPtBooking {
  return {
    id: booking._id.toHexString(),
    memberId: booking.member_id.toHexString(),
    membershipId: booking.membership_id.toHexString(),
    trainerId: booking.trainer_id.toHexString(),
    shiftId: booking.shift_id.toHexString(),
    startAt: booking.start_at.toISOString(),
    endAt: booking.end_at.toISOString(),
    // US-28-F02: địa điểm lấy từ ca lúc đặt (snapshot), không từ client.
    location: booking.location_snapshot ?? '',
    status: 'BOOKED',
    version: booking.version,
    notificationState,
  };
}

// US-29-TC01: booking vừa hủy → kết quả trả về; cancelledAt là giờ server lúc hủy, dạng ISO UTC.
// Chỉ gọi với booking repository vừa ghi CANCELLED nên cancelled_at chắc chắn có (dấu !).
export function toCancelledPtBooking(booking: PtBooking, notificationState: BookingNotificationState): CancelledPtBooking {
  return {
    id: booking._id.toHexString(),
    status: 'CANCELLED',
    version: booking.version,
    cancelledAt: booking.cancelled_at!.toISOString(),
    notificationState,
  };
}

// US-64-TC01: booking vừa hoàn tất → kết quả trả về. completedAt là giờ server lúc xác nhận (không phải endAt).
// Chỉ gọi với booking repository vừa ghi COMPLETED nên completed_at và completion_membership_id chắc chắn có (dấu !).
export function toCompletedPtBooking(booking: PtBooking, sessionsUsed: number): CompletedPtBooking {
  return {
    id: booking._id.toHexString(),
    status: 'COMPLETED',
    version: booking.version,
    completedAt: booking.completed_at!.toISOString(),
    completionRevision: booking.completion_revision,
    membershipId: booking.completion_membership_id!.toHexString(),
    sessionsUsed,
  };
}

// US-64-TC11: booking vừa được Admin rút xác nhận → kết quả trả về. membershipId là gói vừa được hoàn lại 1 buổi.
export function toReopenedPtBooking(booking: PtBooking, membershipId: Types.ObjectId, sessionsUsed: number): CorrectedPtBooking {
  return {
    id: booking._id.toHexString(),
    status: 'BOOKED',
    version: booking.version,
    completionRevision: booking.completion_revision,
    membershipId: membershipId.toHexString(),
    sessionsUsed,
  };
}

// US-29-TC13: nội dung thông báo hủy, cùng khuôn với BOOKING_CREATED: tên buổi, giờ VN, địa điểm, trạng thái.
// Không kèm lý do hủy, số điện thoại, email, tiền hay tên Member.
export function toBookingCancelledMessage(booking: PtBooking): { title: string; body: string } {
  return { title: 'Đã hủy lịch PT', body: bookingMessageBody(booking, 'Đã hủy') };
}

// US-28-G04, US-28-TC01: nội dung thông báo CHỈ có tên buổi, giờ (giờ Việt Nam), địa điểm, trạng thái.
// Không có số điện thoại, email, tiền hay tên Member. Tiêu đề ≤ 190 và nội dung ≤ 2000 ký tự theo schema EN-03.
export function toBookingCreatedMessage(booking: PtBooking): { title: string; body: string } {
  return { title: 'Đã đặt lịch PT', body: bookingMessageBody(booking, 'Đã đặt') };
}

// Nội dung chung của thông báo đặt/hủy: "Buổi PT với <PT>, <giờ VN>[, tại <địa điểm>]. Trạng thái: <trạng thái>."
// Booking cũ (trước US-28) có thể không có location_snapshot: khi đó bỏ hẳn đoạn ", tại …" để không ra câu "tại .".
function bookingMessageBody(booking: PtBooking, statusLabel: string): string {
  const session = `Buổi PT với ${booking.trainer_name_snapshot ?? 'PT'}`;
  const time = `${vietnamTime(booking.start_at)}–${vietnamTime(booking.end_at)} ngày ${vietnamDate(booking.start_at)}`;
  const location = booking.location_snapshot?.trim();
  const place = location ? `, tại ${location}` : '';
  return `${session}, ${time}${place}. Trạng thái: ${statusLabel}.`;
}

// Cộng 7 giờ rồi đọc phần UTC để ra giờ Việt Nam, không phụ thuộc múi giờ của máy chủ. Ví dụ 02:00Z → "09:00".
function vietnamTime(at: Date): string {
  const local = new Date(at.getTime() + VIETNAM_OFFSET_MS);
  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

// Ví dụ 2026-11-25T01:00Z → "25/11/2026".
function vietnamDate(at: Date): string {
  const local = new Date(at.getTime() + VIETNAM_OFFSET_MS);
  return `${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)}/${local.getUTCFullYear()}`;
}

const pad = (value: number) => String(value).padStart(2, '0');
