// Tầng kiểm thử backend (Jest, unit, không cần DB): US-25 bước 1.
// Kiểm tra luật chuyển trạng thái ca: công bố SCHEDULED→CONFIRMED, hủy ca trước giờ bắt đầu, bảo toàn ca quá giờ (TC01, TC03, TC04, TC05, TC07).
import { ApplicationError } from '../src/common/errors/application-error';
// Hợp đồng test đặt ra cho Builder (US-25 bước 1):
//   new ShiftTransitionService() – class thuần, không phụ thuộc DB; bước 2 gọi trong transaction sau khi đã đọc ca và đếm BOOKED.
//   Đầu vào shift = { status, startAt: Date, endAt: Date, version: number } (ca đã đọc từ DB).
//   planConfirm(shift, serverNow)
//     → trả { status: 'CONFIRMED', version: shift.version + 1, confirmedAt: serverNow, updatedAt: serverNow }
//     → status khác SCHEDULED: ném ApplicationError(409, 'INVALID_SHIFT_STATE')
//     → startAt <= serverNow: ném ApplicationError(409, 'SHIFT_ALREADY_STARTED')
//   planCancel(shift, { reason, bookedCount }, serverNow)
//     → trả { status: 'CANCELLED', version: shift.version + 1, cancelledAt: serverNow, cancellationReason: reason đã trim, updatedAt: serverNow }
//     → reason không phải chuỗi hoặc sau trim không dài 10–500 ký tự: ném ApplicationError(400, 'VALIDATION_ERROR', ..., [{ field: 'reason', ... }])
//     → status COMPLETED hoặc CANCELLED: ném ApplicationError(409, 'INVALID_SHIFT_STATE')
//     → serverNow >= startAt: ném ApplicationError(409, 'SHIFT_ALREADY_STARTED')
//     → bookedCount > 0: ném ApplicationError(409, 'SHIFT_HAS_BOOKINGS')
//   offersSlots(shift, serverNow) → true chỉ khi ca CONFIRMED và chưa kết thúc
//   Không hàm nào được sửa object shift truyền vào (repository ở bước 2 mới ghi DB).
import { ShiftTransitionService } from '../src/modules/shifts/shift-transition.service';

type ShiftInput = { status: string; startAt: Date; endAt: Date; version: number };

