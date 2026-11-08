// Tầng dữ liệu (US-09 bước 1): cấu trúc collection members, mỗi document là một hồ sơ hội viên lập tại quầy.
// MembersModule sở hữu schema và index của collection này; module khác (US-01 đăng ký) chỉ đọc.
import { Schema, Types } from 'mongoose';

export interface Member {
  _id: Types.ObjectId;
  id: Types.ObjectId;
  member_code: string;
  // Chỉ có khi đã liên kết tài khoản (bước 3). Lúc tạo KHÔNG ghi field này, kể cả null (US-09-TC04).
  account_id?: Types.ObjectId;
  full_name: string;
  phone: string;
  birth_date?: string;
  address?: string;
  version: number;
  service_revision: bigint;
  created_by: Types.ObjectId;
  updated_by: Types.ObjectId;
  created_at: Date;
  updated_at: Date;
}

export const MemberSchema = new Schema<Member>({
  // Báo cáo mục 4.2: id bắt buộc, luôn bằng _id. Tự lấy giá trị _id khi tạo, không đổi được.
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (value: Types.ObjectId) { return value.equals(this._id); } },
  // US-09-F02: server sinh "HV-" + id (27 ký tự); giới hạn 30 theo bảng collection.
  member_code: { type: String, required: true, immutable: true, maxlength: 30 },
  account_id: { type: Schema.Types.ObjectId, ref: 'Account' },
  full_name: { type: String, required: true, maxlength: 120 },
  // Phone đã chuẩn hóa EN01-D01 ở service (ví dụ +84901234567).
  phone: { type: String, required: true, maxlength: 20 },
  // Ngày sinh dạng YYYY-MM-DD giống accounts.birth_date.
  birth_date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
  address: { type: String, maxlength: 255 },
  version: { type: Number, required: true, min: 0, default: 0, validate: Number.isInteger },
  // Int64 mặc định 0; bán gói và liên kết tài khoản tăng số này để khóa hồ sơ (US-09-F06, US-14).
  service_revision: { type: Schema.Types.BigInt, required: true, default: 0n },
  created_by: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  updated_by: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
// id: false tắt virtual id (chuỗi) của Mongoose để dùng field id thật ở trên.
// timestamps: Mongoose tự ghi created_at khi tạo và updated_at mỗi lần lưu (Date UTC).
}, { collection: 'members', id: false, versionKey: false, strict: 'throw',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

MemberSchema.index({ id: 1 }, { unique: true, name: 'members_id_unique' });
// US-09-TC05: một số điện thoại (đã chuẩn hóa) chỉ có một hồ sơ, kể cả khi hai request chạy cùng lúc.
MemberSchema.index({ phone: 1 }, { unique: true, name: 'members_phone_unique' });
MemberSchema.index({ member_code: 1 }, { unique: true, name: 'members_member_code_unique' });
// US-09-TC04: chỉ áp dụng cho document có account_id kiểu ObjectId, nên nhiều hồ sơ chưa liên kết vẫn tạo được;
// một tài khoản không thể gắn với hai hồ sơ.
MemberSchema.index({ account_id: 1 }, { unique: true, name: 'members_account_id_unique',
  partialFilterExpression: { account_id: { $type: 'objectId' } } });
// Danh sách hồ sơ mới nhất trước (US-11 dùng).
MemberSchema.index({ created_at: -1, _id: -1 }, { name: 'members_created_at_id' });
