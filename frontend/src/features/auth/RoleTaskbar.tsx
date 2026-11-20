// Tầng giao diện – thành phần: thanh menu tab (taskbar) nằm ngay dưới header, chứa các chức năng của vai trò đang đăng nhập.
// Chỉ là điều hướng; quyền vào từng trang vẫn do ProtectedRoute và API quyết định. Guest không thấy thanh này.
import { NavLink } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import type { RoleCode } from './auth.types';

interface TaskbarItem { to: string; label: string }

// Các mục chung của Admin và Staff (đường dẫn bắt đầu bằng /admin hoặc /staff).
const counterItems = (home: string): TaskbarItem[] => [
  { to: `${home}/members`, label: 'Tra cứu hội viên' },
  { to: `${home}/members/new`, label: 'Tạo hồ sơ hội viên' },
  { to: `${home}/transactions`, label: 'Đối chiếu thanh toán' },
  // US-29: tra cứu và hủy hỗ trợ lịch PT.
  { to: `${home}/pt-bookings`, label: 'Tra cứu lịch PT' },
  { to: `${home}/trainer-attendance`, label: 'Chấm công huấn luyện viên' },
  { to: `${home}/pos`, label: 'Bán sản phẩm tại quầy' },
  { to: `${home}/orders`, label: 'Chuẩn bị đơn website' },
  { to: `${home}/refunds`, label: 'Nghĩa vụ hoàn tiền' },
  { to: `${home}/returns`, label: 'Tiếp nhận hàng trả' },
  { to: `${home}/stock-receipts`, label: 'Phiếu nhập kho' },
  { to: `${home}/inventory`, label: 'Tra cứu tồn kho' },
];

// "Thông tin tài khoản" không nằm ở đây vì đã có ô tài khoản trên header.
const MENUS: Record<RoleCode, TaskbarItem[]> = {
  MEMBER: [
    // US-17: gói tập, lịch sử mua và chứng từ. US-18: tự đăng ký mua gói. US-27: lịch PT và giờ trống của PT.
    { to: '/member/memberships', label: 'Gói tập của tôi' },
    { to: '/member/service-registrations', label: 'Đăng ký gói tập' },
    { to: '/member/pt-bookings', label: 'Lịch PT của tôi' },
    { to: '/member/orders', label: 'Đơn hàng của tôi' },
    { to: '/member/cart', label: 'Giỏ hàng của tôi' },
    { to: '/member/notifications', label: 'Hộp thư thông báo' },
  ],
  TRAINER: [
    // US-64: buổi dạy và xác nhận đã dạy. US-30: học viên có buổi với mình. US-31: đánh giá của học viên.
    { to: '/trainer/shifts', label: 'Ca làm việc' },
    { to: '/trainer/bookings', label: 'Buổi dạy của tôi' },
    { to: '/trainer/trainees', label: 'Học viên của tôi' },
    { to: '/trainer/reviews', label: 'Đánh giá của học viên' },
  ],
  STAFF: counterItems('/staff'),
  ADMIN: [
    { to: '/admin/users', label: 'Quản lý tài khoản' },
    { to: '/admin/notifications', label: 'Thông báo nhóm' },
    ...counterItems('/admin'),
    { to: '/admin/stock-issues', label: 'Phiếu xuất ngoài bán' },
    { to: '/admin/stock-adjustments', label: 'Kiểm kê và điều chỉnh kho' },
    { to: '/admin/trainers', label: 'Quản lý huấn luyện viên' },
    { to: '/admin/trainers/activity', label: 'Đối chiếu chấm công và buổi PT' },
    { to: '/admin/trainer-reviews', label: 'Tổng hợp đánh giá PT' },
    { to: '/admin/classes', label: 'Quản lý lớp miễn phí' },
    { to: '/admin/plans', label: 'Danh mục gói tập và PT' },
    { to: '/admin/categories', label: 'Danh mục bán lẻ' },
    { to: '/admin/products', label: 'Sản phẩm bán lẻ' },
    { to: '/admin/reports/memberships', label: 'Báo cáo hội viên và membership' },
    { to: '/admin/reports/cash-flow', label: 'Báo cáo khoản thu và hoàn tiền' },
    { to: '/admin/reports/trainers', label: 'Báo cáo hiệu suất huấn luyện viên' },
  ],
};

export function RoleTaskbar() {
  const { user } = useAuth();
  if (!user) return null;
  // Thanh cuộn ngang khi nhiều mục; NavLink "end" để /staff/members không sáng khi đang ở /staff/members/new.
  return <nav className="role-taskbar" aria-label="Menu chức năng">
    <div className="role-taskbar-inner">
      {MENUS[user.roleCode].map(item => <NavLink key={item.to} to={item.to} end>{item.label}</NavLink>)}
    </div>
  </nav>;
}
