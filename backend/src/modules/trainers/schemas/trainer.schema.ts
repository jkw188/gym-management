import { Schema, Types } from 'mongoose';

export const TRAINER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type TrainerStatus = typeof TRAINER_STATUSES[number];
export interface Trainer {
  _id: Types.ObjectId; id: Types.ObjectId; account_id: Types.ObjectId;
  specialty: string; status: TrainerStatus; version: number;
  created_at: Date; updated_at: Date; created_by: Types.ObjectId; updated_by: Types.ObjectId;
}

export const TrainerSchema = new Schema<Trainer>({
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (value: Types.ObjectId) { return value.equals(this._id); } },
  account_id: { type: Schema.Types.ObjectId, required: true, immutable: true, ref: 'Account' },
  specialty: { type: String, required: true, trim: true, minlength: 1, maxlength: 255 },
  status: { type: String, required: true, enum: TRAINER_STATUSES },
  version: { type: Schema.Types.Int32, required: true, default: 0, min: 0 },
  created_by: { type: Schema.Types.ObjectId, required: true, immutable: true },
  updated_by: { type: Schema.Types.ObjectId, required: true },
}, { collection: 'trainers', id: false, versionKey: false, strict: 'throw',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });
TrainerSchema.index({ account_id: 1 }, { unique: true, name: 'trainers_account_unique' });
TrainerSchema.index({ status: 1, _id: 1 }, { name: 'trainers_status_id' });
