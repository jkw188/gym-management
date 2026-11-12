import { Schema, Types } from 'mongoose';
import { CATALOG_STATUSES, CatalogStatus } from './plan.schema';

export const CONVERSION_RULE = 'PRORATED_REMAINING_DAYS_V1' as const;
export interface PlanPolicy {
  _id: Types.ObjectId; id: Types.ObjectId; from_plan_id: Types.ObjectId; to_plan_id: Types.ObjectId;
  status: CatalogStatus; rule_code: typeof CONVERSION_RULE; note: string; version: number;
  created_by: Types.ObjectId; updated_by: Types.ObjectId; created_at: Date; updated_at: Date;
}
export const PlanPolicySchema = new Schema<PlanPolicy>({
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (value: Types.ObjectId) { return value.equals(this._id); } },
  from_plan_id: { type: Schema.Types.ObjectId, required: true, immutable: true, ref: 'Plan' },
  to_plan_id: { type: Schema.Types.ObjectId, required: true, immutable: true, ref: 'Plan',
    validate: function (value: Types.ObjectId) { return !value.equals(this.from_plan_id); } },
  status: { type: String, required: true, enum: CATALOG_STATUSES },
  rule_code: { type: String, required: true, immutable: true, enum: [CONVERSION_RULE], default: CONVERSION_RULE },
  note: { type: String, trim: true, maxlength: 500, default: '' },
  version: { type: Schema.Types.Int32, required: true, default: 0, validate: (value: number) => Number.isInteger(value) && value >= 0 },
  created_by: { type: Schema.Types.ObjectId, required: true, ref: 'Account' },
  updated_by: { type: Schema.Types.ObjectId, required: true, ref: 'Account' },
}, { collection: 'plan_conversion_policies', id: false, versionKey: false, strict: 'throw',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });
PlanPolicySchema.index({ id: 1 }, { unique: true, name: 'plan_policies_id_unique' });
PlanPolicySchema.index({ from_plan_id: 1, to_plan_id: 1 }, { unique: true, name: 'plan_policies_pair_unique' });
PlanPolicySchema.index({ to_plan_id: 1, status: 1 }, { name: 'plan_policies_target_status' });
PlanPolicySchema.index({ created_at: -1, _id: -1 }, { name: 'plan_policies_created_id' });
