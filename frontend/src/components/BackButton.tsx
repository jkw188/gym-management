// Tầng giao diện – thành phần dùng chung: khung trang (PageFrame) có nút "Trở về" ở góc trên trái, nội dung trang nằm ngay dưới.
// Mọi trang dùng chung một khung nên nút luôn cùng chỗ, cùng kiểu. Không có khung ở trang chủ, trang chính theo vai trò và trang đăng nhập/đăng ký.
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthProvider';
import { rolePaths } from '../features/auth/auth.routes';
import { Icon } from './Icon';

// Trang xác thực là thẻ hẹp giữa màn hình, đã có link riêng (Đăng ký, Quên mật khẩu…) nên không cần khung.
const AUTH_PAGES = ['/login', '/register', '/forgot-password', '/reset-password'];

// Trang của Member/PT nằm trong AccountLayout (có menu trái); khung của chúng do AccountLayout đặt trong cột nội dung.
const isAccountPage = (path: string) => /^\/(member|trainer)\/./.test(path);

function BackButton({ home }: { home: string }) {
  const navigate = useNavigate();
  function goBack() {
    // React Router ghi số thứ tự trang vào history.state.idx; idx > 0 nghĩa là còn trang trước trong web này.
    const index = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (index > 0) navigate(-1);
    else navigate(home);
  }
  return <button type="button" className="back-button" onClick={goBack}><Icon name="back" label="Trở về" showLabel /></button>;
}

// scope = 'main': khung trong <main> của App (bỏ qua trang tài khoản); scope = 'account': khung trong AccountLayout.
export function PageFrame({ scope, children }: { scope: 'main' | 'account'; children: ReactNode }) {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const home = user ? rolePaths[user.roleCode] : '/';
  const noFrame = pathname === '/' || pathname === home || AUTH_PAGES.includes(pathname)
    || /^\/(admin|staff)\/members(?:\/(?!new\/?$)[^/]+)?\/?$/i.test(pathname)
    || (scope === 'main' && isAccountPage(pathname));
  if (noFrame) return <>{children}</>;
  return <div className="page-frame">
    <div className="page-frame-bar"><BackButton home={home} /></div>
    {children}
  </div>;
}
