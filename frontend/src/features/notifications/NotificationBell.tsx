// Tầng giao diện – thành phần (US-47 bước 3): chuông thông báo hiện số chưa đọc lấy từ server, bấm thì mở trang inbox.
// Không tự cộng/trừ số: luôn tải lại từ server khi có tín hiệu socket, quay lại tab hoặc đổi account (US-47-TC07, TC09, TC12).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { inboxApi } from './inbox.api';
import { useAccountId, useReloadSignals } from './inbox-signals';

export function NotificationBell() {
  const accountId = useAccountId();
  const [count, setCount] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  // Số thứ tự lần tải mới nhất: kết quả của lần tải cũ (vd. của account trước) về muộn thì bỏ qua.
  const latestLoad = useRef(0);

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

  // US-47-TC12: đổi account thì xóa số của account trước rồi tải lại.
  useEffect(() => {
    setCount(null);
    setFailed(false);
    void load();
  }, [load]);

  useReloadSignals(load);

  let label = 'Thông báo: đang tải';
  if (failed) label = 'Thông báo: chưa tải được số chưa đọc';
  else if (count !== null) label = `Thông báo: ${count} chưa đọc`;

  // Icon chuông SVG (thay emoji) + chấm số chưa đọc; tên của link vẫn là aria-label ở trên.
  return <Link to="/member/notifications" className="header-bell" aria-label={label} title={label}>
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
    {count !== null && !failed && count > 0 && <span className="header-bell-count" aria-hidden="true">{count}</span>}
  </Link>;
}
