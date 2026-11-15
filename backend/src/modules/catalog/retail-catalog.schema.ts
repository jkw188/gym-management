import { Schema, Types } from 'mongoose';
import { RETAIL_STATUSES, RetailStatus } from './retail-catalog.policy';

export interface RetailCategory {
  _id: Types.ObjectId; id: Types.ObjectId; name: string; name_key: string; status: RetailStatus; version: number;
  created_at: Date; updated_at: Date; created_by: Types.ObjectId; updated_by: Types.ObjectId;
}
export interface RetailProduct extends Omit<RetailCategory, 'name_key'> {
  category_id: Types.ObjectId; sku: string; description?: string; image_url?: string; price: Types.Decimal128;
}
export interface RetailInventory {
  _id: Types.ObjectId; product_id: Types.ObjectId; on_hand: number; reserved: number; version: number; guard_revision: bigint; updated_at: Date;
}
export interface CatalogEvent {
  _id: Types.ObjectId; entity_type: 'CATEGORY' | 'PRODUCT'; entity_id: Types.ObjectId; actor_id: Types.ObjectId;
  action: 'CREATED' | 'UPDATED' | 'ACTIVATED' | 'DEACTIVATED'; before: Record<string, unknown> | null;
  after: Record<string, unknown>; occurred_at: Date; request_key: string;
}
const version = { type: Schema.Types.Int32, required: true, min: 0, max: 2147483647, default: 0 };
const fields = {
  name: { type: String, required: true, minlength: 1, maxlength: 120 },
  status: { type: String, required: true, enum: RETAIL_STATUSES }, version,
  created_by: { type: Schema.Types.ObjectId, required: true }, updated_by: { type: Schema.Types.ObjectId, required: true },
};
const options = { id: false as const, versionKey: false as const, strict: 'throw' as const,
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } };
export const RetailCategorySchema = new Schema<RetailCategory>({ ...fields,
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (this: RetailCategory, id: Types.ObjectId) { return id.equals(this._id); } },
  name_key: { type: String, required: true },
}, { ...options, collection: 'categories' });
RetailCategorySchema.index({ name_key: 1 }, { unique: true, collation: { locale: 'simple' }, name: 'categories_name_key_unique' });
RetailCategorySchema.index({ name: 1, _id: 1 }, { name: 'categories_name_id' });

export const RetailProductSchema = new Schema<RetailProduct>({ ...fields,
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (this: RetailProduct, id: Types.ObjectId) { return id.equals(this._id); } },
  category_id: { type: Schema.Types.ObjectId, required: true },
  sku: { type: String, required: true, immutable: true, match: /^[A-Z0-9_-]{1,40}$/ },
  description: { type: String, maxlength: 2000 }, image_url: { type: String, maxlength: 500 },
  price: { type: Schema.Types.Decimal128, required: true },
}, { ...options, collection: 'products' });
RetailProductSchema.index({ sku: 1 }, { unique: true, collation: { locale: 'simple' }, name: 'products_sku_unique' });
RetailProductSchema.index({ category_id: 1, status: 1, name: 1, _id: 1 }, { name: 'products_category_status_name_id' });
RetailProductSchema.index({ status: 1, name: 1, _id: 1 }, { name: 'products_status_name_id' });

export const RetailInventorySchema = new Schema<RetailInventory>({
  product_id: { type: Schema.Types.ObjectId, required: true },
  on_hand: { ...version }, reserved: { ...version }, version: { ...version },
  guard_revision: { type: Schema.Types.BigInt, required: true, validate: (value: bigint) => value >= 0n, default: 0n }, updated_at: { type: Date, required: true },
}, { collection: 'inventory', strict: 'throw', versionKey: false });
RetailInventorySchema.index({ product_id: 1 }, { unique: true, name: 'inventory_product_unique' });
export const CatalogEventSchema = new Schema<CatalogEvent>({
  entity_type: { type: String, enum: ['CATEGORY', 'PRODUCT'], required: true },
  entity_id: { type: Schema.Types.ObjectId, required: true }, actor_id: { type: Schema.Types.ObjectId, required: true },
  action: { type: String, enum: ['CREATED', 'UPDATED', 'ACTIVATED', 'DEACTIVATED'], required: true },
  before: { type: Schema.Types.Mixed, default: null }, after: { type: Schema.Types.Mixed, required: true },
  occurred_at: { type: Date, required: true }, request_key: { type: String, required: true },
}, { collection: 'catalog_events', strict: 'throw', versionKey: false, minimize: false });
CatalogEventSchema.index({ request_key: 1 }, { unique: true, name: 'catalog_events_request_key_unique' });

export const RETAIL_MODELS = [
  { name: 'RetailCategory', schema: RetailCategorySchema }, { name: 'RetailProduct', schema: RetailProductSchema },
  { name: 'RetailInventory', schema: RetailInventorySchema }, { name: 'CatalogEvent', schema: CatalogEventSchema },
];
