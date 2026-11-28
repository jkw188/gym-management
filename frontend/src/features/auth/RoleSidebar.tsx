// Khung trang theo phiên đăng nhập. ProtectedRoute và API kiểm tra quyền truy cập.
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { HeaderAccount, LogoutButton } from './AuthRoutes';
import { roleNames, rolePaths } from './auth.routes';
import type { AuthUser, RoleCode } from './auth.types';
import { Icon, IconSvg, type IconName } from '../../components/Icon';
import { operationsNavigation, publicPages, type OperationsItem, type OperationsRole } from './operations.routes';
import './operations.css';

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

const MENUS: Record<Exclude<RoleCode, OperationsRole>, MenuGroup[]> = {
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
            {group.title}<IconSvg name="down" size={14} />
          </button>
          {isOpen && group.items.map(item => <NavLink key={item.to} to={item.to} end onClick={onNavigate}>
            <IconSvg name={item.icon} />{item.label}
          </NavLink>)}
        </div>;
      })}
    </nav>
  </aside>;
}

const normalizePageName = (value: string) => value.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/g, 'd').trim();

// Ô "Tìm trang…": gõ chữ thì hiện các mục menu có tên khớp; Enter mở mục đầu tiên.
function PageSearch({ groups }: { groups: MenuGroup[] }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const allItems = groups.flatMap(group => group.items);
  const keyword = normalizePageName(text);
  const matches = keyword ? allItems.filter(item => normalizePageName(item.label).includes(keyword)).slice(0, 8) : [];
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
        <button className="secondary" type="button" onClick={() => go(item.to)}><IconSvg name={item.icon} size={16} />{item.label}</button>
      </li>)}
    </ul>}
  </div>;
}

const normalizePath = (pathname: string) => pathname.toLowerCase().replace(/\/+$/, '') || '/';
const matchesPage = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);

export function AppLayout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  if (!user) return <PublicLayout>{children}</PublicLayout>;

  const role = user.roleCode;
  if (role === 'ADMIN' || role === 'STAFF') {
    const path = normalizePath(pathname);
    if (/^\/(admin|staff)(\/|$)/.test(path) || publicPages.some(page => matchesPage(path, page.to))) {
      return <OperationsLayout user={user} role={role}>{children}</OperationsLayout>;
    }
    const { pinned, groups } = operationsNavigation(role, rolePaths[role]);
    const sidebarGroups = [
      { title: 'Vào nhanh', items: pinned },
      ...groups.map(({ label, items }) => ({ title: label, items })),
    ];
    return <SignedInLayout groups={sidebarGroups}>{children}</SignedInLayout>;
  }
  return <SignedInLayout groups={MENUS[role]}>{children}</SignedInLayout>;
}

function SignedInLayout({ children, groups }: { children: ReactNode; groups: MenuGroup[] }) {
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="app-shell">
    <Sidebar groups={groups} open={menuOpen} onNavigate={() => setMenuOpen(false)} />
    <div className="app-main-col">
      <header className="app-topbar">
        <button type="button" className="menu-toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          <IconSvg name="menu" /><span className="sr-only">Mở menu</span>
        </button>
        {/* key: đổi trang thì ô tìm kiếm được làm mới (xóa chữ đang gõ). */}
        <PageSearch key={pathname} groups={groups} />
        <HeaderAccount />
      </header>
      <div className="app-content">
        <main>{children}</main>
        <footer className="app-footer">© 2026 Gym Management – Nhóm 02 · <Link to="/health">Kiểm tra nền tảng</Link></footer>
      </div>
    </div>
  </div>;
}

