import { Connection, Types } from 'mongoose';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { Payment } from '../payments/schemas/payment.schema';
import { Refund, RefundSchema } from './refund.schema';
import { Int32 } from 'mongodb';
import { RefundAttemptSchema } from './refund-attempt.schema';
import { payoutReference } from './refund-payout.service';
import { ConfirmRefundDto } from './refunds.dto';

// Never infer a payout or overwrite a legacy obligation. Invalid historical rows require reconciliation.
export async function ensureRefundsIntegrity(connection: Connection) {
  const model = connection.models.Refund ?? connection.model('Refund', RefundSchema), db = connection.db!;
  for (const name of ['refunds', 'refund_attempts', 'returns', 'return_items', 'payments', 'invoices', 'orders', 'stock_movements', 'operation_requests']) {
    const indexes = await db.collection(name).listIndexes().toArray().catch(() => []);
    if (indexes.some(index => index.expireAfterSeconds !== undefined)) throw new Error('REFUNDS_FINANCIAL_TTL_NOT_ALLOWED');
  }
  const totals = new Map<string, bigint>(), keys = new Set<string>(), references = new Set<string>(), payouts = new Set<string>();
  for await (const row of db.collection<Refund>('refunds').find()) {
    if (!(row.id instanceof Types.ObjectId) || !row.id.equals(row._id) || row.amount?._bsontype !== 'Decimal128') throw new Error('REFUNDS_RECONCILIATION_REQUIRED');
    await model.hydrate(row).validate();
    if (row.version !== undefined && (!Number.isInteger(row.version) || row.version < 0 || row.version > 2147483647)) throw new Error('REFUNDS_RECONCILIATION_REQUIRED');
    if (row.payout_reference_key !== undefined) {
      if (typeof row.payout_reference_key !== 'string' || !row.payout_reference_key || payouts.has(row.payout_reference_key) || row.status !== 'SUCCEEDED' || !row.payout_evidence || !row.verified_at || !row.verified_by) throw new Error('REFUNDS_PAYOUT_RECONCILIATION_REQUIRED');
      if (payoutReference({ method: row.method, ...row.payout_evidence } as ConfirmRefundDto) !== row.payout_reference_key ||
        row.refunded_at! < row.created_at || row.refunded_at! > row.verified_at) throw new Error('REFUNDS_PAYOUT_RECONCILIATION_REQUIRED');
      payouts.add(row.payout_reference_key);
    }
    const payment = await db.collection<Payment>('payments').findOne({ _id: row.payment_id, status: 'SUCCEEDED' });
    const order = payment && await db.collection('orders').findOne({ _id: row.order_id, transaction_id: payment.transaction_id });
    if (!payment || payment.amount?._bsontype !== 'Decimal128' || !order || row.reason === 'CANCELLATION' && (order.status !== 'CANCELLED' || row.obligation_key !== `CANCELLATION:${row.payment_id}` || row.reference !== `RF:${row._id}`) ||
      (row.status === 'SUCCEEDED' ? !Number.isFinite(row.refunded_at?.getTime()) : row.refunded_at !== undefined) ||
      keys.has(row.obligation_key) || references.has(row.reference)) throw new Error('REFUNDS_RECONCILIATION_REQUIRED');
    const id = String(payment._id), total = (totals.get(id) ?? 0n) + BigInt(fromVndDecimal(row.amount));
    if (total > BigInt(fromVndDecimal(payment.amount))) throw new Error('REFUNDS_EXCEED_PAYMENT');
    if (row.reason === 'RETURN') {
      const source = row.return_id && await db.collection('returns').findOne({ _id: row.return_id, order_id: row.order_id });
      if (!source || order.status !== 'COMPLETED' || row.reference !== `RF:${row._id}` || row.obligation_key !== `RETURN:${row.return_id}:${row.payment_id}` ||
        fromVndDecimal(source.amount_snapshot) !== fromVndDecimal(row.amount)) throw new Error('REFUNDS_RETURN_RECONCILIATION_REQUIRED');
    }
    totals.set(id, total); keys.add(row.obligation_key); references.add(row.reference);
  }
  // Explicit S06 -> S07 metadata migration only after every obligation passed preflight. No inferred payout.
  await db.collection('refunds').updateMany({ version: { $exists: false } }, { $set: { version: new Int32(0) } });
  await model.createIndexes();
  await (connection.models.RefundAttempt ?? connection.model('RefundAttempt', RefundAttemptSchema)).createIndexes();
}
