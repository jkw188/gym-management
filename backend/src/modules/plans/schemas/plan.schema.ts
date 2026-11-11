import { Schema, Types } from 'mongoose';
import { fromVndDecimal } from '../../../common/utils/vnd-money';

// Read contract for US-14. Catalog administration remains owned by US-12.
export interface Plan {
  _id: Types.ObjectId; id: Types.ObjectId; code: string; name: string;
  kind: 'GYM' | 'PT'; duration_days: number; session_quota: number;
  price: Types.Decimal128; benefits: string; status: 'ACTIVE' | 'INACTIVE';
  version: number; guard_revision: bigint;
}
export const PlanSchema = new Schema<Plan>({
  id: { type: Schema.Types.ObjectId, required: true, default: function () { return this._id; },
    validate: function (value: Types.ObjectId) { return value.equals(this._id); } },
  code: { type: String, required: true, trim: true, uppercase: true, minlength: 3, maxlength: 30, match: /^[A-Z0-9_-]+$/, immutable: true },
  name: { type: String, required: true, minlength: 2, maxlength: 120 },
  kind: { type: String, required: true, enum: ['GYM', 'PT'] },
  duration_days: { type: Schema.Types.Int32, required: true, min: 1, max: 3650 },
  session_quota: { type: Schema.Types.Int32, required: true, min: 0, max: 10000 },
  price: { type: Schema.Types.Decimal128, required: true, validate: (value: Types.Decimal128) => {
    try { fromVndDecimal(value); return true; } catch { return false; }
  } },
  benefits: { type: String, required: true, maxlength: 1000 },
  status: { type: String, required: true, enum: ['ACTIVE', 'INACTIVE'] },
  version: { type: Schema.Types.Int32, required: true, default: 0, min: 0 },
  guard_revision: { type: Schema.Types.BigInt, required: true, default: 0n, validate: (value: bigint) => value >= 0n },
}, { collection: 'plans', id: false, versionKey: false });
PlanSchema.index({ code: 1 }, { unique: true, name: 'plans_code_unique' });
PlanSchema.pre('validate', function () {
  if (this.kind === 'GYM' && this.session_quota !== 0) this.invalidate('session_quota', 'Gói GYM dùng quota 0');
  if (this.kind === 'PT' && this.session_quota < 1) this.invalidate('session_quota', 'Gói PT cần ít nhất 1 buổi');
});
