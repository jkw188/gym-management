import { bookingIneligibility, bookingWindow, existedAt, membershipIneligibility, membershipWindow, reminderDecision, reminderEventKey } from '../src/modules/reminders/reminder.policy';
import { readConfiguration } from '../src/config/configuration';
import { ConfigService } from '@nestjs/config';
import { ServerClock } from '../src/common/utils/business-date';
import { RemindersWorker } from '../src/modules/reminders/reminders.worker';
import { RemindersRepository } from '../src/modules/reminders/reminders.repository';
import { RemindersService } from '../src/modules/reminders/reminders.service';

describe('US-49 policy: ngày Việt Nam và cửa sổ nửa mở', () => {
  it('TC01/16: ngày cuối tháng/năm, leap year và clock UTC', () => {
    expect(membershipWindow('2026-11-10', '3D').dueAt.toISOString()).toBe('2026-11-06T17:00:00.000Z');
    expect(membershipWindow('2026-11-10', '1D').dueAt.toISOString()).toBe('2026-11-08T17:00:00.000Z');
    expect(membershipWindow('2027-01-01', '3D').dueAt.toISOString()).toBe('2026-12-28T17:00:00.000Z');
    expect(membershipWindow('2028-03-01', '1D').dueAt.toISOString()).toBe('2028-02-28T17:00:00.000Z');
  });
  it('TC02: booking 18h VN, due24H và due2H chính xác', () => {
    const start = new Date('2026-11-10T11:00:00Z');
    expect(bookingWindow(start, '24H').dueAt.toISOString()).toBe('2026-11-09T11:00:00.000Z');
    expect(bookingWindow(start, '2H').dueAt.toISOString()).toBe('2026-11-10T09:00:00.000Z');
  });
  it.each([
    membershipWindow('2026-11-10', '3D'), membershipWindow('2026-11-10', '1D'),
    bookingWindow(new Date('2026-11-10T11:00:00Z'), '24H'), bookingWindow(new Date('2026-11-10T11:00:00Z'), '2H'),
  ])('TC06/07: boundary due inclusive, window end exclusive %j', window => {
    expect(reminderDecision(new Date(window.dueAt.getTime() - 1), window, 'CANCELLED')).toBeNull();
    expect(reminderDecision(window.dueAt, window)?.status).toBe('STORED');
    expect(reminderDecision(new Date(window.until.getTime() - 1), window)?.status).toBe('STORED');
    expect(reminderDecision(window.until, window)?.status).toBe('SKIPPED_STALE');
  });
  it('TC03: timestamp thiếu hoặc sau due không đủ bằng chứng tồn tại', () => {
    const due = new Date('2026-11-01Z');
    expect(existedAt(undefined, due)).toBe(false);
    expect(existedAt(due, due)).toBe(true);
    expect(existedAt(new Date(due.getTime() + 1), due)).toBe(false);
    expect(reminderEventKey('PT_BOOKING', 'abc', '2H')).toBe('PT_REMINDER:abc:2H');
  });
  it('TC03/04/08: eligibility thuần kiểm paid tại due, kỳ hiệu lực và nối kỳ', () => {
    const dueAt = new Date('2026-11-06T17:00:00Z');
    const input = { status: 'ACTIVE', createdAt: dueAt, startDate: '2026-11-01', endDate: '2026-11-10',
      transaction: { status: 'SETTLED', kind: 'GYM', settled_at: dueAt }, now: dueAt, dueAt };
    expect(membershipIneligibility(input)).toBeUndefined();
    expect(membershipIneligibility({ ...input, transaction: { ...input.transaction, settled_at: new Date(dueAt.getTime() + 1) } })).toBe('CREATED_AFTER_DUE');
    expect(membershipIneligibility({ ...input, hasContinuation: true })).toBe('SETTLED_CONTINUATION');
    expect(bookingIneligibility('COMPLETED', dueAt, dueAt)).toBe('BOOKING_NOT_BOOKED');
  });
  it.each([{ REMINDER_TICK_MS: '60001' }, { REMINDER_TICK_MS: '0' }, { REMINDER_BATCH_SIZE: '51' }, { REMINDER_BATCH_SIZE: '1.5' }])('config từ chối %j', extra => {
    expect(() => readConfiguration({ MONGODB_URI: 'mongodb://localhost', MONGODB_DB: 'gym_test_us49', ...extra })).toThrow();
  });
});

describe('US-49 lifecycle worker', () => {
  it('chỉ start nội bộ mới chạy ngay; tick60s và destroy dọn timer', async () => {
    jest.useFakeTimers();
    try {
      const worker = new RemindersWorker({} as RemindersRepository, {} as RemindersService, new ServerClock(),
        new ConfigService({ reminderTickMs: 60000, reminderBatchSize: 50 }));
      const run = jest.spyOn(worker, 'runOnce').mockResolvedValue({ stored: 0, skipped: 0, failed: 0, existing: 0, lagMs: 0 });
      expect(run).not.toHaveBeenCalled(); worker.start(); worker.start();
      expect(run).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60000); expect(run).toHaveBeenCalledTimes(2);
      worker.onModuleDestroy(); expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
});
