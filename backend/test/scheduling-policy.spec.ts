// Tầng kiểm thử backend (Jest, unit, không cần DB): US-28 bước 1.
// Kiểm tra chính sách slot (slot đúng mốc 60 phút trong ca CONFIRMED, sau "now") và chính sách khoảng thời gian
// (overlap nửa mở, kỳ gói theo ngày VN gồm ngày cuối) dùng chung cho đặt lịch (TC03, TC14).
// Hợp đồng test đặt ra cho Builder (US-28 bước 1, theo F02, F04 và mục 3 của spec; sinh viên chốt 10/11: bước 1 đơn giản hóa):
//   backend/src/modules/scheduling/interval.policy.ts – hàm thuần, không phụ thuộc DB:
//     overlaps(a, b) với a, b = { startAt: Date, endAt: Date } → true khi a.start < b.end và b.start < a.end (tiếp giáp không giao).
//     vietnamPeriod(startDate, endDate) với chuỗi 'YYYY-MM-DD' (ngày VN) → { startAt: Date, endAt: Date }
//        = [startDate 00:00 giờ VN, (endDate + 1 ngày) 00:00 giờ VN).
//     insidePeriod(interval, period) → true khi CẢ interval nằm trong period (start ≥ period.start, end ≤ period.end).
//   backend/src/modules/scheduling/slot.policy.ts – hàm thuần:
//     checkSlot(shift, startAt, now) với shift = { startAt: Date, endAt: Date, status: string }
//       → { ok: true, endAt: Date } khi: shift.status = 'CONFIRMED', startAt = shift.startAt + k×60 phút (k ≥ 0),
//         endAt = startAt + 60 phút ≤ shift.endAt, startAt > now. endAt do server tính.
//       → { ok: false, code: 'SHIFT_UNAVAILABLE' } khi ca không CONFIRMED (ca nháp SCHEDULED, CANCELLED, COMPLETED).
//       → { ok: false, code: 'SLOT_UNAVAILABLE' } khi lệch mốc, rơi vào phần dư, nằm ngoài ca hoặc startAt ≤ now.
import { insidePeriod, overlaps, vietnamPeriod } from '../src/modules/scheduling/interval.policy';
import { checkSlot } from '../src/modules/scheduling/slot.policy';

