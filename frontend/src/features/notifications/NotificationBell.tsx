// Tầng giao diện – thành phần (US-47 bước 3): chuông thông báo hiện số chưa đọc lấy từ server; bấm chuông mở dropdown 5 thông báo mới nhất.
// Không tự cộng/trừ số: luôn tải lại từ server khi có tín hiệu socket, quay lại tab hoặc đổi account (US-47-TC07, TC09, TC12).
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { inboxApi, type InboxItem } from './inbox.api';
import { useAccountId, useReloadSignals } from './inbox-signals';
import { formatNotificationTime } from './notification-time';

// Số thông báo hiện trong dropdown; muốn xem hết thì bấm "Xem tất cả thông báo".
const DROPDOWN_SIZE = 5;

export function NotificationBell() {
  const accountId = useAccountId();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [count, setCount] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  // Số thứ tự lần tải mới nhất: kết quả của lần tải cũ (vd. của account trước) về muộn thì bỏ qua.
  const latestLoad = useRef(0);
  // Khối bao chuông + dropdown, để biết người dùng bấm ra ngoài thì đóng dropdown.
  const wrapper = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const loadNumber = ++latestLoad.current;
    try {
      const result = await inboxApi.unreadCount();
      if (loadNumber !== latestLoad.current) return;
      setCount(result.unreadCount);
      setFailed(false);
    } catch {
      if (loadNumber === latestLoad.current) setFailed(true);
    }
  }, [accountId]);

  // US-47-TC12: đổi account thì xóa số và danh sách của account trước rồi tải lại.
  useEffect(() => {
    setCount(null);
    setFailed(false);
    setItems(null);
    setOpen(false);
    void load();
  }, [load]);

  useReloadSignals(load);

  // Dropdown đang mở thì tải 5 thông báo mới nhất (chỉ đọc, KHÔNG đánh dấu đã đọc).
  useEffect(() => {
    if (!open || !accountId) return;
    let ignore = false;
    setListFailed(false);
    inboxApi.list({ readState: 'ALL', page: 1, limit: DROPDOWN_SIZE })
      .then(result => { if (!ignore) setItems(result.items); })
      .catch(() => { if (!ignore) setListFailed(true); });
    return () => { ignore = true; };
  }, [open, accountId, count]);

  // Đóng dropdown khi bấm ra ngoài, bấm phím Esc hoặc chuyển sang trang khác.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(event: globalThis.MouseEvent) {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) { if (event.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onMouseDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open]);
  useEffect(() => { setOpen(false); }, [pathname]);

  // Chuông vẫn là link tới hộp thư (mở tab mới bằng chuột giữa vẫn được), nhưng bấm thường thì chỉ mở/đóng dropdown.
  function toggle(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    setOpen(value => !value);
  }

  // Bấm một thông báo: sang hộp thư và mở luôn cửa sổ chi tiết của thông báo đó (hộp thư lo việc mark-read).
  function openItem(id: string) {
    setOpen(false);
    navigate('/member/notifications', { state: { openId: id } });
  }

  let label = 'Thông báo: đang tải';
  if (failed) label = 'Thông báo: chưa tải được số chưa đọc';
  else if (count !== null) label = `Thông báo: ${count} chưa đọc`;

  // Icon chuông SVG + chấm số chưa đọc; tên của link vẫn là aria-label ở trên.
  return <div className="bell-menu" ref={wrapper}>
    <Link to="/member/notifications" className="header-bell" aria-label={label} title={label}
      aria-haspopup="true" aria-expanded={open} onClick={toggle}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
      {count !== null && !failed && count > 0 && <span className="header-bell-count" aria-hidden="true">{count}</span>}
    </Link>
    {open && <div className="bell-dropdown" role="region" aria-label="Thông báo mới nhất">
      <div className="bell-dropdown-head"><strong>Thông báo</strong>{count !== null && <span>{count} chưa đọc</span>}</div>
      {items === null && !listFailed && <p className="bell-dropdown-note">Đang tải…</p>}
      {listFailed && <p className="bell-dropdown-note" role="alert">Không tải được thông báo.</p>}
      {items && items.length === 0 && <p className="bell-dropdown-note">Chưa có thông báo nào.</p>}
      {items && items.length > 0 && <ul>
        {/* Dropdown chỉ hiện nội dung xem trước và thời gian; chưa đọc thì có chấm xanh. React hiện chữ thuần (US-47-TC11). */}
        {items.map(item => <li key={item.id}>
          <button type="button" className={item.readAt ? 'bell-item' : 'bell-item notification-unread'} onClick={() => openItem(item.id)}>
            <span className="notification-text">{item.bodyPreview}</span>
            <time dateTime={item.createdAt}>{formatNotificationTime(item.createdAt)}</time>
          </button>
        </li>)}
      </ul>}
      <Link to="/member/notifications" className="bell-dropdown-all" onClick={() => setOpen(false)}>Xem tất cả thông báo</Link>
    </div>}
  </div>;
}
