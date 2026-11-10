// Tầng kiểu dữ liệu (US-28 bước 3–4): đổi document pt_bookings vừa tạo thành body 201 trả cho Member
// và thành tiêu đề/nội dung thông báo BOOKING_CREATED. Chỉ chép field trong hợp đồng; không trả request_key, created_by.
import { BookingNotificationState, CreatedPtBooking } from './booking.types';
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

// US-28-G04, US-28-TC01: nội dung thông báo CHỈ có tên buổi, giờ (giờ Việt Nam), địa điểm, trạng thái.
// Không có số điện thoại, email, tiền hay tên Member. Tiêu đề ≤ 190 và nội dung ≤ 2000 ký tự theo schema EN-03.
export function toBookingCreatedMessage(booking: PtBooking): { title: string; body: string } {
  const session = `Buổi PT với ${booking.trainer_name_snapshot ?? 'PT'}`;
  const time = `${vietnamTime(booking.start_at)}–${vietnamTime(booking.end_at)} ngày ${vietnamDate(booking.start_at)}`;
  return {
    title: 'Đã đặt lịch PT',
    body: `${session}, ${time}, tại ${booking.location_snapshot ?? ''}. Trạng thái: Đã đặt.`,
  };
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
