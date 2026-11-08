// Tầng dữ liệu (US-26 bước 1, 2): cấu trúc collection public_sessions, mỗi document là một lớp miễn phí.
// Field theo mục 4.2.17 + phần bổ sung của US-66 (subject_code, DRAFT, version, audit). US-26 chỉ đọc; US-66 sẽ là nơi ghi.
import { Schema, Types } from 'mongoose';
import { SESSION_STATUSES, SessionStatus, SUBJECT_CODES, SubjectCode } from '../public-sessions.types';

export interface PublicSession {
  _id: Types.ObjectId;
  id: Types.ObjectId;
  trainer_id: Types.ObjectId;
  title: string;
  subject_code: SubjectCode;
  location: string;
  start_at: Date;
  end_at: Date;
  status: SessionStatus;
  version: number;
  created_by: Types.ObjectId;
  updated_by: Types.ObjectId;
  published_at?: Date;
  cancelled_at?: Date;
  cancelled_by?: Types.ObjectId;
  cancellation_reason?: string;
  created_at: Date;
  updated_at: Date;
}

export const PublicSessionSchema = new Schema<PublicSession>({
  // Mục 4.2.17: id bắt buộc, unique, luôn bằng _id.
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (value: Types.ObjectId) { return value.equals(this._id); } },
  trainer_id: { type: Schema.Types.ObjectId, ref: 'Trainer', required: true },
  title: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  // US-66: bộ môn bắt buộc, chỉ nhận mã trong taxonomy S04.
  subject_code: { type: String, required: true, enum: SUBJECT_CODES },
  location: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  start_at: { type: Date, required: true },
  end_at: { type: Date, required: true },
  status: { type: String, required: true, enum: SESSION_STATUSES, maxlength: 20, default: 'DRAFT' },
  version: { type: Number, required: true, min: 0, default: 0, validate: Number.isInteger },
  created_by: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  updated_by: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  published_at: { type: Date },
  cancelled_at: { type: Date },
  cancelled_by: { type: Schema.Types.ObjectId, ref: 'Account' },
  cancellation_reason: { type: String, maxlength: 500 },
}, { collection: 'public_sessions', id: false, versionKey: false, strict: 'throw',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

PublicSessionSchema.index({ id: 1 }, { unique: true, name: 'public_sessions_id_unique' });
// US-26 mục index: lịch công khai lọc theo status, sắp start_at rồi _id.
PublicSessionSchema.index({ status: 1, start_at: 1, _id: 1 }, { name: 'public_sessions_status_start_id' });
// Lọc theo bộ môn.
PublicSessionSchema.index({ status: 1, subject_code: 1, start_at: 1 }, { name: 'public_sessions_status_subject_start' });
// Lọc theo PT; US-27/28 dùng để loại giờ PT bận vì lớp PUBLISHED.
PublicSessionSchema.index({ trainer_id: 1, status: 1, start_at: 1, end_at: 1 }, { name: 'public_sessions_trainer_status_time' });
