import { ClientSession, Db, Long, ObjectId } from 'mongodb';
import { Connection } from 'mongoose';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { StockMovement } from '../stock/stock.schema';

interface Balance { product_id: ObjectId; on_hand: number; reserved: number; version: number }
const max = 2147483647;
const unsigned = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;
export const validInventoryBalance = (row: Omit<Balance, 'product_id'> | null | undefined): boolean => Boolean(row &&
  [row.on_hand, row.reserved, row.version].every(unsigned) && row.reserved <= row.on_hand);

// Read-only oracle, shared by the operational report and the writer after acquiring the inventory lock.
// A nonzero legacy balance without a proven opening ledger is rejected, never silently treated as zero.
export async function inspectInventoryLedger(db: Db, balance: Balance, session: ClientSession): Promise<string[]> {
  const issues = new Set<string>();
  if (!validInventoryBalance(balance)) issues.add('INVALID_BALANCE');
  let sequence = 0, hand = 0, reserved = 0;
  const eventKeys = new Set<string>();
  const cursor = db.collection<StockMovement>('stock_movements').find({ product_id: balance.product_id }, { session }).sort({ sequence: 1 });
  for await (const row of cursor) {
    if (!unsigned(row.sequence) || row.sequence !== sequence + 1) issues.add('SEQUENCE_GAP');
    if (row.before_on_hand !== hand || row.before_reserved !== reserved) issues.add('BROKEN_CHAIN');
    if (![row.on_hand_delta, row.reserved_delta].every(n => Number.isInteger(n) && Math.abs(n) <= max) ||
      row.on_hand_delta === 0 && row.reserved_delta === 0) issues.add('INVALID_DELTA');
    hand += row.on_hand_delta; reserved += row.reserved_delta; sequence++;
    if (!unsigned(hand) || !unsigned(reserved) || reserved > hand || row.after_on_hand !== hand || row.after_reserved !== reserved) issues.add('INVALID_AFTER');
    if (!(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime()) || !row.sku_snapshot || !row.name_snapshot || !row.event_key) issues.add('INVALID_METADATA');
    if (eventKeys.has(row.event_key)) issues.add('DUPLICATE_EVENT_KEY');
    eventKeys.add(row.event_key);
    if (row.kind === 'RECEIPT_POST') {
      const item = row.document_item_id && await db.collection('stock_document_items').findOne({ _id: row.document_item_id, document_id: row.source_id, product_id: row.product_id }, { session });
      const source = item && await db.collection('stock_documents').findOne({ _id: row.source_id, kind: 'RECEIPT', status: 'POSTED' }, { session, projection: { _id: 1 } });
      if (!source || !item || row.event_key !== `RECEIPT_POST:${row.document_item_id}` || item.quantity_delta !== row.on_hand_delta ||
        row.reserved_delta !== 0 || item.sku_snapshot !== row.sku_snapshot || item.name_snapshot !== row.name_snapshot) issues.add('INVALID_RECEIPT_SOURCE');
    }
  }
  if (sequence !== balance.version || hand !== balance.on_hand || reserved !== balance.reserved) issues.add('BALANCE_LEDGER_MISMATCH');
  return [...issues];
}

export async function reconcileInventory(connection: Connection, transactions: TransactionRunner) {
  return transactions.run(async session => {
    const db = connection.db!, issues: { productId: string; codes: string[] }[] = [];
    let checked = 0;
    for await (const product of db.collection('products').find({}, { session, projection: { _id: 1 } }).sort({ _id: 1 })) {
      checked++;
      const balances = await db.collection<Balance & { guard_revision?: unknown }>('inventory').find({ product_id: product._id }, { session, promoteLongs: false }).toArray();
      const codes = balances.length === 1 ? await inspectInventoryLedger(db, balances[0], session) : [balances.length ? 'DUPLICATE_INVENTORY' : 'MISSING_INVENTORY'];
      if (balances.length === 1) {
        const revision = balances[0].guard_revision;
        if (!Long.isLong(revision) || revision.lt(Long.ZERO) || revision.gte(Long.MAX_VALUE)) codes.push('INVALID_GUARD');
      }
      if (codes.length) issues.push({ productId: String(product._id), codes });
    }
    for (const collection of ['inventory', 'stock_movements']) {
      const orphans = await db.collection(collection).aggregate<{ product_id: ObjectId }>([
        { $lookup: { from: 'products', localField: 'product_id', foreignField: '_id', as: 'products' } },
        { $match: { products: { $size: 0 } } }, { $group: { _id: '$product_id' } }, { $project: { _id: 0, product_id: '$_id' } },
      ], { session }).toArray();
      for (const row of orphans) issues.push({ productId: String(row.product_id), codes: [`ORPHAN_${collection.toUpperCase()}`] });
    }
    const duplicateKeys = await db.collection('stock_movements').aggregate<{ products: ObjectId[] }>([
      { $group: { _id: '$event_key', products: { $addToSet: '$product_id' }, count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } },
    ], { session }).toArray();
    for (const row of duplicateKeys) for (const productId of row.products) issues.push({ productId: String(productId), codes: ['DUPLICATE_EVENT_KEY'] });
    return { checked, consistent: issues.length === 0, issues };
  });
}
