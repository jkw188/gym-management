// Tầng giao diện – khung chung: thanh menu, banner, vùng nội dung <main>, chân trang và khai báo mọi route.
import { FoundationStatus } from './features/foundation/FoundationStatus';
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './features/auth/AuthProvider';
import { HomeRedirect, LogoutButton, MemberNotificationBell, ProtectedRoute, RoleShell } from './features/auth/AuthRoutes';
import { LoginPage } from './features/auth/LoginPage';
import { RegisterPage } from './features/auth/RegisterPage';
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage';
import { PasswordResetFlow } from './features/auth/PasswordResetFlow';
import { ResetPasswordPage } from './features/auth/ResetPasswordPage';
import { rolePaths } from './features/auth/auth.routes';
import type { RoleCode } from './features/auth/auth.types';
import { ProfilePage } from './features/profile/ProfilePage';
import { NotificationsPage } from './features/notifications/NotificationsPage';
import { ChangePasswordPage } from './features/security/ChangePasswordPage';
import { UsersPage } from './features/users/UsersPage';
import { ShiftsPage } from './features/shifts/ShiftsPage';
import { TrainerBookingsPage } from './features/pt-bookings/TrainerBookingsPage';
import { ClassesPage } from './features/classes/ClassesPage';
import { NewMemberPage } from './features/members/NewMemberPage';
import { MyMembershipsPage } from './features/memberships/MyMembershipsPage';
import { PtBookingsPage } from './features/pt-bookings/PtBookingsPage';
import { SupportPtBookingsPage } from './features/pt-bookings/SupportPtBookingsPage';
import { MemberDetailPage } from './features/members/MemberDetailPage';
import { MembersPage } from './features/members/MembersPage';
import { PlansPage } from './features/plans/PlansPage';
import { TraineesPage } from './features/trainees/TraineesPage';

export default function App() {
  return <BrowserRouter><AuthProvider>
    {/* Thanh trên cùng: logo bên trái, menu bên phải. NavLink tự thêm class "active" cho trang đang mở. */}
    <header className="site-header"><div className="site-header-inner">
      <Link to="/" className="brand"><span className="brand-mark" aria-hidden="true">GM</span>Gym Management</Link>
      <nav aria-label="Điều hướng chính"><NavLink to="/" end>Trang chính</NavLink><NavLink to="/classes">Lịch lớp</NavLink>
        <NavLink to="/health">Kiểm tra nền tảng</NavLink><MemberNotificationBell /><LogoutButton /></nav>
    </div></header>
    {/* Dải banner tối dưới thanh menu: tiêu đề lớn và khẩu hiệu. */}
    <section className="hero"><div className="hero-inner"><h1>Gym Management</h1>
      <p>Nền tảng quản lý phòng Gym, hội viên và dịch vụ thể hình trực tuyến.</p></div></section>
    <main>
    <Routes><Route path="/" element={<HomeRedirect />} /><Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/health" element={<FoundationStatus />} />
      {/* US-26: lịch lớp miễn phí công khai, KHÔNG bọc ProtectedRoute nên Guest xem được. */}
      <Route path="/classes" element={<ClassesPage />} />
      {/* US-05: hai trang con dùng chung PasswordResetFlow để giữ challenge trong bộ nhớ khi chuyển trang. */}
      <Route element={<PasswordResetFlow />}><Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} /></Route>
      <Route element={<ProtectedRoute role="ADMIN" />}><Route path="/admin/users" element={<UsersPage />} /></Route>
      <Route element={<ProtectedRoute role="ADMIN" />}><Route path="/admin/plans" element={<PlansPage />} /></Route>
      <Route element={<ProtectedRoute role="ADMIN" />}><Route path="/admin/members" element={<MembersPage />} /></Route>
      <Route element={<ProtectedRoute role="STAFF" />}><Route path="/staff/members" element={<MembersPage />} /></Route>
      <Route element={<ProtectedRoute role="ADMIN" />}><Route path="/admin/members/new" element={<NewMemberPage />} /></Route>
      <Route element={<ProtectedRoute role="STAFF" />}><Route path="/staff/members/new" element={<NewMemberPage />} /></Route>
      <Route element={<ProtectedRoute role="ADMIN" />}><Route path="/admin/members/:id" element={<MemberDetailPage />} /></Route>
      <Route element={<ProtectedRoute role="STAFF" />}><Route path="/staff/members/:id" element={<MemberDetailPage />} /></Route>
      {/* US-29: Staff/Admin tra cứu và hủy hỗ trợ lịch PT (server kiểm quyền ptBookings.readSupport/cancelSupport). */}
      <Route element={<ProtectedRoute role="STAFF" />}><Route path="/staff/pt-bookings" element={<SupportPtBookingsPage />} /></Route>
      <Route element={<ProtectedRoute role="ADMIN" />}><Route path="/admin/pt-bookings" element={<SupportPtBookingsPage />} /></Route>
      <Route element={<ProtectedRoute role="MEMBER" />}><Route path="/member/profile" element={<ProfilePage role="MEMBER" />} />
        <Route path="/member/security" element={<ChangePasswordPage />} />
        {/* US-47: inbox thông báo của member. */}
        <Route path="/member/notifications" element={<NotificationsPage />} />
        {/* US-17: gói tập, lịch sử mua và chứng từ của member (chỉ đọc). */}
        <Route path="/member/memberships" element={<MyMembershipsPage />} />
        {/* US-27: lịch PT riêng và xem giờ trống của PT. */}
        <Route path="/member/pt-bookings" element={<PtBookingsPage />} /></Route>
      <Route element={<ProtectedRoute role="TRAINER" />}><Route path="/trainer/profile" element={<ProfilePage role="TRAINER" />} />
        <Route path="/trainer/security" element={<ChangePasswordPage />} />
        {/* US-24: lịch tuần và ca nháp của PT. */}
        <Route path="/trainer/shifts" element={<ShiftsPage />} />
        {/* US-64 bước 4: PT xem buổi dạy và xác nhận buổi đã dạy; chỉ TRAINER. */}
        <Route path="/trainer/bookings" element={<TrainerBookingsPage />} />
        {/* US-30 bước 3: PT tra cứu học viên có buổi với mình; chỉ TRAINER. */}
        <Route path="/trainer/trainees" element={<TraineesPage />} /></Route>
      {(Object.entries(rolePaths) as [RoleCode, string][]).map(([role, path]) => <Route key={role} element={<ProtectedRoute role={role} />}>
        <Route path={path} element={<RoleShell role={role} />} /></Route>)}
      <Route path="*" element={<section><h2>Không tìm thấy trang</h2><Link to="/">Về trang chính</Link></section>} />
    </Routes>
    </main>
    <footer className="site-footer">© 2026 Gym Management – Nhóm 02</footer>
  </AuthProvider></BrowserRouter>;
}
