// Reference oracle tests only. Report API comparisons remain BLOCKED until US-50/51/52 exist.
const oracle = require('./helpers/en08-report-oracle.cjs');
const fixture = require('./fixtures/en08-reports.cjs');

describe('EN-08 independent reference oracle (not report API acceptance)', () => {
  it('O02 distinct members, free SETTLED, unlinked/locked and quota exhausted do not change entitlement', () => {
    const result = oracle.membershipOracle(fixture.members, '2026-11-02T12:00:00+07:00', fixture.observedAt);
    expect(result).toMatchObject(fixture.expected.memberships);
    expect(result.knownActiveMemberIds).toEqual(['test_member_a', 'test_member_b']);
    expect(oracle.membershipOracle(fixture.members, '2026-11-02T12:00:00+07:00', fixture.observedAt, 'PT')).toMatchObject({ totalMembers: 4, activeMembers: 1, activeMemberships: 1 });
  });
  it('O02 exact settlement and VN end-date boundaries; historical SUPERSEDED is not filtered out', () => {
    const source = structuredClone(fixture.members);
    source.memberships[0].status = 'SUPERSEDED'; source.memberships[0].superseded_at = '2026-11-02T10:30:00+07:00';
    const run = (at: string) => oracle.membershipOracle(source, at, '2026-12-01T12:00:00+07:00', 'GYM');
    expect(run('2026-11-01T02:59:59+07:00').activeMemberships).toBe(0);
    expect(run('2026-11-01T03:00:00+07:00').activeMemberships).toBe(2);
    expect(run('2026-11-02T10:29:59+07:00').activeMemberships).toBe(2);
    expect(run('2026-11-02T10:30:00+07:00').activeMemberships).toBe(1);
    expect(run('2026-11-30T23:59:59+07:00').activeMemberships).toBe(1);
    expect(run('2026-12-01T00:00:00+07:00').activeMemberships).toBe(0);
  });
  it('O02 missing history produces partial/null; empty denominator is null; invalid input fails', () => {
    const source = structuredClone(fixture.members); delete source.transactions[0].settled_at;
    expect(oracle.membershipOracle(source, fixture.observedAt, fixture.observedAt)).toMatchObject({ dataQuality: 'PARTIAL', activeMembers: null, activeRate: null });
    expect(oracle.membershipOracle({ members: [], memberships: [] }, fixture.observedAt, fixture.observedAt).activeRate).toBeNull();
    expect(() => oracle.membershipOracle(fixture.members, '2026-11-07T00:00:00Z', fixture.observedAt)).toThrow();
    expect(() => oracle.window('2026-02-30', '2026-03-01', fixture.observedAt)).toThrow();
    expect(() => oracle.membershipOracle(fixture.members, '2026-11-02T12:00:00', fixture.observedAt)).toThrow();
  });
  it('O03 includes cancelled late receipts, cross-period refund, separates outstanding and ignores invoices/credits', () => {
    expect(oracle.cashOracle(fixture.cash, '2026-11-01', '2026-11-03', fixture.observedAt)).toMatchObject(fixture.expected.cash);
    expect(oracle.cashOracle(fixture.cash, '2026-11-04', '2026-11-04', fixture.observedAt)).toMatchObject({ grossReceipts: '0', refundPaid: '300000', netCash: '-300000', outstandingRefundAmount: '70000' });
  });
  it('O03 bigint sum exceeds safe Number and paid_at controls period instead of verified_at', () => {
    const source = structuredClone(fixture.cash); source.refunds = [];
    source.payments = Array.from({ length: 10000 }, (_, i) => ({ ...fixture.cash.payments[0], _id: `test_big_${i}`, amount: '999999999999' }));
    expect(oracle.cashOracle(source, '2026-11-01', '2026-11-01', fixture.observedAt).grossReceipts).toBe('9999999999990000');
    expect(oracle.cashOracle(source, '2026-11-05', '2026-11-05', fixture.observedAt).grossReceipts).toBe('0');
  });
  it('O03 unknown source produces null KPIs and known totals, and events at observedAt are included', () => {
    const source = structuredClone(fixture.cash); delete source.payments[0].paid_at;
    expect(oracle.cashOracle(source, '2026-11-01', '2026-11-03', fixture.observedAt)).toMatchObject({ dataQuality: 'PARTIAL', grossReceipts: null,
      netCash: null, knownTotals: { grossReceipts: '1000000', refundPaid: '100000', netCash: '900000' } });
    expect(oracle.cashOracle(fixture.cash, '2026-11-01', '2026-11-01', fixture.cash.payments[0].paid_at).grossReceipts).toBe('1000000');
  });
  it('O04 independent planned/completed/actual/review sources preserve OPEN attendance as null', () => {
    expect(oracle.trainerOracle(fixture.trainers, '2026-11-02', '2026-11-02', fixture.observedAt).rows[0]).toMatchObject(fixture.expected.trainer);
  });
  it('O04 clips boundary intervals separately per trainer and weights utilization (1/1 + 0/3 = 25%)', () => {
    const source = structuredClone(fixture.trainers); source.trainers.push({ _id: 'test_trainer_b' });
    source.work_shifts = [
      { _id: 's1', trainer_id: 'test_trainer_a', status: 'CONFIRMED', start_at: '2026-10-31T23:00:00+07:00', end_at: '2026-11-01T01:00:00+07:00' },
      { _id: 's2', trainer_id: 'test_trainer_b', status: 'CONFIRMED', start_at: '2026-11-01T00:00:00+07:00', end_at: '2026-11-01T03:00:00+07:00' },
    ];
    source.pt_bookings = [{ ...source.work_shifts[0], _id: 'b1', shift_id: 's1', status: 'COMPLETED' }];
    source.trainer_attendance = []; source.trainer_reviews = [];
    const result = oracle.trainerOracle(source, '2026-11-01', '2026-11-01', fixture.observedAt);
    expect(result.totals).toEqual({ plannedMilliseconds: '14400000', completedBookingMilliseconds: '3600000', utilizationRate: 25 });
    expect(result.rows[0].actualTotalMilliseconds).toBeNull();
    expect(result.rows[1].averageRating).toBeNull();
  });
  it('O04 union does not hide overlap; outside-shift source makes rate null; future duration clipped', () => {
    expect(oracle.union([[0, 60], [30, 90], [90, 120]])).toEqual({ intervals: [[0, 120]], milliseconds: 120, overlapCount: 1 });
    const source = structuredClone(fixture.trainers); source.work_shifts.push({ ...source.work_shifts[0], _id: 'test_overlap' });
    expect(oracle.trainerOracle(source, '2026-11-02', '2026-11-02', fixture.observedAt).rows[0]).toMatchObject({ overlappingShiftCount: 1, utilizationRate: null });
    expect(oracle.window('2026-11-02', '2026-11-02', '2026-11-02T10:30:00+07:00').end).toBe(Date.parse('2026-11-02T10:30:00+07:00'));
  });
  it('O01 discrepancy retains source IDs, range, timestamps, expected/actual and signed difference', () => {
    const context = { sourceIds: ['test_payment_late'], fromDate: '2026-11-01', toDate: '2026-11-03', observedAt: fixture.observedAt };
    expect(oracle.compareMetrics({ netCash: '1900000' }, { netCash: '2000000' }, context)).toEqual({ ...context, metricVersion: 'S08-V1', status: 'FAIL',
      differences: [{ field: 'netCash', expected: '1900000', actual: '2000000', difference: '100000' }] });
    expect(oracle.compareMetrics({ actual: null }, {}, context).status).toBe('FAIL');
    expect(oracle.compareMetrics(fixture.expected.cash, oracle.cashOracle(fixture.cash, '2026-11-01', '2026-11-03', fixture.observedAt), context).status).toBe('PASS');
  });
});

export {};
