import type { IconName } from '../../components/Icon';

export type OperationsRole = 'ADMIN' | 'STAFF';
export interface OperationsItem { to: string; label: string; icon: IconName; keywords?: string }
interface OperationsRoute extends OperationsItem { adminOnly?: boolean }

const pinnedRoutes: OperationsItem[] = [
  { to: '', label: 'Trang chủ', icon: 'home' },
  { to: '/members', label: 'Tra cứu hội viên', icon: 'users' },
  { to: '/pos', label: 'Bán tại quầy', icon: 'cart', keywords: 'Bán sản phẩm tại quầy' },
];

export const publicPages: OperationsItem[] = [
  { to: '/', label: 'Trang chính', icon: 'home' },
  { to: '/services', label: 'Gói tập và dịch vụ PT', icon: 'weights' },
  { to: '/classes', label: 'Lịch lớp miễn phí', icon: 'calendar' },
  { to: '/shop', label: 'Cửa hàng', icon: 'bag' },
];

const operationsGroups: { label: string; routes: OperationsRoute[]; public?: boolean }[] = [
  { label: 'Vận hành', routes: [
    { to: '/members/new', label: 'Tạo hồ sơ hội viên', icon: 'plus' },
    { to: '/transactions', label: 'Đối chiếu thanh toán', icon: 'cash' },
    { to: '/pt-bookings', label: 'Tra cứu lịch PT', icon: 'calendar' },
    { to: '/trainer-attendance', label: 'Chấm công PT', icon: 'clock', keywords: 'Chấm công huấn luyện viên' },
    { to: '/orders', label: 'Đơn hàng website', icon: 'bag', keywords: 'Chuẩn bị và bàn giao đơn website' },
    { to: '/returns', label: 'Tiếp nhận hàng trả', icon: 'box' },
    { to: '/refunds', label: 'Nghĩa vụ hoàn tiền', icon: 'refund' },
  ] },
  { label: 'Kho và bán lẻ', routes: [
    { to: '/stock-receipts', label: 'Phiếu nhập kho', icon: 'document' },
    { to: '/inventory', label: 'Tra cứu tồn kho', icon: 'box' },
    { to: '/categories', label: 'Danh mục bán lẻ', icon: 'box', adminOnly: true },
    { to: '/products', label: 'Sản phẩm bán lẻ', icon: 'bag', adminOnly: true },
    { to: '/stock-issues', label: 'Phiếu xuất ngoài bán', icon: 'document', adminOnly: true },
    { to: '/stock-adjustments', label: 'Kiểm kê và điều chỉnh kho', icon: 'document', adminOnly: true },
  ] },
  { label: 'Quản trị', routes: [
    { to: '/users', label: 'Quản lý tài khoản', icon: 'lock', adminOnly: true },
    { to: '/plans', label: 'Danh mục gói tập và PT', icon: 'weights', adminOnly: true },
    { to: '/trainers', label: 'Quản lý PT', icon: 'users', keywords: 'Quản lý huấn luyện viên', adminOnly: true },
    { to: '/trainers/activity', label: 'Đối chiếu ca và buổi PT', icon: 'clock', keywords: 'Đối chiếu chấm công và buổi PT', adminOnly: true },
    { to: '/trainer-reviews', label: 'Tổng hợp đánh giá PT', icon: 'trophy', adminOnly: true },
    { to: '/classes', label: 'Quản lý lớp miễn phí', icon: 'calendar', adminOnly: true },
    { to: '/notifications', label: 'Thông báo nhóm', icon: 'bell', adminOnly: true },
  ] },
  { label: 'Báo cáo', routes: [
    { to: '/reports/memberships', label: 'Báo cáo hội viên', icon: 'users', keywords: 'Báo cáo hội viên và membership', adminOnly: true },
    { to: '/reports/cash-flow', label: 'Báo cáo thu & hoàn', icon: 'chart', keywords: 'Báo cáo khoản thu và hoàn tiền', adminOnly: true },
    { to: '/reports/trainers', label: 'Hiệu suất huấn luyện viên', icon: 'chart', keywords: 'Báo cáo hiệu suất huấn luyện viên', adminOnly: true },
  ] },
  { label: 'Danh mục công khai', routes: publicPages, public: true },
];

export function operationsNavigation(role: OperationsRole, home: string) {
  const pinned = pinnedRoutes.map(item => ({ ...item, to: home + item.to }));
  const groups = operationsGroups.map(group => ({
    label: group.label,
    items: group.routes.filter(item => !item.adminOnly || role === 'ADMIN')
      .map(item => ({ ...item, to: group.public ? item.to : home + item.to })),
  })).filter(group => group.items.length);
  const account: OperationsItem = { to: `${home}/account`, label: 'Thông tin tài khoản', icon: 'user' };
  return { pinned, groups, account };
}