describe('US-25 bước 1: ShiftTransitionService chuyển trạng thái ca', () => {
  const service = new ShiftTransitionService();
  // "Bây giờ" của server cố định: 10:00 ngày 07/11/2026 giờ Việt Nam.
  const serverNow = new Date('2026-11-07T03:00:00.000Z');
  const validReason = 'PT bận việc gia đình';

  // Ca mặc định: 08:00–10:00 ngày 01/12/2026 giờ Việt Nam (tương lai), đang là nháp version 2.
  function shift(overrides: Partial<ShiftInput> = {}): ShiftInput {
    return {
      status: 'SCHEDULED',
      startAt: new Date('2026-12-01T01:00:00.000Z'),
      endAt: new Date('2026-12-01T03:00:00.000Z'),
      version: 2,
      ...overrides,
    };
  }

  // Ca đang diễn ra: bắt đầu 09:00, kết thúc 11:00 hôm nay (serverNow là 10:00).
  const inProgress = { startAt: new Date('2026-11-07T02:00:00.000Z'), endAt: new Date('2026-11-07T04:00:00.000Z') };
  // Ca đã kết thúc: 07:00–08:00 hôm nay.
  const finished = { startAt: new Date('2026-11-07T00:00:00.000Z'), endAt: new Date('2026-11-07T01:00:00.000Z') };

  // Chạy hàm và trả về lỗi ném ra (để kiểm status, code, field).
  function errorOf(run: () => unknown): ApplicationError {
    try {
      run();
    } catch (error) {
      return error as ApplicationError;
    }
    throw new Error('Hàm phải ném lỗi nhưng lại chấp nhận');
  }

  function expectConflict(run: () => unknown, code: string) {
    const error = errorOf(run);
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error.status).toBe(409);
    expect(error.code).toBe(code);
  }

  function expectInvalidReason(reason: unknown) {
    const error = errorOf(() => service.planCancel(shift(), { reason, bookedCount: 0 }, serverNow));
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details?.some(detail => detail.field === 'reason')).toBe(true);
  }

  // ---------- TC01: công bố nháp tương lai hợp lệ ----------
  describe('US-25-TC01: PT công bố nháp tương lai hợp lệ', () => {
    it('US-25-TC01: nháp tương lai chuyển CONFIRMED, version+1, ghi confirmedAt và updatedAt theo giờ server', () => {
      expect(service.planConfirm(shift(), serverNow)).toEqual({
        status: 'CONFIRMED',
        version: 3,
        confirmedAt: serverNow,
        updatedAt: serverNow,
      });
    });

    it('US-25-TC01: còn 1 phút nữa mới bắt đầu vẫn công bố được (startAt > now)', () => {
      const oneMinuteLater = new Date(serverNow.getTime() + 60_000);
      const result = service.planConfirm(shift({ startAt: oneMinuteLater, endAt: new Date('2026-11-07T04:01:00.000Z') }), serverNow);
      expect(result.status).toBe('CONFIRMED');
    });

    it('US-25-TC01: không sửa object ca truyền vào (chỉ trả giá trị mới)', () => {
      const input = shift();
      service.planConfirm(input, serverNow);
      expect(input).toEqual(shift());
    });

    it('US-25-TC01: ca CONFIRMED tương lai bắt đầu có slot', () => {
      expect(service.offersSlots(shift({ status: 'CONFIRMED' }), serverNow)).toBe(true);
    });

    it('US-25-TC01: ca nháp SCHEDULED chưa có slot', () => {
      expect(service.offersSlots(shift(), serverNow)).toBe(false);
    });
  });

  // ---------- TC03: công bố ca đã CONFIRMED / đã bắt đầu → 409 ----------
  describe('US-25-TC03: công bố ca không còn hợp lệ bị từ chối', () => {
    it('US-25-TC03: công bố ca đã CONFIRMED → 409 INVALID_SHIFT_STATE', () => {
      expectConflict(() => service.planConfirm(shift({ status: 'CONFIRMED' }), serverNow), 'INVALID_SHIFT_STATE');
    });

    it('US-25-TC03: công bố ca CANCELLED → 409 INVALID_SHIFT_STATE', () => {
      expectConflict(() => service.planConfirm(shift({ status: 'CANCELLED' }), serverNow), 'INVALID_SHIFT_STATE');
    });

    it('US-25-TC03: công bố ca COMPLETED → 409 INVALID_SHIFT_STATE', () => {
      expectConflict(() => service.planConfirm(shift({ status: 'COMPLETED' }), serverNow), 'INVALID_SHIFT_STATE');
    });

    it('US-25-TC03: công bố nháp đúng lúc bắt đầu (startAt = now) → 409 SHIFT_ALREADY_STARTED', () => {
      expectConflict(
        () => service.planConfirm(shift({ startAt: serverNow, endAt: new Date('2026-11-07T04:00:00.000Z') }), serverNow),
        'SHIFT_ALREADY_STARTED',
      );
    });

    it('US-25-TC03: công bố nháp đang diễn ra → 409 SHIFT_ALREADY_STARTED', () => {
      expectConflict(() => service.planConfirm(shift(inProgress), serverNow), 'SHIFT_ALREADY_STARTED');
    });

    it('US-25-TC03: công bố nháp đã hết giờ → 409 SHIFT_ALREADY_STARTED', () => {
      expectConflict(() => service.planConfirm(shift(finished), serverNow), 'SHIFT_ALREADY_STARTED');
    });

    it('US-25-TC03: bị từ chối thì không tự reset ca (object truyền vào giữ nguyên)', () => {
      const input = shift({ status: 'CONFIRMED' });
      errorOf(() => service.planConfirm(input, serverNow));
      expect(input).toEqual(shift({ status: 'CONFIRMED' }));
    });
  });

  // ---------- TC04: hủy ca trống trước startAt với reason hợp lệ ----------
  describe('US-25-TC04: hủy ca trống trước giờ bắt đầu', () => {
    it('US-25-TC04: hủy nháp trống → CANCELLED, version+1, ghi cancelledAt, reason và updatedAt', () => {
      expect(service.planCancel(shift(), { reason: validReason, bookedCount: 0 }, serverNow)).toEqual({
        status: 'CANCELLED',
        version: 3,
        cancelledAt: serverNow,
        cancellationReason: validReason,
        updatedAt: serverNow,
      });
    });

    it('US-25-TC04: hủy ca CONFIRMED trống → CANCELLED', () => {
      const result = service.planCancel(shift({ status: 'CONFIRMED' }), { reason: validReason, bookedCount: 0 }, serverNow);
      expect(result.status).toBe('CANCELLED');
      expect(result.version).toBe(3);
    });

    it('US-25-TC04: còn 1 phút nữa mới bắt đầu vẫn hủy được (now < startAt)', () => {
      const oneMinuteLater = new Date(serverNow.getTime() + 60_000);
      const result = service.planCancel(
        shift({ status: 'CONFIRMED', startAt: oneMinuteLater, endAt: new Date('2026-11-07T04:01:00.000Z') }),
        { reason: validReason, bookedCount: 0 },
        serverNow,
      );
      expect(result.status).toBe('CANCELLED');
    });

    it('US-25-TC04: ca đã hủy không còn slot', () => {
      expect(service.offersSlots(shift({ status: 'CANCELLED' }), serverNow)).toBe(false);
    });

    it('US-25-TC04: reason được trim trước khi lưu', () => {
      const result = service.planCancel(shift(), { reason: `   ${validReason}   `, bookedCount: 0 }, serverNow);
      expect(result.cancellationReason).toBe(validReason);
    });

    it('US-25-TC04: reason đúng 10 ký tự sau trim → chấp nhận', () => {
      const result = service.planCancel(shift(), { reason: '  ' + 'a'.repeat(10) + '  ', bookedCount: 0 }, serverNow);
      expect(result.cancellationReason).toBe('a'.repeat(10));
    });

    it('US-25-TC04: reason đúng 500 ký tự → chấp nhận', () => {
      const result = service.planCancel(shift(), { reason: 'a'.repeat(500), bookedCount: 0 }, serverNow);
      expect(result.cancellationReason).toHaveLength(500);
    });

    it('US-25-TC04: reason 9 ký tự sau trim → 400 field reason', () => {
      expectInvalidReason('  ' + 'a'.repeat(9) + '  ');
    });

    it('US-25-TC04: reason 501 ký tự → 400 field reason', () => {
      expectInvalidReason('a'.repeat(501));
    });

    it('US-25-TC04: reason toàn khoảng trắng → 400 field reason', () => {
      expectInvalidReason('            ');
    });

    it('US-25-TC04: thiếu reason hoặc reason không phải chuỗi → 400 field reason', () => {
      expectInvalidReason(undefined);
      expectInvalidReason(1234567890);
    });

    it('US-25-TC04: không sửa object ca truyền vào', () => {
      const input = shift();
      service.planCancel(input, { reason: validReason, bookedCount: 0 }, serverNow);
      expect(input).toEqual(shift());
    });
  });

  // ---------- TC05: hủy ca còn BOOKED → 409 ----------
  describe('US-25-TC05: hủy ca còn BOOKED bị chặn', () => {
    it('US-25-TC05: ca CONFIRMED còn 1 BOOKED → 409 SHIFT_HAS_BOOKINGS', () => {
      expectConflict(
        () => service.planCancel(shift({ status: 'CONFIRMED' }), { reason: validReason, bookedCount: 1 }, serverNow),
        'SHIFT_HAS_BOOKINGS',
      );
    });

    it('US-25-TC05: nháp bất thường có BOOKED → 409 SHIFT_HAS_BOOKINGS', () => {
      expectConflict(() => service.planCancel(shift(), { reason: validReason, bookedCount: 3 }, serverNow), 'SHIFT_HAS_BOOKINGS');
    });

    it('US-25-TC05: bị chặn thì ca truyền vào giữ nguyên', () => {
      const input = shift({ status: 'CONFIRMED' });
      errorOf(() => service.planCancel(input, { reason: validReason, bookedCount: 1 }, serverNow));
      expect(input).toEqual(shift({ status: 'CONFIRMED' }));
    });
  });

  // ---------- TC07: hủy ca đang diễn ra / đã hết / COMPLETED → 409 ----------
  describe('US-25-TC07: không hủy ca quá giờ hoặc ca đã kết thúc trạng thái', () => {
    it('US-25-TC07: hủy ca CONFIRMED đúng lúc bắt đầu (now = startAt) → 409 SHIFT_ALREADY_STARTED', () => {
      expectConflict(
        () =>
          service.planCancel(
            shift({ status: 'CONFIRMED', startAt: serverNow, endAt: new Date('2026-11-07T04:00:00.000Z') }),
            { reason: validReason, bookedCount: 0 },
            serverNow,
          ),
        'SHIFT_ALREADY_STARTED',
      );
    });

    it('US-25-TC07: hủy ca CONFIRMED đang diễn ra → 409 SHIFT_ALREADY_STARTED', () => {
      expectConflict(
        () => service.planCancel(shift({ status: 'CONFIRMED', ...inProgress }), { reason: validReason, bookedCount: 0 }, serverNow),
        'SHIFT_ALREADY_STARTED',
      );
    });

    it('US-25-TC07: hủy nháp đã hết giờ → 409 SHIFT_ALREADY_STARTED, không tự đánh dấu COMPLETED', () => {
      expectConflict(
        () => service.planCancel(shift({ status: 'SCHEDULED', ...finished }), { reason: validReason, bookedCount: 0 }, serverNow),
        'SHIFT_ALREADY_STARTED',
      );
    });

    it('US-25-TC07: hủy ca COMPLETED → 409 (ca đã kết thúc trạng thái)', () => {
      const error = errorOf(() =>
        service.planCancel(shift({ status: 'COMPLETED', ...finished }), { reason: validReason, bookedCount: 0 }, serverNow),
      );
      expect(error).toBeInstanceOf(ApplicationError);
      expect(error.status).toBe(409);
      expect(['INVALID_SHIFT_STATE', 'SHIFT_ALREADY_STARTED']).toContain(error.code);
    });

    it('US-25-TC07: hủy lại ca đã CANCELLED → 409 INVALID_SHIFT_STATE', () => {
      expectConflict(
        () => service.planCancel(shift({ status: 'CANCELLED' }), { reason: validReason, bookedCount: 0 }, serverNow),
        'INVALID_SHIFT_STATE',
      );
    });

    it('US-25-TC07: nháp hết giờ không mở slot', () => {
      expect(service.offersSlots(shift({ status: 'SCHEDULED', ...finished }), serverNow)).toBe(false);
    });

    it('US-25-TC07: ca CONFIRMED đã kết thúc không còn slot', () => {
      expect(service.offersSlots(shift({ status: 'CONFIRMED', ...finished }), serverNow)).toBe(false);
    });

    it('US-25-TC07: ca COMPLETED không có slot', () => {
      expect(service.offersSlots(shift({ status: 'COMPLETED', ...finished }), serverNow)).toBe(false);
    });
  });
});
