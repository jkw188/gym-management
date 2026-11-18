import { ObjectId } from 'mongodb';
import { clipInterval, decimalRatio, durationFields, interval, Interval, reportRange, timestamp, unionIntervals } from './report-interval';
import { PerformanceSource, PerformanceSources } from './trainer-performance.repository';

const sourceId = (v: unknown) => v instanceof ObjectId ? v.toHexString() : null;
const iso = (v: unknown) => timestamp(v) === null ? null : (v as Date).toISOString();
const validShift = (s: PerformanceSource | undefined) => !!s && ['CONFIRMED', 'COMPLETED'].includes(String(s.status));
type Kind = 'shifts' | 'attendance' | 'bookings' | 'reviews';
export interface PerformanceDetailSource {
  id: string; trainerId: string | null; shiftId: string | null; bookingId: string | null; status: string | null;
  startAt: string | null; endAt: string | null; clippedStartAt: string | null; clippedEndAt: string | null;
  rawMilliseconds: string | null; clippedMilliseconds: string | null;
  rawMinutes: string | null; rawHours: string | null; clippedMinutes: string | null; clippedHours: string | null;
  completedAt: string | null; recordedAt: string | null; actorId: string | null; rating: number | null;
  sourceLink: string | null; dataIssue: string[];
}
function accumulator() {
  return { planned: 0n, completedShift: 0n, completedBooking: 0n, knownActual: 0n,
    shiftCount: 0, completedShiftCount: 0, completedBookingCount: 0, missingCount: 0, openCount: 0, closedCount: 0,
    invalidSourceCount: 0, overlappingShiftCount: 0, overlappingBookingCount: 0, reviewCount: 0, ratingSum: 0,
    distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } as Record<string, number>,
    badPlanned: false, badCompletedShift: false, badBooking: false, badActual: false, badReview: false, inconsistent: false,
    invalid: new Set<string>(), warnings: new Set<string>() };
}
type Metrics = ReturnType<typeof accumulator>;
function view(m: Metrics) {
  const warnings = [...m.warnings].sort();
  const dataQuality = m.badPlanned && !m.planned && m.badBooking && !m.completedBooking && m.badActual && !m.knownActual && m.badReview
    ? 'UNAVAILABLE' : warnings.length ? 'PARTIAL' : 'COMPLETE';
  return { ...durationFields('planned', m.badPlanned ? null : m.planned),
    ...durationFields('completedShift', m.badCompletedShift ? null : m.completedShift),
    ...durationFields('completedBooking', m.badBooking ? null : m.completedBooking),
    ...durationFields('knownPlanned', m.planned), ...durationFields('knownCompletedBooking', m.completedBooking),
    ...durationFields('knownActual', m.knownActual),
    ...durationFields('actualTotal', m.badActual || m.missingCount > 0 || m.openCount > 0 ? null : m.knownActual),
    shiftCount: m.badPlanned ? null : m.shiftCount, completedShiftCount: m.badCompletedShift ? null : m.completedShiftCount,
    completedBookingCount: m.badBooking ? null : m.completedBookingCount, knownCompletedBookingCount: m.completedBookingCount,
    missingCount: m.missingCount, openCount: m.openCount, closedCount: m.closedCount, invalidSourceCount: m.invalidSourceCount,
    overlappingShiftCount: m.overlappingShiftCount, overlappingBookingCount: m.overlappingBookingCount,
    utilizationRate: m.inconsistent || m.badPlanned || m.badBooking || !m.planned ? null : Number(decimalRatio(m.completedBooking * 100n, m.planned)),
    utilizationStatus: m.inconsistent || m.badPlanned || m.badBooking ? 'DATA_INCONSISTENT' : !m.planned ? 'NOT_APPLICABLE' : 'AVAILABLE',
    reviewCount: m.badReview ? null : m.reviewCount, knownReviewCount: m.reviewCount,
    averageRating: m.badReview || !m.reviewCount ? null : Number(decimalRatio(BigInt(m.ratingSum), BigInt(m.reviewCount))),
    ratingDistribution: m.badReview ? null : m.distribution, knownRatingDistribution: m.distribution, knownTotalsLabel: dataQuality, dataQuality,
    warningCodes: warnings, invalidRecordCount: m.invalid.size };
}

