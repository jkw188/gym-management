import { Connection, Types } from 'mongoose';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { Payment } from '../payments/schemas/payment.schema';
import { Refund, RefundSchema } from './refund.schema';

// Never infer a payout or overwrite a legacy obligation. Invalid historical rows require reconciliation.
export async function ensureRefundsIntegrity(connection: Connection) {
  const model = connection.models.Refund ?? connection.model('Refund', RefundSchema), db = connection.db!;
  for (const name of ['refunds', 'payments', 'invoices', 'orders', 'stock_movements', 'operation_requests']) {
    const indexes = await db.collection(name).listIndexes().toArray().catch(() => []);
    if (indexes.some(index => index.expireAfterSeconds !== undefined)) throw new Error('REFUNDS_FINANCIAL_TTL_NOT_ALLOWED');
  }
  const totals = new Map<string, bigint>(), keys = new Set<string>(), references = new Set<string>();
  for await (const row of db.collection<Refund>('refunds').find()) {
    if (!(row.id instanceof Types.ObjectId) || !row.id.equals(row._id)) throw new Error('REFUNDS_RECONCILIATION_REQUIRED');
    await model.hydrate(row).validate();
    const payment = await db.collection<Payment>('payments').findOne({ _id: row.payment_id, status: 'SUCCEEDED' });
    const order = payment && await db.collection('orders').findOne({ _id: row.order_id, transaction_id: payment.transaction_id });
    if (!payment || !order || row.reason === 'CANCELLATION' && (order.status !== 'CANCELLED' || row.obligation_key !== `CANCELLATION:${row.payment_id}` || row.reference !== `RF:${row._id}`) ||
      (row.status === 'SUCCEEDED' ? !Number.isFinite(row.refunded_at?.getTime()) : row.refunded_at !== undefined) ||
      keys.has(row.obligation_key) || references.has(row.reference)) throw new Error('REFUNDS_RECONCILIATION_REQUIRED');
    const id = String(payment._id), total = (totals.get(id) ?? 0n) + BigInt(fromVndDecimal(row.amount));
    if (total > BigInt(fromVndDecimal(payment.amount))) throw new Error('REFUNDS_EXCEED_PAYMENT');
    totals.set(id, total); keys.add(row.obligation_key); references.add(row.reference);
  }
  await model.createIndexes();
}
