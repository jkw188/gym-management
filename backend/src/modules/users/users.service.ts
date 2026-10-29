import { Injectable } from '@nestjs/common';
import { mapAccount, mapRole, mapUserResponse } from './account.mapper';
import { RoleCode } from './schemas/role.schema';
import { UsersRepository } from './users.repository';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { PasswordService } from '../../common/security/password.service';
import { normalizeEmail, normalizeFullName, normalizePhone } from '../../common/utils/normalization';
import { Account } from './schemas/account.schema';
import { CreateUserDto, ListUsersDto, UpdateUserDto } from './users.dto';
import { duplicateIdentifier, rethrowDuplicate, versionConflict } from './account-errors';

@Injectable()
export class UsersService {
  constructor(private readonly repository: UsersRepository, private readonly passwords: PasswordService) {}

  async list(query: ListUsersDto) {
    if (!Number.isSafeInteger((query.page - 1) * query.limit)) invalidField('page', 'Trang không hợp lệ');
    const roles = await this.repository.listRoles();
    const role = query.roleCode ? roles.find(item => item.code === query.roleCode) : undefined;
    const { items, total } = await this.repository.listAccounts(query, role?.id.toHexString());
    return { items: items.map(account => {
      const currentRole = roles.find(item => item.id.equals(account.role_id));
      if (!currentRole) throw this.roleNotConfigured();
      return mapUserResponse(account, currentRole);
    }), page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) };
  }

  async listRoles() {
    return { items: (await this.repository.listRoles()).map(role => ({ code: role.code, name: role.name })) };
  }

  async detail(id: string) {
    this.validateId(id);
    const account = await this.repository.findAccountById(id);
    if (!account) throw this.notFound();
    return this.response(account);
  }

  async create(input: CreateUserDto) {
    const fullName = normalizeFullName(input.fullName);
    const phone = normalizePhone(input.phone);
    const email = normalizeEmail(input.email);
    this.passwords.validate(input.password);
    const role = await this.repository.findRoleByCode(input.roleCode);
    if (!role) throw this.roleNotConfigured();
    await this.checkIdentifiers(phone, email);
    const passwordHash = await this.passwords.hash(input.password);
    try {
      const account = await this.repository.createAccount({ roleId: role.id.toHexString(), fullName, phone, email, passwordHash });
      return mapUserResponse(account, role);
    } catch (error) { return rethrowDuplicate(error); }
  }

  async update(id: string, input: UpdateUserDto) {
    this.validateId(id);
    if (input.fullName === undefined && input.phone === undefined && input.email === undefined) {
      invalidField('fields', 'Cần ít nhất một trường fullName, phone hoặc email');
    }
    const fullName = input.fullName === undefined ? undefined : normalizeFullName(input.fullName);
    const phone = input.phone === undefined ? undefined : normalizePhone(input.phone);
    const email = input.email === undefined ? undefined : input.email === null ? null : normalizeEmail(input.email) ?? null;
    const account = await this.repository.findAccountById(id);
    if (!account) throw this.notFound();
    if (Number(account.version) !== input.version) throw versionConflict();
    const role = await this.repository.findRoleById(account.role_id.toHexString());
    if (!role) throw this.roleNotConfigured();
    const changes: { fullName?: string; phone?: string; email?: string | null } = {};
    if (fullName !== undefined && fullName !== account.full_name) changes.fullName = fullName;
    if (phone !== undefined && phone !== account.phone) changes.phone = phone;
    if (email !== undefined && email !== (account.email ?? null)) changes.email = email;
    if (!Object.keys(changes).length) {
      // Re-read with the expected version: even a no-op must not return a stale form as current.
      const current = await this.repository.findAccountAtVersion(id, input.version);
      if (!current) return this.failedUpdate(id);
      return mapUserResponse(current, role);
    }
    await this.checkIdentifiers(changes.phone, changes.email ?? undefined, id);
    try {
      const updated = await this.repository.updateAccount(id, input.version, changes);
      if (!updated) return this.failedUpdate(id);
      return mapUserResponse(updated, role);
    } catch (error) { return rethrowDuplicate(error); }
  }

  private async response(account: Account) {
    const role = await this.repository.findRoleById(account.role_id.toHexString());
    if (!role) throw this.roleNotConfigured();
    return mapUserResponse(account, role);
  }

  private async checkIdentifiers(phone?: string, email?: string, excludeId?: string) {
    if (phone && await this.repository.findIdentifier('phone', phone, excludeId)) throw duplicateIdentifier('phone');
    if (email && await this.repository.findIdentifier('email', email, excludeId)) throw duplicateIdentifier('email');
  }

  private validateId(id: string) {
    if (!/^[a-f\d]{24}$/i.test(id)) throw new ApplicationError(400, 'INVALID_ID', 'ID tài khoản không hợp lệ', [{ field: 'id', message: 'ID tài khoản không hợp lệ' }]);
  }
  private notFound() { return new ApplicationError(404, 'USER_NOT_FOUND', 'Không tìm thấy tài khoản'); }
  private roleNotConfigured() { return new ApplicationError(409, 'ROLE_NOT_CONFIGURED', 'Vai trò chưa được cấu hình, vui lòng kiểm tra seed'); }
  private async failedUpdate(id: string): Promise<never> {
    if (!await this.repository.findAccountById(id)) throw this.notFound();
    throw versionConflict();
  }
  async findById(id: string) { const account = await this.repository.findAccountById(id); return account ? mapAccount(account) : null; }
  async findByPhone(phone: string) { const account = await this.repository.findAccountByPhone(phone); return account ? mapAccount(account) : null; }
  async findRoleByCode(code: RoleCode) { const role = await this.repository.findRoleByCode(code); return role ? mapRole(role) : null; }
  async findRoleById(id: string) { const role = await this.repository.findRoleById(id); return role ? mapRole(role) : null; }
  // Internal authentication contract for US-02. Never return credentials from an HTTP controller.
  async findCredentialsByPhone(phone: string) {
    const account = await this.repository.findCredentialsByPhone(phone);
    return account ? { account: mapAccount(account), passwordHash: account.password_hash } : null;
  }
}
