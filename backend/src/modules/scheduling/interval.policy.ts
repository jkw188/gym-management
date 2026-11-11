// Tầng nghiệp vụ (US-28 bước 1): luật khoảng thời gian dùng chung cho đặt lịch PT, hàm thuần không đọc/ghi DB.
// Kiểm hai khoảng [start, end) có giao nhau không và buổi có nằm trọn trong kỳ gói tính theo ngày Việt Nam không.

export interface TimeInterval {
  startAt: Date;
  endAt: Date;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// US-28-TC14: hai khoảng nửa mở [start, end) giao nhau khi a.start < b.end và b.start < a.end.
// Hai khoảng tiếp giáp (cái này kết thúc đúng lúc cái kia bắt đầu) thì KHÔNG giao.
export function overlaps(a: TimeInterval, b: TimeInterval): boolean {
  return a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();
}

// US-28-F02, US-28-TC14: kỳ gói từ 00:00 giờ VN ngày đầu đến 00:00 giờ VN của ngày SAU ngày cuối (gồm cả ngày cuối).
// startDate, endDate là chuỗi 'YYYY-MM-DD' theo ngày Việt Nam; "+07:00" để JavaScript tự đổi sang UTC.
export function vietnamPeriod(startDate: string, endDate: string): TimeInterval {
  const startAt = new Date(`${startDate}T00:00:00+07:00`);
  const lastDayStart = new Date(`${endDate}T00:00:00+07:00`);
  return { startAt, endAt: new Date(lastDayStart.getTime() + DAY_MS) };
}

// US-28-TC03, US-28-TC14: CẢ buổi phải nằm trong kỳ; chỉ chạm một phần vẫn coi là ngoài kỳ.
export function insidePeriod(interval: TimeInterval, period: TimeInterval): boolean {
  return interval.startAt.getTime() >= period.startAt.getTime() && interval.endAt.getTime() <= period.endAt.getTime();
}
