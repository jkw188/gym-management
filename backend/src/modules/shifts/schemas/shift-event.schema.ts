// Tầng dữ liệu (US-24 bước 1): cấu trúc collection shift_events, mỗi document là một dòng audit của ca làm việc.
// Ghi cùng transaction với thay đổi ca (US-24-F05); request_key unique để gửi lại cùng key không thêm audit.
import { Schema, Types } from 'mongoose';
import { SHIFT_ACTIONS, SHIFT_STATUSES, ShiftAction, ShiftStatus } from '../shifts.types';

// Ảnh chụp thời gian, địa điểm, trạng thái, version của ca trước hoặc sau thay đổi.
export interface ShiftSnapshot {
  start_at: Date;
  end_at: Date;
  location: string;
  status: ShiftStatus;
  version: number;
}

export interface ShiftEvent {
  _id: Types.ObjectId;
  shift_id: Types.ObjectId;
  actor_id: Types.ObjectId;
  action: ShiftAction;
  before?: ShiftSnapshot;
  after: ShiftSnapshot;
  reason?: string;
  occurred_at: Date;
  request_key: string;
}

// _id: false: snapshot là dữ liệu lồng bên trong, không cần _id riêng.
const ShiftSnapshotSchema = new Schema<ShiftSnapshot>({
  start_at: { type: Date, required: true },
  end_at: { type: Date, required: true },
  location: { type: String, required: true, maxlength: 120 },
  status: { type: String, required: true, enum: SHIFT_STATUSES },
  version: { type: Number, required: true, min: 0 },
}, { _id: false, strict: 'throw' });

export const ShiftEventSchema = new Schema<ShiftEvent>({
  shift_id: { type: Schema.Types.ObjectId, ref: 'WorkShift', required: true },
  actor_id: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  // US-24-TC10: chỉ 4 hành động.
  action: { type: String, required: true, enum: SHIFT_ACTIONS },
  // CREATED không có before; UPDATED/CONFIRMED/CANCELLED có cả before và after.
  before: { type: ShiftSnapshotSchema },
  after: { type: ShiftSnapshotSchema, required: true },
  // US-25-TC04: lý do hủy ca (action CANCELLED), tối đa 500 ký tự như cancellation_reason.
  reason: { type: String, maxlength: 500 },
  occurred_at: { type: Date, required: true },
  request_key: { type: String, required: true, maxlength: 120 },
}, { collection: 'shift_events', versionKey: false, strict: 'throw' });

// US-24-TC10: cùng request_key chỉ có một audit.
ShiftEventSchema.index({ request_key: 1 }, { unique: true, name: 'shift_events_request_key_unique' });
// Xem lịch sử một ca theo thời gian.
ShiftEventSchema.index({ shift_id: 1, occurred_at: 1 }, { name: 'shift_events_shift_time' });
