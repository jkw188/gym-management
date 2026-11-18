import assert from 'node:assert/strict';
import { Db, Document } from 'mongodb';

const id = (value: unknown) => String(value);
const amount = (value: unknown) => { const text = String(value); assert.match(text, /^\d+$/); return BigInt(text); };
export interface ReturnSources { returns: Document[]; items: Document[]; orderItems: Document[]; refunds: Document[]; payments: Document[]; movements: Document[] }
// Independent source invariants: do not call writer migration/integrity methods as expected results.
export function assertReturnSources(rows: ReturnSources) {
  for (const line of rows.orderItems) {
    const returned = rows.items.filter(item => id(item.order_item_id) === id(line._id)).reduce((sum, item) => sum + item.quantity, 0);
    assert.ok(returned <= line.quantity, 'EN08_RETURN_QUANTITY_EXCEEDS_DELIVERED');
  }
  for (const item of rows.items) {
    const line = rows.orderItems.find(line => id(line._id) === id(item.order_item_id)), source = rows.returns.find(r => id(r._id) === id(item.return_id));
    assert.ok(line && source && id(line.order_id) === id(source.order_id), 'EN08_ORPHAN_RETURN_ITEM');
    assert.equal(amount(item.line_refund_amount), amount(item.unit_price_snapshot) * BigInt(item.quantity), 'EN08_RETURN_SNAPSHOT_AMOUNT');
    const movements = rows.movements.filter(m => id(m.return_item_id) === id(item._id));
    assert.equal(movements.length, item.restockable ? 1 : 0, 'EN08_RETURN_RESTOCK_COUNT');
    for (const movement of movements) {
      assert.equal(movement.kind, 'RETURN_RECEIVE'); assert.equal(id(movement.source_id), id(source._id));
      assert.equal(movement.on_hand_delta, item.quantity); assert.equal(movement.reserved_delta, 0);
    }
  }
  for (const source of rows.returns) {
    const sum = rows.items.filter(item => id(item.return_id) === id(source._id)).reduce((sum, item) => sum + amount(item.line_refund_amount), 0n);
    assert.equal(sum, amount(source.amount_snapshot), 'EN08_RETURN_DOCUMENT_AMOUNT');
    const obligations = rows.refunds.filter(r => id(r.return_id) === id(source._id));
    assert.equal(obligations.length, sum === 0n ? 0 : 1, 'EN08_RETURN_OBLIGATION_COUNT');
    if (obligations.length) assert.equal(amount(obligations[0].amount), sum, 'EN08_RETURN_OBLIGATION_AMOUNT');
  }
  for (const payment of rows.payments) {
    const obligations = rows.refunds.filter(r => id(r.payment_id) === id(payment._id));
    const total = obligations.reduce((sum, r) => sum + amount(r.amount), 0n);
    assert.ok(total <= amount(payment.amount), 'EN08_REFUND_BUDGET_INCLUDES_FAILED');
    assert.ok(obligations.filter(r => r.status === 'SUCCEEDED').reduce((sum, r) => sum + amount(r.amount), 0n) <= amount(payment.amount), 'EN08_PAYOUT_EXCEEDS_PAYMENT');
  }
  for (const refund of rows.refunds) assert.ok(rows.payments.some(p => id(p._id) === id(refund.payment_id) && p.status === 'SUCCEEDED'), 'EN08_ORPHAN_REFUND_PAYMENT');
  return { invariants: 'PASS', returnIds: rows.returns.map(r => id(r._id)), refundIds: rows.refunds.map(r => id(r._id)), paymentIds: rows.payments.map(p => id(p._id)) };
}
export async function inspectReturnSources(db: Db) {
  const names = ['returns', 'return_items', 'order_items', 'refunds', 'payments', 'stock_movements'];
  const session = db.client.startSession();
  try {
    return await session.withTransaction(async () => {
      const rows: Document[][] = [];
      for (const name of names) rows.push(await db.collection(name).find({}, { session }).sort({ _id: 1 }).toArray());
      return assertReturnSources({ returns: rows[0], items: rows[1], orderItems: rows[2], refunds: rows[3], payments: rows[4], movements: rows[5] });
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
  } finally { await session.endSession(); }
}
