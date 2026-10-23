import { FoundationStatus } from './features/foundation/FoundationStatus';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './features/auth/AuthProvider';
import { HomeRedirect, ProtectedRoute, RoleShell } from './features/auth/AuthRoutes';
import { LoginPage } from './features/auth/LoginPage';
import { rolePaths } from './features/auth/auth.routes';
import type { RoleCode } from './features/auth/auth.types';
import { UsersPage } from './features/users/UsersPage';

export default function App() {
  return <BrowserRouter><AuthProvider><main><h1>Gym Management</h1><p>Nền tảng quản lý phòng Gym, hội viên và dịch vụ thể hình trực tuyến.</p>
    <nav aria-label="Điều hướng chính"><Link to="/">Trang chính</Link><Link to="/health">Kiểm tra nền tảng</Link></nav>
    <Routes><Route path="/" element={<HomeRedirect />} /><Route path="/login" element={<LoginPage />} />
      <Route path="/health" element={<FoundationStatus />} />
      <Route element={<ProtectedRoute role="ADMIN" />}><Route path="/admin/users" element={<UsersPage />} /></Route>
      {(Object.entries(rolePaths) as [RoleCode, string][]).map(([role, path]) => <Route key={role} element={<ProtectedRoute role={role} />}>
        <Route path={path} element={<RoleShell role={role} />} /></Route>)}
      <Route path="*" element={<section><h2>Không tìm thấy trang</h2><Link to="/">Về trang chính</Link></section>} />
    </Routes>
  </main></AuthProvider></BrowserRouter>;
}
