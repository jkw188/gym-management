// Tầng dữ liệu: cấu trúc collection auth_rate_limits, bộ đếm giới hạn dùng chung giữa các instance (US-67-F05).
// Mỗi key có một khung 15 phút riêng, tính từ lần đếm đầu tiên (window_start) đến expires_at.
import { Schema } from 'mongoose';

export interface AuthRateLimit {
  key: string; count: number; window_start: Date; expires_at: Date;
}

export const AuthRateLimitSchema = new Schema<AuthRateLimit>({
  key: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  count: { type: Schema.Types.Int32, required: true },
  window_start: { type: Date, required: true },
  expires_at: { type: Date, required: true },
}, { collection: 'auth_rate_limits', id: false, versionKey: false, strict: 'throw' });

AuthRateLimitSchema.index({ key: 1 }, { unique: true, name: 'auth_rate_limits_key_unique' });
AuthRateLimitSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'auth_rate_limits_expiry_ttl' });
