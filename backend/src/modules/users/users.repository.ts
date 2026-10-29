import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types, UpdateQuery } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { isDuplicateKey } from '../../common/http/http-error.filter';
import { normalizeEmail, normalizeFullName, normalizePhone, validateObjectId } from '../../common/utils/normalization';
import { Account } from './schemas/account.schema';
import { Role, ROLE_CODES, RoleCode } from './schemas/role.schema';
import { ListUsersDto } from './users.dto';

export interface CreateAccountInput { roleId: string; fullName: string; phone: string; email?: string; passwordHash: string }
export interface AccountChanges {
  fullName?: string; phone?: string; email?: string | null; birthDate?: string | null; address?: string | null;
}

@Injectable()
export class UsersRepository implements OnModuleInit {
  private indexesReady = false;
  constructor(@InjectModel('Account') private readonly accounts: Model<Account>, @InjectModel('Role') private readonly roles: Model<Role>, private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get('nodeEnv') !== 'production') {
      await Promise.all([this.accounts.createIndexes(), this.roles.createIndexes()]);
    }
    // Production verifies existing indexes without creating or dropping any index.
    for (const model of [this.accounts, this.roles]) {
      const actual = await model.collection.listIndexes().toArray();
      for (const [key, options] of model.schema.indexes()) {
        if (!actual.some(index => JSON.stringify(index.key) === JSON.stringify(key) && index.unique === true &&
          JSON.stringify(index.partialFilterExpression) === JSON.stringify(options.partialFilterExpression))) {
          throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
        }
      }
    }
    this.indexesReady = true;
  }

  findAccountById(id: string) { return this.accounts.findOne({ id: new Types.ObjectId(validateObjectId(id)) }).maxTimeMS(5000).exec(); }
  findAccountByPhone(phone: string) { return this.accounts.findOne({ phone: normalizePhone(phone) }).exec(); }
  findCredentialsByPhone(phone: string) { return this.accounts.findOne({ phone: normalizePhone(phone) }).select('+password_hash').exec(); }
  findRoleByCode(code: RoleCode) { return this.roles.findOne({ code }).exec(); }
  findRoleById(id: string) { return this.roles.findOne({ id: new Types.ObjectId(validateObjectId(id)) }).exec(); }

  async listRoles() {
    const roles = await this.roles.find({ code: { $in: ROLE_CODES } }).maxTimeMS(5000).exec();
    return roles.sort((left, right) => ROLE_CODES.indexOf(left.code) - ROLE_CODES.indexOf(right.code));
  }

  async listAccounts(query: ListUsersDto, roleId?: string) {
    const filter: QueryFilter<Account> = {};
    if (query.roleCode) filter.role_id = roleId ? new Types.ObjectId(roleId) : { $in: [] };
    if (query.status) filter.status = query.status;
    const term = query.q?.trim().replace(/\s+/g, ' ');
    if (term) {
      const literal = (value: string) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      let phoneTerm = term;
      try { phoneTerm = normalizePhone(term); }
      catch (error) {
        if (!(error instanceof ApplicationError) || error.status !== 400) throw error;
        // Permit partial phone searches using the same domestic prefixes as EN01-D01.
        if (/^[+\d\s.()\-]+$/.test(term)) {
          const digits = term.replace(/[\s.()\-]/g, '');
          if (/^\+?\d+$/.test(digits)) phoneTerm = digits.replace(/^0/, '+84').replace(/^84/, '+84');
        }
      }
      filter.$or = [{ full_name: literal(term) }, { email: literal(term.toLowerCase()) }, { phone: literal(phoneTerm) }];
    }
    const [items, total] = await Promise.all([
      this.accounts.find(filter).sort({ created_at: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).maxTimeMS(5000).exec(),
      this.accounts.countDocuments(filter).maxTimeMS(5000).exec(),
    ]);
    return { items, total };
  }

  findIdentifier(field: 'phone' | 'email', value: string, excludeId?: string) {
    return this.accounts.exists({ [field]: value, ...(excludeId ? { _id: { $ne: new Types.ObjectId(excludeId) } } : {}) }).maxTimeMS(5000).exec();
  }

  findAccountAtVersion(id: string, version: number) {
    return this.accounts.findOne({ _id: new Types.ObjectId(id), version }).maxTimeMS(5000).exec();
  }

  updateAccount(id: string, version: number, changes: AccountChanges) {
    const fields = { full_name: changes.fullName, phone: changes.phone, email: changes.email,
      birth_date: changes.birthDate, address: changes.address };
    const set: Record<string, string> = {};
    const unset: Record<string, ''> = {};
    for (const [field, value] of Object.entries(fields)) {
      if (value === null) unset[field] = '';
      else if (value !== undefined) set[field] = value;
    }
    const update: UpdateQuery<Account> = { $set: set, $inc: { version: 1 } };
    if (Object.keys(unset).length) update.$unset = unset;
    if (changes.phone !== undefined || changes.email !== undefined) update.$inc!.auth_version = 1;
    return this.accounts.findOneAndUpdate({ _id: new Types.ObjectId(id), version }, update,
      { returnDocument: 'after', runValidators: true, maxTimeMS: 5000 }).exec();
  }

  async createAccount(input: CreateAccountInput) {
    if (!this.indexesReady) throw new ApplicationError(503, 'DATABASE_UNAVAILABLE', 'Cơ sở dữ liệu chưa sẵn sàng');
    const roleId = new Types.ObjectId(validateObjectId(input.roleId));
    if (!await this.roles.exists({ id: roleId })) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy vai trò');
    const email = normalizeEmail(input.email);
    return this.accounts.create({ role_id: roleId, full_name: normalizeFullName(input.fullName), phone: normalizePhone(input.phone),
      ...(email ? { email } : {}), password_hash: input.passwordHash });
  }

  async ensureRole(code: RoleCode, name: string) {
    const id = new Types.ObjectId();
    const now = new Date();
    try {
      return await this.roles.findOneAndUpdate({ code }, { $setOnInsert: { _id: id, id, code, name, created_at: now, updated_at: now } },
        { upsert: true, returnDocument: 'after', runValidators: true, timestamps: false }).orFail().exec();
    }
    catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const winner = await this.findRoleByCode(code);
      if (!winner || !winner.id.equals(winner._id)) throw error;
      return winner;
    }
  }
}
