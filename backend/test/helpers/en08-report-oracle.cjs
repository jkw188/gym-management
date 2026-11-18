// EN-08-O01: intentionally independent of application services, pipelines and money/date helpers.
const assert = require('node:assert/strict');
const METRIC_VERSION = 'S08-V1';
function instant(value) {
  assert.equal(typeof value, 'string', 'ORACLE_TIMESTAMP_REQUIRED');
  assert.match(value, /(?:Z|[+-]\d{2}:\d{2})$/, 'ORACLE_TIMEZONE_REQUIRED');
  const result = Date.parse(value);
  assert.ok(Number.isFinite(result), 'ORACLE_INVALID_TIMESTAMP');
  return result;
}
function dayStart(value) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
  const result = instant(`${value}T00:00:00+07:00`);
  assert.equal(new Date(result + 7 * 3600000).toISOString().slice(0, 10), value, 'ORACLE_INVALID_DATE');
  return result;
}
function window(fromDate, toDate, observedAt) {
  const start = dayStart(fromDate), end = dayStart(toDate) + 86400000;
  assert.ok(start < end && end - start <= 366 * 86400000, 'ORACLE_INVALID_RANGE');
  const today = new Date(instant(observedAt) + 7 * 3600000).toISOString().slice(0, 10);
  assert.ok(toDate <= today, 'ORACLE_FUTURE_RANGE');
  return { start, end: Math.min(end, instant(observedAt)) };
}
const money = value => { assert.match(String(value), /^\d+$/, 'ORACLE_INTEGER_VND_REQUIRED'); return BigInt(value); };
const ratio = (n, d) => d === 0 ? null : 100 * n / d;
const unique = rows => {
  assert.equal(new Set(rows.map(row => String(row._id))).size, rows.length, 'ORACLE_DUPLICATE_SOURCE_ID');
  return rows;
};
function membershipOracle(source, asOfAt, observedAt, kind = 'ALL') {
  const at = instant(asOfAt); assert.ok(at <= instant(observedAt), 'ORACLE_FUTURE_AS_OF');
  assert.ok(['ALL', 'GYM', 'PT'].includes(kind));
  const members = unique(source.members).filter(row => instant(row.created_at) <= at);
  const qualifying = [], issues = [];
  for (const row of unique(source.memberships)) {
    const sale = source.service_sales.find(s => s._id === row.service_sale_id);
    const transaction = sale && source.transactions.find(t => t._id === sale.transaction_id);
    if (!sale || !transaction) { issues.push(row._id); continue; }
    if (!members.some(member => member._id === sale.member_id) || !['GYM', 'PT'].includes(transaction.kind) || transaction.status !== 'SETTLED') continue;
    if (!transaction.settled_at || !row.created_at || row.status === 'SUPERSEDED' && !row.superseded_at || row.status === 'CANCELLED' && !row.cancelled_at) {
      issues.push(row._id); continue;
    }
    const start = Math.max(dayStart(sale.start_date), instant(transaction.settled_at), instant(row.created_at));
    const end = Math.min(dayStart(sale.end_date) + 86400000,
      row.superseded_at ? instant(row.superseded_at) : Infinity, row.cancelled_at ? instant(row.cancelled_at) : Infinity);
    if (start <= at && at < end && (kind === 'ALL' || kind === transaction.kind)) qualifying.push({ membershipId: row._id, memberId: sale.member_id, kind: transaction.kind });
  }
  const ids = [...new Set(qualifying.map(row => row.memberId))].sort();
  return { metricVersion: METRIC_VERSION, asOfAt, observedAt, totalMembers: members.length,
    activeMembers: issues.length ? null : ids.length, inactiveMembers: issues.length ? null : members.length - ids.length,
    activeRate: issues.length ? null : ratio(ids.length, members.length), activeMemberships: issues.length ? null : qualifying.length,
    knownActiveMemberIds: ids, qualifying, dataQuality: issues.length ? 'PARTIAL' : 'COMPLETE', invalidSourceIds: issues };
}
function cashOracle(source, fromDate, toDate, observedAt) {
  const range = window(fromDate, toDate, observedAt), receipts = [], payouts = [], issues = [];
  const groups = Object.fromEntries(['GYM', 'PT', 'RETAIL'].map(kind => [kind, { gross: 0n, refunded: 0n }]));
  let outstanding = 0n;
  const belongs = value => { const t = instant(value); return t >= range.start && t < dayStart(toDate) + 86400000 && t <= instant(observedAt); };
  for (const row of unique(source.payments)) {
    if (row.status !== 'SUCCEEDED') continue;
    const transaction = source.transactions.find(t => t._id === row.transaction_id);
    if (!transaction || !groups[transaction.kind] || !row.paid_at || !row.method) { issues.push(row._id); continue; }
    if (belongs(row.paid_at)) { groups[transaction.kind].gross += money(row.amount); receipts.push(row._id); }
  }
  for (const row of unique(source.refunds)) {
    const payment = source.payments.find(p => p._id === row.payment_id && p.status === 'SUCCEEDED');
    const transaction = payment && source.transactions.find(t => t._id === payment.transaction_id);
    if (!transaction || !groups[transaction.kind]) { issues.push(row._id); continue; }
    if (['PENDING', 'FAILED'].includes(row.status)) { outstanding += money(row.amount); continue; }
    if (row.status !== 'SUCCEEDED') continue;
    if (!row.refunded_at || !row.method) { issues.push(row._id); continue; }
    if (belongs(row.refunded_at)) { groups[transaction.kind].refunded += money(row.amount); payouts.push(row._id); }
  }
  const gross = Object.values(groups).reduce((s, g) => s + g.gross, 0n), refunded = Object.values(groups).reduce((s, g) => s + g.refunded, 0n);
  return { metricVersion: METRIC_VERSION, observedAt, fromDate, toDate,
    grossReceipts: issues.length ? null : String(gross), refundPaid: issues.length ? null : String(refunded), netCash: issues.length ? null : String(gross - refunded),
    knownTotals: { grossReceipts: String(gross), refundPaid: String(refunded), netCash: String(gross - refunded) },
    outstandingRefundAmount: String(outstanding), receiptIds: receipts.sort(), payoutIds: payouts.sort(),
    byKind: Object.fromEntries(Object.entries(groups).map(([kind, g]) => [kind, { gross: String(g.gross), refunded: String(g.refunded), net: String(g.gross - g.refunded) }])),
    dataQuality: issues.length ? 'PARTIAL' : 'COMPLETE', invalidSourceIds: issues };
}
function clip(row, range) {
  const start = Math.max(instant(row.start_at), range.start), end = Math.min(instant(row.end_at), range.end);
  assert.ok(instant(row.end_at) > instant(row.start_at), 'ORACLE_INVALID_INTERVAL');
  return end > start ? [start, end] : null;
}
function union(intervals) {
  const sorted = intervals.filter(Boolean).sort((a, b) => a[0] - b[0]);
  const result = []; let overlapCount = 0;
  for (const [start, end] of sorted) {
    const last = result.at(-1);
    if (last && start <= last[1]) { if (start < last[1]) overlapCount++; last[1] = Math.max(last[1], end); }
    else result.push([start, end]);
  }
  return { intervals: result, milliseconds: result.reduce((sum, [s, e]) => sum + e - s, 0), overlapCount };
}
function trainerOracle(source, fromDate, toDate, observedAt) {
  const range = window(fromDate, toDate, observedAt);
  const rows = unique(source.trainers).map(trainer => {
    const shifts = unique(source.work_shifts).filter(s => s.trainer_id === trainer._id && ['CONFIRMED', 'COMPLETED'].includes(s.status) && clip(s, range));
    const bookings = unique(source.pt_bookings).filter(b => b.trainer_id === trainer._id && b.status === 'COMPLETED' && clip(b, range));
    const planned = union(shifts.map(s => clip(s, range))), completed = union(bookings.map(b => clip(b, range)));
    const issues = bookings.filter(b => !shifts.some(s => s._id === b.shift_id && instant(s.start_at) <= instant(b.start_at) && instant(b.end_at) <= instant(s.end_at))).map(b => b._id);
    let missingCount = 0, openCount = 0; const actual = [];
    for (const shift of shifts) {
      const attendance = source.trainer_attendance.filter(a => a.shift_id === shift._id);
      assert.ok(attendance.length <= 1, 'ORACLE_DUPLICATE_ATTENDANCE');
      if (!attendance.length) { missingCount++; continue; }
      const a = attendance[0];
      // Source schema has no OPEN/CLOSED field: state is derived from check_out_at.
      if (!a.check_in_at) { missingCount++; issues.push(a._id); continue; }
      if (!a.check_out_at) { openCount++; continue; }
      actual.push(clip({ start_at: a.check_in_at, end_at: a.check_out_at }, range));
    }
    const reviews = unique(source.trainer_reviews).filter(r => r.trainer_id === trainer._id && instant(r.created_at) >= range.start && instant(r.created_at) < range.end);
    const known = union(actual).milliseconds;
    return { trainerId: trainer._id, plannedMilliseconds: String(planned.milliseconds), completedBookingMilliseconds: String(completed.milliseconds),
      completedShiftMilliseconds: String(union(shifts.filter(s => s.status === 'COMPLETED').map(s => clip(s, range))).milliseconds),
      knownActualMilliseconds: String(known), actualTotalMilliseconds: missingCount || openCount || issues.length ? null : String(known),
      completedBookingCount: bookings.length, missingCount, openCount, overlappingShiftCount: planned.overlapCount, overlappingBookingCount: completed.overlapCount,
      utilizationRate: issues.length || planned.overlapCount || completed.overlapCount ? null : ratio(completed.milliseconds, planned.milliseconds),
      reviewCount: reviews.length, averageRating: reviews.length ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : null,
      sourceIds: { shifts: shifts.map(s => s._id), bookings: bookings.map(b => b._id), reviews: reviews.map(r => r._id) }, invalidSourceIds: issues };
  });
  const sum = key => rows.reduce((n, row) => n + BigInt(row[key]), 0n);
  const planned = sum('plannedMilliseconds'), completed = sum('completedBookingMilliseconds');
  return { metricVersion: METRIC_VERSION, observedAt, fromDate, toDate, rows,
    totals: { plannedMilliseconds: String(planned), completedBookingMilliseconds: String(completed),
      utilizationRate: rows.some(r => r.invalidSourceIds.length || r.overlappingShiftCount || r.overlappingBookingCount) ? null : ratio(Number(completed), Number(planned)) } };
}
// Compare explicitly selected contract fields; never use actual to calculate expected.
function compareMetrics(expected, actual, context) {
  const differences = [];
  function visit(e, a, field) {
    if (e !== null && typeof e === 'object' && !Array.isArray(e)) for (const [key, value] of Object.entries(e)) visit(value, a?.[key], field ? `${field}.${key}` : key);
    else if (JSON.stringify(e) !== JSON.stringify(a)) differences.push({ field, expected: e, actual: a === undefined ? null : a,
      difference: typeof e === 'string' && /^-?\d+$/.test(e) && typeof a === 'string' && /^-?\d+$/.test(a) ? String(BigInt(a) - BigInt(e)) : null });
  }
  visit(expected, actual, '');
  return { ...context, metricVersion: METRIC_VERSION, status: differences.length ? 'FAIL' : 'PASS', differences };
}
module.exports = { membershipOracle, cashOracle, trainerOracle, compareMetrics, window, union };
