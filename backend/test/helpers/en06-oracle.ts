import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Db, Document, MongoClient } from 'mongodb';

export const COLLECTIONS = ['products', 'inventory', 'stock_documents', 'stock_document_items', 'stock_document_events',
  'stock_movements', 'orders', 'order_items', 'order_events', 'cart_states', 'cart_items', 'transactions', 'service_sales',
  'memberships', 'payments', 'invoices', 'refunds', 'operation_requests', 'notifications', 'notification_recipients', 'notification_outbox'] as const;
export type Rows = Record<typeof COLLECTIONS[number], Document[]>;
const id = (value: unknown) => String(value);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function money(value: unknown): bigint {
  const text = String(value);
  assert.match(text, /^\d{1,12}$/, 'MONEY_NOT_INTEGER_VND');
  return BigInt(text);
}
function unique(rows: Document[], key: (row: Document) => string, message: string) {
  assert.equal(new Set(rows.map(key)).size, rows.length, message);
}

// Independent committed-data oracle, not HTTP success counts or the writer's own checks.
export function assertCommittedRows(rows: Rows) {
  const byId = (name: typeof COLLECTIONS[number], value: unknown) => rows[name].find(row => id(row._id) === id(value));
  unique(rows.inventory, row => id(row.product_id), 'DUPLICATE_INVENTORY');
  unique(rows.stock_movements, row => String(row.event_key), 'DUPLICATE_MOVEMENT_EVENT');
  unique(rows.stock_movements, row => `${row.product_id}:${row.sequence}`, 'DUPLICATE_SEQUENCE');
  unique(rows.operation_requests, row => `${row.actor_id}:${row.operation}:${row.client_key}`, 'DUPLICATE_OPERATION');
  for (const balance of rows.inventory) {
    assert.ok(byId('products', balance.product_id), 'ORPHAN_INVENTORY');
    assert.ok([balance.on_hand, balance.reserved, balance.version].every(value => Number.isInteger(value) && value >= 0 && value <= 2147483647), 'INVALID_BALANCE');
    assert.ok(balance.reserved <= balance.on_hand, 'OVERSELL');
    let hand = 0, reserved = 0, sequence = 0;
    for (const movement of rows.stock_movements.filter(row => id(row.product_id) === id(balance.product_id)).sort((a, b) => a.sequence - b.sequence)) {
      assert.equal(movement.sequence, ++sequence, 'SEQUENCE_GAP');
      assert.equal(movement.before_on_hand, hand, 'HAND_CHAIN');
      assert.equal(movement.before_reserved, reserved, 'RESERVED_CHAIN');
      hand += movement.on_hand_delta; reserved += movement.reserved_delta;
      assert.equal(movement.after_on_hand, hand, 'HAND_DELTA');
      assert.equal(movement.after_reserved, reserved, 'RESERVED_DELTA');
      assert.ok(reserved >= 0 && hand >= reserved, 'MOVEMENT_OVERSELL');
      if (movement.kind === 'RECEIPT_POST') {
        const source = byId('stock_documents', movement.source_id), item = byId('stock_document_items', movement.document_item_id);
        assert.equal(source?.status, 'POSTED', 'DRAFT_ADDED_STOCK');
        assert.equal(id(item?.document_id), id(source?._id), 'ORPHAN_RECEIPT_MOVEMENT');
        assert.equal(id(item?.product_id), id(balance.product_id), 'RECEIPT_PRODUCT');
        assert.equal(movement.on_hand_delta, item?.quantity_delta, 'RECEIPT_QUANTITY');
        assert.equal(movement.reserved_delta, 0, 'RECEIPT_RESERVED');
      }
    }
    assert.equal(balance.on_hand, hand, 'HAND_LEDGER_BALANCE');
    assert.equal(balance.reserved, reserved, 'RESERVED_LEDGER_BALANCE');
    assert.equal(balance.version, sequence, 'VERSION_SEQUENCE');
    const held = rows.order_items.filter(item => id(item.product_id) === id(balance.product_id) &&
      byId('orders', item.order_id)?.reservation_state === 'HELD').reduce((sum, item) => sum + item.quantity, 0);
    assert.equal(balance.reserved, held, 'HELD_RESERVATION_TOTAL');
  }
  for (const movement of rows.stock_movements) assert.ok(rows.inventory.some(row => id(row.product_id) === id(movement.product_id)), 'ORPHAN_MOVEMENT');
  for (const item of rows.stock_document_items) assert.ok(byId('stock_documents', item.document_id) && byId('products', item.product_id), 'ORPHAN_STOCK_ITEM');
  for (const document of rows.stock_documents) {
    const items = rows.stock_document_items.filter(row => id(row.document_id) === id(document._id));
    const movements = rows.stock_movements.filter(row => id(row.source_id) === id(document._id));
    assert.equal(movements.length, document.status === 'POSTED' ? items.length : 0, 'RECEIPT_EFFECT_COUNT');
  }
  unique(rows.orders, row => id(row.transaction_id), 'DUPLICATE_ORDER_TRANSACTION');
  unique(rows.order_items, row => `${row.order_id}:${row.product_id}`, 'DUPLICATE_ORDER_PRODUCT');
  for (const item of rows.order_items) {
    const order = byId('orders', item.order_id);
    assert.ok(order && byId('products', item.product_id), 'ORPHAN_ORDER_ITEM');
    assert.equal(money(item.line_total), money(item.unit_price) * BigInt(item.quantity), 'LINE_TOTAL');
    const effects = rows.stock_movements.filter(row => id(row.order_item_id) === id(item._id));
    for (const kind of ['ORDER_RESERVE', 'ORDER_FULFILL', 'ORDER_RELEASE']) {
      const found = effects.filter(row => row.kind === kind);
      assert.equal(found.length, kind === 'ORDER_RESERVE' || kind === 'ORDER_FULFILL' && order.reservation_state === 'CONSUMED' ||
        kind === 'ORDER_RELEASE' && order.reservation_state === 'RELEASED' ? 1 : 0, 'ORDER_EFFECT_COUNT');
      for (const movement of found) {
        assert.equal(movement.event_key, `${kind}:${item._id}`, 'ORDER_EVENT_KEY');
        assert.equal(movement.on_hand_delta, kind === 'ORDER_FULFILL' ? -item.quantity : 0, 'ORDER_HAND_DELTA');
        assert.equal(movement.reserved_delta, kind === 'ORDER_RESERVE' ? item.quantity : -item.quantity, 'ORDER_RESERVED_DELTA');
      }
    }
  }
  for (const order of rows.orders) {
    const transaction = byId('transactions', order.transaction_id);
    assert.equal(transaction?.kind, 'RETAIL', 'ORPHAN_ORDER');
    const lines = rows.order_items.filter(row => id(row.order_id) === id(order._id));
    assert.ok(lines.length > 0, 'EMPTY_ORDER');
    assert.equal(lines.reduce((sum, line) => sum + money(line.line_total), 0n), money(transaction.amount_due), 'ORDER_TOTAL');
    assert.equal(new Date(order.reservation_expires_at).getTime() - new Date(order.created_at).getTime(), 86400000, 'HOLD_DEADLINE_CHANGED');
    if (order.status === 'COMPLETED') {
      assert.equal(order.reservation_state, 'CONSUMED', 'COMPLETED_NOT_CONSUMED');
      assert.equal(transaction.status, 'SETTLED', 'FULFILLED_UNPAID');
      assert.ok(new Date(order.fulfilled_at) < new Date(order.reservation_expires_at), 'FULFILLED_EXPIRED');
    } else if (order.status === 'CANCELLED') assert.equal(order.reservation_state, 'RELEASED', 'CANCELLED_NOT_RELEASED');
    else assert.equal(order.reservation_state, 'HELD', 'ACTIVE_NOT_HELD');
  }
  const succeeded = rows.payments.filter(row => row.status === 'SUCCEEDED');
  unique(rows.payments, row => String(row.reference), 'DUPLICATE_REFERENCE');
  unique(succeeded, row => id(row.transaction_id), 'DUPLICATE_SUCCEEDED_PAYMENT');
  unique(rows.invoices, row => id(row.transaction_id), 'DUPLICATE_INVOICE');
  unique(rows.refunds, row => id(row.payment_id), 'DUPLICATE_REFUND_PAYMENT');
  for (const payment of succeeded) {
    const transaction = byId('transactions', payment.transaction_id);
    assert.ok(transaction, 'ORPHAN_PAYMENT');
    assert.ok(money(payment.amount) > 0n, 'ZERO_PAYMENT');
    assert.equal(money(payment.amount), money(transaction.amount_due), 'PAYMENT_AMOUNT');
    if (transaction.status === 'CANCELLED') {
      assert.equal(rows.invoices.filter(row => id(row.transaction_id) === id(transaction._id)).length, 0, 'LATE_SALE_INVOICE');
      assert.equal(rows.refunds.filter(row => id(row.payment_id) === id(payment._id)).length, 1, 'LATE_REFUND_MISSING');
    } else assert.equal(transaction.status, 'SETTLED', 'PAYMENT_UNSETTLED');
  }
  for (const transaction of rows.transactions.filter(row => row.status === 'SETTLED')) {
    const invoices = rows.invoices.filter(row => id(row.transaction_id) === id(transaction._id));
    const payments = succeeded.filter(row => id(row.transaction_id) === id(transaction._id));
    assert.equal(invoices.length, 1, 'SETTLED_WITHOUT_INVOICE');
    assert.equal(payments.length, money(transaction.amount_due) === 0n ? 0 : 1, 'SETTLED_PAYMENT_COUNT');
    assert.equal(money(invoices[0].total_amount), money(transaction.amount_due), 'INVOICE_AMOUNT');
  }
  for (const invoice of rows.invoices) assert.ok(byId('transactions', invoice.transaction_id), 'ORPHAN_INVOICE');
  for (const refund of rows.refunds) {
    const payment = byId('payments', refund.payment_id);
    assert.equal(payment?.status, 'SUCCEEDED', 'ORPHAN_REFUND');
    assert.ok(money(refund.amount) > 0n && money(refund.amount) <= money(payment.amount), 'REFUND_AMOUNT');
    if (refund.status === 'PENDING') assert.ok(!refund.refunded_at, 'PENDING_REFUND_PAID');
  }
  unique(rows.notifications, row => String(row.event_key), 'DUPLICATE_NOTIFICATION');
  unique(rows.notification_recipients, row => `${row.notification_id}:${row.account_id}`, 'DUPLICATE_RECIPIENT');
  for (const name of ['notification_recipients', 'notification_outbox'] as const) {
    for (const row of rows[name]) assert.ok(byId('notifications', row.notification_id), 'ORPHAN_NOTIFICATION');
  }
  const gross = succeeded.reduce((sum, row) => sum + money(row.amount), 0n);
  const paidRefunds = rows.refunds.filter(row => row.status === 'SUCCEEDED').reduce((sum, row) => sum + money(row.amount), 0n);
  return { invariants: 'PASSED' as const, counts: Object.fromEntries(COLLECTIONS.map(name => [name, rows[name].length])),
    inventory: rows.inventory.map(row => ({ productId: id(row.product_id), onHand: row.on_hand, reserved: row.reserved, version: row.version })),
    ledger: rows.stock_movements.map(row => ({ id: id(row._id), productId: id(row.product_id), sourceId: id(row.source_id),
      documentItemId: row.document_item_id && id(row.document_item_id), orderItemId: row.order_item_id && id(row.order_item_id),
      eventKey: row.event_key, kind: row.kind, sequence: row.sequence, handDelta: row.on_hand_delta, reservedDelta: row.reserved_delta,
      beforeHand: row.before_on_hand, afterHand: row.after_on_hand, beforeReserved: row.before_reserved, afterReserved: row.after_reserved })),
    orders: rows.orders.map(row => ({ id: id(row._id), transactionId: id(row.transaction_id), channel: row.channel, status: row.status,
      reservationState: row.reservation_state, createdAt: row.created_at, expiresAt: row.reservation_expires_at, fulfilledAt: row.fulfilled_at, version: row.version })),
    orderItems: rows.order_items.map(row => ({ id: id(row._id), orderId: id(row.order_id), productId: id(row.product_id), quantity: row.quantity,
      unitPrice: String(row.unit_price), lineTotal: String(row.line_total) })),
    transactions: rows.transactions.map(row => ({ id: id(row._id), kind: row.kind, status: row.status, amount: String(row.amount_due), version: row.version })),
    payments: rows.payments.map(row => ({ id: id(row._id), transactionId: id(row.transaction_id), status: row.status,
      amount: String(row.amount), paidAt: row.paid_at, referenceHash: hash(row.reference) })),
    invoices: rows.invoices.map(row => ({ id: id(row._id), transactionId: id(row.transaction_id), totalAmount: String(row.total_amount), buyerHash: hash(row.buyer_snapshot) })),
    refunds: rows.refunds.map(row => ({ id: id(row._id), paymentId: id(row.payment_id), status: row.status, amount: String(row.amount) })),
    carts: rows.cart_states.map(row => ({ id: id(row._id), memberId: id(row.member_id), version: row.version,
      itemsHash: hash(rows.cart_items.filter(item => id(item.member_id) === id(row.member_id))) })),
    gross: String(gross), paidRefunds: String(paidRefunds), cash: String(gross - paidRefunds),
    // Hash complete documents for rollback/snapshot checks without logging contacts, bank references or tokens.
    hashes: Object.fromEntries(COLLECTIONS.map(name => [name, hash(rows[name])])) };
}

export async function inspectCommitted(db: Db, client: MongoClient) {
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      const rows = {} as Rows;
      for (const name of COLLECTIONS) rows[name] = await db.collection(name).find({}, { session }).sort({ _id: 1 }).toArray();
      const guardHashes: Record<string, string> = {};
      for (const name of ['security_state', 'catalog_state', 'schedule_guards', 'members', 'plans', 'notification_counters']) {
        guardHashes[name] = hash(await db.collection(name).find({}, { session }).sort({ _id: 1 }).toArray());
      }
      return { ...assertCommittedRows(rows), guardHashes };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', timeoutMS: 10000 });
  } finally { await session.endSession(); }
}
