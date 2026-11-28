// Tầng giao diện – thành phần: khung trang khi đã đăng nhập = menu chức năng dọc bên trái (theo vai trò) + nội dung bên phải.
// Chỉ là điều hướng; quyền vào từng trang vẫn do ProtectedRoute và API quyết định. Guest không có menu này.
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { useAuth } from './AuthProvider';
import { LogoutButton } from './AuthRoutes';
import { roleNames, rolePaths } from './auth.routes';
import type { AuthUser, RoleCode } from './auth.types';
import { operationsNavigation, publicPages, type OperationsItem, type OperationsRole } from './operations.routes';
import './operations.css';

interface TaskbarItem { to: string; label: string }

// "Thông tin tài khoản" không nằm ở đây vì đã có ô tài khoản trên header.
const MENUS: Record<Exclude<RoleCode, OperationsRole>, TaskbarItem[]> = {
  MEMBER: [
    // US-17: gói tập, lịch sử mua và chứng từ. US-18: tự đăng ký mua gói. US-27: lịch PT và giờ trống của PT.
    { to: '/member/memberships', label: 'Gói tập của tôi' },
    { to: '/member/service-registrations', label: 'Đăng ký gói tập' },
    { to: '/member/pt-bookings', label: 'Lịch PT của tôi' },
    { to: '/member/orders', label: 'Đơn hàng của tôi' },
    { to: '/member/cart', label: 'Giỏ hàng của tôi' },
    { to: '/member/notifications', label: 'Hộp thư thông báo' },
  ],
  TRAINER: [
    // US-64: buổi dạy và xác nhận đã dạy. US-30: học viên có buổi với mình. US-31: đánh giá của học viên.
    { to: '/trainer/shifts', label: 'Ca làm việc' },
    { to: '/trainer/bookings', label: 'Buổi dạy của tôi' },
    { to: '/trainer/trainees', label: 'Học viên của tôi' },
    { to: '/trainer/reviews', label: 'Đánh giá của học viên' },
  ],
};

const normalizePath = (pathname: string) => pathname.toLowerCase().replace(/\/+$/, '') || '/';
const matchesPage = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);

// Guest: chỉ có <main>. Đã đăng nhập: menu trái (tên, vai trò, các chức năng xếp từ trên xuống) + <main> bên phải.
export function AppLayout({ children, header, footer }: { children: ReactNode; header: ReactNode; footer: ReactNode }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  if (!user) return <>{header}<main>{children}</main>{footer}</>;
  const role = user.roleCode;
  let menu: TaskbarItem[];
  if (role === 'ADMIN' || role === 'STAFF') {
    const path = normalizePath(pathname);
    if (/^\/(admin|staff)(\/|$)/.test(path) || publicPages.some(page => matchesPage(path, page.to))) {
      return <OperationsLayout user={user} role={role}>{children}</OperationsLayout>;
    }
    const { pinned, groups } = operationsNavigation(role, rolePaths[role]);
    menu = [...pinned.slice(1), ...groups.flatMap(group => group.items.filter(item => item.to.startsWith(`${rolePaths[role]}/`)))];
  } else {
    menu = MENUS[role];
  }
  const initial = user.fullName.trim().split(/\s+/).pop()?.charAt(0).toUpperCase() ?? '?';
  return <>{header}<div className="app-with-sidebar">
    <aside className="role-sidebar">
      <div className="role-sidebar-head">
        <span className="account-avatar" aria-hidden="true">{initial}</span>
        <span><strong>{user.fullName}</strong><small>{roleNames[user.roleCode]}</small></span>
      </div>
      {/* NavLink "end" để /staff/members không sáng khi đang ở /staff/members/new. */}
      <nav aria-label="Menu chức năng">
        {menu.map(item => <NavLink key={item.to} to={item.to} end>{item.label}</NavLink>)}
      </nav>
    </aside>
    <main>{children}</main>
  </div>{footer}</>;
}

const normalizePageName = (value: string) => value.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/g, 'd').trim();

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
