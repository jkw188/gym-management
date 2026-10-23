import { Account } from './schemas/account.schema';
import { Role } from './schemas/role.schema';
import { UserResponseDto } from './users.dto';

export function mapUserResponse(account: Account, role: Role): UserResponseDto {
  return {
    id: account.id.toHexString(), fullName: account.full_name, phone: account.phone,
    ...(account.email ? { email: account.email } : {}), roleCode: role.code, roleName: role.name,
    status: account.status, version: Number(account.version), createdAt: account.created_at, updatedAt: account.updated_at,
  };
}

export function mapAccount(account: Account) {
  return {
    id: account.id.toHexString(), roleId: account.role_id.toHexString(), fullName: account.full_name,
    phone: account.phone, ...(account.email ? { email: account.email } : {}), status: account.status,
    version: Number(account.version), authVersion: Number(account.auth_version),
    createdAt: account.created_at, updatedAt: account.updated_at,
  };
}

export function mapRole(role: Role) {
  return { id: role.id.toHexString(), code: role.code, name: role.name, createdAt: role.created_at, updatedAt: role.updated_at };
}
