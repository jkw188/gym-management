import { Query, Schema, Types } from 'mongoose';

export interface Permission { _id: Types.ObjectId; id: Types.ObjectId; code: string; name: string }
export interface RolePermission { _id: Types.ObjectId; role_id: Types.ObjectId; permission_id: Types.ObjectId }

export const PermissionSchema = new Schema<Permission>({
  id: { type: Schema.Types.ObjectId, required: true, immutable: true, default: function () { return this._id; },
    validate: function (this: Permission | Query<unknown, Permission>, value: Types.ObjectId) {
      if (this instanceof Query) {
        const update = this.getUpdate();
        return !!update && !Array.isArray(update) && value.equals(update.$setOnInsert?._id ?? update.$set?._id);
      }
      return value.equals(this._id);
    } },
  code: { type: String, required: true, trim: true, maxlength: 80 },
  name: { type: String, required: true, trim: true, maxlength: 120 },
}, { collection: 'permissions', id: false, versionKey: false, strict: 'throw' });
PermissionSchema.index({ id: 1 }, { unique: true, name: 'permissions_id_unique' });
PermissionSchema.index({ code: 1 }, { unique: true, name: 'permissions_code_unique' });

export const RolePermissionSchema = new Schema<RolePermission>({
  role_id: { type: Schema.Types.ObjectId, required: true },
  permission_id: { type: Schema.Types.ObjectId, required: true },
}, { collection: 'role_permissions', versionKey: false, strict: 'throw' });
RolePermissionSchema.index({ role_id: 1, permission_id: 1 }, { unique: true, name: 'role_permissions_pair_unique' });
