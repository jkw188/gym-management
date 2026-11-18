import { Schema, Types } from 'mongoose';

export interface AttendanceRecord {
  _id: Types.ObjectId;
  id: Types.ObjectId;
  shift_id: Types.ObjectId;
  trainer_id: Types.ObjectId;
  check_in_at: Date;
  check_out_at?: Date;
  recorded_by: Types.ObjectId;
  checked_out_by?: Types.ObjectId;
  note?: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  last_corrected_by?: Types.ObjectId;
  last_corrected_at?: Date;
}

export const AttendanceSchema = new Schema<AttendanceRecord>({
  id: { type: Schema.Types.ObjectId, required: true },
  shift_id: { type: Schema.Types.ObjectId, required: true, immutable: true },
  trainer_id: { type: Schema.Types.ObjectId, required: true, immutable: true },
  check_in_at: { type: Date, required: true }, check_out_at: Date,
  recorded_by: { type: Schema.Types.ObjectId, required: true, immutable: true },
  checked_out_by: Schema.Types.ObjectId, note: { type: String, maxlength: 255 },
  version: { type: Number, required: true, min: 0 },
  created_at: { type: Date, required: true, immutable: true }, updated_at: { type: Date, required: true },
  last_corrected_by: Schema.Types.ObjectId, last_corrected_at: Date,
}, { collection: 'trainer_attendance', versionKey: false, strict: 'throw' });
AttendanceSchema.index({ shift_id: 1 }, { unique: true, name: 'trainer_attendance_shift_unique' });
AttendanceSchema.index({ trainer_id: 1, check_in_at: 1 }, { name: 'trainer_attendance_trainer_in' });

export const AttendanceEventSchema = new Schema({
  shift_id: { type: Schema.Types.ObjectId, required: true },
  attendance_id: { type: Schema.Types.ObjectId, required: true },
  action: { type: String, enum: ['CHECK_IN', 'CHECK_OUT', 'CORRECT'], required: true },
  actor_id: { type: Schema.Types.ObjectId, required: true }, occurred_at: { type: Date, required: true },
  before: Schema.Types.Mixed, after: { type: Schema.Types.Mixed, required: true },
  reason: { type: String, minlength: 10, maxlength: 500 }, operation_id: { type: String, required: true },
}, { collection: 'attendance_events', versionKey: false, strict: 'throw' });
AttendanceEventSchema.index({ operation_id: 1 }, { unique: true, name: 'attendance_events_operation_unique',
  partialFilterExpression: { operation_id: { $type: 'string' } } });
AttendanceEventSchema.index({ attendance_id: 1, occurred_at: 1 }, { name: 'attendance_events_attendance_time' });
AttendanceEventSchema.index({ shift_id: 1, occurred_at: 1, _id: 1 }, { name: 'attendance_events_shift_time' });
