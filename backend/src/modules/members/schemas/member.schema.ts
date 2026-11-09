import { Schema, Types } from 'mongoose';
import { normalizeFullName, normalizePhone } from '../../../common/utils/normalization';

export interface Member {
  _id: Types.ObjectId; id: Types.ObjectId; member_code: string; account_id?: Types.ObjectId;
  full_name: string; phone: string; birth_date?: string; address?: string;
  version: number; service_revision: bigint;
  created_by: Types.ObjectId; updated_by: Types.ObjectId; created_at: Date; updated_at: Date;
}

export const MemberSchema = new Schema<Member>({
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (this: Member, value: Types.ObjectId) { return value.equals(this._id); } },
  member_code: { type: String, required: true, immutable: true, maxlength: 30, match: /^HV-[a-f0-9]{24}$/ },
  account_id: { type: Schema.Types.ObjectId, ref: 'Account' },
  full_name: { type: String, required: true, set: normalizeFullName },
  phone: { type: String, required: true, maxlength: 20, set: normalizePhone },
  birth_date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
  address: { type: String, maxlength: 255 },
  version: { type: Schema.Types.Int32, required: true, default: 0, min: 0 },
  service_revision: { type: Schema.Types.BigInt, required: true, default: 0n, validate: (value: bigint) => value >= 0n },
  created_by: { type: Schema.Types.ObjectId, required: true },
  updated_by: { type: Schema.Types.ObjectId, required: true },
}, { collection: 'members', id: false, versionKey: false, strict: 'throw',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });
MemberSchema.index({ member_code: 1 }, { unique: true, name: 'members_code_unique' });
MemberSchema.index({ phone: 1 }, { unique: true, name: 'members_phone_unique' });
MemberSchema.index({ account_id: 1 }, { unique: true, name: 'members_account_unique',
  partialFilterExpression: { account_id: { $type: 'objectId' } } });
MemberSchema.index({ created_at: -1, _id: -1 }, { name: 'members_created_desc' });
