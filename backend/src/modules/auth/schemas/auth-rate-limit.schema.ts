// Tầng dữ liệu: cấu trúc collection auth_rate_limits, bộ đếm giới hạn dùng chung giữa các instance (US-67-F05).
// Tên collection và các field theo bảng auth_rate_limits trong spec US-05 để US-05 dùng lại được.
import { Schema } from 'mongoose';

export interface AuthRateLimit {
  key: string; bucket: number; count: number; window_start: Date; expires_at: Date;
}

export const AuthRateLimitSchema = new Schema<AuthRateLimit>({
  key: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  bucket: { type: Number, required: true },
  count: { type: Schema.Types.Int32, required: true },
  window_start: { type: Date, required: true },
  expires_at: { type: Date, required: true },
}, { collection: 'auth_rate_limits', id: false, versionKey: false, strict: 'throw' });

AuthRateLimitSchema.index({ key: 1, bucket: 1 }, { unique: true, name: 'auth_rate_limits_key_bucket_unique' });
AuthRateLimitSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'auth_rate_limits_expiry_ttl' });
