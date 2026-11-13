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
  'members.read': { name: 'Xem hội viên', roles: ['ADMIN', 'STAFF'] },
  'members.create': { name: 'Tạo hội viên', roles: ['ADMIN', 'STAFF'] },
  'members.update': { name: 'Sửa hội viên', roles: ['ADMIN', 'STAFF'] },
  'members.link': { name: 'Liên kết tài khoản hội viên', roles: ['ADMIN', 'STAFF'] },
  'serviceSales.read': { name: 'Xem lần bán dịch vụ', roles: ['ADMIN', 'STAFF'] },
  'serviceSales.create': { name: 'Đăng ký bán dịch vụ', roles: ['ADMIN', 'STAFF'] },
  'serviceSales.cancel': { name: 'Hủy lần bán dịch vụ', roles: ['ADMIN', 'STAFF'] },
  'transactions.read': { name: 'Xem giao dịch', roles: ['ADMIN', 'STAFF'] },
  'transactions.confirmPayment': { name: 'Xác nhận thu tiền', roles: ['ADMIN', 'STAFF'] },
  'invoices.read': { name: 'Xem chứng từ', roles: ['ADMIN', 'STAFF'] },
  // US-17: Member chỉ xem dữ liệu gói/giao dịch/chứng từ của chính mình.
  'memberships.readOwn': { name: 'Xem gói tập của mình', roles: ['MEMBER'] },
  'serviceSales.readOwn': { name: 'Xem lần mua gói của mình', roles: ['MEMBER'] },
  'transactions.readOwn': { name: 'Xem giao dịch của mình', roles: ['MEMBER'] },
  'invoices.readOwn': { name: 'Xem chứng từ của mình', roles: ['MEMBER'] },
  // US-27: Member xem danh mục PT khả dụng và giờ trống của PT (chỉ xem, không giữ chỗ).
  'ptTrainers.readAvailable': { name: 'Xem danh mục PT khả dụng', roles: ['MEMBER'] },
  'ptAvailability.read': { name: 'Xem giờ trống của PT', roles: ['MEMBER'] },
  'ptBookings.readOwn': { name: 'Xem lịch PT của mình', roles: ['MEMBER'] },
  // US-28: Member đặt slot PT bằng gói của chính mình.
  'ptBookings.createOwn': { name: 'Đặt lịch PT', roles: ['MEMBER'] },
  // US-29-TC03: Member tự hủy lịch của mình; Staff/Admin tra cứu và hủy hỗ trợ. PT không có quyền nào ở đây.
  'ptBookings.cancelOwn': { name: 'Hủy lịch PT của mình', roles: ['MEMBER'] },
  'ptBookings.readSupport': { name: 'Tra cứu lịch PT để hỗ trợ', roles: ['STAFF', 'ADMIN'] },
  'ptBookings.cancelSupport': { name: 'Hủy lịch PT hỗ trợ', roles: ['STAFF', 'ADMIN'] },
  // US-64-F01: chỉ PT xác nhận buổi mình đã dạy; Member, Staff, Admin gọi lệnh này → 403.
  'ptBookings.completeOwn': { name: 'Xác nhận buổi PT đã dạy', roles: ['TRAINER'] },
  // US-64-C01, C02: chỉ Admin xác nhận hỗ trợ hoặc rút xác nhận sai, và xem chi tiết kèm lịch sử hoàn tất.
  'ptBookings.correct': { name: 'Xử lý sai xác nhận buổi PT', roles: ['ADMIN'] },
  // US-64 bước 4 (spec 1.1): PT xem danh sách buổi dạy của chính mình (UI /trainer/bookings).
  'ptBookings.readTrainerOwn': { name: 'Xem buổi dạy của mình', roles: ['TRAINER'] },
  // US-30: PT tra cứu học viên có booking BOOKED/COMPLETED với mình (UI /trainer/trainees).
  'trainees.readRelated': { name: 'Xem học viên có booking với mình', roles: ['TRAINER'] },
  'plans.manage':{ name: 'Quản lý gói dịch vụ', roles: ['ADMIN'] },
  'planPolicies.manage': { name: 'Quản lý chính sách gói', roles: ['ADMIN'] },
} satisfies Record<string, { name: string; roles: RoleCode[] }>;

export type PermissionCode = keyof typeof ACCESS_POLICY;
export const FIXED_PERMISSION = 'access:fixed-permission';
export const FixedPermission = (code: PermissionCode) => applyDecorators(
  SetMetadata(FIXED_PERMISSION, code),
  // Logout accepts an access token OR a refresh cookie and is idempotent even after
  // expiration. AuthService validates ownership; preserve US-02's public HTTP policy.
  ...(code === 'auth.logout' ? [] : [Roles(...ACCESS_POLICY[code].roles)]),
);
