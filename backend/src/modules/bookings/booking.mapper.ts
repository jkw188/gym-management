// Tầng kiểu dữ liệu (US-28 bước 3): đổi document pt_bookings vừa tạo thành body 201 trả cho Member.
// Chỉ chép field trong hợp đồng; không trả request_key, created_by.
import { BookingNotificationState, CreatedPtBooking } from './booking.types';
import { PtBooking } from './schemas/pt-booking.schema';

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
