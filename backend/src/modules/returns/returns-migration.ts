import { Connection } from 'mongoose';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { Order, OrderItem } from '../orders/order.schema';
import { Refund } from '../refunds/refund.schema';
import { StockMovement } from '../stock/stock.schema';
import { RETURN_MODELS, ReturnDocument, ReturnItem } from './return.schema';

// Run with writers stopped, before enabling US46. Do not repair financial or inventory history by guessing.
export async function ensureReturnsIntegrity(connection: Connection) {
  const db = connection.db!, totals = new Map<string, number>();
  for (const { name, schema } of RETURN_MODELS) {
    const model = connection.models[name] ?? connection.model(name, schema);
    const indexes = await db.collection(schema.get('collection')!).listIndexes().toArray().catch(() => []);
    if (indexes.some(index => index.expireAfterSeconds !== undefined)) throw new Error('RETURNS_FINANCIAL_TTL_NOT_ALLOWED');
    for await (const row of model.collection.find()) await model.hydrate(row).validate();
  }
  for await (const row of db.collection<ReturnDocument>('returns').find()) {
    const order = await db.collection<Order>('orders').findOne({ _id: row.order_id, status: 'COMPLETED', reservation_state: 'CONSUMED' });
    const items = await db.collection<ReturnItem>('return_items').find({ return_id: row._id }).toArray();
    if (!order || !items.length || items.length > 100 || row.amount_snapshot?._bsontype !== 'Decimal128' || row.order_channel_snapshot !== order.channel || !/^[a-f0-9]{64}$/.test(row.request_key) ||
      new Set(items.map(item => String(item.order_item_id))).size !== items.length) throw new Error('RETURNS_RECONCILIATION_REQUIRED');
    let amount = 0n;
    for (const item of items) {
      const line = await db.collection<OrderItem>('order_items').findOne({ _id: item.order_item_id, order_id: row.order_id, product_id: item.product_id });
      if (!line || item.unit_price_snapshot?._bsontype !== 'Decimal128' || item.line_refund_amount?._bsontype !== 'Decimal128' ||
        fromVndDecimal(line.unit_price) !== fromVndDecimal(item.unit_price_snapshot) ||
        BigInt(fromVndDecimal(item.line_refund_amount)) !== BigInt(fromVndDecimal(line.unit_price)) * BigInt(item.quantity)) throw new Error('RETURNS_RECONCILIATION_REQUIRED');
      const total = (totals.get(String(line._id)) ?? 0) + item.quantity;
      if (total > line.quantity) throw new Error('RETURNS_QUANTITY_EXCEEDED');
      totals.set(String(line._id), total); amount += BigInt(fromVndDecimal(item.line_refund_amount));
      const movements = await db.collection<StockMovement>('stock_movements').find({ return_item_id: item._id }).toArray();
      if (item.restockable ? movements.length !== 1 || movements[0].event_key !== `RETURN_RECEIVE:${item._id}` || movements[0].on_hand_delta !== item.quantity ||
        movements[0].reserved_delta !== 0 || String(movements[0].source_id) !== String(row._id) || String(movements[0].product_id) !== String(item.product_id) : movements.length !== 0) throw new Error('RETURNS_MOVEMENT_RECONCILIATION_REQUIRED');
    }
    if (amount !== BigInt(fromVndDecimal(row.amount_snapshot))) throw new Error('RETURNS_RECONCILIATION_REQUIRED');
    const refunds = await db.collection<Refund>('refunds').find({ return_id: row._id }).toArray();
    if (amount === 0n ? refunds.length !== 0 : refunds.length !== 1 || refunds[0].reason !== 'RETURN' || String(refunds[0].order_id) !== String(row.order_id) ||
      fromVndDecimal(refunds[0].amount) !== String(amount) || refunds[0].obligation_key !== `RETURN:${row._id}:${refunds[0].payment_id}`) throw new Error('RETURNS_REFUND_RECONCILIATION_REQUIRED');
  }
  for await (const item of db.collection<ReturnItem>('return_items').find()) {
    if (!await db.collection('returns').findOne({ _id: item.return_id })) throw new Error('RETURNS_ORPHAN_ITEM');
  }
  for (const { name, schema } of RETURN_MODELS) await (connection.models[name] ?? connection.model(name, schema)).createIndexes();
}
