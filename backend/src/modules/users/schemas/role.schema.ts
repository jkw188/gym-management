import { Query, Schema, Types } from 'mongoose';

export const ROLE_CODES = ['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as const;
export type RoleCode = typeof ROLE_CODES[number];
export interface Role {
  _id: Types.ObjectId; id: Types.ObjectId; code: RoleCode; name: string;
  created_at: Date; updated_at: Date;
}

export const RoleSchema = new Schema<Role>({
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (this: Role | Query<unknown, Role>, value: Types.ObjectId) {
      if (this instanceof Query) {
        const update = this.getUpdate();
        return !!update && !Array.isArray(update) && value.equals(update.$setOnInsert?._id ?? update.$set?._id);
      }
      return value.equals(this._id);
    } },
  code: { type: String, enum: ROLE_CODES, required: true, maxlength: 20 },
  name: { type: String, required: true, trim: true, maxlength: 120 },
}, { collection: 'roles', id: false, versionKey: false, strict: 'throw', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });
RoleSchema.index({ id: 1 }, { unique: true, name: 'roles_id_unique' });
RoleSchema.index({ code: 1 }, { unique: true, name: 'roles_code_unique' });
