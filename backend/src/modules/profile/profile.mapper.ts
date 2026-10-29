import { Account } from '../users/schemas/account.schema';
import { RoleCode } from '../users/schemas/role.schema';
import { ProfileResponseDto } from './profile.dto';

export function mapProfileResponse(account: Account, roleCode: RoleCode): ProfileResponseDto {
  return {
    id: account.id.toHexString(),
    fullName: account.full_name,
    phone: account.phone,
    ...(account.email ? { email: account.email } : {}),
    ...(account.birth_date ? { birthDate: account.birth_date } : {}),
    ...(account.address ? { address: account.address } : {}),
    roleCode,
    status: account.status,
    version: Number(account.version),
    createdAt: account.created_at,
    updatedAt: account.updated_at,
  };
}
