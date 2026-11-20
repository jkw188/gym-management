// Tầng giao diện – khung trang tài khoản: cột menu bên trái (tên, vai trò, các mục) và nội dung trang con bên phải.
// Chỉ dùng cho Member và PT; quyền truy cập vẫn do ProtectedRoute bọc bên ngoài quyết định.
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { roleNames } from './auth.routes';
import { PageFrame } from '../../components/BackButton';

type AccountRole = 'MEMBER' | 'TRAINER';

// Các mục menu của từng vai trò, đúng các route đã có trong App.tsx.
const MENUS: Record<AccountRole, { to: string; label: string }[]> = {
  MEMBER: [
    { to: '/member/profile', label: 'Thông tin tài khoản' },
    { to: '/member/memberships', label: 'Gói tập của tôi' },
    { to: '/member/service-registrations', label: 'Đăng ký gói tập' },
    { to: '/member/pt-bookings', label: 'Lịch PT của tôi' },
    { to: '/member/orders', label: 'Đơn hàng của tôi' },
    { to: '/member/cart', label: 'Giỏ hàng của tôi' },
    { to: '/member/notifications', label: 'Hộp thư thông báo' },
  ],
  TRAINER: [
    { to: '/trainer/shifts', label: 'Ca làm việc' },
    { to: '/trainer/bookings', label: 'Buổi dạy của tôi' },
    { to: '/trainer/trainees', label: 'Học viên của tôi' },
    { to: '/trainer/reviews', label: 'Đánh giá của học viên' },
    { to: '/trainer/profile', label: 'Thông tin tài khoản' },
  ],
};

export function AccountLayout({ role }: { role: AccountRole }) {
  const { user } = useAuth();
  const initial = user?.fullName.trim().split(/\s+/).pop()?.charAt(0).toUpperCase() ?? '?';
  return <div className="account-layout">
    <aside className="account-sidebar">
      <div className="account-sidebar-head">
        <span className="account-avatar" aria-hidden="true">{initial}</span>
        <span className="account-sidebar-role">{roleNames[role]}</span>
      </div>
      <nav aria-label="Menu tài khoản">
        {/* NavLink tự gắn class "active" cho mục của trang đang mở. */}
        {MENUS[role].map(item => <NavLink key={item.to} to={item.to}>{item.label}</NavLink>)}
      </nav>
    </aside>
    {/* Khung chung có nút "Trở về" nằm trong cột nội dung, ngay trên trang con. */}
    <div className="account-content"><PageFrame scope="account"><Outlet /></PageFrame></div>
  </div>;
}
