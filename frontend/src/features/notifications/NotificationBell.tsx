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

  return <Link to="/member/notifications" aria-label={label} title={label}>
    🔔 {count !== null && !failed ? count : ''}
  </Link>;
}
