// Tầng kiểu dữ liệu (US-30 bước 1): đổi một dòng repository thành một dòng danh sách học viên trả cho PT.
// Chỉ chép field trong hợp đồng US-30-F02, không thêm thông tin liên hệ.
import { TraineeListItem, TraineeRow } from './trainees.types';

export function toTraineeListItem(row: TraineeRow): TraineeListItem {
  return {
    memberId: row._id.toHexString(),
    memberCode: row.member_code,
    fullName: row.full_name,
    nextBookingAt: row.next_booking_at ? row.next_booking_at.toISOString() : undefined,
    lastCompletedAt: row.last_completed_at ? row.last_completed_at.toISOString() : undefined,
    relatedBookingCount: row.related_booking_count,
    hasUpcoming: row.next_booking_at ? true : false,
  };
}
