// Tầng dữ liệu: cấu trúc collection password_resets, mỗi record là một flow quên mật khẩu (US-05, bảng "Lưu mã").
// Không lưu OTP hay challenge thô: chỉ lưu token_hash (HMAC) và challenge_hash (SHA-256).
import { Schema, Types } from 'mongoose';

export interface PasswordReset {
  _id: Types.ObjectId; id: Types.ObjectId; account_id: Types.ObjectId;
  token_hash: string; challenge_hash: string; expires_at: Date; used_at?: Date; invalidated_at?: Date; attempts: number;
  auth_version_snapshot: number; recovery_revision_snapshot: number; email_snapshot: string; created_at: Date;
}

export const PasswordResetSchema = new Schema<PasswordReset>({
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; } },
  account_id: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  token_hash: { type: String, required: true, maxlength: 255 },
  challenge_hash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  expires_at: { type: Date, required: true },
  used_at: { type: Date },
  invalidated_at: { type: Date },
  attempts: { type: Schema.Types.Int32, required: true, default: 0, min: 0 },
  auth_version_snapshot: { type: Schema.Types.Int32, required: true },
  recovery_revision_snapshot: { type: Schema.Types.Int32, required: true },
  email_snapshot: { type: String, required: true, maxlength: 190 },
  created_at: { type: Date, required: true },
}, { collection: 'password_resets', id: false, versionKey: false, strict: 'throw' });

PasswordResetSchema.index({ token_hash: 1 }, { unique: true, name: 'password_resets_token_hash_unique' });
PasswordResetSchema.index({ challenge_hash: 1 }, { unique: true, name: 'password_resets_challenge_hash_unique' });
PasswordResetSchema.index({ account_id: 1, created_at: 1 }, { name: 'password_resets_account_created' });
// TTL chỉ dọn rác trễ 1 ngày sau khi hết hạn; hạn mã do service kiểm tra theo expires_at, không dựa vào TTL.
PasswordResetSchema.index({ expires_at: 1 }, { expireAfterSeconds: 24 * 60 * 60, name: 'password_resets_expiry_ttl' });
