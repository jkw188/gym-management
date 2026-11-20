// Tầng giao diện – thành phần dùng chung: nút "Trở về" ở đầu vùng nội dung, quay lại trang trước.
// Ẩn ở trang chủ và trang chính theo vai trò; nếu mở thẳng link (không có trang trước) thì về trang chính.
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthProvider';
import { rolePaths } from '../features/auth/auth.routes';
import { Icon } from './Icon';

export function BackButton() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const home = user ? rolePaths[user.roleCode] : '/';
  if (location.pathname === '/' || location.pathname === home) return null;

  function goBack() {
    // React Router ghi số thứ tự trang vào history.state.idx; idx > 0 nghĩa là còn trang trước trong web này.
    const index = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (index > 0) navigate(-1);
    else navigate(home);
  }

  return <button type="button" className="back-button" onClick={goBack}><Icon name="back" label="Trở về" showLabel /></button>;
}
