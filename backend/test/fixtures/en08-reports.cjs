// DEMO ONLY, declarative source records. Not seeded business data or report acceptance evidence.
const observedAt = '2026-11-06T05:00:00.000Z';
const members = {
  members: ['a', 'b', 'c', 'd'].map(id => ({ _id: `test_member_${id}`, created_at: '2026-10-01T00:00:00+07:00' })),
  transactions: ['gym_a', 'pt_a', 'gym_b', 'pending_c'].map(id => ({ _id: `test_tx_${id}`, kind: id === 'pt_a' ? 'PT' : 'GYM',
    status: id === 'pending_c' ? 'PENDING' : 'SETTLED', settled_at: '2026-11-01T03:00:00+07:00' })),
  service_sales: ['gym_a', 'pt_a', 'gym_b', 'pending_c'].map(id => ({ _id: `test_sale_${id}`, transaction_id: `test_tx_${id}`,
    member_id: `test_member_${id.at(-1)}`, start_date: '2026-11-01', end_date: '2026-11-30' })),
  memberships: ['gym_a', 'pt_a', 'gym_b'].map(id => ({ _id: `test_membership_${id}`, service_sale_id: `test_sale_${id}`, status: 'ACTIVE',
    created_at: '2026-11-01T03:00:00+07:00', sessions_used: id === 'pt_a' ? 10 : 0 })),
};
const cash = {
  transactions: ['gym', 'pt', 'retail', 'late', 'old'].map(id => ({ _id: `test_tx_${id}`, kind: id === 'gym' ? 'GYM' : id === 'pt' ? 'PT' : 'RETAIL', status: id === 'late' ? 'CANCELLED' : 'SETTLED' })),
  payments: ['gym', 'pt', 'retail', 'late', 'old'].map((id, i) => ({ _id: `test_payment_${id}`, transaction_id: `test_tx_${id}`, status: 'SUCCEEDED',
    amount: ['1000000', '500000', '200000', '300000', '500000'][i], method: 'CASH', paid_at: `${id === 'old' ? '2026-10-20' : '2026-11-0' + (i === 0 ? 1 : i === 1 ? 2 : 3)}T10:00:00+07:00`,
    verified_at: '2026-11-05T10:00:00+07:00' })),
  refunds: [
    { _id: 'test_refund_old', payment_id: 'test_payment_old', amount: '100000', status: 'SUCCEEDED', method: 'TRANSFER', refunded_at: '2026-11-02T10:00:00+07:00' },
    { _id: 'test_refund_late', payment_id: 'test_payment_late', amount: '300000', status: 'SUCCEEDED', method: 'CASH', refunded_at: '2026-11-04T10:00:00+07:00' },
    { _id: 'test_refund_pending', payment_id: 'test_payment_old', amount: '50000', status: 'PENDING' },
    { _id: 'test_refund_failed', payment_id: 'test_payment_old', amount: '20000', status: 'FAILED' },
  ],
  invoices: [{ _id: 'test_invoice_zero', total_amount: '0' }], credits: [{ amount: '400000' }],
};
const trainers = {
  trainers: [{ _id: 'test_trainer_a' }],
  work_shifts: [8, 10].map(hour => ({ _id: `test_shift_${hour}`, trainer_id: 'test_trainer_a', status: 'CONFIRMED',
    start_at: `2026-11-02T${String(hour).padStart(2, '0')}:00:00+07:00`, end_at: `2026-11-02T${hour + 2}:00:00+07:00` })),
  pt_bookings: [8, 10].map(hour => ({ _id: `test_booking_${hour}`, shift_id: `test_shift_${hour}`, trainer_id: 'test_trainer_a', status: 'COMPLETED',
    start_at: `2026-11-02T${String(hour).padStart(2, '0')}:00:00+07:00`, end_at: `2026-11-02T${String(hour + 1).padStart(2, '0')}:00:00+07:00` })),
  trainer_attendance: [
    { _id: 'test_attendance_closed', shift_id: 'test_shift_8', check_in_at: '2026-11-02T07:50:00+07:00', check_out_at: '2026-11-02T10:10:00+07:00' },
    { _id: 'test_attendance_open', shift_id: 'test_shift_10', check_in_at: '2026-11-02T10:00:00+07:00' },
  ],
  trainer_reviews: [{ _id: 'test_review_outside_booking_period', trainer_id: 'test_trainer_a', booking_id: 'test_booking_october', created_at: '2026-11-02T13:00:00+07:00', rating: 4 }],
};
// Literal, hand-calculated expectations from EN-08 O02/O03/O04, never derived from actual responses.
const expected = {
  memberships: { totalMembers: 4, activeMembers: 2, inactiveMembers: 2, activeRate: 50, activeMemberships: 3, dataQuality: 'COMPLETE' },
  cash: { grossReceipts: '2000000', refundPaid: '100000', netCash: '1900000', outstandingRefundAmount: '70000',
    byKind: { GYM: { net: '1000000' }, PT: { net: '500000' }, RETAIL: { net: '400000' } } },
  trainer: { plannedMilliseconds: '14400000', completedBookingMilliseconds: '7200000', completedShiftMilliseconds: '0',
    knownActualMilliseconds: '8400000', actualTotalMilliseconds: null, utilizationRate: 50, completedBookingCount: 2, openCount: 1, reviewCount: 1, averageRating: 4 },
};
module.exports = { observedAt, members, cash, trainers, expected };
