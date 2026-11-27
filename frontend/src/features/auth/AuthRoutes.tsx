import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { SESSION_EXPIRED } from '../../api/client';
import { useAuth } from './AuthProvider';
import { roleNames, rolePaths } from './auth.routes';
import type { RoleCode } from './auth.types';
import { NotificationBell } from '../notifications/NotificationBell';
import { Icon } from '../../components/Icon';
import { HomePage } from '../home/HomePage';

export function AuthChecking() {
  const auth = useAuth();
  return <section className="auth-card" aria-live="polite" aria-busy={!auth.error}>
    <h2>{auth.error ? 'Chưa thể khôi phục phiên' : 'Đang kiểm tra phiên đăng nhập…'}</h2>
    {auth.error && <><p role="alert">{auth.error}</p>{auth.requestId && <small>Mã tra cứu: {auth.requestId}</small>}
      <button type="button" onClick={() => void auth.retry()}><Icon name="retry" label="Thử lại" /></button></>}
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
  return <button type="button" className="logout-button" onClick={() => void logout()}><Icon name="logout" label="Đăng xuất" showLabel /></button>;
}

export function LogoutPending() {
  const auth = useAuth();
  const logout = useLogoutAction();
  return <section className="auth-card" aria-live="polite" aria-busy={!auth.error}>
    <h2>{auth.error ? 'Chưa xác nhận đăng xuất' : 'Đang đăng xuất…'}</h2>
    {auth.error && <><p role="alert">{auth.error}</p>{auth.requestId && <small>Mã tra cứu: {auth.requestId}</small>}
      <button type="button" onClick={() => void logout()}><Icon name="retry" label="Thử lại" /></button></>}
  </section>;
}

export function ProtectedRoute({ role }: { role: RoleCode }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === 'checking') return <AuthChecking />;
  if (auth.status === 'loggingOut') return <LogoutPending />;
  const returnTo = encodeURIComponent(location.pathname + location.search + location.hash);
  // US-42-TC11: phiên hết hiệu lực giữa chừng → báo lý do và vẫn quay lại đúng trang sau khi đăng nhập.
  if (!auth.user && auth.loginReason === SESSION_EXPIRED) return <Navigate to={`/login?reason=${SESSION_EXPIRED}&returnTo=${returnTo}`} replace />;
  if (!auth.user && auth.loginReason) return <Navigate to={`/login?reason=${auth.loginReason}`} replace />;
  if (!auth.user) return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  if (auth.user.roleCode !== role) return <section className="auth-card"><h2>Không có quyền truy cập</h2>
    <p role="alert">Tài khoản của bạn không có quyền truy cập trang này.</p></section>;
  return <Outlet />;
}

export function HomeRedirect() {
  const auth = useAuth();
  if (auth.status === 'checking') return <AuthChecking />;
  if (auth.status === 'loggingOut') return <LogoutPending />;
  // Trang chủ công khai: Guest và người đã đăng nhập đều xem được (báo cáo: đăng xuất "chuyển về trang chủ (chế độ Guest)").
  // Đã đăng nhập thì các chức năng của vai trò nằm ở menu bên trái (AppLayout).
  return <HomePage />;
}

export function RoleShell({ role }: { role: RoleCode }) {
  const { user } = useAuth();
  // Đăng nhập xong vào thẳng trang chủ; phía trên chỉ có một dòng chào. Các chức năng nằm ở menu bên trái (AppLayout).
  return <div className="role-home">
    <div className="welcome-bar"><p role="status">Đăng nhập thành công.</p><p>Xin chào, <strong>{user?.fullName}</strong>.</p></div>
    <HomePage />
  </div>;
}

// Trang riêng hiện thông tin tài khoản đang đăng nhập (Admin/Staff), lấy từ phiên đăng nhập nên không gọi API.
export function AccountInfoPage({ role }: { role: RoleCode }) {
  const { user } = useAuth();
  return <section className="auth-card"><h2>Thông tin tài khoản</h2>
    <dl className="info-grid"><dt>Họ tên</dt><dd>{user?.fullName}</dd><dt>Số điện thoại</dt><dd>{user?.phone}</dd>
      <dt>Vai trò</dt><dd>{roleNames[role]}</dd>{user?.email && <><dt>Email</dt><dd>{user.email}</dd></>}</dl>
  </section>;
}

// Khối bên phải thanh header: Guest thấy "Đăng nhập" + "Đăng ký"; đã đăng nhập thấy chuông (member),
// ô tên tài khoản (bấm vào mở trang thông tin tài khoản) và nút đăng xuất.
export function HeaderAccount() {
  const auth = useAuth();
  if (auth.status === 'checking') return null;
  if (!auth.user) return <div className="header-account">
    <Link to="/login" className="header-link">Đăng nhập</Link>
    <Link to="/register" className="button-link">Đăng ký</Link>
  </div>;
  const role = auth.user.roleCode;
  // Admin/Staff xem thông tin ở /account (chỉ đọc); Member/PT dùng /profile (sửa được, có đổi mật khẩu).
  const accountPath = role === 'ADMIN' || role === 'STAFF' ? `${rolePaths[role]}/account` : `${rolePaths[role]}/profile`;
  // Chữ cái đầu của tên cuối (vd. "Lê Minh An" → "A") làm ảnh đại diện.
  const initial = auth.user.fullName.trim().split(/\s+/).pop()?.charAt(0).toUpperCase() ?? '?';
  return <div className="header-account">
    <MemberNotificationBell />
    <Link to={accountPath} className="account-chip" aria-label="Thông tin tài khoản" title="Thông tin tài khoản">
      <span className="account-avatar" aria-hidden="true">{initial}</span>
      {/* Tên và vai trò xếp hai dòng như bản thiết kế; aria-label của link đã đọc "Thông tin tài khoản". */}
      <span className="account-text" aria-hidden="true">
        <strong className="account-name">{auth.user.fullName}</strong>
        <span className="account-role">{roleNames[role]}</span>
      </span>
    </Link>
    <LogoutButton />
  </div>;
}

// US-47: chuông thông báo nằm trên thanh điều hướng chung nên mọi trang của member đều thấy; role khác không hiện.
export function MemberNotificationBell() {
  const auth = useAuth();
  if (auth.status !== 'authenticated' || auth.user?.roleCode !== 'MEMBER') return null;
  return <NotificationBell />;
}
