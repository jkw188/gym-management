import { Decimal128, ObjectId } from 'mongodb';
import { assertCommittedRows, COLLECTIONS, Rows } from './helpers/en06-oracle';

// Negative self-tests for the oracle. These are not evidence of concurrent writer safety.
const empty = () => Object.fromEntries(COLLECTIONS.map(name => [name, []])) as unknown as Rows;
describe('EN06 independent oracle rejects broken committed invariants', () => {
  it('rejects unexplained reserved stock even when the ledger balances', () => {
    const rows = empty(), product = new ObjectId(); rows.products.push({ _id: product });
    rows.inventory.push({ product_id: product, on_hand: 1, reserved: 1, version: 1 });
    rows.stock_movements.push({ product_id: product, sequence: 1, event_key: 'opening', before_on_hand: 0, before_reserved: 0,
      on_hand_delta: 1, reserved_delta: 1, after_on_hand: 1, after_reserved: 1 });
    expect(() => assertCommittedRows(rows)).toThrow('HELD_RESERVATION_TOTAL');
  });
  it('rejects non-contiguous ledger sequence and missing sources', () => {
    const rows = empty(), product = new ObjectId(); rows.products.push({ _id: product });
    rows.inventory.push({ product_id: product, on_hand: 1, reserved: 0, version: 2 });
    rows.stock_movements.push({ product_id: product, sequence: 2, event_key: 'opening' });
    expect(() => assertCommittedRows(rows)).toThrow('SEQUENCE_GAP');
    rows.stock_movements[0] = { product_id: product, sequence: 1, event_key: 'orphan', before_on_hand: 0, before_reserved: 0,
      on_hand_delta: 1, reserved_delta: 0, after_on_hand: 1, after_reserved: 0, kind: 'RECEIPT_POST' };
    expect(() => assertCommittedRows(rows)).toThrow('DRAFT_ADDED_STOCK');
  });
  it('rejects successful zero payment or duplicate successful receipts', () => {
    const rows = empty(), transaction = new ObjectId();
    rows.transactions.push({ _id: transaction, amount_due: Decimal128.fromString('0'), status: 'SETTLED' });
    rows.payments.push({ transaction_id: transaction, amount: Decimal128.fromString('0'), status: 'SUCCEEDED', reference: 'FIXTURE:0' });
    expect(() => assertCommittedRows(rows)).toThrow('ZERO_PAYMENT');
    rows.payments.push({ ...rows.payments[0], reference: 'FIXTURE:1' });
    expect(() => assertCommittedRows(rows)).toThrow('DUPLICATE_SUCCEEDED_PAYMENT');
  });
  it('counts late cash on cancelled transactions and deducts only paid refunds', () => {
    const rows = empty(), transaction = new ObjectId(), payment = new ObjectId();
    rows.transactions.push({ _id: transaction, amount_due: Decimal128.fromString('300000'), status: 'CANCELLED' });
    rows.payments.push({ _id: payment, transaction_id: transaction, amount: Decimal128.fromString('300000'), status: 'SUCCEEDED', reference: 'FIXTURE:late' });
    rows.refunds.push({ payment_id: payment, amount: Decimal128.fromString('300000'), status: 'PENDING' });
    expect(assertCommittedRows(rows)).toMatchObject({ gross: '300000', paidRefunds: '0', cash: '300000' });
    rows.refunds[0].status = 'SUCCEEDED';
    expect(assertCommittedRows(rows)).toMatchObject({ gross: '300000', paidRefunds: '300000', cash: '0' });
  });
});
