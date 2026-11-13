// Tầng kiểm thử backend (Jest, unit, không cần DB): US-24 bước 1.
// Kiểm tra service dùng chung kiểm thời gian ca nháp (TC03, TC04), quy tắc chồng ca (TC05) và preview slot 60 phút (TC01).
import { ApplicationError } from '../src/common/errors/application-error';
// Hợp đồng test đặt ra cho Builder (US-24 bước 1):
//   new ShiftIntervalService() – class thuần, không phụ thuộc DB, US-28 dùng lại.
//   validateDraft(input, serverNow) với input = { startAt, endAt, location } nhận từ request (chuỗi ISO 8601)
//     → trả { startAt: Date, endAt: Date, location: string (đã trim) }
//     → dữ liệu sai thì ném ApplicationError(400, 'VALIDATION_ERROR', ..., [{ field, message }])
//   overlaps(a, b) với a, b = { startAt: Date, endAt: Date } → true nếu a.start < b.end và b.start < a.end
//   previewSlots(startAt, endAt) → { slots: [{ startAt: Date, endAt: Date }], remainderMinutes: number }
import { ShiftIntervalService } from '../src/modules/shifts/shift-interval.service';

describe('US-24 bước 1: ShiftIntervalService kiểm thời gian ca nháp', () => {
  const service = new ShiftIntervalService();
  // "Bây giờ" của server cố định: 10:00 ngày 06/11/2026 giờ Việt Nam.
  const serverNow = new Date('2026-11-06T03:00:00.000Z');

  function draft(overrides: Partial<{ startAt: unknown; endAt: unknown; location: unknown }> = {}) {
    return { startAt: '2026-12-01T08:10:00+07:00', endAt: '2026-12-01T10:40:00+07:00', location: 'Phòng PT 1', ...overrides };
  }

  // Gọi validateDraft và trả về lỗi ném ra (để kiểm status, code, field).
  function errorOf(input: ReturnType<typeof draft>): ApplicationError {
    try {
      service.validateDraft(input, serverNow);
    } catch (error) {
      return error as ApplicationError;
    }
    throw new Error('validateDraft phải ném lỗi nhưng lại chấp nhận dữ liệu');
  }

  function expectInvalid(input: ReturnType<typeof draft>, field: string) {
    const error = errorOf(input);
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details?.some(detail => detail.field === field)).toBe(true);
  }

  // ---------- TC01: ca hợp lệ, slot 60 phút bắt đầu từ startAt, phần dư không thành slot ----------
  describe('US-24-TC01: ca 08:10–10:40 hợp lệ', () => {
    it('US-24-TC01: chấp nhận ca 08:10–10:40, trả Date đúng thời điểm', () => {
      const result = service.validateDraft(draft(), serverNow);
      expect(result.startAt.toISOString()).toBe('2026-12-01T01:10:00.000Z');
      expect(result.endAt.toISOString()).toBe('2026-12-01T03:40:00.000Z');
      expect(result.location).toBe('Phòng PT 1');
    });

    it('US-24-TC01: preview slot là 08:10 và 09:10, dư 30 phút', () => {
      const preview = service.previewSlots(new Date('2026-12-01T01:10:00.000Z'), new Date('2026-12-01T03:40:00.000Z'));
      expect(preview.slots.map(slot => [slot.startAt.toISOString(), slot.endAt.toISOString()])).toEqual([
        ['2026-12-01T01:10:00.000Z', '2026-12-01T02:10:00.000Z'],
        ['2026-12-01T02:10:00.000Z', '2026-12-01T03:10:00.000Z'],
      ]);
      expect(preview.remainderMinutes).toBe(30);
    });

    it('US-24-TC01: ca đúng 60 phút cho 1 slot, dư 0 phút', () => {
      const preview = service.previewSlots(new Date('2026-12-01T01:00:00.000Z'), new Date('2026-12-01T02:00:00.000Z'));
      expect(preview.slots).toHaveLength(1);
      expect(preview.remainderMinutes).toBe(0);
    });

    it('US-24-TC01: chấp nhận thời điểm dạng Z (UTC)', () => {
      const result = service.validateDraft(draft({ startAt: '2026-12-01T01:10:00Z', endAt: '2026-12-01T03:40:00Z' }), serverNow);
      expect(result.startAt.toISOString()).toBe('2026-12-01T01:10:00.000Z');
      expect(result.endAt.toISOString()).toBe('2026-12-01T03:40:00.000Z');
    });
  });

  // ---------- TC03: end ≤ start, dưới 60 phút, quá khứ, thiếu offset → 400 ----------
  describe('US-24-TC03: dữ liệu thời gian sai bị từ chối', () => {
    it('US-24-TC03: endAt bằng startAt → 400', () => {
      expectInvalid(draft({ endAt: '2026-12-01T08:10:00+07:00' }), 'endAt');
    });

    it('US-24-TC03: endAt trước startAt → 400', () => {
      expectInvalid(draft({ endAt: '2026-12-01T07:10:00+07:00' }), 'endAt');
    });

    it('US-24-TC03: ca 59 phút (dưới 60 phút) → 400', () => {
      expectInvalid(draft({ endAt: '2026-12-01T09:09:00+07:00' }), 'endAt');
    });

    it('US-24-TC03: startAt ở quá khứ → 400', () => {
      expectInvalid(draft({ startAt: '2026-11-05T08:00:00+07:00', endAt: '2026-11-05T09:00:00+07:00' }), 'startAt');
    });

    it('US-24-TC03: startAt đúng bằng thời điểm server hiện tại (không lớn hơn) → 400', () => {
      expectInvalid(draft({ startAt: '2026-11-06T10:00:00+07:00', endAt: '2026-11-06T11:00:00+07:00' }), 'startAt');
    });

    it('US-24-TC03: startAt thiếu timezone (không có Z hoặc offset) → 400', () => {
      expectInvalid(draft({ startAt: '2026-12-01T08:10:00' }), 'startAt');
    });

    it('US-24-TC03: endAt thiếu timezone → 400', () => {
      expectInvalid(draft({ endAt: '2026-12-01T10:40:00' }), 'endAt');
    });

    it('US-24-TC03: chuỗi không phải ngày giờ thật → 400', () => {
      expectInvalid(draft({ startAt: '2026-02-30T08:00:00+07:00' }), 'startAt');
      expectInvalid(draft({ startAt: 'abc' }), 'startAt');
    });

    it('US-24-TC03: startAt không phải chuỗi → 400', () => {
      expectInvalid(draft({ startAt: 1764551400000 }), 'startAt');
    });

    it('US-24-TC03: thời điểm có giây hoặc mili giây khác 0 → 400', () => {
      expectInvalid(draft({ startAt: '2026-12-01T08:10:30+07:00' }), 'startAt');
      expectInvalid(draft({ endAt: '2026-12-01T10:40:00.500+07:00' }), 'endAt');
    });

    it('US-24-TC03: location rỗng hoặc chỉ có khoảng trắng → 400', () => {
      expectInvalid(draft({ location: '' }), 'location');
      expectInvalid(draft({ location: '    ' }), 'location');
    });

    it('US-24-TC03: location dài 121 ký tự sau trim → 400', () => {
      expectInvalid(draft({ location: 'a'.repeat(121) }), 'location');
    });

    it('US-24-TC03: location dài 120 ký tự được chấp nhận, khoảng trắng hai đầu bị trim', () => {
      expect(service.validateDraft(draft({ location: 'a'.repeat(120) }), serverNow).location).toBe('a'.repeat(120));
      expect(service.validateDraft(draft({ location: '  Phòng PT 1  ' }), serverNow).location).toBe('Phòng PT 1');
    });
  });

  // ---------- TC04: không qua nửa đêm Việt Nam; 00:00 ngày kế tiếp là biên kết thúc hợp lệ ----------
  describe('US-24-TC04: ranh giới nửa đêm giờ Việt Nam', () => {
    it('US-24-TC04: ca 22:30–00:30 qua nửa đêm → 400', () => {
      expectInvalid(draft({ startAt: '2026-12-01T22:30:00+07:00', endAt: '2026-12-02T00:30:00+07:00' }), 'endAt');
    });

    it('US-24-TC04: ca 23:00–00:00 ngày kế tiếp (đủ 60 phút) được phép', () => {
      const result = service.validateDraft(draft({ startAt: '2026-12-01T23:00:00+07:00', endAt: '2026-12-02T00:00:00+07:00' }), serverNow);
      expect(result.endAt.toISOString()).toBe('2026-12-01T17:00:00.000Z');
    });

    it('US-24-TC04: ca 23:30–00:00 kết thúc đúng biên nhưng chỉ 30 phút → 400', () => {
      expectInvalid(draft({ startAt: '2026-12-01T23:30:00+07:00', endAt: '2026-12-02T00:00:00+07:00' }), 'endAt');
    });

    it('US-24-TC04: nửa đêm tính theo giờ Việt Nam, không theo UTC (nhập dạng Z vẫn bị chặn)', () => {
      // 16:30Z–18:30Z = 23:30–01:30 giờ Việt Nam: cùng ngày UTC nhưng qua nửa đêm Việt Nam.
      expectInvalid(draft({ startAt: '2026-12-01T16:30:00Z', endAt: '2026-12-01T18:30:00Z' }), 'endAt');
    });

    it('US-24-TC04: ca qua nửa đêm UTC nhưng cùng ngày Việt Nam được phép', () => {
      // 23:00Z–01:00Z = 06:00–08:00 giờ Việt Nam ngày 02/12.
      const result = service.validateDraft(draft({ startAt: '2026-12-01T23:00:00Z', endAt: '2026-12-02T01:00:00Z' }), serverNow);
      expect(result.startAt.toISOString()).toBe('2026-12-01T23:00:00.000Z');
    });
  });

  // ---------- TC05 (phần quy tắc dùng chung): khoảng [start, end), tiếp giáp không tính là chồng ----------
  describe('US-24-TC05: quy tắc chồng khoảng thời gian', () => {
    const at = (hhmm: string) => new Date(`2026-12-01T${hhmm}:00+07:00`);
    const shift = (from: string, to: string) => ({ startAt: at(from), endAt: at(to) });

    it('US-24-TC05: hai ca liền nhau 08:00–09:00 và 09:00–10:00 không chồng (cả hai chiều)', () => {
      expect(service.overlaps(shift('08:00', '09:00'), shift('09:00', '10:00'))).toBe(false);
      expect(service.overlaps(shift('09:00', '10:00'), shift('08:00', '09:00'))).toBe(false);
    });

    it('US-24-TC05: giao một phần 08:00–09:30 và 09:00–10:00 là chồng', () => {
      expect(service.overlaps(shift('08:00', '09:30'), shift('09:00', '10:00'))).toBe(true);
      expect(service.overlaps(shift('09:00', '10:00'), shift('08:00', '09:30'))).toBe(true);
    });

    it('US-24-TC05: ca này nằm trọn trong ca kia, hoặc trùng hẳn, là chồng', () => {
      expect(service.overlaps(shift('08:00', '12:00'), shift('09:00', '10:00'))).toBe(true);
      expect(service.overlaps(shift('09:00', '10:00'), shift('08:00', '12:00'))).toBe(true);
      expect(service.overlaps(shift('08:00', '09:00'), shift('08:00', '09:00'))).toBe(true);
    });

    it('US-24-TC05: hai ca cách nhau không chồng', () => {
      expect(service.overlaps(shift('08:00', '09:00'), shift('10:00', '11:00'))).toBe(false);
    });
  });
});
