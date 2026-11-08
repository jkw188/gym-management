import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import { RoleCode } from './schemas/role.schema';

// Fixed module policy: decorators and the explanatory DB catalog use this same source.
// Other modules add their permissions only with their own requirements and tests.
export const ACCESS_POLICY = {
  'accounts.read': { name: 'Xem tài khoản và danh mục vai trò', roles: ['ADMIN'] },
  'accounts.create': { name: 'Tạo tài khoản', roles: ['ADMIN'] },
  'accounts.update': { name: 'Sửa thông tin tài khoản', roles: ['ADMIN'] },
  'accounts.changeStatus': { name: 'Khóa / mở khóa tài khoản', roles: ['ADMIN'] },
  'accounts.changeRole': { name: 'Phân quyền tài khoản', roles: ['ADMIN'] },
  'profile.readOwn': { name: 'Xem hồ sơ của mình', roles: ['TRAINER', 'MEMBER'] },
  'profile.updateOwn': { name: 'Sửa hồ sơ của mình', roles: ['TRAINER', 'MEMBER'] },
  'auth.me': { name: 'Xem phiên đăng nhập của mình', roles: ['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] },
  'auth.logout': { name: 'Đăng xuất phiên của mình', roles: ['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] },
} satisfies Record<string, { name: string; roles: RoleCode[] }>;

export type PermissionCode = keyof typeof ACCESS_POLICY;
export const FIXED_PERMISSION = 'access:fixed-permission';
export const FixedPermission = (code: PermissionCode) => applyDecorators(
  SetMetadata(FIXED_PERMISSION, code),
  // Logout accepts an access token OR a refresh cookie and is idempotent even after
  // expiration. AuthService validates ownership; preserve US-02's public HTTP policy.
  ...(code === 'auth.logout' ? [] : [Roles(...ACCESS_POLICY[code].roles)]),
);
