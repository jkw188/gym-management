// Tầng kiểu dữ liệu (US-27 bước 2): đổi document pt_bookings thành dữ liệu lịch riêng trả cho Member.
// Mapper chỉ chép field; cancelAllowed do MePtBookingsService tính rồi truyền vào.
import { MePtBookingItem } from './me-pt-bookings.types';
import { PtBooking } from './schemas/pt-booking.schema';

// US-27-TC08: tên PT và địa điểm lấy snapshot lúc đặt, không đọc lại tên PT hiện tại.
export function toMePtBookingItem(booking: PtBooking, cancelAllowed: boolean): MePtBookingItem {
  return {
    id: booking._id.toHexString(),
    membershipId: booking.membership_id.toHexString(),
    trainerId: booking.trainer_id.toHexString(),
    trainerName: booking.trainer_name_snapshot ?? '',
    shiftId: booking.shift_id.toHexString(),
    startAt: booking.start_at.toISOString(),
    endAt: booking.end_at.toISOString(),
    location: booking.location_snapshot ?? '',
    status: booking.status,
    version: booking.version ?? 0,
    cancelAllowed,
  };
}
