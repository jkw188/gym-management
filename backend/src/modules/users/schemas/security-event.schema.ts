import { Schema, Types } from 'mongoose';
import { AccountStatus } from './account.schema';
import { RoleCode, ROLE_CODES } from './role.schema';

export interface SecurityEvent {
  _id: Types.ObjectId; actor_id: Types.ObjectId; target_id: Types.ObjectId;
  action: 'LOCK' | 'UNLOCK' | 'CHANGE_ROLE';
  before: { status?: AccountStatus; roleCode?: RoleCode };
  after: { status?: AccountStatus; roleCode?: RoleCode };
  reason: string; created_at: Date; request_id: string;
}
const valueSchema = new Schema({
  status: { type: String, enum: ['ACTIVE', 'LOCKED'] },
  roleCode: { type: String, enum: ROLE_CODES },
}, { _id: false, strict: 'throw' });
export const SecurityEventSchema = new Schema<SecurityEvent>({
  actor_id: { type: Schema.Types.ObjectId, required: true, immutable: true },
  target_id: { type: Schema.Types.ObjectId, required: true, immutable: true },
  action: { type: String, enum: ['LOCK', 'UNLOCK', 'CHANGE_ROLE'], required: true, immutable: true },
  before: { type: valueSchema, required: true, immutable: true },
  after: { type: valueSchema, required: true, immutable: true },
  reason: { type: String, trim: true, minlength: 10, maxlength: 500, required: true, immutable: true },
  created_at: { type: Date, default: Date.now, required: true, immutable: true },
  request_id: { type: String, required: true, immutable: true },
}, { collection: 'security_events', versionKey: false, strict: 'throw' });
SecurityEventSchema.index({ target_id: 1, created_at: -1, _id: -1 }, { name: 'security_events_target_history' });
SecurityEventSchema.index({ actor_id: 1, created_at: -1 }, { name: 'security_events_actor_history' });
