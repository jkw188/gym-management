import { Schema, Types } from 'mongoose';
import { Refund } from './refund.schema';

export interface RefundAttempt {
  _id: Types.ObjectId; refund_id: Types.ObjectId; operation_id: string;
  status_before: Refund['status']; status_after: Refund['status']; actor_id: Types.ObjectId; occurred_at: Date;
  evidence_note: string; failure_reason?: string; method?: 'CASH' | 'TRANSFER';
  payout_evidence?: Refund['payout_evidence']; paid_out_at?: Date;
}
export const RefundAttemptSchema = new Schema<RefundAttempt>({
  refund_id: { type: Schema.Types.ObjectId, required: true }, operation_id: { type: String, required: true },
  status_before: { type: String, required: true, enum: ['PENDING', 'FAILED'] },
  status_after: { type: String, required: true, enum: ['FAILED', 'SUCCEEDED'] },
  actor_id: { type: Schema.Types.ObjectId, required: true }, occurred_at: { type: Date, required: true },
  evidence_note: { type: String, required: true, minlength: 10, maxlength: 500 }, failure_reason: String,
  method: { type: String, enum: ['CASH', 'TRANSFER'] }, payout_evidence: refundSchemaEvidence(), paid_out_at: Date,
}, { collection: 'refund_attempts', versionKey: false, strict: 'throw' });
function refundSchemaEvidence() {
  return { type: new Schema({ evidenceNote: String, payoutAccountCode: String, bankReference: String, cashVoucherReference: String }, { _id: false, strict: 'throw' }) };
}
RefundAttemptSchema.index({ operation_id: 1 }, { unique: true, name: 'refund_attempts_operation_unique' });
RefundAttemptSchema.index({ refund_id: 1, occurred_at: -1, _id: -1 }, { name: 'refund_attempts_refund_occurred' });
