import { Schema, Types } from 'mongoose';
import { normalizeEmail, normalizeFullName, normalizePhone } from '../../../common/utils/normalization';

export type AccountStatus = 'ACTIVE' | 'LOCKED';
export interface Account {
  _id: Types.ObjectId; id: Types.ObjectId; role_id: Types.ObjectId;
  full_name: string; phone: string; email?: string; password_hash: string;
  status: AccountStatus; version: number; auth_version: number; created_at: Date; updated_at: Date;
}

export const AccountSchema = new Schema<Account>({
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (value: Types.ObjectId) { return value.equals(this._id); } },
  role_id: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
  full_name: { type: String, required: true, set: normalizeFullName },
  phone: { type: String, required: true, maxlength: 20, set: normalizePhone },
  email: { type: String, maxlength: 190, set: normalizeEmail },
  password_hash: { type: String, required: true, maxlength: 255, select: false,
    validate: (value: string) => /^\$argon2id\$/.test(value) },
  status: { type: String, enum: ['ACTIVE', 'LOCKED'], required: true, default: 'ACTIVE' },
  version: { type: Schema.Types.Int32, required: true, default: 0, validate: (value: number) => Number.isInteger(value) && value >= 0 },
  auth_version: { type: Schema.Types.Int32, required: true, default: 0, validate: (value: number) => Number.isInteger(value) && value >= 0 },
}, {
  collection: 'accounts', id: false, versionKey: false, strict: 'throw',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  toJSON: { transform: (_document, result) => { const { password_hash: _passwordHash, ...safe } = result; return safe; } },
});
AccountSchema.index({ id: 1 }, { unique: true, name: 'accounts_id_unique' });
AccountSchema.index({ phone: 1 }, { unique: true, name: 'accounts_phone_unique' });
AccountSchema.index({ email: 1 }, { unique: true, name: 'accounts_email_unique', partialFilterExpression: { email: { $type: 'string', $gt: '' } } });
