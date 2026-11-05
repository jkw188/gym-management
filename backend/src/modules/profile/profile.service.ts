import { Injectable } from '@nestjs/common';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { normalizeEmail, normalizeFullName, normalizePhone } from '../../common/utils/normalization';
import { AuthPrincipal } from '../auth/auth.types';
import { duplicateIdentifier, rethrowDuplicate, versionConflict } from '../users/account-errors';
import { AccountChanges, UsersRepository } from '../users/users.repository';
import { UpdateProfileDto } from './profile.dto';
import { mapProfileResponse } from './profile.mapper';

const EDITABLE_FIELDS = ['fullName', 'phone', 'email', 'birthDate', 'address'] as const;

export function todayInVietnam(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now);
}

export function normalizeBirthDate(value: string | null): string | null {
  if (value === null) return null;
  const invalid = () => invalidField('birthDate', 'Ngày sinh phải là ngày hợp lệ dạng YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid();
  if (value > todayInVietnam()) invalidField('birthDate', 'Ngày sinh không được sau ngày hiện tại');
  return value;
}

export function normalizeAddress(value: string | null): string | null {
  if (value === null) return null;
  const address = value.trim();
  if (!address) return null;
  if (address.length > 255) invalidField('address', 'Địa chỉ tối đa 255 ký tự');
  return address;
}

@Injectable()
export class ProfileService {
  constructor(private readonly repository: UsersRepository) {}

  async get(user: AuthPrincipal) {
    const account = await this.repository.findAccountById(user.id);
    if (!account) throw this.unauthenticated();
    return mapProfileResponse(account, user.roleCode);
  }

  async update(user: AuthPrincipal, input: UpdateProfileDto) {
    if (EDITABLE_FIELDS.every(field => input[field] === undefined)) {
      invalidField('fields', 'Cần ít nhất một trường fullName, phone, email, birthDate hoặc address');
    }

    const requested: AccountChanges = {
      fullName: input.fullName === undefined ? undefined : normalizeFullName(input.fullName),
      phone: input.phone === undefined ? undefined : normalizePhone(input.phone),
      email: input.email === undefined ? undefined : input.email === null ? null : normalizeEmail(input.email) ?? null,
      birthDate: input.birthDate === undefined ? undefined : normalizeBirthDate(input.birthDate),
      address: input.address === undefined ? undefined : normalizeAddress(input.address),
    };

    const account = await this.repository.findAccountById(user.id);
    if (!account) throw this.unauthenticated();
    if (Number(account.version) !== input.version) throw versionConflict();

    const current: AccountChanges = {
      fullName: account.full_name, phone: account.phone, email: account.email ?? null,
      birthDate: account.birth_date ?? null, address: account.address ?? null,
    };
    const changes: AccountChanges = {};
    for (const field of EDITABLE_FIELDS) {
      const value = requested[field];
      if (value !== undefined && value !== current[field]) Object.assign(changes, { [field]: value });
    }

    if (!Object.keys(changes).length) {
      const unchanged = await this.repository.findAccountAtVersion(account._id.toHexString(), input.version);
      if (!unchanged) throw versionConflict();
      return { profile: mapProfileResponse(unchanged, user.roleCode), reauthenticationRequired: false };
    }

    if (changes.phone && await this.repository.findIdentifier('phone', changes.phone, account._id.toHexString())) {
      throw duplicateIdentifier('phone');
    }
    if (changes.email && await this.repository.findIdentifier('email', changes.email, account._id.toHexString())) {
      throw duplicateIdentifier('email');
    }

    try {
      const updated = await this.repository.updateAccount(account._id.toHexString(), input.version, changes);
      if (!updated) throw versionConflict();
      const reauthenticationRequired = changes.phone !== undefined || changes.email !== undefined;
      return { profile: mapProfileResponse(updated, user.roleCode), reauthenticationRequired };
    } catch (error) { return rethrowDuplicate(error); }
  }

  private unauthenticated() {
    return new ApplicationError(401, 'UNAUTHENTICATED', 'Cần đăng nhập lại');
  }
}
