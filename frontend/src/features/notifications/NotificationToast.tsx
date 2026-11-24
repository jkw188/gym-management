import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { notificationFeed } from './notification-feed';
import type { NotificationItem } from './notifications.types';
import { NotificationSourceLink } from './NotificationSourceLink';
import { Icon } from '../../components/Icon';

// US-48: các vai trò ngoài Member dùng toast và sync/ack, không truy cập inbox Member.
export function NotificationToast() {
  const { user } = useAuth();
  return user && user.roleCode !== 'MEMBER' ? <AccountToast key={user.id} role={user.roleCode} /> : null;
}
function AccountToast({ role }: { role: string }) {
  const [item, setItem] = useState<NotificationItem>();
  useEffect(() => {
    const seen = new Set(notificationFeed.getItems().map(row => row.id));
    return notificationFeed.subscribe(() => {
      const incoming = notificationFeed.getItems().filter(row => !seen.has(row.id));
      for (const row of incoming) seen.add(row.id);
      if (incoming.length) setItem(incoming[incoming.length - 1]);
    });
  }, []);
  // Bố cục thẻ thông báo: hàng đầu là tiêu đề + nút X đóng ở góc phải; giữa là nội dung (dài thì tự xuống dòng,
  // quá cao thì cuộn trong thẻ, không bị che); cuối là link tới trang liên quan (nếu có).
  return item ? <aside role="status" className="auth-card notification-toast">
    <div className="notification-toast-head">
      <strong>{item.title}</strong>
      <button type="button" className="close-x" onClick={() => setItem(undefined)}><Icon name="close" label="Đóng thông báo" /></button>
    </div>
    <p className="notification-toast-body">{item.body}</p>
    <div className="notification-toast-link"><NotificationSourceLink source={item.source} role={role} /></div>
  </aside> : null;
}
