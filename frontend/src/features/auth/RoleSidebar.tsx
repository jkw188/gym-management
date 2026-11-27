// Tầng giao diện – thành phần: khung trang chung. Guest: thanh menu công khai + nội dung. Đã đăng nhập (mọi vai trò):
// thanh bên tối màu (menu chia nhóm có icon) + thanh trên (tìm trang, chuông, tài khoản) + vùng nội dung sáng bo góc.
// Chỉ là điều hướng; quyền vào từng trang vẫn do ProtectedRoute và API quyết định.
import { useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { HeaderAccount } from './AuthRoutes';
import type { RoleCode } from './auth.types';
import { IconSvg, type IconName } from '../../components/Icon';

interface MenuItem { to: string; label: string; icon: IconName }
interface MenuGroup { title: string; items: MenuItem[] }

// Nhóm "Khám phá": các trang công khai, vai trò nào cũng thấy.
const exploreGroup: MenuGroup = {
  title: 'Khám phá',
  items: [
    { to: '/', label: 'Trang chủ', icon: 'home' },
    { to: '/classes', label: 'Lịch lớp', icon: 'calendar' },
    { to: '/services', label: 'Gói dịch vụ', icon: 'dumbbell' },
    { to: '/shop', label: 'Cửa hàng', icon: 'bag' },
  ],
};

// Các nhóm chung của Admin và Staff (đường dẫn bắt đầu bằng /admin hoặc /staff).
function counterGroups(home: string): MenuGroup[] {
  return [
    { title: 'Hội viên', items: [
      { to: `${home}/members`, label: 'Tra cứu hội viên', icon: 'users' },
      { to: `${home}/members/new`, label: 'Tạo hồ sơ hội viên', icon: 'userPlus' },
    ] },
    { title: 'Vận hành', items: [
      { to: `${home}/transactions`, label: 'Đối chiếu thanh toán', icon: 'card' },
      // US-29: tra cứu và hủy hỗ trợ lịch PT.
      { to: `${home}/pt-bookings`, label: 'Tra cứu lịch PT', icon: 'calendar' },
      { to: `${home}/trainer-attendance`, label: 'Chấm công huấn luyện viên', icon: 'clock' },
    ] },
    { title: 'Bán hàng', items: [
      { to: `${home}/pos`, label: 'Bán sản phẩm tại quầy', icon: 'cart' },
      { to: `${home}/orders`, label: 'Chuẩn bị đơn website', icon: 'bag' },
      { to: `${home}/returns`, label: 'Tiếp nhận hàng trả', icon: 'returnArrow' },
      { to: `${home}/refunds`, label: 'Nghĩa vụ hoàn tiền', icon: 'coin' },
    ] },
  ];
}

// Nhóm kho: Staff có 2 mục, Admin có thêm xuất ngoài bán và kiểm kê.
function stockGroup(home: string, isAdmin: boolean): MenuGroup {
  const items: MenuItem[] = [
    { to: `${home}/stock-receipts`, label: 'Phiếu nhập kho', icon: 'receipt' },
    { to: `${home}/inventory`, label: 'Tra cứu tồn kho', icon: 'box' },
  ];
  if (isAdmin) {
    items.push({ to: '/admin/stock-issues', label: 'Phiếu xuất ngoài bán', icon: 'truck' });
    items.push({ to: '/admin/stock-adjustments', label: 'Kiểm kê và điều chỉnh kho', icon: 'clipboard' });
  }
  return { title: 'Kho', items };
}

// "Thông tin tài khoản" không nằm ở đây vì đã có ô tài khoản trên thanh trên.
const MENUS: Record<RoleCode, MenuGroup[]> = {
  MEMBER: [
    // US-17: gói tập, lịch sử mua và chứng từ. US-18: tự đăng ký mua gói. US-27: lịch PT và giờ trống của PT.
    { title: 'Gói tập', items: [
      { to: '/member/memberships', label: 'Gói tập của tôi', icon: 'dumbbell' },
      { to: '/member/service-registrations', label: 'Đăng ký gói tập', icon: 'card' },
      { to: '/member/pt-bookings', label: 'Lịch PT của tôi', icon: 'calendar' },
    ] },
    { title: 'Mua sắm', items: [
      { to: '/member/cart', label: 'Giỏ hàng của tôi', icon: 'cart' },
      { to: '/member/orders', label: 'Đơn hàng của tôi', icon: 'bag' },
    ] },
    { title: 'Tin nhắn', items: [{ to: '/member/notifications', label: 'Hộp thư thông báo', icon: 'bell' }] },
    exploreGroup,
  ],
  TRAINER: [
    // US-24: ca làm việc. US-64: buổi dạy. US-30: học viên. US-31: đánh giá của học viên.
    { title: 'Công việc', items: [
      { to: '/trainer/shifts', label: 'Ca làm việc', icon: 'clock' },
      { to: '/trainer/bookings', label: 'Buổi dạy của tôi', icon: 'calendar' },
      { to: '/trainer/trainees', label: 'Học viên của tôi', icon: 'users' },
      { to: '/trainer/reviews', label: 'Đánh giá của học viên', icon: 'star' },
    ] },
    exploreGroup,
  ],
  STAFF: [...counterGroups('/staff'), stockGroup('/staff', false), exploreGroup],
  ADMIN: [
    { title: 'Hệ thống', items: [
      { to: '/admin/users', label: 'Quản lý tài khoản', icon: 'shield' },
      { to: '/admin/notifications', label: 'Thông báo nhóm', icon: 'megaphone' },
    ] },
    ...counterGroups('/admin'),
    stockGroup('/admin', true),
    { title: 'Huấn luyện viên', items: [
      { to: '/admin/trainers', label: 'Quản lý huấn luyện viên', icon: 'user' },
      { to: '/admin/trainers/activity', label: 'Đối chiếu chấm công và buổi PT', icon: 'activity' },
      { to: '/admin/trainer-reviews', label: 'Tổng hợp đánh giá PT', icon: 'star' },
      { to: '/admin/classes', label: 'Quản lý lớp miễn phí', icon: 'calendar' },
    ] },
    { title: 'Danh mục', items: [
      { to: '/admin/plans', label: 'Danh mục gói tập và PT', icon: 'dumbbell' },
      { to: '/admin/categories', label: 'Danh mục bán lẻ', icon: 'layers' },
      { to: '/admin/products', label: 'Sản phẩm bán lẻ', icon: 'tag' },
    ] },
    { title: 'Báo cáo', items: [
      { to: '/admin/reports/memberships', label: 'Báo cáo hội viên và membership', icon: 'chart' },
      { to: '/admin/reports/cash-flow', label: 'Báo cáo khoản thu và hoàn tiền', icon: 'coin' },
      { to: '/admin/reports/trainers', label: 'Báo cáo hiệu suất huấn luyện viên', icon: 'activity' },
    ] },
    exploreGroup,
  ],
};

// Logo dùng chung cho thanh công khai và thanh bên.
function Brand() {
  return <Link to="/" className="brand">
    <span className="brand-mark" aria-hidden="true"><IconSvg name="dumbbell" size={20} /></span>
    <span className="brand-text"><strong>Gym Management</strong><small>Quản lý phòng tập</small></span>
  </Link>;
}

// Guest: thanh menu công khai trên cùng, nội dung và chân trang như trước.
function PublicLayout({ children }: { children: ReactNode }) {
  return <>
    <header className="site-header"><div className="site-header-inner">
      <Brand />
      <nav aria-label="Điều hướng chính">
        <NavLink to="/" end>Trang chính</NavLink><NavLink to="/classes">Lịch lớp</NavLink>
        <NavLink to="/services">Gói dịch vụ</NavLink><NavLink to="/shop">Cửa hàng</NavLink>
      </nav>
      <HeaderAccount />
    </div></header>
    <main>{children}</main>
    <footer className="site-footer">© 2026 Gym Management – Nhóm 02 · <Link to="/health">Kiểm tra nền tảng</Link></footer>
  </>;
}

// Thanh bên: logo + các nhóm menu. Bấm tên nhóm để thu gọn / mở lại nhóm đó.
function Sidebar({ groups, open, onNavigate }: { groups: MenuGroup[]; open: boolean; onNavigate: () => void }) {
  // Tên các nhóm đang thu gọn. Mặc định mở hết.
  const [collapsed, setCollapsed] = useState<string[]>([]);
  function toggle(title: string) {
    setCollapsed(current => current.includes(title) ? current.filter(item => item !== title) : [...current, title]);
  }
  return <aside className={open ? 'app-sidebar open' : 'app-sidebar'}>
    <Brand />
    {/* NavLink "end" để /staff/members không sáng khi đang ở /staff/members/new. */}
    <nav aria-label="Menu chức năng">
      {groups.map(group => {
        const isOpen = !collapsed.includes(group.title);
        return <div key={group.title} className="nav-group">
          <button type="button" className="nav-group-title" aria-expanded={isOpen} onClick={() => toggle(group.title)}>
            {group.title}<IconSvg name="chevronDown" size={14} />
          </button>
          {isOpen && group.items.map(item => <NavLink key={item.to} to={item.to} end onClick={onNavigate}>
            <IconSvg name={item.icon} />{item.label}
          </NavLink>)}
        </div>;
      })}
    </nav>
  </aside>;
}

// Ô "Tìm trang…": gõ chữ thì hiện các mục menu có tên khớp; Enter mở mục đầu tiên.
function PageSearch({ groups }: { groups: MenuGroup[] }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const allItems = groups.flatMap(group => group.items);
  const keyword = text.trim().toLowerCase();
  const matches = keyword ? allItems.filter(item => item.label.toLowerCase().includes(keyword)).slice(0, 8) : [];
  function go(to: string) {
    setText('');
    navigate(to);
  }
  return <div className="page-search">
    <input type="search" placeholder="Tìm trang…" aria-label="Tìm trang" value={text}
      onChange={event => setText(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && matches.length > 0) go(matches[0].to); }} />
    <IconSvg name="search" size={16} />
    {keyword && <ul className="page-search-results">
      {matches.length === 0 && <li className="page-search-empty">Không có trang nào khớp.</li>}
      {matches.map(item => <li key={item.to}>
        <button type="button" onClick={() => go(item.to)}><IconSvg name={item.icon} size={16} />{item.label}</button>
      </li>)}
    </ul>}
  </div>;
}

// Đã đăng nhập: thanh bên + thanh trên + vùng nội dung. Chưa đăng nhập: PublicLayout.
export function AppLayout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  // Trên điện thoại thanh bên ẩn, bấm nút ba gạch để mở; chọn trang xong thì tự đóng.
  const [menuOpen, setMenuOpen] = useState(false);
  if (!user) return <PublicLayout>{children}</PublicLayout>;
  const groups = MENUS[user.roleCode];
  return <div className="app-shell">
    <Sidebar groups={groups} open={menuOpen} onNavigate={() => setMenuOpen(false)} />
    <div className="app-main-col">
      <header className="app-topbar">
        <button type="button" className="menu-toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          <IconSvg name="menu" /><span className="sr-only">Mở menu</span>
        </button>
        {/* key: đổi trang thì ô tìm kiếm được làm mới (xóa chữ đang gõ). */}
        <PageSearch key={location.pathname} groups={groups} />
        <HeaderAccount />
      </header>
      <div className="app-content">
        <main>{children}</main>
        <footer className="app-footer">© 2026 Gym Management – Nhóm 02 · <Link to="/health">Kiểm tra nền tảng</Link></footer>
      </div>
    </div>
  </div>;
}
