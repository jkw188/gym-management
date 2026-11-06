// Tầng kiểu dữ liệu (US-24 bước 1): kiểu dùng chung của module ca làm việc PT.
// Trạng thái ca, hành động audit và khoảng thời gian [startAt, endAt).

// work_shifts.status (mục 4.2.14). SCHEDULED là ca nháp, chưa mở booking.
export const SHIFT_STATUSES = ['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED'] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

// shift_events.action: mỗi lần tạo/sửa/công bố/hủy ca ghi một dòng audit.
export const SHIFT_ACTIONS = ['CREATED', 'UPDATED', 'CONFIRMED', 'CANCELLED'] as const;
export type ShiftAction = (typeof SHIFT_ACTIONS)[number];

// Khoảng thời gian nửa mở [startAt, endAt): điểm cuối không thuộc khoảng.
export interface TimeInterval {
  startAt: Date;
  endAt: Date;
}

// Dữ liệu ca nháp sau khi đã kiểm tra: thời điểm là Date UTC, location đã trim.
export interface ValidDraft extends TimeInterval {
  location: string;
}

// Kết quả xem trước slot 60 phút (US-27 sẽ sinh slot thật theo cùng quy tắc).
export interface SlotPreview {
  slots: TimeInterval[];
  remainderMinutes: number;
}