// Giờ Việt Nam → Date (UTC bên trong).
const vn = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+07:00`);
const interval = (day: string, from: string, to: string) => ({ startAt: vn(day, from), endAt: vn(day, to) });

describe('US-28 bước 1: chính sách slot và khoảng thời gian', () => {
  // "Bây giờ" của server cố định: 10:00 ngày 20/11/2026 giờ VN. Ca xem xét ở ngày 25/11/2026.
  const now = vn('2026-11-20', '10:00');
  const DAY = '2026-11-25';
  const shift = (status = 'CONFIRMED', from = '08:10', to = '10:40', day = DAY) => ({ startAt: vn(day, from), endAt: vn(day, to), status });

  // ---------- TC03: slot lệch mốc, phần dư, ca nháp, start ≤ now ----------
  describe('US-28-TC03: slot hợp lệ và không hợp lệ', () => {
    it('US-28-TC03: slot đúng đầu ca 08:10 trong ca CONFIRMED 08:10–10:40 → hợp lệ, endAt = 09:10 do server tính', () => {
      const result = checkSlot(shift(), vn(DAY, '08:10'), now);
      expect(result).toEqual({ ok: true, endAt: vn(DAY, '09:10') });
    });

    it('US-28-TC03: slot thứ hai 09:10 (k = 1) → hợp lệ, endAt = 10:10', () => {
      expect(checkSlot(shift(), vn(DAY, '09:10'), now)).toEqual({ ok: true, endAt: vn(DAY, '10:10') });
    });

    it('US-28-TC03: slot lệch mốc 08:30 (không phải đầu ca + k×60 phút) → SLOT_UNAVAILABLE', () => {
      expect(checkSlot(shift(), vn(DAY, '08:30'), now)).toEqual({ ok: false, code: 'SLOT_UNAVAILABLE' });
    });

    it('US-28-TC03: slot lệch 1 phút 09:11 → SLOT_UNAVAILABLE', () => {
      expect(checkSlot(shift(), vn(DAY, '09:11'), now)).toEqual({ ok: false, code: 'SLOT_UNAVAILABLE' });
    });

    it('US-28-TC03: slot rơi vào phần dư 10:10 (kết thúc 11:10 vượt cuối ca 10:40) → SLOT_UNAVAILABLE', () => {
      expect(checkSlot(shift(), vn(DAY, '10:10'), now)).toEqual({ ok: false, code: 'SLOT_UNAVAILABLE' });
    });

    it('US-28-TC03: slot trước đầu ca 07:10 hoặc sau cuối ca 11:10 → SLOT_UNAVAILABLE', () => {
      expect(checkSlot(shift(), vn(DAY, '07:10'), now)).toEqual({ ok: false, code: 'SLOT_UNAVAILABLE' });
      expect(checkSlot(shift(), vn(DAY, '11:10'), now)).toEqual({ ok: false, code: 'SLOT_UNAVAILABLE' });
    });

    it('US-28-TC03: slot cuối vừa khít cuối ca (ca 08:00–10:00, slot 09:00) → hợp lệ', () => {
      expect(checkSlot(shift('CONFIRMED', '08:00', '10:00'), vn(DAY, '09:00'), now)).toEqual({ ok: true, endAt: vn(DAY, '10:00') });
    });

    it.each(['SCHEDULED', 'CANCELLED', 'COMPLETED'])('US-28-TC03: ca %s (không phải CONFIRMED) → SHIFT_UNAVAILABLE', status => {
      expect(checkSlot(shift(status), vn(DAY, '08:10'), now)).toEqual({ ok: false, code: 'SHIFT_UNAVAILABLE' });
    });

    it('US-28-TC03: startAt đúng bằng now → SLOT_UNAVAILABLE (phải startAt > now)', () => {
      const today = shift('CONFIRMED', '10:00', '12:00', '2026-11-20');
      expect(checkSlot(today, vn('2026-11-20', '10:00'), now)).toEqual({ ok: false, code: 'SLOT_UNAVAILABLE' });
    });

    it('US-28-TC03: startAt đã qua (ca hôm nay 08:00–12:00, slot 09:00 lúc 10:00) → SLOT_UNAVAILABLE; slot 11:00 → hợp lệ', () => {
      const today = shift('CONFIRMED', '08:00', '12:00', '2026-11-20');
      expect(checkSlot(today, vn('2026-11-20', '09:00'), now)).toEqual({ ok: false, code: 'SLOT_UNAVAILABLE' });
      expect(checkSlot(today, vn('2026-11-20', '11:00'), now)).toEqual({ ok: true, endAt: vn('2026-11-20', '12:00') });
    });

    it('US-28-TC03: buổi vượt kỳ gói → không nằm trong kỳ (insidePeriod = false)', () => {
      const period = vietnamPeriod('2026-11-01', '2026-11-24');
      expect(insidePeriod(interval(DAY, '08:10', '09:10'), period)).toBe(false);
    });
  });

  // ---------- TC14: ngày cuối, UTC khác VN, lớp phủ một phần và tiếp giáp ----------
  describe('US-28-TC14: interval và ngày bao gồm đúng, không lỗi múi giờ', () => {
    it('US-28-TC14: kỳ gói đổi đúng sang UTC: 00:00 VN ngày đầu = 17:00Z hôm trước; kết thúc = 00:00 VN ngày sau ngày cuối', () => {
      const period = vietnamPeriod('2026-11-01', '2026-11-30');
      expect(period.startAt.toISOString()).toBe('2026-10-31T17:00:00.000Z');
      expect(period.endAt.toISOString()).toBe('2026-11-30T17:00:00.000Z');
    });

    it('US-28-TC14: buổi 23:00–24:00 VN đúng ngày cuối của gói vẫn nằm trong kỳ', () => {
      const period = vietnamPeriod('2026-11-01', '2026-11-30');
      expect(insidePeriod({ startAt: vn('2026-11-30', '23:00'), endAt: vn('2026-12-01', '00:00') }, period)).toBe(true);
    });

    it('US-28-TC14: buổi 00:00 VN ngày sau ngày cuối nằm ngoài kỳ', () => {
      const period = vietnamPeriod('2026-11-01', '2026-11-30');
      expect(insidePeriod(interval('2026-12-01', '00:00', '01:00'), period)).toBe(false);
    });

    it('US-28-TC14: buổi 00:00–01:00 VN ngày đầu (UTC còn là hôm trước) vẫn nằm trong kỳ; buổi 23:00 VN hôm trước thì không', () => {
      const period = vietnamPeriod('2026-11-01', '2026-11-30');
      expect(insidePeriod(interval('2026-11-01', '00:00', '01:00'), period)).toBe(true);
      expect(insidePeriod({ startAt: vn('2026-10-31', '23:00'), endAt: vn('2026-11-01', '00:00') }, period)).toBe(false);
    });

    it('US-28-TC14: buổi chỉ một phần nằm trong kỳ (23:30 ngày cuối → 00:30 hôm sau) → ngoài kỳ, phải CẢ buổi trong kỳ', () => {
      const period = vietnamPeriod('2026-11-01', '2026-11-30');
      expect(insidePeriod({ startAt: vn('2026-11-30', '23:30'), endAt: vn('2026-12-01', '00:30') }, period)).toBe(false);
    });

    it('US-28-TC14: gói một ngày (ngày đầu = ngày cuối) dài đúng 24 giờ', () => {
      const period = vietnamPeriod('2026-11-25', '2026-11-25');
      expect(period.endAt.getTime() - period.startAt.getTime()).toBe(24 * 60 * 60 * 1000);
    });

    it('US-28-TC14: lớp phủ một phần (lớp 08:30–09:30 với slot 08:00–09:00 và 09:00–10:00) → giao cả hai', () => {
      const lesson = interval(DAY, '08:30', '09:30');
      expect(overlaps(interval(DAY, '08:00', '09:00'), lesson)).toBe(true);
      expect(overlaps(interval(DAY, '09:00', '10:00'), lesson)).toBe(true);
    });

    it('US-28-TC14: hai khoảng tiếp giáp (09:00–10:00 và 10:00–11:00) không giao, theo cả hai chiều', () => {
      const first = interval(DAY, '09:00', '10:00');
      const second = interval(DAY, '10:00', '11:00');
      expect(overlaps(first, second)).toBe(false);
      expect(overlaps(second, first)).toBe(false);
    });

    it('US-28-TC14: khoảng nằm trọn trong khoảng khác hoặc trùng hệt → giao', () => {
      expect(overlaps(interval(DAY, '08:00', '11:00'), interval(DAY, '09:00', '10:00'))).toBe(true);
      expect(overlaps(interval(DAY, '09:00', '10:00'), interval(DAY, '09:00', '10:00'))).toBe(true);
    });

    it('US-28-TC14: khoảng giao chỉ 1 phút (09:59–10:59 với 09:00–10:00) → giao', () => {
      expect(overlaps(interval(DAY, '09:59', '10:59'), interval(DAY, '09:00', '10:00'))).toBe(true);
    });
  });
});
