import { Schema, Types } from 'mongoose';

export interface ReturnDocument {
  _id: Types.ObjectId; order_id: Types.ObjectId; created_by: Types.ObjectId; request_key: string;
  reason: string; created_at: Date; amount_snapshot: Types.Decimal128; order_channel_snapshot: 'WEBSITE' | 'POS';
}
export interface ReturnItem {
  _id: Types.ObjectId; return_id: Types.ObjectId; order_item_id: Types.ObjectId; product_id: Types.ObjectId;
  quantity: number; restockable: boolean; condition_note: string; unit_price_snapshot: Types.Decimal128;
  line_refund_amount: Types.Decimal128; sku_snapshot: string; name_snapshot: string;
}
const oid = { type: Schema.Types.ObjectId, required: true };
const options = { versionKey: false as const, strict: 'throw' as const };
export const ReturnSchema = new Schema<ReturnDocument>({
  order_id: oid, created_by: oid, request_key: { type: String, required: true },
  reason: { type: String, required: true, minlength: 10, maxlength: 500 }, created_at: { type: Date, required: true },
  amount_snapshot: { type: Schema.Types.Decimal128, required: true }, order_channel_snapshot: { type: String, required: true, enum: ['WEBSITE', 'POS'] },
}, { ...options, collection: 'returns' });
ReturnSchema.index({ request_key: 1 }, { unique: true, name: 'returns_request_unique' });
ReturnSchema.index({ order_id: 1, created_at: -1, _id: -1 }, { name: 'returns_order_created' });
ReturnSchema.index({ created_at: -1, _id: -1 }, { name: 'returns_created' });
export const ReturnItemSchema = new Schema<ReturnItem>({
  return_id: oid, order_item_id: oid, product_id: oid, quantity: { type: Schema.Types.Int32, required: true, min: 1, max: 2147483647 },
  restockable: { type: Boolean, required: true }, condition_note: { type: String, required: true, minlength: 10, maxlength: 500 },
  unit_price_snapshot: { type: Schema.Types.Decimal128, required: true }, line_refund_amount: { type: Schema.Types.Decimal128, required: true },
  sku_snapshot: { type: String, required: true }, name_snapshot: { type: String, required: true },
}, { ...options, collection: 'return_items' });
ReturnItemSchema.index({ return_id: 1, order_item_id: 1 }, { unique: true, name: 'return_items_return_order_item_unique' });
ReturnItemSchema.index({ order_item_id: 1 }, { name: 'return_items_order_item' });
export const RETURN_MODELS = [{ name: 'Return', schema: ReturnSchema }, { name: 'ReturnItem', schema: ReturnItemSchema }];
