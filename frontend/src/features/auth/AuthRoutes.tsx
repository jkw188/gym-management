import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { roleNames, rolePaths } from './auth.routes';
import type { RoleCode } from './auth.types';

export function AuthChecking() {
  const auth = useAuth();
  return <section className="auth-card" aria-live="polite" aria-busy={!auth.error}>
    <h2>{auth.error ? 'Chưa thể khôi phục phiên' : 'Đang kiểm tra phiên đăng nhập…'}</h2>
    {auth.error && <><p role="alert">{auth.error}</p>{auth.requestId && <small>Mã tra cứu: {auth.requestId}</small>}
      <button type="button" onClick={() => void auth.retry()}>Thử lại</button></>}
  </section>;
}

export function ProtectedRoute({ role }: { role: RoleCode }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === 'checking') return <AuthChecking />;
  if (!auth.user) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`} replace />;
  if (auth.user.roleCode !== role) return <section className="auth-card"><h2>Không có quyền truy cập</h2>
    <p role="alert">Tài khoản của bạn không có quyền truy cập trang này.</p></section>;
  return <Outlet />;
}

export function HomeRedirect() {
  const auth = useAuth();
  if (auth.status === 'checking') return <AuthChecking />;
  return <Navigate to={auth.user ? rolePaths[auth.user.roleCode] : '/login'} replace />;
}

export function RoleShell({ role }: { role: RoleCode }) {
  const { user } = useAuth();
  return <section className="auth-card"><h2>Không gian {roleNames[role].toLowerCase()}</h2>
    <p role="status">Đăng nhập thành công.</p><p>Xin chào, <strong>{user?.fullName}</strong>.</p>
    <dl><dt>Số điện thoại</dt><dd>{user?.phone}</dd><dt>Vai trò</dt><dd>{roleNames[role]}</dd>
      {user?.email && <><dt>Email</dt><dd>{user.email}</dd></>}</dl>
    {role === 'ADMIN' ? <Link to="/admin/users">Quản lý tài khoản</Link> : <p>Các chức năng quản lý cho vai trò này sẽ được bổ sung sau.</p>}
  </section>;
}
