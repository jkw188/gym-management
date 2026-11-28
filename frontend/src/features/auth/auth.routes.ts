import type { RoleCode } from './auth.types';
import { operationsNavigation } from './operations.routes';

export const rolePaths: Record<RoleCode, string> = { ADMIN: '/admin', STAFF: '/staff', TRAINER: '/trainer', MEMBER: '/member' };
export const roleNames: Record<RoleCode, string> = { ADMIN: 'Quản trị viên', STAFF: 'Nhân viên', TRAINER: 'Huấn luyện viên', MEMBER: 'Hội viên' };

export function resolveReturnTo(value: unknown, role: RoleCode): string {
  const home = rolePaths[role];
  // Only currently implemented role routes are accepted. Never pass untrusted URLs to navigation.
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value)) return home;
  try {
    const parsed = new URL(value, 'https://gym.invalid');
    const allowed = [home,
      // US-40: Member đăng nhập lại được quay về giỏ hàng của mình.
      ...(role === 'MEMBER' ? ['/member/orders', '/member/cart'] : []),
      ...(role === 'MEMBER' || role === 'TRAINER' ? [`${home}/profile`, `${home}/security`] : [])];
    if (role === 'ADMIN' || role === 'STAFF') {
      const { pinned, groups, account } = operationsNavigation(role, home);
      allowed.push(account.to, ...[...pinned, ...groups.flatMap(group => group.items)]
        .map(item => item.to).filter(path => path.startsWith(`${home}/`)));
    }
    const memberDetail = (role === 'ADMIN' || role === 'STAFF') &&
      new RegExp(`^${home}/members/[a-f\\d]{24}$`, 'i').test(parsed.pathname);
    // US-35-TC11: trang cửa hàng công khai /shop và /shop/<id> được quay lại với mọi vai trò.
    const shopPage = /^\/shop(\/[a-f\d]{24})?$/i.test(parsed.pathname);
    const broadcastPage = role === 'ADMIN' && /^\/admin\/notifications\/(new|[a-f\d]{24})$/i.test(parsed.pathname);
    const path = parsed.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    if (parsed.origin !== 'https://gym.invalid' || (!allowed.includes(path) && !memberDetail && !shopPage && !broadcastPage)) return home;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch { return home; }
}
