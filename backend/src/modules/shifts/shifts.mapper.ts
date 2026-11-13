// Tầng kiểu dữ liệu (US-24 bước 2, US-25 bước 2): đổi document work_shifts thành dữ liệu trả về client theo allowlist.
// Thời điểm trả chuỗi ISO 8601 có Z; giao diện tự hiển thị theo giờ Việt Nam.
import { WorkShift } from './schemas/work-shift.schema';
import { ShiftResponse } from './shifts.types';

// US-24-TC01: chỉ field công khai, không lộ trainer_id, created_by, updated_by, cancelled_by.
export function toShiftResponse(shift: WorkShift): ShiftResponse {
  const response: ShiftResponse = {
    id: shift._id.toHexString(),
    startAt: shift.start_at.toISOString(),
    endAt: shift.end_at.toISOString(),
    location: shift.location,
    status: shift.status,
    version: shift.version,
    createdAt: shift.created_at.toISOString(),
    updatedAt: shift.updated_at.toISOString(),
  };
  // US-25-TC01, US-25-TC04: chỉ thêm khi ca đã công bố/đã hủy; ca nháp giữ đúng 8 field như US-24.
  if (shift.confirmed_at) response.confirmedAt = shift.confirmed_at.toISOString();
  if (shift.cancelled_at) response.cancelledAt = shift.cancelled_at.toISOString();
  return response;
}
