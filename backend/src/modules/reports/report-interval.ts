import Decimal from 'decimal.js';
import { invalidField } from '../../common/errors/application-error';
import { assertBusinessDate } from '../../common/utils/business-date';

// S08-P01: integer UTC milliseconds, half-open windows, union within ONE trainer/source.
export type Interval = readonly [number, number];
export function reportRange(query: { fromDate?: string; toDate?: string }, observedAt: Date) {
  const today = new Date(observedAt.getTime() + 7 * 3600000).toISOString().slice(0, 10);
  const fromDate = assertBusinessDate(query.fromDate ?? `${today.slice(0, 7)}-01`);
  const toDate = assertBusinessDate(query.toDate ?? today);
  const start = Date.parse(`${fromDate}T00:00:00+07:00`);
  const end = Date.parse(`${toDate}T00:00:00+07:00`) + 86400000;
  if (fromDate > toDate || toDate > today || (end - start) / 86400000 > 366)
    invalidField('fromDate', 'Kỳ phải đúng thứ tự, tối đa 366 ngày và không sau hôm nay VN');
  return { fromDate, toDate, timezone: 'Asia/Ho_Chi_Minh', start: new Date(start).toISOString(),
    endExclusive: new Date(end).toISOString(), effectiveTo: new Date(Math.min(end, observedAt.getTime())).toISOString(), isOngoing: toDate === today };
}
export function timestamp(value: unknown): number | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
}
export function interval(start: unknown, end: unknown): Interval | null {
  const s = timestamp(start), e = timestamp(end);
  return s !== null && e !== null && e > s ? [s, e] : null;
}
export function clipInterval(value: Interval, window: Interval): Interval | null {
  const s = Math.max(value[0], window[0]), e = Math.min(value[1], window[1]);
  return e > s ? [s, e] : null;
}
export function unionIntervals(values: readonly Interval[]) {
  const merged: [number, number][] = [];
  let overlappingCount = 0;
  for (const [s, e] of [...values].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = merged.at(-1);
    if (last && s <= last[1]) { if (s < last[1]) overlappingCount++; last[1] = Math.max(last[1], e); }
    else merged.push([s, e]);
  }
  return { intervals: merged, overlappingCount, milliseconds: merged.reduce((n, [s, e]) => n + BigInt(e - s), 0n) };
}
export function decimalRatio(value: bigint, divisor: bigint): string {
  return new Decimal(value.toString()).div(divisor.toString()).toDecimalPlaces(4).toFixed();
}
export function durationFields(name: string, value: bigint | null): Record<string, string | null> {
  return { [`${name}Milliseconds`]: value === null ? null : String(value),
    [`${name}Minutes`]: value === null ? null : decimalRatio(value, 60000n),
    [`${name}Hours`]: value === null ? null : decimalRatio(value, 3600000n) };
}
