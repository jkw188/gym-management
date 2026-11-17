import { Schema, Types } from 'mongoose';
import { ReminderMilestone, ReminderSource, ReminderStatus } from './reminder.policy';

export interface ReminderOccurrence {
  _id: Types.ObjectId;
  event_key: string;
  source_type: ReminderSource;
  source_id: Types.ObjectId;
  milestone: ReminderMilestone;
  due_at: Date;
  status: ReminderStatus;
  reason_code?: string;
  notification_id?: Types.ObjectId;
  source_snapshot: { member_id: Types.ObjectId; membership_id?: Types.ObjectId; end_date?: string;
    start_at?: Date; plan_name?: string; trainer_name?: string; location?: string };
  created_at: Date;
}

export const ReminderOccurrenceSchema = new Schema<ReminderOccurrence>({
  event_key: { type: String, required: true, maxlength: 120, immutable: true },
  source_type: { type: String, enum: ['MEMBERSHIP', 'PT_BOOKING'], required: true },
  source_id: { type: Schema.Types.ObjectId, required: true },
  milestone: { type: String, enum: ['3D', '1D', '24H', '2H'], required: true },
  due_at: { type: Date, required: true },
  status: { type: String, enum: ['STORED', 'SKIPPED_STALE', 'SKIPPED_INELIGIBLE'], required: true },
  reason_code: { type: String, maxlength: 64 },
  notification_id: { type: Schema.Types.ObjectId },
  source_snapshot: { type: new Schema({ member_id: { type: Schema.Types.ObjectId, required: true },
    membership_id: Schema.Types.ObjectId, end_date: String, start_at: Date, plan_name: String,
    trainer_name: String, location: String }, { _id: false, strict: 'throw' }), required: true },
  created_at: { type: Date, required: true },
}, { collection: 'reminder_occurrences', versionKey: false, strict: 'throw' });
ReminderOccurrenceSchema.index({ source_type: 1, source_id: 1, milestone: 1 }, { unique: true, name: 'reminder_source_milestone_unique' });
ReminderOccurrenceSchema.index({ event_key: 1 }, { unique: true, name: 'reminder_event_key_unique' });
