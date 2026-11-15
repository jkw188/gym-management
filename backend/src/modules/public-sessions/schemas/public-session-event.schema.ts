import { Schema, Types } from 'mongoose';
import { SESSION_STATUSES, SessionStatus, SUBJECT_CODES, SubjectCode } from '../public-sessions.types';

export interface SessionSnapshot {
  title: string; trainer_id: Types.ObjectId; subject_code: SubjectCode; location: string;
  start_at: Date; end_at: Date; status: SessionStatus; version: number;
}
export interface PublicSessionEvent {
  session_id: Types.ObjectId; actor_id: Types.ObjectId;
  action: 'CREATED' | 'UPDATED' | 'PUBLISHED' | 'CANCELLED';
  before?: SessionSnapshot; after: SessionSnapshot; reason?: string; occurred_at: Date; request_key: string;
}
const snapshotSchema = new Schema<SessionSnapshot>({
  title: { type: String, required: true }, trainer_id: { type: Schema.Types.ObjectId, required: true },
  subject_code: { type: String, enum: SUBJECT_CODES, required: true }, location: { type: String, required: true },
  start_at: { type: Date, required: true }, end_at: { type: Date, required: true },
  status: { type: String, enum: SESSION_STATUSES, required: true }, version: { type: Number, required: true },
}, { _id: false, strict: 'throw' });
export const PublicSessionEventSchema = new Schema<PublicSessionEvent>({
  session_id: { type: Schema.Types.ObjectId, required: true, ref: 'PublicSession' },
  actor_id: { type: Schema.Types.ObjectId, required: true, ref: 'Account' },
  action: { type: String, enum: ['CREATED', 'UPDATED', 'PUBLISHED', 'CANCELLED'], required: true },
  before: snapshotSchema, after: { type: snapshotSchema, required: true }, reason: { type: String, maxlength: 500 },
  occurred_at: { type: Date, required: true }, request_key: { type: String, required: true },
}, { collection: 'public_session_events', versionKey: false, strict: 'throw' });
PublicSessionEventSchema.index({ request_key: 1 }, { unique: true, name: 'public_session_events_request_unique' });
PublicSessionEventSchema.index({ session_id: 1, occurred_at: 1 }, { name: 'public_session_events_session_time' });
