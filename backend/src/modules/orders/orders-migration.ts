// Tầng dữ liệu – migration (US-41 bước 1): kiểm TTL, đối chiếu orders/items/transaction và inventory.reserved với tổng HELD, rồi tạo index.
// Chỉ báo lỗi bằng mã riêng; không tự sửa số dư, không xóa chứng từ.
import { Connection } from 'mongoose';
import { Long, ObjectId } from 'mongodb';
import { Order, OrderItem, ORDER_MODELS } from './order.schema';
import { Transaction } from '../payments/schemas/transaction.schema';
import { assertOrderIntegrity } from './order.policy';

// Preflight only: never reconstruct missing snapshots, reset reservations, or guess historical deadlines.
export async function ensureOrdersIntegrity(connection: Connection) {
  const db = connection.db!;
  const orderModel = connection.models.Order ?? connection.model('Order', ORDER_MODELS[0].schema);
  for (const { schema } of ORDER_MODELS) {
    const indexes = await db.collection(schema.get('collection')!).listIndexes().toArray().catch(() => []);
    if (indexes.some(index => index.expireAfterSeconds !== undefined)) throw new Error('ORDERS_TTL_NOT_ALLOWED');
  }
  for await (const order of db.collection<Order>('orders').find({}, { promoteLongs: false })) {
    const revision: unknown = order.guard_revision;
    if (!Long.isLong(revision) || revision.isNegative() || revision.gte(Long.MAX_VALUE)) throw new Error('ORDERS_REVISION_RECONCILIATION_REQUIRED');
    const transaction = await db.collection<Transaction>('transactions').findOne({ _id: order.transaction_id });
    // US-41-TC05 (spec 1.0.1 mục 3): order trỏ tới transaction không tồn tại → mã riêng, không xóa order/items.
    if (!transaction) throw new Error('ORDERS_ORPHAN_RECONCILIATION_REQUIRED');
    const items = await db.collection<OrderItem>('order_items').find({ order_id: order._id }).toArray();
    assertOrderIntegrity(order, transaction, items);
    await orderModel.hydrate(order).validate();
    if (order.status === 'COMPLETED' ? order.reservation_state !== 'CONSUMED' : order.status === 'CANCELLED' ? order.reservation_state !== 'RELEASED' : order.reservation_state !== 'HELD') {
      throw new Error('ORDERS_STATE_RECONCILIATION_REQUIRED');
    }
  }
  const orphan = await db.collection('order_items').aggregate([{ $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
    { $match: { order: { $size: 0 } } }, { $limit: 1 }]).hasNext();
  if (orphan) throw new Error('ORDER_ITEMS_ORPHAN_RECONCILIATION_REQUIRED');
  const orphanTransaction = await db.collection('transactions').aggregate([{ $match: { kind: 'RETAIL' } },
    { $lookup: { from: 'orders', localField: '_id', foreignField: 'transaction_id', as: 'orders' } },
    { $match: { orders: { $size: 0 } } }, { $limit: 1 }]).hasNext();
  if (orphanTransaction) throw new Error('RETAIL_TRANSACTION_ORPHAN_RECONCILIATION_REQUIRED');
  const held = await db.collection('order_items').aggregate<{ _id: ObjectId; quantity: number }>([
    { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
    { $match: { 'order.reservation_state': 'HELD' } }, { $group: { _id: '$product_id', quantity: { $sum: '$quantity' } } },
  ]).toArray();
  const expected = new Map(held.map(row => [String(row._id), row.quantity]));
  for await (const balance of db.collection('inventory').find()) {
    const quantity = expected.get(String(balance.product_id)) ?? 0;
    if (balance.reserved !== quantity) throw new Error('ORDERS_RESERVED_RECONCILIATION_REQUIRED');
    expected.delete(String(balance.product_id));
  }
  if (expected.size) throw new Error('ORDERS_INVENTORY_MISSING');
  for (const { name, schema } of ORDER_MODELS) await (connection.models[name] ?? connection.model(name, schema)).createIndexes();
}
