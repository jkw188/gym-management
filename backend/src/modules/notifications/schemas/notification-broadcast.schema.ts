import { Schema, Types } from 'mongoose';
import { RoleCode, ROLE_CODES } from '../../users/schemas/role.schema';

export interface NotificationBroadcast {
  _id: Types.ObjectId; created_by: Types.ObjectId; audience: 'ALL_ACTIVE' | 'ROLES'; roles: RoleCode[];
  title: string; body: string; recipient_digest: string; recipient_count: number;
  preview_expires_at: Date; version: number; status: 'PREVIEW' | 'SENT';
  notification_id?: Types.ObjectId; created_at: Date; sent_at?: Date;
}

export const NotificationBroadcastSchema = new Schema<NotificationBroadcast>({
  created_by: { type: Schema.Types.ObjectId, required: true },
  audience: { type: String, enum: ['ALL_ACTIVE', 'ROLES'], required: true },
  roles: [{ type: String, enum: ROLE_CODES }],
  title: { type: String, required: true, maxlength: 190 },
  body: { type: String, required: true, maxlength: 2000 },
  recipient_digest: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  recipient_count: { type: Number, required: true, min: 0 },
  preview_expires_at: { type: Date, required: true },
  version: { type: Number, required: true, default: 0 },
  status: { type: String, enum: ['PREVIEW', 'SENT'], required: true, default: 'PREVIEW' },
  notification_id: { type: Schema.Types.ObjectId },
  created_at: { type: Date, required: true }, sent_at: { type: Date },
}, { collection: 'notification_broadcasts', versionKey: false, strict: 'throw' });
NotificationBroadcastSchema.index({ created_by: 1, created_at: -1 });
NotificationBroadcastSchema.index({ created_at: -1, _id: -1 });
NotificationBroadcastSchema.index({ notification_id: 1 }, {
  unique: true, partialFilterExpression: { notification_id: { $type: 'objectId' } }, name: 'broadcast_notification_unique',
});
