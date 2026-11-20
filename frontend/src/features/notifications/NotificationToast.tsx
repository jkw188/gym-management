import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { notificationFeed } from './notification-feed';
import type { NotificationItem } from './notifications.types';
import { NotificationSourceLink } from './NotificationSourceLink';

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
  // Toast chỉ hiện nội dung và thời gian nhận (giờ Việt Nam).
  return item ? <aside role="status" className="auth-card"><p>{item.body}</p>
    <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' })}</time>
    <NotificationSourceLink source={item.source} role={role} />
    <button onClick={() => setItem(undefined)}>Đóng thông báo</button></aside> : null;
}
