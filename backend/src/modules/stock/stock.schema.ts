import { Schema, Types } from 'mongoose';

export interface StockDocument {
  _id: Types.ObjectId; id: Types.ObjectId; code: string; kind: 'RECEIPT' | 'ISSUE' | 'ADJUSTMENT'; status: 'DRAFT' | 'POSTED';
  reason: string; source_reference?: string; version: number; total_cost: Types.Decimal128;
  created_by: Types.ObjectId; updated_by: Types.ObjectId; posted_by?: Types.ObjectId;
  created_at: Date; updated_at: Date; posted_at?: Date;
}
export interface StockDocumentItem {
  _id: Types.ObjectId; id: Types.ObjectId; document_id: Types.ObjectId; product_id: Types.ObjectId;
  quantity_delta: number; unit_cost: Types.Decimal128; line_total_cost: Types.Decimal128; sku_snapshot: string; name_snapshot: string;
}
export interface StockMovement {
  _id: Types.ObjectId; product_id: Types.ObjectId; document_item_id?: Types.ObjectId; order_item_id?: Types.ObjectId; return_item_id?: Types.ObjectId;
  event_key: string; sequence: number; kind: string; source_id: Types.ObjectId; actor_id?: Types.ObjectId; actor_type?: 'USER' | 'SYSTEM';
  source_type?: string; source_code?: string;
  on_hand_delta: number; reserved_delta: number; before_on_hand: number; before_reserved: number; after_on_hand: number; after_reserved: number;
  sku_snapshot: string; name_snapshot: string; created_at: Date;
}
export interface StockDocumentEvent {
  _id: Types.ObjectId; document_id: Types.ObjectId; actor_id: Types.ObjectId; action: 'CREATED' | 'UPDATED' | 'POSTED';
  before: Record<string, unknown> | null; after: Record<string, unknown>; occurred_at: Date; request_key: string;
}
const objectId = { type: Schema.Types.ObjectId, required: true };
const unsigned = { type: Schema.Types.Int32, required: true, min: 0, max: 2147483647 };
const signed = { type: Schema.Types.Int32, required: true, min: -2147483647, max: 2147483647 };
const money = { type: Schema.Types.Decimal128, required: true };
const options = { id: false as const, versionKey: false as const, strict: 'throw' as const };
const identity = { ...objectId, immutable: true, default: function (this: { _id: Types.ObjectId }) { return this._id; },
  validate: function (this: { _id: Types.ObjectId }, id: Types.ObjectId) { return id.equals(this._id); } };
export const StockDocumentSchema = new Schema<StockDocument>({
  id: identity, code: { type: String, required: true, maxlength: 40 },
  kind: { type: String, required: true, enum: ['RECEIPT', 'ISSUE', 'ADJUSTMENT'] },
  status: { type: String, required: true, enum: ['DRAFT', 'POSTED'] },
  reason: { type: String, required: true, minlength: 10, maxlength: 500 }, source_reference: { type: String, maxlength: 100 },
  version: unsigned, total_cost: money, created_by: objectId, updated_by: objectId, posted_by: Schema.Types.ObjectId,
  created_at: { type: Date, required: true }, updated_at: { type: Date, required: true }, posted_at: Date,
}, { ...options, collection: 'stock_documents' });
StockDocumentSchema.index({ code: 1 }, { unique: true, name: 'stock_documents_code_unique' });
StockDocumentSchema.index({ kind: 1, created_at: -1, _id: -1 }, { name: 'stock_documents_kind_created_id' });
export const StockDocumentItemSchema = new Schema<StockDocumentItem>({
  id: identity, document_id: objectId, product_id: objectId, quantity_delta: signed, unit_cost: money, line_total_cost: money,
  sku_snapshot: { type: String, required: true }, name_snapshot: { type: String, required: true },
}, { ...options, collection: 'stock_document_items' });
StockDocumentItemSchema.index({ document_id: 1, product_id: 1 }, { unique: true, name: 'stock_items_document_product_unique' });
export const StockMovementSchema = new Schema<StockMovement>({
  product_id: objectId, document_item_id: Schema.Types.ObjectId, order_item_id: Schema.Types.ObjectId, return_item_id: Schema.Types.ObjectId,
  event_key: { type: String, required: true }, sequence: unsigned, kind: { type: String, required: true }, source_id: objectId,
  actor_type: { type: String, enum: ['USER', 'SYSTEM'] },
  actor_id: { type: Schema.Types.ObjectId, required: function (this: StockMovement) { return this.actor_type !== 'SYSTEM'; } },
  source_type: String, source_code: String,
  on_hand_delta: signed, reserved_delta: signed, before_on_hand: unsigned, before_reserved: unsigned, after_on_hand: unsigned, after_reserved: unsigned,
  sku_snapshot: { type: String, required: true }, name_snapshot: { type: String, required: true }, created_at: { type: Date, required: true },
}, { ...options, collection: 'stock_movements' });
StockMovementSchema.index({ event_key: 1 }, { unique: true, name: 'stock_movements_event_key_unique' });
StockMovementSchema.index({ product_id: 1, sequence: 1 }, { unique: true, name: 'stock_movements_product_sequence_unique' });
StockMovementSchema.index({ product_id: 1, created_at: 1, sequence: 1 }, { name: 'stock_movements_product_created_sequence' });
for (const field of ['document_item_id', 'order_item_id', 'return_item_id']) StockMovementSchema.index({ [field]: 1 }, { name: `stock_movements_${field}` });
export const StockDocumentEventSchema = new Schema<StockDocumentEvent>({
  document_id: objectId, actor_id: objectId, action: { type: String, required: true, enum: ['CREATED', 'UPDATED', 'POSTED'] },
  before: { type: Schema.Types.Mixed, default: null }, after: { type: Schema.Types.Mixed, required: true },
  occurred_at: { type: Date, required: true }, request_key: { type: String, required: true },
}, { ...options, collection: 'stock_document_events', minimize: false });
StockDocumentEventSchema.index({ request_key: 1 }, { unique: true, name: 'stock_events_request_key_unique' });
StockDocumentEventSchema.index({ document_id: 1, action: 1 }, { unique: true, partialFilterExpression: { action: 'POSTED' }, name: 'stock_events_posted_unique' });
export const STOCK_MODELS = [
  { name: 'StockDocument', schema: StockDocumentSchema }, { name: 'StockDocumentItem', schema: StockDocumentItemSchema },
  { name: 'StockMovement', schema: StockMovementSchema }, { name: 'StockDocumentEvent', schema: StockDocumentEventSchema },
];
