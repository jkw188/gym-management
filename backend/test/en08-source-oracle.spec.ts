import { assertReturnSources, ReturnSources } from './helpers/en08-source-oracle';

function fixture(): ReturnSources {
  return { returns: [{ _id: 'return', order_id: 'order', amount_snapshot: '9000' }],
    items: [{ _id: 'item', order_item_id: 'line', return_id: 'return', quantity: 1, unit_price_snapshot: '9000', line_refund_amount: '9000', restockable: true }],
    orderItems: [{ _id: 'line', order_id: 'order', quantity: 1 }],
    refunds: [{ _id: 'refund', return_id: 'return', payment_id: 'payment', amount: '9000', status: 'FAILED' }],
    payments: [{ _id: 'payment', amount: '9000', status: 'SUCCEEDED' }],
    movements: [{ _id: 'movement', source_id: 'return', return_item_id: 'item', kind: 'RETURN_RECEIVE', on_hand_delta: 1, reserved_delta: 0 }] };
}
describe('EN08 O05 committed return/stock/refund source oracle', () => {
  it('keeps failed obligation budget and traces restock to the actual return line', () => {
    expect(assertReturnSources(fixture())).toMatchObject({ invariants: 'PASS', returnIds: ['return'], paymentIds: ['payment'] });
  });
  it('rejects duplicate restock, excessive quantity, orphan source and mismatched snapshot', () => {
    const duplicate = fixture(); duplicate.movements.push({ ...duplicate.movements[0], _id: 'duplicate' }); expect(() => assertReturnSources(duplicate)).toThrow();
    const quantity = fixture(); quantity.items[0].quantity = 2; expect(() => assertReturnSources(quantity)).toThrow();
    const orphan = fixture(); orphan.items[0].return_id = 'foreign'; expect(() => assertReturnSources(orphan)).toThrow();
    const wrong = fixture(); wrong.returns[0].amount_snapshot = '1'; expect(() => assertReturnSources(wrong)).toThrow();
  });
  it('rejects budget overspend including FAILED and a damaged return that silently restocks', () => {
    const budget = fixture(); budget.refunds.push({ _id: 'other', payment_id: 'payment', amount: '1', status: 'PENDING' });
    expect(() => assertReturnSources(budget)).toThrow('EN08_REFUND_BUDGET_INCLUDES_FAILED');
    const damaged = fixture(); damaged.items[0].restockable = false;
    expect(() => assertReturnSources(damaged)).toThrow('EN08_RETURN_RESTOCK_COUNT');
  });
});
