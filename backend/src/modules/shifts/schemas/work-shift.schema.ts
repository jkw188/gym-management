// Tầng dữ liệu (US-24 bước 1): cấu trúc collection work_shifts, mỗi document là một ca làm việc của PT.
// Thời điểm lưu Date UTC; ca SCHEDULED là nháp, chỉ US-25 mới chuyển sang CONFIRMED/CANCELLED.
import { Schema, Types } from 'mongoose';
import { SHIFT_STATUSES, ShiftStatus } from '../shifts.types';

export interface WorkShift {
  _id: Types.ObjectId;
  id: Types.ObjectId;
  trainer_id: Types.ObjectId;
  start_at: Date;
  end_at: Date;
  location: string;
  status: ShiftStatus;
  version: number;
  created_by: Types.ObjectId;
  updated_by: Types.ObjectId;
  created_at: Date;
  updated_at: Date;
}

export const WorkShiftSchema = new Schema<WorkShift>({
  // Mục 4.2.14: id bắt buộc, unique, luôn bằng _id. Tự lấy giá trị _id khi tạo, không đổi được.
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (value: Types.ObjectId) { return value.equals(this._id); } },
  // Lấy từ principal ở service, không nhận từ client (US-24-F01).
  trainer_id: { type: Schema.Types.ObjectId, ref: 'Trainer', required: true },
  start_at: { type: Date, required: true },
  end_at: { type: Date, required: true },
  location: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  // US-24-TC07: chỉ 4 trạng thái theo mục 4.2.14.
  status: { type: String, required: true, enum: SHIFT_STATUSES, default: 'SCHEDULED' },
  // US-24-TC10: version ≥ 0, mỗi lần sửa tăng 1 để kiểm "đúng version" (CAS).
  version: { type: Number, required: true, min: 0, default: 0, validate: Number.isInteger },
  created_by: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  updated_by: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
// id: false tắt virtual id (chuỗi) mặc định của Mongoose để dùng field id thật ở trên.
// timestamps: Mongoose tự ghi created_at khi tạo và updated_at mỗi lần lưu.
}, { collection: 'work_shifts', id: false, versionKey: false, strict: 'throw',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

WorkShiftSchema.index({ id: 1 }, { unique: true, name: 'work_shifts_id_unique' });
// US-24-TC05: tìm ca còn hiệu lực của cùng PT để kiểm chồng ca. Index chỉ giúp query, không tự chặn overlap.
WorkShiftSchema.index({ trainer_id: 1, status: 1, start_at: 1, end_at: 1 }, { name: 'work_shifts_trainer_status_time' });
// Liệt kê lịch của PT sắp startAt ASC rồi id ASC.
WorkShiftSchema.index({ trainer_id: 1, start_at: 1, _id: 1 }, { name: 'work_shifts_trainer_start_id' });
