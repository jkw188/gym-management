import { Schema, Types } from 'mongoose';

export const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'] as const;
export type OrderStatus = typeof ORDER_STATUSES[number];
export interface Order {
  _id: Types.ObjectId; id: Types.ObjectId; transaction_id: Types.ObjectId; member_id?: Types.ObjectId;
  code: string; channel: 'WEBSITE' | 'POS'; status: OrderStatus; reservation_state: 'HELD' | 'CONSUMED' | 'RELEASED';
  reservation_expires_at: Date; preferred_payment_method: 'CASH' | 'TRANSFER';
  recipient_name: string; recipient_phone: string; pickup_location_snapshot: string;
  created_by: Types.ObjectId; created_at: Date; updated_at: Date; version: number; guard_revision: bigint;
  confirmed_at?: Date; confirmed_by?: Types.ObjectId; fulfilled_at?: Date; fulfilled_by?: Types.ObjectId;
  cancelled_at?: Date; cancelled_by?: Types.ObjectId; cancellation_reason?: string; cancellation_source?: 'USER' | 'EXPIRED';
  expiry_retry_at?: Date; expiry_attempts?: number;
}
export interface OrderItem {
  _id: Types.ObjectId; id: Types.ObjectId; order_id: Types.ObjectId; product_id: Types.ObjectId;
  sku_snapshot: string; name_snapshot: string; product_version_snapshot: number;
  quantity: number; unit_price: Types.Decimal128; line_total: Types.Decimal128;
}
export interface OrderEvent {
  _id: Types.ObjectId; order_id: Types.ObjectId; action: string; actor_type: 'USER' | 'SYSTEM'; actor_id?: Types.ObjectId;
  occurred_at: Date; before: { status: OrderStatus; version: number } | null; after: { status: OrderStatus; version: number };
  event_key: string; reason?: string;
}
const objectId = { type: Schema.Types.ObjectId, required: true };
const unsigned = { type: Schema.Types.Int32, required: true, min: 0, max: 2147483647 };
const identity = { ...objectId, immutable: true, default: function (this: { _id: Types.ObjectId }) { return this._id; },
  validate: function (this: { _id: Types.ObjectId }, id: Types.ObjectId) { return id.equals(this._id); } };
const options = { id: false as const, versionKey: false as const, strict: 'throw' as const };
// Shared S06 fields follow US-41/53. POS may have no contact phone.
export const OrderSchema = new Schema<Order>({
  id: identity, transaction_id: { ...objectId, immutable: true }, member_id: { type: Schema.Types.ObjectId, immutable: true },
  code: { type: String, required: true, maxlength: 40, match: /^ORD-[a-f\d]{24}$/ },
  channel: { type: String, required: true, enum: ['WEBSITE', 'POS'], immutable: true }, status: { type: String, required: true, enum: ORDER_STATUSES },
  reservation_state: { type: String, required: true, enum: ['HELD', 'CONSUMED', 'RELEASED'] },
  reservation_expires_at: { type: Date, required: true, immutable: true }, preferred_payment_method: { type: String, required: true, enum: ['CASH', 'TRANSFER'] },
  recipient_name: { type: String, required: true, minlength: 2, maxlength: 120, immutable: true },
  recipient_phone: { type: String, required: function (this: Order) { return this.channel === 'WEBSITE'; }, immutable: true }, pickup_location_snapshot: { type: String, required: true, immutable: true },
  created_by: objectId, created_at: { type: Date, required: true, immutable: true }, updated_at: { type: Date, required: true },
  version: unsigned, guard_revision: { type: Schema.Types.BigInt, required: true, default: 0n, validate: (v: bigint) => v >= 0n },
  confirmed_at: Date, confirmed_by: Schema.Types.ObjectId, fulfilled_at: Date, fulfilled_by: Schema.Types.ObjectId,
  cancelled_at: Date, cancelled_by: Schema.Types.ObjectId, cancellation_reason: { type: String, maxlength: 500 },
  cancellation_source: { type: String, enum: ['USER', 'EXPIRED'] },
  expiry_retry_at: Date, expiry_attempts: { type: Number, min: 0 },
}, { ...options, collection: 'orders' });
OrderSchema.index({ code: 1 }, { unique: true, name: 'orders_code_unique' });
OrderSchema.index({ transaction_id: 1 }, { unique: true, name: 'orders_transaction_unique' });
OrderSchema.index({ member_id: 1, created_at: -1, _id: -1 }, { name: 'orders_member_created_id' });
OrderSchema.index({ channel: 1, status: 1, created_at: -1, _id: -1 }, { name: 'orders_channel_status_created_id' });
OrderSchema.index({ reservation_state: 1, reservation_expires_at: 1 }, { name: 'orders_reservation_expiry' });
export const OrderItemSchema = new Schema<OrderItem>({
  id: identity, order_id: objectId, product_id: objectId, sku_snapshot: { type: String, required: true }, name_snapshot: { type: String, required: true },
  product_version_snapshot: unsigned, quantity: { type: Schema.Types.Int32, required: true, min: 1, max: 999 },
  unit_price: { type: Schema.Types.Decimal128, required: true }, line_total: { type: Schema.Types.Decimal128, required: true },
}, { ...options, collection: 'order_items' });
OrderItemSchema.index({ order_id: 1, product_id: 1 }, { unique: true, name: 'order_items_order_product_unique' });
OrderItemSchema.index({ product_id: 1 }, { name: 'order_items_product' });
export const OrderEventSchema = new Schema<OrderEvent>({
  order_id: objectId, action: { type: String, required: true, enum: ['CREATED', 'PREPARED', 'PAYMENT_SETTLED', 'FULFILLED', 'CANCELLED', 'LATE_RECEIPT'] },
  actor_type: { type: String, required: true, enum: ['USER', 'SYSTEM'] }, actor_id: Schema.Types.ObjectId,
  occurred_at: { type: Date, required: true }, before: { type: Schema.Types.Mixed, default: null }, after: { type: Schema.Types.Mixed, required: true },
  event_key: { type: String, required: true }, reason: String,
}, { ...options, collection: 'order_events' });
OrderEventSchema.index({ event_key: 1 }, { unique: true, name: 'order_events_event_key_unique' });
OrderEventSchema.index({ order_id: 1, occurred_at: 1 }, { name: 'order_events_order_occurred' });
export const ORDER_MODELS = [{ name: 'Order', schema: OrderSchema }, { name: 'OrderItem', schema: OrderItemSchema }, { name: 'OrderEvent', schema: OrderEventSchema }];
