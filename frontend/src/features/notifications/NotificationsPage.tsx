// Tầng giao diện – trang (US-47 bước 3): trang /member/notifications xem thông báo của mình, lọc, phân trang, mở chi tiết.
// Mở chi tiết thành công rồi MỚI gửi mark-read; số chưa đọc luôn lấy lại từ server, không tự trừ (US-47-F02, TC07, TC12).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { inboxApi, type InboxDetail, type InboxPage, type ReadState } from './inbox.api';
import { announceInboxChanged, useAccountId, useReloadSignals } from './inbox-signals';
import { Icon } from '../../components/Icon';
import { NotificationSourceLink } from './NotificationSourceLink';
import { formatNotificationTime } from './notification-time';

const PAGE_SIZE = 20;

const FILTERS: { value: ReadState; label: string }[] = [
  { value: 'ALL', label: 'Tất cả' },
  { value: 'UNREAD', label: 'Chưa đọc' },
  { value: 'READ', label: 'Đã đọc' },
];

const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

export function NotificationsPage() {
  const accountId = useAccountId();
  const location = useLocation();
  const navigate = useNavigate();
  const [readState, setReadState] = useState<ReadState>('ALL');
  const [pageNumber, setPageNumber] = useState(1);
  const [data, setData] = useState<InboxPage | null>(null);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [selected, setSelected] = useState<InboxDetail | null>(null);
  const [actionError, setActionError] = useState('');
  // Số thứ tự lần tải danh sách mới nhất: kết quả cũ về muộn thì bỏ qua (tránh hiện dữ liệu account trước).
  const latestLoad = useRef(0);
  // Account hiện tại, để bỏ kết quả mở chi tiết/mark-read về sau khi đã đổi account.
  const currentAccount = useRef(accountId);
  currentAccount.current = accountId;

  const loadList = useCallback(async () => {
    if (!accountId) return;
    const loadNumber = ++latestLoad.current;
    setLoading(true);
    setListError('');
    try {
      // US-47-TC09: luôn đọc lịch sử từ REST (MongoDB), không lấy từ bộ đệm socket.
      const result = await inboxApi.list({ readState, page: pageNumber, limit: PAGE_SIZE });
      if (loadNumber !== latestLoad.current) return;
      setData(result);
      setUnreadCount(result.unreadCount);
    } catch (error) {
      if (loadNumber === latestLoad.current) setListError(errorMessage(error, 'Không tải được danh sách thông báo.'));
    } finally {
      if (loadNumber === latestLoad.current) setLoading(false);
    }
  }, [accountId, readState, pageNumber]);

  // US-47-TC12: đổi account thì xóa ngay dữ liệu của account trước.
  useEffect(() => {
    setData(null);
    setUnreadCount(null);
    setSelected(null);
    setActionError('');
  }, [accountId]);

  useEffect(() => { void loadList(); }, [loadList]);

  // US-47-TC05, TC09, TC10: tín hiệu socket hoặc quay lại tab chỉ tải lại danh sách (lệnh GET), không đánh dấu đã đọc.
  useReloadSignals(loadList);

  // US-47-TC08: đổi bộ lọc thì quay về trang 1.
  function changeFilter(value: ReadState) {
    setReadState(value);
    setPageNumber(1);
  }

  // US-47-TC07: hiện nội dung trước, mở thành công mới mark-read, rồi lấy lại số chưa đọc từ server.
  async function openNotification(id: string) {
    const account = accountId;
    setActionError('');
    let detail: InboxDetail;
    try {
      detail = await inboxApi.detail(id);
    } catch (error) {
      if (currentAccount.current === account) setActionError(errorMessage(error, 'Không mở được thông báo.'));
      return;
    }
    if (currentAccount.current !== account) return;
    setSelected(detail);
    try {
      await inboxApi.markRead(id);
    } catch {
      // US-47-TC12: mark-read lỗi thì giữ nguyên số chưa đọc, không báo thành công giả.
      if (currentAccount.current === account) setActionError('Chưa đánh dấu đã đọc được, vui lòng thử lại sau.');
      return;
    }
    if (currentAccount.current !== account) return;
    try {
      const result = await inboxApi.unreadCount();
      if (currentAccount.current === account) setUnreadCount(result.unreadCount);
    } catch {
      // Không lấy được số mới thì giữ số cũ; lần tải lại sau (focus/socket) sẽ cập nhật.
    }
    // Báo cho chuông và chính trang này tải lại (danh sách thấy thông báo đã đọc, chuông giảm số theo server).
    announceInboxChanged();
  }

  // Bấm một thông báo trong dropdown của chuông: chuông chuyển sang đây kèm state.openId, trang mở luôn cửa sổ chi tiết.
  // Mở xong thì xóa state (replace) để tải lại trang hay bấm "Trở về" không mở lại lần nữa.
  const openIdFromBell = (location.state as { openId?: string } | null)?.openId;
  useEffect(() => {
    if (!openIdFromBell || !accountId) return;
    navigate(location.pathname, { replace: true, state: null });
    void openNotification(openIdFromBell);
  // Chỉ chạy khi có openId mới từ chuông (hoặc đổi account); openNotification không cần nằm trong danh sách này.
  }, [openIdFromBell, accountId]);

  // Cửa sổ chi tiết đang mở thì bấm phím Esc để đóng.
  useEffect(() => {
    if (!selected) return;
    function onKeyDown(event: KeyboardEvent) { if (event.key === 'Escape') setSelected(null); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selected]);

  return <section className="auth-card notification-inbox">
    <h2>Thông báo</h2>
    {unreadCount !== null && <p>Chưa đọc: {unreadCount}</p>}

    <div role="group" aria-label="Lọc theo trạng thái đọc">
      {FILTERS.map(filter => <button key={filter.value} type="button" aria-pressed={readState === filter.value}
        onClick={() => changeFilter(filter.value)}>{filter.label}</button>)}
    </div>

    {loading && <p>Đang tải…</p>}
    {listError && <div role="alert">{listError} <button type="button" onClick={() => void loadList()}><Icon name="retry" label="Thử lại" /></button></div>}
    {actionError && <p role="alert">{actionError}</p>}

    {data && data.items.length === 0 && !listError && <p>Chưa có thông báo nào.</p>}
    {data && data.items.length > 0 && <ul>
      {/* Mỗi dòng hiện tiêu đề và thời gian; bấm vào thì mở cửa sổ chi tiết. Chưa đọc: chữ đậm, chấm xanh.
          React hiện title dạng chữ, không dịch HTML (US-47-TC11). key theo id nên mỗi thông báo một dòng. */}
      {data.items.map(item => <li key={item.id}>
        <button type="button" className={item.readAt ? 'notification-item' : 'notification-item notification-unread'}
          onClick={() => void openNotification(item.id)}>
          {!item.readAt && <span className="sr-only">Mới: </span>}
          <span className="notification-text">{item.title}</span>
          <time dateTime={item.createdAt}>{formatNotificationTime(item.createdAt)}</time>
        </button>
      </li>)}
    </ul>}

    {data && data.totalPages > 0 && <nav aria-label="Phân trang thông báo">
      <button type="button" disabled={pageNumber <= 1} onClick={() => setPageNumber(pageNumber - 1)}><Icon name="prev" label="Trang trước" /></button>
      <span> Trang {data.page}/{data.totalPages} </span>
      <button type="button" disabled={pageNumber >= data.totalPages} onClick={() => setPageNumber(pageNumber + 1)}><Icon name="next" label="Trang sau" /></button>
    </nav>}

    {/* Cửa sổ chi tiết nổi giữa màn hình; bấm nền tối, nút "Đóng" hoặc phím Esc để đóng. */}
    {selected && <div className="modal-backdrop" onClick={() => setSelected(null)}>
    <article className="modal-card" role="dialog" aria-modal="true" aria-labelledby="notification-detail-title"
      onClick={event => event.stopPropagation()}>
      <div className="modal-head">
        <h3 id="notification-detail-title">{selected.title}</h3>
        <button type="button" className="secondary" onClick={() => setSelected(null)}>Đóng</button>
      </div>
      <p><small>{formatNotificationTime(selected.createdAt)}</small></p>
      {/* US-47-F05, TC11: body hiện như chữ thuần; URL trong body không thành link, không tự chuyển trang. */}
      <p className="notification-body">{selected.body}</p>
      <NotificationSourceLink source={selected.source} role="MEMBER" />
      {selected.source && <p>Thông báo lưu tại thời điểm nhắc. Xem trang gói/lịch để biết trạng thái hiện tại.</p>}
    </article>
    </div>}
  </section>;
}
