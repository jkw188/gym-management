import { Injectable } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/application-error';
import { isDuplicateKey } from '../../common/http/http-error.filter';
import { PasswordService } from '../../common/security/password.service';
import { normalizeEmail, normalizeFullName, normalizePhone } from '../../common/utils/normalization';
import { UsersRepository } from './users.repository';
import { Account } from './schemas/account.schema';
import { ROLE_CODES } from './schemas/role.schema';

export interface SeedAdminInput { phone: string; fullName: string; password: string; email?: string }

@Injectable()
export class SeedAdminService {
  constructor(private readonly users: UsersRepository, private readonly passwords: PasswordService) {}

  async run(input: SeedAdminInput): Promise<'created' | 'unchanged'> {
    const phone = normalizePhone(input.phone);
    const fullName = normalizeFullName(input.fullName);
    const email = normalizeEmail(input.email);
    this.passwords.validate(input.password);
    const names = { ADMIN: 'Quản trị viên', STAFF: 'Nhân viên', TRAINER: 'PT', MEMBER: 'Hội viên' };
    for (const code of ROLE_CODES) await this.users.ensureRole(code, names[code]);
    const role = await this.users.findRoleByCode('ADMIN');
    if (!role) throw new Error('SEED_ROLE_MISSING');
    const verifyExisting = (account: Account | null) => {
      if (!account || !account.role_id.equals(role.id) || account.status !== 'ACTIVE' || !account.id.equals(account._id)) {
        throw new ApplicationError(409, 'SEED_ADMIN_CONFLICT', 'Số điện thoại không thuộc Admin đang hoạt động');
      }
      return 'unchanged' as const;
    };
    const existing = await this.users.findAccountByPhone(phone);
    if (existing) return verifyExisting(existing);
    const passwordHash = await this.passwords.hash(input.password);
    try {
      await this.users.createAccount({ roleId: role.id.toHexString(), phone, fullName, email, passwordHash });
      return 'created';
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // A duplicate email alone must never be treated as a successful seed.
      return verifyExisting(await this.users.findAccountByPhone(phone));
    }
  }
}
