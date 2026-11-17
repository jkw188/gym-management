import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { notificationFeed } from './notification-feed';
import type { NotificationItem } from './notifications.types';

// US-48: các vai trò ngoài Member dùng toast và sync/ack, không truy cập inbox Member.
export function NotificationToast() {
  const { user } = useAuth();
  return user && user.roleCode !== 'MEMBER' ? <AccountToast key={user.id} /> : null;
}
function AccountToast() {
  const [item, setItem] = useState<NotificationItem>();
  useEffect(() => {
    const seen = new Set(notificationFeed.getItems().map(row => row.id));
    return notificationFeed.subscribe(() => {
      const incoming = notificationFeed.getItems().filter(row => !seen.has(row.id));
      for (const row of incoming) seen.add(row.id);
      if (incoming.length) setItem(incoming[incoming.length - 1]);
    });
  }, []);
  return item ? <aside role="status" className="auth-card"><strong>{item.title}</strong><p>{item.body}</p>
    <button onClick={() => setItem(undefined)}>Đóng thông báo</button></aside> : null;
}
