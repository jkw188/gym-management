// Tầng giao diện – hàm hỗ trợ (US-24 bước 3): đổi thời điểm UTC sang ngày/giờ Việt Nam để HIỂN THỊ lịch tuần và preview slot.
// Không kiểm luật ca ở đây: luật thời gian và chồng ca do backend kiểm (US-24-F05).

// Việt Nam dùng UTC+7 cố định, không có giờ mùa hè.
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_NAMES = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ nhật'];

// Cộng 7 giờ rồi đọc theo UTC thì được ngày/giờ Việt Nam.
const vietnamClock = (date: Date) => new Date(date.getTime() + VIETNAM_OFFSET_MS).toISOString();

// Ngày Việt Nam dạng YYYY-MM-DD của một thời điểm.
export const vietnamDate = (date: Date) => vietnamClock(date).slice(0, 10);

// Giờ Việt Nam dạng HH:mm của một chuỗi ISO.
export const vietnamTime = (iso: string) => vietnamClock(new Date(iso)).slice(11, 16);

// Cộng n ngày vào ngày YYYY-MM-DD.
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

// Thứ Hai của tuần chứa ngày Việt Nam hiện tại.
export function mondayOf(now: Date): string {
  const today = vietnamDate(now);
  // getUTCDay(): 0 = Chủ nhật, 1 = thứ Hai… → số ngày đã qua kể từ thứ Hai.
  const daysSinceMonday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(today, -daysSinceMonday);
}

// Nhãn ngày trong tuần, ví dụ index 0 của "2026-11-02" → "Thứ Hai 02/11".
export function dayLabel(day: string, index: number): string {
  return `${DAY_NAMES[index]} ${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

// Ghép ngày + giờ nhập ở form thành chuỗi ISO có offset +07:00 để gửi backend.
export const toVietnamIso = (day: string, time: string) => `${day}T${time}:00+07:00`;

// "HH:mm" → số phút tính từ 00:00.
const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const fromMinutes = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// Giờ kết thúc 00:00 nghĩa là 00:00 ngày kế tiếp (biên kết thúc hợp lệ của ca, US-24-F02).
export const endMinutes = (to: string) => (to === '00:00' ? 24 * 60 : toMinutes(to));

// Xem trước slot 60 phút bắt đầu từ giờ bắt đầu ca; phần dư dưới 60 phút không thành slot (US-24-TC01).
export function previewSlots(from: string, to: string): { slots: { from: string; to: string }[]; remainderMinutes: number } {
  const start = toMinutes(from);
  const end = endMinutes(to);
  if (end <= start) return { slots: [], remainderMinutes: 0 };
  const slots: { from: string; to: string }[] = [];
  let slotStart = start;
  while (slotStart + 60 <= end) {
    slots.push({ from: fromMinutes(slotStart), to: fromMinutes((slotStart + 60) % (24 * 60)) });
    slotStart += 60;
  }
  return { slots, remainderMinutes: end - slotStart };
}
