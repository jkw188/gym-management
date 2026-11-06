// Tầng kiểu dữ liệu (US-24 bước 2): đổi document work_shifts thành dữ liệu trả về client theo allowlist.
// Thời điểm trả chuỗi ISO 8601 có Z; giao diện tự hiển thị theo giờ Việt Nam.
import { WorkShift } from './schemas/work-shift.schema';
import { ShiftResponse } from './shifts.types';

// US-24-TC01: chỉ 8 field công khai, không lộ trainer_id, created_by, updated_by.
export function toShiftResponse(shift: WorkShift): ShiftResponse {
  return {
    id: shift._id.toHexString(),
    startAt: shift.start_at.toISOString(),
    endAt: shift.end_at.toISOString(),
    location: shift.location,
    status: shift.status,
    version: shift.version,
    createdAt: shift.created_at.toISOString(),
    updatedAt: shift.updated_at.toISOString(),
  };
}
