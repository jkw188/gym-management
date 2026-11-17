import { ClientSession } from 'mongodb';
import { Connection, Schema, Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { Payment } from '../payments/schemas/payment.schema';
import { Refund } from './refund.schema';

export const refundIntegrityError = () => new ApplicationError(409, 'REFUND_INTEGRITY_ERROR', 'Nghĩa vụ hoàn cần được đối chiếu với khoản thu gốc');
export function refundAmount(value: Types.Decimal128): bigint {
  try {
    if (value?._bsontype !== 'Decimal128') throw refundIntegrityError();
    const amount = BigInt(fromVndDecimal(value));
    if (amount <= 0n) throw refundIntegrityError();
    return amount;
  } catch { throw refundIntegrityError(); }
}
// Must run after the original transaction/order gates. All statuses reserve the budget.
export async function refundBudget(connection: Connection, orderId: Types.ObjectId, payment: Payment, session: ClientSession) {
  if (payment.status !== 'SUCCEEDED') throw refundIntegrityError();
  const rows = await connection.db!.collection<Refund>('refunds').find({ payment_id: payment._id }, { session }).toArray();
  let obligated = 0n, refunded = 0n;
  for (const row of rows) {
    if (!row.id?.equals(row._id) || !row.order_id?.equals(orderId) || !['PENDING', 'FAILED', 'SUCCEEDED'].includes(row.status) ||
      row.reference !== `RF:${row._id}` || !row.obligation_key ||
      (row.status === 'SUCCEEDED' ? !Number.isFinite(row.refunded_at?.getTime()) : row.refunded_at !== undefined)) throw refundIntegrityError();
    const amount = refundAmount(row.amount); obligated += amount;
    if (row.status === 'SUCCEEDED') refunded += amount;
  }
  if (obligated > refundAmount(payment.amount)) throw refundIntegrityError();
  return { rows, obligated, refunded };
}
export async function assertRefundIndexes(connection: Connection, schemas: Schema[]) {
  for (const schema of schemas) {
    const indexes = await connection.db!.collection(schema.get('collection')!).listIndexes().toArray().catch(() => []);
    if (indexes.some(index => index.expireAfterSeconds !== undefined) || schema.indexes().some(([key, options]) => !indexes.some(index =>
      JSON.stringify(index.key) === JSON.stringify(key) && Boolean(index.unique) === Boolean(options.unique) && !index.sparse &&
      JSON.stringify(index.partialFilterExpression) === JSON.stringify(options.partialFilterExpression) && (!index.collation || index.collation.locale === 'simple')))) {
      throw new ApplicationError(503, 'REFUNDS_NOT_READY', 'Cần chạy ensure-indexes và đối soát hoàn tiền trước khi ghi');
    }
  }
}
