import { Schema, Types } from 'mongoose';
import { TRAINER_STATUSES, TrainerStatus } from './trainer.schema';

export interface TrainerSnapshot { specialty: string; status: TrainerStatus; version: number }
export interface TrainerEvent {
  _id: Types.ObjectId; trainer_id: Types.ObjectId; actor_id: Types.ObjectId;
  action: 'CREATED' | 'UPDATED' | 'DEACTIVATED' | 'REACTIVATED';
  before?: TrainerSnapshot; after: TrainerSnapshot; occurred_at: Date; request_key: string;
}
const snapshot = new Schema<TrainerSnapshot>({
  specialty: { type: String, required: true, maxlength: 255 },
  status: { type: String, required: true, enum: TRAINER_STATUSES },
  version: { type: Schema.Types.Int32, required: true, min: 0 },
}, { _id: false, strict: 'throw' });
export const TrainerEventSchema = new Schema<TrainerEvent>({
  trainer_id: { type: Schema.Types.ObjectId, required: true },
  actor_id: { type: Schema.Types.ObjectId, required: true },
  action: { type: String, required: true, enum: ['CREATED', 'UPDATED', 'DEACTIVATED', 'REACTIVATED'] },
  before: { type: snapshot }, after: { type: snapshot, required: true },
  occurred_at: { type: Date, required: true }, request_key: { type: String, required: true },
}, { collection: 'trainer_events', versionKey: false, strict: 'throw' });
TrainerEventSchema.index({ request_key: 1 }, { unique: true, name: 'trainer_events_request_unique' });
TrainerEventSchema.index({ trainer_id: 1, occurred_at: 1, _id: 1 }, { name: 'trainer_events_history' });
