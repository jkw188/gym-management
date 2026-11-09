// Tầng kiểu dữ liệu (US-27 bước 1): đổi hàng PT và slot nội bộ thành dữ liệu trả về cho Member.
// Mapper chỉ chép field, không tự tính luật (bookable/reason do AvailabilityService quyết định).
import { TimeInterval } from '../shifts/shifts.types';
import { WorkShift } from '../shifts/schemas/work-shift.schema';
import { AvailableTrainerRow, PtSlot, PtTrainerItem, SlotReason } from './pt-availability.types';

// US-27-F01: chỉ id, tên hiển thị, chuyên môn.
export function toPtTrainerItem(row: AvailableTrainerRow): PtTrainerItem {
  return { id: row._id.toHexString(), displayName: row.display_name, specialty: row.specialty ?? '' };
}

// US-27-F02: địa điểm lấy từ ca; thời điểm trả ISO UTC có Z. reason chỉ có khi slot chưa đặt được.
export function toPtSlot(shift: WorkShift, slot: TimeInterval, reason: SlotReason | undefined): PtSlot {
  const result: PtSlot = {
    shiftId: shift._id.toHexString(),
    startAt: slot.startAt.toISOString(),
    endAt: slot.endAt.toISOString(),
    location: shift.location,
    bookable: reason === undefined,
  };
  if (reason) result.reason = reason;
  return result;
}