function OperationsLayout({ children, user, role }: {
  children: ReactNode; user: AuthUser; role: OperationsRole;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const home = rolePaths[role];
  const { pinned, groups, account } = operationsNavigation(role, home);
  const pages = [...pinned, ...groups.flatMap(group => group.items), account];
  const currentPath = normalizePath(location.pathname);
  const active = pages.find(item => item.to === currentPath) ?? pages
    .filter(item => item.to !== home && matchesPage(currentPath, item.to))
    .sort((first, second) => second.to.length - first.to.length)[0];
  const nameParts = user.fullName.trim().split(/\s+/);
  const initials = (nameParts.length > 1 ? [nameParts[0], nameParts[nameParts.length - 1]] : nameParts)
    .map(part => part.charAt(0)).join('').toUpperCase() || '?';
  const search = useRef<HTMLDialogElement>(null);
  const drawer = useRef<HTMLDialogElement>(null);
  const accountMenu = useRef<HTMLDetailsElement>(null);
  const main = useRef<HTMLElement>(null);
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const terms = normalizePageName(query).split(/\s+/);
  const matches = pages.filter(item => {
    const label = normalizePageName(`${item.label} ${item.keywords ?? ''}`);
    return terms.every(term => label.includes(term));
  });

  useLayoutEffect(() => {
    if (search.current?.open) search.current.close();
    if (drawer.current?.open) drawer.current.close();
    accountMenu.current?.removeAttribute('open');
    main.current?.scrollTo?.(0, 0);
  }, [location.pathname]);

  useEffect(() => {
    const mobile = window.matchMedia?.('(max-width: 900px)');
    const closeOnDesktop = (event: MediaQueryListEvent) => { if (!event.matches) drawer.current?.close(); };
    mobile?.addEventListener('change', closeOnDesktop);
    return () => mobile?.removeEventListener('change', closeOnDesktop);
  }, []);

  function openNavigation() {
    drawer.current?.showModal();
    drawer.current?.querySelector('button')?.focus();
    setDrawerOpen(true);
  }

  function navItem(item: OperationsItem) {
    return <Link className="gm-nav-link" key={item.to} to={item.to} aria-current={item.to === active?.to ? 'page' : undefined}
      onClick={() => { if (drawer.current?.open) drawer.current.close(); }}>
      <span className="gm-nav-icon"><Icon name={item.icon} /></span><span className="gm-nav-label">{item.label}</span>
    </Link>;
  }
  function navigation() {
    return <nav key={currentPath} aria-label="Menu chức năng">
      <div className="gm-nav-primary">{pinned.map(navItem)}</div>
      {groups.map(group => <details className="gm-nav-group" key={group.label}
        open={group.items.some(item => item.to === active?.to)}>
        <summary>{group.label}<Icon name="down" /></summary>
        <div className="gm-nav-children">{group.items.map(navItem)}</div>
      </details>)}
    </nav>;
  }
  function brand() {
    return <Link className="gm-brand" to={home} aria-label="Gym Management, trang chủ"
      onClick={() => { if (drawer.current?.open) drawer.current.close(); }}>
      <span className="gm-brand-icon"><span className="gm-brand-mark"><Icon name="weights" /></span></span>
      <span className="gm-brand-copy"><strong>Gym Management</strong><small>Quản lý phòng tập</small></span>
    </Link>;
  }
  return <div className="gm-shell">
    <aside className="gm-sidebar">{brand()}{navigation()}</aside>
    <header className="gm-toolbar">
      <div className="gm-toolbar-start">
        <button className="gm-drawer-toggle secondary" type="button" aria-haspopup="dialog" aria-controls="gm-navigation"
          aria-expanded={drawerOpen} onClick={openNavigation}>
          <Icon name="menu" label="Mở menu" />
        </button>
        <button className="gm-find secondary" type="button" aria-label="Tìm trang" aria-haspopup="dialog" aria-controls="gm-page-search"
          onClick={() => { setQuery(''); search.current?.showModal(); search.current?.querySelector('input')?.focus(); }}>
          <span className="gm-find-label">Tìm trang…</span><Icon name="search" />
        </button>
        <span className="gm-toolbar-route">{active?.label}</span>
      </div>
      <details className="gm-account" ref={accountMenu} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }} onKeyDown={event => {
        if (event.key === 'Escape' && event.currentTarget.open) {
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}>
        <summary aria-label={`Tài khoản ${user.fullName}, ${roleNames[role]}`}>
          <span className="gm-avatar" data-role={role} aria-hidden="true">{initials}</span>
          <span className="gm-account-name"><strong>{user.fullName}</strong><small>{roleNames[role]}</small></span><Icon name="down" />
        </summary>
        <div className="gm-account-actions">
          <Link to={account.to} onClick={() => accountMenu.current?.removeAttribute('open')}><Icon name={account.icon} />{account.label}</Link>
          <LogoutButton className="secondary" />
        </div>
      </details>
    </header>
    <main className="gm-main" ref={main}>{children}</main>
    <dialog className="gm-dialog gm-drawer" id="gm-navigation" aria-label="Điều hướng" ref={drawer}
      onClose={event => setDrawerOpen(event.currentTarget.open)}
      onClick={event => { if (event.target === event.currentTarget) drawer.current?.close(); }}>
      <div className="gm-drawer-body">
        <div className="gm-dialog-head">{brand()}<button type="button" className="secondary" onClick={() => drawer.current?.close()}><Icon name="close" label="Đóng menu" /></button></div>
        {navigation()}
      </div>
    </dialog>
    <dialog className="gm-dialog" id="gm-page-search" aria-labelledby="gm-page-search-title" ref={search}
      onClick={event => { if (event.target === event.currentTarget) search.current?.close(); }}>
      <div className="gm-dialog-body">
        <div className="gm-dialog-head">
          <h2 id="gm-page-search-title">Tìm trang</h2>
          <button type="button" className="secondary" onClick={() => search.current?.close()}><Icon name="close" label="Đóng tìm trang" /></button>
        </div>
        <form onSubmit={event => {
          event.preventDefault();
          if (matches[0]) { search.current?.close(); navigate(matches[0].to); }
        }}>
          <label htmlFor="gm-page-query">Tên trang</label>
          <input id="gm-page-query" placeholder="Ví dụ: hội viên, bán tại quầy" value={query}
            onChange={event => setQuery(event.target.value)} />
        </form>
        <div className="gm-page-results" aria-live="polite">
          {matches.length ? matches.map(item => <Link key={item.to} to={item.to} onClick={() => search.current?.close()}>
            <span className="gm-icon-tile"><Icon name={item.icon} /></span>{item.label}<Icon name="next" />
          </Link>) : <p>Không tìm thấy trang phù hợp.</p>}
        </div>
      </div>
    </dialog>
  </div>;
}
