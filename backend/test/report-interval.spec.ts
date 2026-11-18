import { clipInterval, decimalRatio, durationFields, interval, reportRange, unionIntervals } from '../src/modules/reports/report-interval';

describe('US52 owns S08-P01 interval contract (independent literal expectations)', () => {
  it('clips half-open edges and merges adjacent/overlapping intervals without rounding rows', () => {
    expect(clipInterval([-60000, 60000], [0, 120000])).toEqual([0, 60000]);
    expect(clipInterval([-60000, 0], [0, 120000])).toBeNull();
    expect(clipInterval([120000, 180000], [0, 120000])).toBeNull();
    expect(unionIntervals([[0, 60000], [60000, 120000], [30000, 90000], [180000, 180001]]))
      .toEqual({ intervals: [[0, 120000], [180000, 180001]], overlappingCount: 2, milliseconds: 120001n });
    expect(durationFields('planned', 120001n)).toEqual({ plannedMilliseconds: '120001', plannedMinutes: '2', plannedHours: '0.0333' });
    expect(decimalRatio(100n, 3n)).toBe('33.3333');
    expect(durationFields('actualTotal', null)).toEqual({ actualTotalMilliseconds: null, actualTotalMinutes: null, actualTotalHours: null });
    expect(interval(new Date(1), new Date(1))).toBeNull(); expect(interval('2026-11-01', new Date())).toBeNull();
  });
  it('keeps all milliseconds until final division; large aggregate precision is retained', () => {
    expect(durationFields('planned', 36000000000000001n).plannedMilliseconds).toBe('36000000000000001');
    expect(unionIntervals([[0, 1], [1, 2], [2, 3]]).milliseconds).toBe(3n);
  });
  it('uses Vietnam dates, defaults, observedAt cap, validates exact calendar and 366 inclusive days', () => {
    const now = new Date('2026-11-17T18:00:00Z');
    expect(reportRange({}, now)).toMatchObject({ fromDate: '2026-11-01', toDate: '2026-11-18', start: '2026-10-31T17:00:00.000Z', effectiveTo: now.toISOString() });
    expect(() => reportRange({ fromDate: '2026-02-30' }, now)).toThrow();
    expect(() => reportRange({ toDate: '2026-11-19' }, now)).toThrow();
    expect(() => reportRange({ fromDate: '2026-11-18', toDate: '2026-11-17' }, now)).toThrow();
    expect(() => reportRange({ fromDate: '2025-11-18' }, now)).not.toThrow();
    expect(() => reportRange({ fromDate: '2025-11-17' }, now)).toThrow();
  });
});
