import type { RoleCode } from './auth.types';

export const rolePaths: Record<RoleCode, string> = { ADMIN: '/admin', STAFF: '/staff', TRAINER: '/trainer', MEMBER: '/member' };
export const roleNames: Record<RoleCode, string> = { ADMIN: 'Quản trị viên', STAFF: 'Nhân viên', TRAINER: 'Huấn luyện viên', MEMBER: 'Hội viên' };

export function resolveReturnTo(value: unknown, role: RoleCode): string {
  const home = rolePaths[role];
  // Only currently implemented role routes are accepted. Never pass untrusted URLs to navigation.
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value)) return home;
  try {
    const parsed = new URL(value, 'https://gym.invalid');
    const allowed = [home, ...(role === 'ADMIN' ? ['/admin/users'] : []), ...(role === 'MEMBER' || role === 'TRAINER' ? [`${home}/profile`] : [])];
    if (parsed.origin !== 'https://gym.invalid' || !allowed.includes(parsed.pathname)) return home;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch { return home; }
}
