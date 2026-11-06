import { FoundationStatus } from './features/foundation/FoundationStatus';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './features/auth/AuthProvider';
import { HomeRedirect, LogoutButton, MemberNotificationBell, ProtectedRoute, RoleShell } from './features/auth/AuthRoutes';
import { LoginPage } from './features/auth/LoginPage';
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage';
import { PasswordResetFlow } from './features/auth/PasswordResetFlow';
import { ResetPasswordPage } from './features/auth/ResetPasswordPage';
import { rolePaths } from './features/auth/auth.routes';
import type { RoleCode } from './features/auth/auth.types';
import { ProfilePage } from './features/profile/ProfilePage';
import { NotificationsPage } from './features/notifications/NotificationsPage';
import { ChangePasswordPage } from './features/security/ChangePasswordPage';
import { UsersPage } from './features/users/UsersPage';

export default function App() {
  return <BrowserRouter><AuthProvider><main><h1>Gym Management</h1><p>Nền tảng quản lý phòng Gym, hội viên và dịch vụ thể hình trực tuyến.</p>
    <nav aria-label="Điều hướng chính"><Link to="/">Trang chính</Link><Link to="/health">Kiểm tra nền tảng</Link><MemberNotificationBell /><LogoutButton /></nav>
    <Routes><Route path="/" element={<HomeRedirect />} /><Route path="/login" element={<LoginPage />} />
      <Route path="/health" element={<FoundationStatus />} />
      {/* US-05: hai trang con dùng chung PasswordResetFlow để giữ challenge trong bộ nhớ khi chuyển trang. */}
      <Route element={<PasswordResetFlow />}><Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} /></Route>
      <Route element={<ProtectedRoute role="ADMIN" />}><Route path="/admin/users" element={<UsersPage />} /></Route>
      <Route element={<ProtectedRoute role="MEMBER" />}><Route path="/member/profile" element={<ProfilePage role="MEMBER" />} />
        <Route path="/member/security" element={<ChangePasswordPage />} />
        {/* US-47: inbox thông báo của member. */}
        <Route path="/member/notifications" element={<NotificationsPage />} /></Route>
      <Route element={<ProtectedRoute role="TRAINER" />}><Route path="/trainer/profile" element={<ProfilePage role="TRAINER" />} />
        <Route path="/trainer/security" element={<ChangePasswordPage />} /></Route>
      {(Object.entries(rolePaths) as [RoleCode, string][]).map(([role, path]) => <Route key={role} element={<ProtectedRoute role={role} />}>
        <Route path={path} element={<RoleShell role={role} />} /></Route>)}
      <Route path="*" element={<section><h2>Không tìm thấy trang</h2><Link to="/">Về trang chính</Link></section>} />
    </Routes>
  </main></AuthProvider></BrowserRouter>;
}
