import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { isDuplicateKey } from '../../common/http/http-error.filter';
import { ACCESS_POLICY, PermissionCode } from './access.policy';
import { Permission, RolePermission } from './schemas/permission.schema';
import { Role, ROLE_CODES } from './schemas/role.schema';

@Injectable()
export class AccessCatalogService {
  constructor(@InjectModel('Role') private readonly roles: Model<Role>,
    @InjectModel('Permission') private readonly permissions: Model<Permission>,
    @InjectModel('RolePermission') private readonly mappings: Model<RolePermission>) {}

  async list() {
    const notReady = () => new ApplicationError(503, 'PERMISSION_CATALOG_NOT_READY', 'Danh mục quyền chưa sẵn sàng. Cần chạy seed:access và kiểm tra mapping cố định');
    try {
      for (const model of [this.permissions, this.mappings]) {
        const indexes = await model.collection.listIndexes().toArray();
        if (model.schema.indexes().some(([key]) => !indexes.some(index => index.unique === true && JSON.stringify(index.key) === JSON.stringify(key)))) throw notReady();
      }
      const [roles, permissions, mappings] = await Promise.all([
        this.roles.find({ code: { $in: ROLE_CODES } }).maxTimeMS(5000).lean().exec(),
        this.permissions.find({ code: { $in: Object.keys(ACCESS_POLICY) } }).maxTimeMS(5000).lean().exec(),
        this.mappings.find().maxTimeMS(5000).lean().exec(),
      ]);
      if (roles.length !== ROLE_CODES.length || permissions.length !== Object.keys(ACCESS_POLICY).length) throw notReady();
      const items = ROLE_CODES.map(code => {
        const role = roles.find(item => item.code === code)!;
        if (!role.id.equals(role._id)) throw notReady();
        const expected = (Object.keys(ACCESS_POLICY) as PermissionCode[]).filter(key => (ACCESS_POLICY[key].roles as readonly string[]).includes(code)).sort();
        const actual = mappings.filter(item => item.role_id.equals(role.id));
        if (actual.length !== expected.length) throw notReady();
        const allowed = expected.map(key => {
          const permission = permissions.find(item => item.code === key);
          if (!permission || !permission.id.equals(permission._id) || permission.name !== ACCESS_POLICY[key].name ||
            !actual.some(item => item.permission_id.equals(permission.id))) throw notReady();
          return { code: key, name: permission.name };
        });
        return { code, name: role.name, permissions: allowed };
      });
      return { items };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Không thể đọc danh mục quyền');
    }
  }

  // Operational command only. HTTP requests never call seed or repair configuration.
  async seed(): Promise<void> {
    const names = { ADMIN: 'Quản trị viên', STAFF: 'Nhân viên', TRAINER: 'PT', MEMBER: 'Hội viên' };
    for (const code of ROLE_CODES) {
      const id = new Types.ObjectId();
      await this.upsert(() => this.roles.updateOne({ code }, { $setOnInsert: { _id: id, id, code, name: names[code] } }, { upsert: true, runValidators: true }).exec());
    }
    for (const code of Object.keys(ACCESS_POLICY) as PermissionCode[]) {
      const id = new Types.ObjectId();
      await this.upsert(() => this.permissions.updateOne({ code }, { $set: { name: ACCESS_POLICY[code].name }, $setOnInsert: { _id: id, id, code } }, { upsert: true, runValidators: true }).exec());
      const permission = await this.permissions.findOne({ code }).orFail().exec();
      for (const roleCode of ACCESS_POLICY[code].roles) {
        const role = await this.roles.findOne({ code: roleCode }).orFail().exec();
        await this.upsert(() => this.mappings.updateOne({ role_id: role.id, permission_id: permission.id },
          { $setOnInsert: { role_id: role.id, permission_id: permission.id } }, { upsert: true, runValidators: true }).exec());
      }
    }
    // Unexpected mappings fail verification; do not silently delete existing configuration.
    await this.list();
  }

  private async upsert(write: () => Promise<unknown>): Promise<void> {
    try { await write(); }
    catch (error) { if (!isDuplicateKey(error)) throw error; await write(); }
  }
}
