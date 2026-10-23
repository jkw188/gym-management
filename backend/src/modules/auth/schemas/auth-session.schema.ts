import { Schema, Types } from 'mongoose';

export interface AuthSession {
  _id: Types.ObjectId; id: Types.ObjectId; account_id: Types.ObjectId;
  refresh_hash: string; auth_version: number; expires_at: Date; revoked_at?: Date; created_at: Date;
}

export const AuthSessionSchema = new Schema<AuthSession>({
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (value: Types.ObjectId) { return value.equals(this._id); } },
  account_id: { type: Schema.Types.ObjectId, ref: 'Account', required: true, immutable: true },
  refresh_hash: { type: String, required: true, select: false, match: /^[a-f0-9]{64}$/ },
  auth_version: { type: Schema.Types.Int32, required: true, immutable: true, validate: (value: number) => Number.isInteger(value) && value >= 0 },
  expires_at: { type: Date, required: true, immutable: true },
  revoked_at: { type: Date },
  created_at: { type: Date, required: true, immutable: true, default: Date.now },
}, {
  collection: 'auth_sessions', id: false, versionKey: false, strict: 'throw',
  toJSON: { transform: (_document, result) => { const { refresh_hash: _hash, ...safe } = result; return safe; } },
});
AuthSessionSchema.index({ id: 1 }, { unique: true, name: 'auth_sessions_id_unique' });
AuthSessionSchema.index({ account_id: 1 }, { name: 'auth_sessions_account' });
AuthSessionSchema.index({ refresh_hash: 1 }, { unique: true, name: 'auth_sessions_refresh_unique' });
AuthSessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'auth_sessions_expiry_ttl' });
