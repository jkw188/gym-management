import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { roleNames, rolePaths } from './auth.routes';
import type { RoleCode } from './auth.types';
import { NotificationBell } from '../notifications/NotificationBell';

export function AuthChecking() {
  const auth = useAuth();
  return <section className="auth-card" aria-live="polite" aria-busy={!auth.error}>
    <h2>{auth.error ? 'Chưa thể khôi phục phiên' : 'Đang kiểm tra phiên đăng nhập…'}</h2>
    {auth.error && <><p role="alert">{auth.error}</p>{auth.requestId && <small>Mã tra cứu: {auth.requestId}</small>}
      <button type="button" onClick={() => void auth.retry()}>Thử lại</button></>}
  </section>;
}

function useLogoutAction() {
  const auth = useAuth();
  const navigate = useNavigate();
  return () => auth.logout().then(() => navigate('/', { replace: true }), () => undefined);
}

export function LogoutButton() {
  const auth = useAuth();
  const logout = useLogoutAction();
  if (auth.status !== 'authenticated') return null;
  return <button type="button" onClick={() => void logout()}>Đăng xuất</button>;
}

export function LogoutPending() {
  const auth = useAuth();
  const logout = useLogoutAction();
  return <section className="auth-card" aria-live="polite" aria-busy={!auth.error}>
    <h2>{auth.error ? 'Chưa xác nhận đăng xuất' : 'Đang đăng xuất…'}</h2>
    {auth.error && <><p role="alert">{auth.error}</p>{auth.requestId && <small>Mã tra cứu: {auth.requestId}</small>}
      <button type="button" onClick={() => void logout()}>Thử lại</button></>}
  </section>;
}

export function ProtectedRoute({ role }: { role: RoleCode }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === 'checking') return <AuthChecking />;
  if (auth.status === 'loggingOut') return <LogoutPending />;
  if (!auth.user && auth.loginReason) return <Navigate to={`/login?reason=${auth.loginReason}`} replace />;
  if (!auth.user) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`} replace />;
  if (auth.user.roleCode !== role) return <section className="auth-card"><h2>Không có quyền truy cập</h2>
    <p role="alert">Tài khoản của bạn không có quyền truy cập trang này.</p></section>;
  return <Outlet />;
}

export function HomeRedirect() {
  const auth = useAuth();
  if (auth.status === 'checking') return <AuthChecking />;
  if (auth.status === 'loggingOut') return <LogoutPending />;
  return <Navigate to={auth.user ? rolePaths[auth.user.roleCode] : '/login'} replace />;
}

export function RoleShell({ role }: { role: RoleCode }) {
  const { user } = useAuth();
  return <section className="auth-card"><h2>Không gian {roleNames[role].toLowerCase()}</h2>
    <p role="status">Đăng nhập thành công.</p><p>Xin chào, <strong>{user?.fullName}</strong>.</p>
    <dl className="info-grid"><dt>Số điện thoại</dt><dd>{user?.phone}</dd><dt>Vai trò</dt><dd>{roleNames[role]}</dd>
      {user?.email && <><dt>Email</dt><dd>{user.email}</dd></>}</dl>
    {/* Các chức năng của vai trò hiện dạng lưới thẻ để bấm nhanh. */}
    <div className="quick-links">
    {role === 'ADMIN' && <Link to="/admin/users">Quản lý tài khoản</Link>}
    {role === 'ADMIN' && <Link to="/admin/plans">Danh mục gói tập và PT</Link>}
    {(role === 'ADMIN' || role === 'STAFF') && <Link to={`${rolePaths[role]}/members`}>Tra cứu hội viên</Link>}
    {(role === 'ADMIN' || role === 'STAFF') && <Link to={`${rolePaths[role]}/members/new`}>Tạo hồ sơ hội viên</Link>}
    {/* US-29: tra cứu và hủy hỗ trợ lịch PT. */}
    {(role === 'ADMIN' || role === 'STAFF') && <Link to={`${rolePaths[role]}/pt-bookings`}>Tra cứu lịch PT</Link>}
    {role === 'TRAINER' && <Link to="/trainer/shifts">Ca làm việc</Link>}
    {/* US-64: PT xem buổi dạy của mình và xác nhận buổi đã dạy. */}
    {role === 'TRAINER' && <Link to="/trainer/bookings">Buổi dạy của tôi</Link>}
    {/* US-30: PT tra cứu học viên có buổi với mình. */}
    {role === 'TRAINER' && <Link to="/trainer/trainees">Học viên của tôi</Link>}
    {/* US-17: member xem gói tập, lịch sử mua và chứng từ của mình. */}
    {role === 'MEMBER' && <Link to="/member/memberships">Gói tập của tôi</Link>}
    {/* US-27: member xem lịch PT của mình và giờ trống của PT. */}
    {role === 'MEMBER' && <Link to="/member/pt-bookings">Lịch PT của tôi</Link>}
    {(role === 'MEMBER' || role === 'TRAINER') && <Link to={`${rolePaths[role]}/profile`}>Thông tin tài khoản</Link>}
    {(role === 'MEMBER' || role === 'TRAINER') && <Link to={`${rolePaths[role]}/security`}>Đổi mật khẩu</Link>}
    </div>
  </section>;
}

// US-47: chuông thông báo nằm trên thanh điều hướng chung nên mọi trang của member đều thấy; role khác không hiện.
export function MemberNotificationBell() {
  const auth = useAuth();
  if (auth.status !== 'authenticated' || auth.user?.roleCode !== 'MEMBER') return null;
  return <NotificationBell />;
}
