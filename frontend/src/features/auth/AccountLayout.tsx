// Tầng giao diện – khung trang tài khoản của Member và PT: đặt trang con vào khung chung (PageFrame) có nút "Trở về".
// Menu chức năng nằm trên thanh menu tab (RoleTaskbar) dưới header; quyền truy cập do ProtectedRoute bọc bên ngoài quyết định.
import { Outlet } from 'react-router-dom';
import { PageFrame } from '../../components/BackButton';

// role giữ lại để App.tsx khai báo rõ khung này của vai trò nào.
export function AccountLayout(_props: { role: 'MEMBER' | 'TRAINER' }) {
  return <div className="account-content"><PageFrame scope="account"><Outlet /></PageFrame></div>;
}
