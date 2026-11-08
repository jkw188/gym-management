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
import { isDuplicateKey } from '../../common/http/http-error.filter';
import { MemberRegistrationReader } from '../members/member-registration.reader';
import { RegisterDto } from '../auth/register.dto';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ACCESS_CONTEXT, AuthPrincipal } from '../auth/auth.types';

@Injectable()
export class UsersService {
  constructor(private readonly repository: UsersRepository, private readonly passwords: PasswordService,
    private readonly members: MemberRegistrationReader) {}

  // Exact-phone lookup for the counter. Does not grant Staff access to the Admin account list.
  async findMemberLinkAccount(filter: { _id: Types.ObjectId } | { phone: string }, session?: ClientSession) {
    const account = await this.repository.findLinkAccount(filter, session);
    if (!account) return null;
    const role = await this.repository.findLinkRole(account.role_id, session);
    return { id: account._id, fullName: account.full_name, phone: account.phone,
      eligible: account.status === 'ACTIVE' && role?.code === 'MEMBER',
      hasTrainer: await this.repository.hasTrainerProfile(account._id, session) };
  }

  async requireMemberOperator(actor: AuthPrincipal, session: ClientSession): Promise<void> {
    const context = actor[ACCESS_CONTEXT];
    const unauthenticated = () => new ApplicationError(401, 'UNAUTHENTICATED', 'Cần đăng nhập lại');
    if (!context || context.expiresAt * 1000 <= Date.now()) throw unauthenticated();
    const account = await this.repository.findLinkAccount({ _id: new Types.ObjectId(actor.id) }, session);
    const currentSession = await this.repository.findLinkSession(new Types.ObjectId(context.sessionId), session);
    if (!account || account.status !== 'ACTIVE' || Number(account.auth_version) !== context.authVersion ||
      !currentSession || !currentSession.account_id.equals(account._id) || currentSession.revoked_at ||
      currentSession.expires_at.getTime() <= Date.now() || Number(currentSession.auth_version) !== context.authVersion) throw unauthenticated();
    const role = await this.repository.findLinkRole(account.role_id, session);
    if (role?.code !== 'ADMIN' && role?.code !== 'STAFF') throw new ApplicationError(403, 'FORBIDDEN', 'Không có quyền truy cập');
  }

  async register(input: RegisterDto): Promise<{ id: string; nextAction: 'LOGIN' }> {
    const fullName = normalizeFullName(input.fullName);
    const phone = normalizePhone(input.phone);
    const email = normalizeEmail(input.email);
    this.passwords.validate(input.password);
    const conflict = () => new ApplicationError(409, 'REGISTRATION_CONFLICT', 'Không thể đăng ký với thông tin định danh này. Vui lòng đăng nhập hoặc liên hệ quầy.');
    try {
      const role = await this.repository.findRoleByCode('MEMBER');
      if (!role) throw this.roleNotConfigured();
      if (await this.repository.findIdentifier('phone', phone) || (email && await this.repository.findIdentifier('email', email))) throw conflict();
      if (await this.members.hasUnlinkedPhone(phone)) {
        throw new ApplicationError(409, 'REGISTRATION_NEEDS_HELP', 'Vui lòng liên hệ quầy để được hỗ trợ đối chiếu thông tin đăng ký.');
      }
      const passwordHash = await this.passwords.hash(input.password);
      const account = await this.repository.createAccount({ roleId: role.id.toHexString(), fullName, phone, email, passwordHash });
      return { id: account.id.toHexString(), nextAction: 'LOGIN' };
    } catch (error) {
      // Unique index accounts quyết định kết quả kể cả khi hai request cùng vượt qua bước đọc.
      if (isDuplicateKey(error)) throw conflict();
      if (error instanceof ApplicationError && error.status === 409) throw error;
      // Role có thể bị xóa giữa lúc đọc và ghi; không seed lại trong request.
      if (error instanceof ApplicationError && error.code === 'NOT_FOUND') throw this.roleNotConfigured();
      throw new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Dịch vụ đăng ký chưa sẵn sàng. Vui lòng thử lại sau.');
    }
  }

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
  updatePasswordIfUnchanged(id: string, oldHash: string, authVersion: number, newHash: string) {
    return this.repository.updatePasswordIfUnchanged(id, oldHash, authVersion, newHash);
  }
  // Internal contract for US-67. Never return credentials from an HTTP controller.
  async findCredentialsById(id: string) {
    const account = await this.repository.findCredentialsById(id);
    return account ? { account: mapAccount(account), passwordHash: account.password_hash } : null;
  }
}
