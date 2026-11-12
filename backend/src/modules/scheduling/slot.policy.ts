// Tầng nghiệp vụ (US-28 bước 1): luật slot PT 60 phút, hàm thuần không đọc/ghi DB.
// Slot hợp lệ khi ca CONFIRMED, bắt đầu đúng mốc đầu ca + k×60 phút, nằm trọn trong ca và ở tương lai; endAt do server tính.

const SLOT_MS = 60 * 60 * 1000;

export interface SlotShift {
  startAt: Date;
  endAt: Date;
  status: string;
}

export type SlotCheck =
  | { ok: true; endAt: Date }
  | { ok: false; code: 'SHIFT_UNAVAILABLE' | 'SLOT_UNAVAILABLE' };

// US-28-F02: kiểm slot người dùng chọn trong một ca; now là giờ server lúc ghi (không lấy từ client).
export function checkSlot(shift: SlotShift, startAt: Date, now: Date): SlotCheck {
  // US-28-TC03: ca nháp SCHEDULED, ca đã hủy hoặc đã xong thì không đặt được.
  if (shift.status !== 'CONFIRMED') return { ok: false, code: 'SHIFT_UNAVAILABLE' };

  // Khoảng cách từ đầu ca đến giờ chọn phải ≥ 0 và chia hết cho 60 phút (US-28-TC03: lệch mốc, lệch 1 phút).
  const offset = startAt.getTime() - shift.startAt.getTime();
  if (offset < 0 || offset % SLOT_MS !== 0) return { ok: false, code: 'SLOT_UNAVAILABLE' };

  // Server tự tính giờ kết thúc; buổi phải nằm trọn trong ca (US-28-TC03: phần dư cuối ca không thành slot).
  const endAt = new Date(startAt.getTime() + SLOT_MS);
  if (endAt.getTime() > shift.endAt.getTime()) return { ok: false, code: 'SLOT_UNAVAILABLE' };

  // US-28-TC03: phải bắt đầu sau "bây giờ"; đúng bằng now cũng không được.
  if (startAt.getTime() <= now.getTime()) return { ok: false, code: 'SLOT_UNAVAILABLE' };

  return { ok: true, endAt };
}
