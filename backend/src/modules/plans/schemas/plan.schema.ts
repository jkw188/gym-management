import { Schema, Types } from 'mongoose';

export const PLAN_KINDS = ['GYM', 'PT'] as const;
export const CATALOG_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type PlanKind = typeof PLAN_KINDS[number];
export type CatalogStatus = typeof CATALOG_STATUSES[number];

export interface Plan {
  _id: Types.ObjectId; id: Types.ObjectId; code: string; name: string; kind: PlanKind;
  duration_days: number; session_quota: number; price: Types.Decimal128; benefits: string;
  status: CatalogStatus; version: number; guard_revision: bigint;
  created_by: Types.ObjectId; updated_by: Types.ObjectId; created_at: Date; updated_at: Date;
}

export const PlanSchema = new Schema<Plan>({
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (this: Plan, value: Types.ObjectId) { return value.equals(this._id); } },
  code: { type: String, required: true, immutable: true, trim: true, uppercase: true, match: /^[A-Z0-9_-]{3,30}$/ },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  kind: { type: String, required: true, immutable: true, enum: PLAN_KINDS },
  duration_days: { type: Schema.Types.Int32, required: true, validate: (value: number) => Number.isInteger(value) && value >= 1 && value <= 3650 },
  session_quota: { type: Schema.Types.Int32, required: true,
    validate: function (this: Plan, value: number) { return Number.isInteger(value) && (this.kind === 'GYM' ? value === 0 : value >= 1 && value <= 10000); } },
  price: { type: Schema.Types.Decimal128, required: true, validate: (value: Types.Decimal128) => /^\d+$/.test(value.toString()) && BigInt(value.toString()) <= 999999999999n },
  benefits: { type: String, required: true, trim: true, minlength: 1, maxlength: 1000 },
  status: { type: String, required: true, enum: CATALOG_STATUSES, default: 'ACTIVE' },
  version: { type: Schema.Types.Int32, required: true, default: 0, validate: (value: number) => Number.isInteger(value) && value >= 0 },
  guard_revision: { type: Schema.Types.BigInt, required: true, validate: (value: bigint) => value >= 0n, default: 0n, select: false },
  created_by: { type: Schema.Types.ObjectId, required: true, ref: 'Account' },
  updated_by: { type: Schema.Types.ObjectId, required: true, ref: 'Account' },
}, { collection: 'plans', id: false, versionKey: false, strict: 'throw',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });
PlanSchema.index({ id: 1 }, { unique: true, name: 'plans_id_unique' });
PlanSchema.index({ code: 1 }, { unique: true, name: 'plans_code_unique', collation: { locale: 'simple' } });
PlanSchema.index({ created_at: -1, _id: -1 }, { name: 'plans_created_id' });
