import { ApplicationError } from '../../common/errors/application-error';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { Transaction } from '../payments/schemas/transaction.schema';
import { Order, OrderItem } from './order.schema';

export const orderIntegrityError = () => new ApplicationError(409, 'ORDER_INTEGRITY_ERROR', 'Dữ liệu đơn hàng cần được đối chiếu');
export const orderConflict = () => new ApplicationError(409, 'VERSION_CONFLICT', 'Đơn hàng đã thay đổi. Hãy tải lại trước khi thao tác');

// Only persisted snapshots participate; current catalog availability/price must not block preparation.
export function assertOrderIntegrity(order: Order, transaction: Transaction | null, items: OrderItem[]): asserts transaction is Transaction {
  try {
    if (!transaction || transaction.kind !== 'RETAIL' || !transaction._id.equals(order.transaction_id) ||
      !transaction.id?.equals(transaction._id) || transaction.amount_due?._bsontype !== 'Decimal128' ||
      String(transaction.member_id ?? '') !== String(order.member_id ?? '') || order.channel === 'WEBSITE' && !order.member_id ||
      !order.id?.equals(order._id) || order.code !== `ORD-${order._id}` ||
      !Number.isSafeInteger(order.version) || order.version < 0 || order.version > 2147483647 ||
      !order.recipient_name?.trim() || !order.recipient_phone?.trim() || !order.pickup_location_snapshot?.trim() ||
      !Number.isFinite(order.created_at?.getTime()) || !Number.isFinite(order.reservation_expires_at?.getTime()) ||
      order.reservation_expires_at.getTime() !== order.created_at.getTime() + 86400000 ||
      items.length < 1 || items.length > 100 || new Set(items.map(item => String(item.product_id))).size !== items.length) throw orderIntegrityError();
    let total = 0n;
    for (const line of items) {
      if (!line.id?.equals(line._id) || !line.order_id.equals(order._id) || !line.product_id || !line.sku_snapshot?.trim() || !line.name_snapshot?.trim() ||
        !Number.isInteger(line.product_version_snapshot) || line.product_version_snapshot < 0 ||
        !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 999) throw orderIntegrityError();
      const price = BigInt(fromVndDecimal(line.unit_price)), amount = BigInt(fromVndDecimal(line.line_total));
      if (line.unit_price?._bsontype !== 'Decimal128' || line.line_total?._bsontype !== 'Decimal128') throw orderIntegrityError();
      if (price * BigInt(line.quantity) !== amount) throw orderIntegrityError();
      total += amount;
    }
    if (total > 999999999999n || total !== BigInt(fromVndDecimal(transaction.amount_due))) throw orderIntegrityError();
  } catch { throw orderIntegrityError(); }
}
export function prepareBlockedReason(order: Order, transaction: Transaction, now: Date): string | null {
  if (order.channel !== 'WEBSITE') return 'ORDER_CHANNEL_MISMATCH';
  if (order.status === 'CONFIRMED') return 'ORDER_ALREADY_CONFIRMED';
  if (order.status !== 'PENDING' || order.reservation_state !== 'HELD' || !['PENDING', 'SETTLED'].includes(transaction.status)) return 'INVALID_ORDER_STATE';
  if (now.getTime() >= order.reservation_expires_at.getTime()) return 'RESERVATION_EXPIRED';
  return null;
}

export function fulfillBlockedReason(order: Order, transaction: Transaction, now: Date, channel: 'WEBSITE' | 'POS' = 'WEBSITE'): string | null {
  if (order.channel !== channel) return 'ORDER_CHANNEL_MISMATCH';
  if (order.status === 'COMPLETED') return 'ORDER_ALREADY_COMPLETED';
  if (order.status !== 'CONFIRMED') return 'ORDER_NOT_PREPARED';
  if (order.reservation_state !== 'HELD') return 'INVALID_RESERVATION_STATE';
  if (now.getTime() >= order.reservation_expires_at.getTime()) return 'RESERVATION_EXPIRED';
  if (transaction.status !== 'SETTLED') return 'ORDER_NOT_SETTLED';
  return null;
}