export function resolveTrainerPerformance(sources: PerformanceSources, range: ReturnType<typeof reportRange>, trainerId?: string) {
  const window: Interval = [Date.parse(range.start), Date.parse(range.effectiveTo)];
  const trainers = new Map(sources.trainers.map(t => [sourceId(t._id), t]));
  const accounts = new Map(sources.accounts.map(t => [sourceId(t._id), t]));
  const shifts = new Map([...sources.shifts, ...sources.linkedShifts].map(t => [sourceId(t._id), t]));
  const bookings = new Map(sources.linkedBookings.map(t => [sourceId(t._id), t]));
  const members = new Set(sources.members.map(t => sourceId(t._id)));
  const ids = new Set<string>(sources.trainers.map(t => String(t._id)));
  for (const s of [...sources.shifts, ...sources.attendance, ...sources.bookings, ...sources.reviews]) ids.add(sourceId(s.trainer_id) ?? 'MISSING_TRAINER_ID');
  const total = accumulator();
  const rows = [];
  for (const id of ids) {
    if (trainerId && id !== trainerId.toLowerCase()) continue;
    const m = accumulator(), trainer = trainers.get(id), account = accounts.get(sourceId(trainer?.account_id));
    const sourcePages: Record<Kind, PerformanceDetailSource[]> = { shifts: [], attendance: [], bookings: [], reviews: [] };
    const warn = (key: string, code: string, inconsistent = false) => {
      m.invalid.add(key); m.warnings.add(code); if (inconsistent) { m.inconsistent = true; m.warnings.add('DATA_INCONSISTENT'); }
    };
    if (!trainer) warn(`trainer:${id}`, 'TRAINER_MISSING', true);
    if (trainer && !account) warn(`trainer:${id}`, 'ACCOUNT_MISSING');
    const own = (values: PerformanceSource[]) => values.filter(s => (sourceId(s.trainer_id) ?? 'MISSING_TRAINER_ID') === id);
    function detail(s: PerformanceSource, kind: Kind, raw: Interval | null, codes: string[], status?: string) {
      const clipped = raw && clipInterval(raw, window);
      const shiftId = kind === 'shifts' ? sourceId(s._id) : sourceId(s.shift_id);
      const bookingId = kind === 'bookings' ? sourceId(s._id) : sourceId(s.booking_id);
      const rawMs = raw ? BigInt(raw[1]) - BigInt(raw[0]) : null;
      const clippedMs = raw ? clipped ? BigInt(clipped[1]) - BigInt(clipped[0]) : 0n : null;
      const sourceLink = (kind === 'shifts' || kind === 'attendance') && shiftId ? `/api/work-shifts/${shiftId}/attendance`
        : kind === 'bookings' && bookingId ? `/api/admin/pt-bookings/${bookingId}`
        : kind === 'reviews' && sourceId(s._id) ? `/api/admin/trainer-reviews/${sourceId(s._id)}` : null;
      const row: PerformanceDetailSource = { id: String(s._id), trainerId: sourceId(s.trainer_id), shiftId, bookingId,
        status: status ?? (typeof s.status === 'string' ? s.status : null),
        startAt: kind === 'attendance' ? iso(s.check_in_at) : kind === 'reviews' ? iso(s.created_at) : iso(s.start_at),
        endAt: kind === 'attendance' ? iso(s.check_out_at) : kind === 'reviews' ? null : iso(s.end_at),
        clippedStartAt: clipped ? new Date(clipped[0]).toISOString() : null, clippedEndAt: clipped ? new Date(clipped[1]).toISOString() : null,
        rawMilliseconds: rawMs === null ? null : String(rawMs), clippedMilliseconds: clippedMs === null ? null : String(clippedMs),
        rawMinutes: rawMs === null ? null : decimalRatio(rawMs, 60000n), rawHours: rawMs === null ? null : decimalRatio(rawMs, 3600000n),
        clippedMinutes: clippedMs === null ? null : decimalRatio(clippedMs, 60000n), clippedHours: clippedMs === null ? null : decimalRatio(clippedMs, 3600000n),
        completedAt: iso(s.completed_at), recordedAt: iso(s.created_at),
        actorId: sourceId(kind === 'bookings' ? s.completed_by : kind === 'attendance' ? s.recorded_by : s.created_by),
        rating: kind === 'reviews' && typeof s.rating === 'number' ? s.rating : null, sourceLink, dataIssue: codes };
      sourcePages[kind].push(row);
      for (const code of codes) warn(`${kind}:${row.id}`, code, kind === 'bookings' || kind === 'shifts');
      return clipped;
    }
    const planned: Interval[] = [], completedShifts: Interval[] = [], taught: Interval[] = [], actual: Interval[] = [];
    const selectedShifts = own(sources.shifts).filter(s => validShift(s) && (!interval(s.start_at, s.end_at) || clipInterval(interval(s.start_at, s.end_at)!, window)));
    for (const s of selectedShifts) {
      const raw = interval(s.start_at, s.end_at), codes: string[] = [];
      m.shiftCount++;
      if (s.status === 'COMPLETED') m.completedShiftCount++;
      if (!raw) { codes.push('SHIFT_INTERVAL_INVALID'); m.badPlanned = true; if (s.status === 'COMPLETED') m.badCompletedShift = true; }
      const clipped = detail(s, 'shifts', raw, codes);
      if (clipped) { planned.push(clipped); if (s.status === 'COMPLETED') completedShifts.push(clipped); }
      const attendance = sources.attendance.filter(a => sourceId(a.shift_id) === sourceId(s._id));
      if (!attendance.length) { m.missingCount++; m.warnings.add('ATTENDANCE_MISSING'); }
      if (attendance.length > 1) { m.badActual = true; warn(`shifts:${s._id}`, 'ATTENDANCE_DUPLICATE'); }
    }
    for (const s of own(sources.bookings)) {
      if (s.status !== 'COMPLETED') continue;
      const raw = interval(s.start_at, s.end_at);
      if (raw && !clipInterval(raw, window)) continue;
      const codes: string[] = [], shift = shifts.get(sourceId(s.shift_id)), shiftRaw = shift && interval(shift.start_at, shift.end_at);
      if (!raw) { codes.push('BOOKING_INTERVAL_INVALID'); m.badBooking = true; }
      else { m.completedBookingCount++; }
      if (!validShift(shift) || !shiftRaw || sourceId(shift?.trainer_id) !== id) codes.push('BOOKING_SHIFT_INVALID');
      else if (raw && (raw[0] < shiftRaw[0] || raw[1] > shiftRaw[1])) codes.push('BOOKING_OUTSIDE_SHIFT');
      if (!members.has(sourceId(s.member_id)) || !sourceId(s.member_id)) codes.push('BOOKING_MEMBER_MISSING');
      if (!iso(s.completed_at) || !sourceId(s.completed_by)) codes.push('BOOKING_COMPLETION_INVALID');
      const clipped = detail(s, 'bookings', raw, codes);
      if (clipped) taught.push(clipped);
    }
    // Keep actual time independent of shift time, including overtime across a period boundary.
    for (const s of sources.attendance) {
      const shift = shifts.get(sourceId(s.shift_id));
      const belongsToShift = selectedShifts.some(t => sourceId(t._id) === sourceId(s.shift_id));
      if ((sourceId(s.trainer_id) ?? 'MISSING_TRAINER_ID') !== id && !belongsToShift) continue;
      const raw = interval(s.check_in_at, s.check_out_at);
      const open = s.check_out_at === undefined || s.check_out_at === null;
      if (raw && !clipInterval(raw, window) && !belongsToShift) continue;
      if (open && !belongsToShift && validShift(shift)) continue;
      const codes: string[] = [];
      if (!validShift(shift) || !interval(shift?.start_at, shift?.end_at) || sourceId(shift?.trainer_id) !== id || sourceId(s.trainer_id) !== id)
        codes.push('ATTENDANCE_SOURCE_INVALID');
      if (timestamp(s.check_in_at) === null || (!open && !raw)) codes.push('ATTENDANCE_INTERVAL_INVALID');
      if (sources.attendance.filter(a => sourceId(a.shift_id) === sourceId(s.shift_id)).length > 1) codes.push('ATTENDANCE_DUPLICATE');
      const state = codes.length ? 'INVALID' : open ? 'OPEN' : 'CLOSED';
      const clipped = detail(s, 'attendance', raw, codes, state);
      if (codes.length) { m.invalidSourceCount++; m.badActual = true; }
      else if (open) { m.openCount++; m.warnings.add('ATTENDANCE_OPEN'); }
      else { m.closedCount++; if (clipped) actual.push(clipped); }
    }
    for (const s of own(sources.reviews)) {
      const at = timestamp(s.created_at);
      if (at !== null && (at < window[0] || at >= window[1])) continue;
      const codes: string[] = [], booking = bookings.get(sourceId(s.booking_id));
      if (at === null) { codes.push('REVIEW_TIMESTAMP_INVALID'); m.badReview = true; }
      const rating = s.rating;
      if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) { codes.push('REVIEW_RATING_INVALID'); m.badReview = true; }
      if (!booking || sourceId(booking.trainer_id) !== id || sourceId(booking.member_id) !== sourceId(s.member_id) || !members.has(sourceId(s.member_id)))
        codes.push('REVIEW_SOURCE_INVALID');
      if (at !== null) { m.reviewCount++; if (typeof rating === 'number' && Number.isInteger(rating) && rating >= 1 && rating <= 5) { m.ratingSum += rating; m.distribution[String(rating)]++; } }
      detail(s, 'reviews', null, codes, 'SUBMITTED');
    }
    const p = unionIntervals(planned), b = unionIntervals(taught);
    m.planned = p.milliseconds; m.completedBooking = b.milliseconds; m.completedShift = unionIntervals(completedShifts).milliseconds;
    m.knownActual = unionIntervals(actual).milliseconds;
    m.overlappingShiftCount = p.overlappingCount; m.overlappingBookingCount = b.overlappingCount;
    // Union is accounting only. Mark every implicated source so a reviewer can resolve overlaps.
    for (const [kind, code] of [['shifts', 'OVERLAPPING_SHIFTS'], ['bookings', 'OVERLAPPING_BOOKINGS']] as const) {
      const ordered = sourcePages[kind].filter(s => s.clippedStartAt && s.clippedEndAt).sort((a, b) => a.clippedStartAt!.localeCompare(b.clippedStartAt!));
      let active: PerformanceDetailSource[] = [];
      for (const row of ordered) {
        active = active.filter(s => s.clippedEndAt! > row.clippedStartAt!);
        if (active.length) for (const s of [...active, row]) {
          if (!s.dataIssue.includes(code)) s.dataIssue.push(code);
          warn(`${kind}:${s.id}`, code, true);
        }
        active.push(row);
      }
    }
    for (const kind of Object.keys(sourcePages) as Kind[]) sourcePages[kind].sort((a, b) => (b.startAt ?? '').localeCompare(a.startAt ?? '') || b.id.localeCompare(a.id));
    rows.push({ id, displayName: typeof account?.full_name === 'string' ? account.full_name : null,
      status: typeof trainer?.status === 'string' ? trainer.status : null, summary: view(m), sourcePages });
    for (const key of ['planned', 'completedShift', 'completedBooking', 'knownActual'] as const) total[key] += m[key];
    for (const key of ['shiftCount', 'completedShiftCount', 'completedBookingCount', 'missingCount', 'openCount', 'closedCount', 'invalidSourceCount',
      'overlappingShiftCount', 'overlappingBookingCount', 'reviewCount', 'ratingSum'] as const) total[key] += m[key];
    for (const key of ['badPlanned', 'badCompletedShift', 'badBooking', 'badActual', 'badReview', 'inconsistent'] as const) total[key] ||= m[key];
    for (const key of Object.keys(m.distribution)) total.distribution[key] += m.distribution[key];
    m.invalid.forEach(k => total.invalid.add(k)); m.warnings.forEach(k => total.warnings.add(k));
  }
  rows.sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? '', 'vi') || a.id.localeCompare(b.id));
  return { rows, totals: view(total) };
}
