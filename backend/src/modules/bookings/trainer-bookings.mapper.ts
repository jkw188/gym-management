// Tầng kiểu dữ liệu (US-64 bước 4): đổi booking (kèm tên Member) thành một dòng danh sách buổi dạy trả cho PT.
// Chỉ chép field trong hợp đồng; không trả số điện thoại, gói, request_key hay người tạo.
import { TrainerBookingAction, TrainerBookingItem, TrainerBookingRow } from './trainer-bookings.types';

export function toTrainerBookingItem(row: TrainerBookingRow, permittedActions: TrainerBookingAction[]): TrainerBookingItem {
  return {
    id: row._id.toHexString(),
    memberName: row.member_name ?? '',
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    status: row.status,
    version: row.version ?? 0,
    // US-64-TC15: giờ xác nhận riêng, chỉ có khi buổi đang COMPLETED.
    completedAt: row.status === 'COMPLETED' ? row.completed_at?.toISOString() : undefined,
    permittedActions,
  };
}
