// Tầng kiểu dữ liệu (US-29 bước 3): đổi booking (kèm mã/tên Member) thành dữ liệu tra cứu hỗ trợ trả cho Staff/Admin.
// Chỉ chép field trong hợp đồng; không trả request_key, created_by, cancelled_by hay dữ liệu liên hệ.
import { SupportPtBookingItem, SupportPtBookingRow } from './support-pt-bookings.types';

// US-29-TC05: tên PT và địa điểm lấy snapshot lúc đặt (giống lịch riêng US-27), mã/tên Member lấy từ hồ sơ hiện tại.
export function toSupportPtBookingItem(row: SupportPtBookingRow): SupportPtBookingItem {
  return {
    id: row._id.toHexString(),
    memberId: row.member_id.toHexString(),
    memberCode: row.member_code ?? '',
    memberName: row.member_name ?? '',
    trainerId: row.trainer_id.toHexString(),
    trainerName: row.trainer_name_snapshot ?? '',
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    location: row.location_snapshot ?? '',
    status: row.status,
    version: row.version ?? 0,
  };
}
