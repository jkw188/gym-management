import { Schema, Types } from 'mongoose';
import { fromVndDecimal } from '../../common/utils/vnd-money';

export const REFUND_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;
export interface Refund {
  _id: Types.ObjectId; id: Types.ObjectId; return_id?: Types.ObjectId; order_id: Types.ObjectId;
  payment_id: Types.ObjectId; reason: 'CANCELLATION' | 'RETURN'; reference: string; obligation_key: string;
  amount: Types.Decimal128; status: typeof REFUND_STATUSES[number]; created_at: Date; created_by?: Types.ObjectId;
  actor_type: 'USER' | 'SYSTEM'; refunded_at?: Date;
}
export const RefundSchema = new Schema<Refund>({
  id: { type: Schema.Types.ObjectId, required: true, default: function (this: Refund) { return this._id; }, validate: function (this: Refund, id: Types.ObjectId) { return id.equals(this._id); } },
  return_id: Schema.Types.ObjectId, order_id: { type: Schema.Types.ObjectId, required: true }, payment_id: { type: Schema.Types.ObjectId, required: true },
  reason: { type: String, required: true, enum: ['CANCELLATION', 'RETURN'] }, reference: { type: String, required: true, maxlength: 100 },
  obligation_key: { type: String, required: true, maxlength: 100 },
  amount: { type: Schema.Types.Decimal128, required: true, validate: (value: Types.Decimal128) => { try { return BigInt(fromVndDecimal(value)) > 0n; } catch { return false; } } },
  status: { type: String, required: true, enum: REFUND_STATUSES }, created_at: { type: Date, required: true }, created_by: Schema.Types.ObjectId,
  actor_type: { type: String, required: true, enum: ['USER', 'SYSTEM'] }, refunded_at: Date,
}, { collection: 'refunds', strict: 'throw', versionKey: false, id: false });
RefundSchema.index({ reference: 1 }, { unique: true, name: 'refunds_reference_unique' });
RefundSchema.index({ obligation_key: 1 }, { unique: true, name: 'refunds_obligation_unique' });
RefundSchema.index({ order_id: 1, created_at: -1, _id: -1 }, { name: 'refunds_order_created' });
RefundSchema.index({ payment_id: 1 }, { name: 'refunds_payment' });
RefundSchema.index({ status: 1, created_at: -1, _id: -1 }, { name: 'refunds_status_created' });
