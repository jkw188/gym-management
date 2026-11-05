// Tầng giao diện – hook dùng chung (US-47 bước 3): biết account đang đăng nhập và các tín hiệu cần tải lại inbox.
// Socket chỉ là TÍN HIỆU để tải lại từ REST, không phải nguồn dữ liệu và không tự đánh dấu đã đọc (US-47-F02, F04).
import { useEffect, useSyncExternalStore } from 'react';
import { apiClient } from '../../api/client';
import { notificationFeed } from './notification-feed';

// Id account đang đăng nhập (null nếu chưa đăng nhập). Đổi account thì component vẽ lại với id mới (US-47-TC12).
export function useAccountId(): string | null {
  return useSyncExternalStore(
    listener => apiClient.subscribe(listener),
    () => {
      const snapshot = apiClient.getSnapshot();
      return snapshot.status === 'authenticated' && snapshot.user ? snapshot.user.id : null;
    },
  );
}

// Gọi reload khi socket báo có thay đổi (US-47-TC09) hoặc người dùng quay lại tab (US-47-TC12).
export function useReloadSignals(reload: () => void): void {
  useEffect(() => {
    const unsubscribe = notificationFeed.subscribe(reload);
    window.addEventListener('focus', reload);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', reload);
    };
  }, [reload]);
}
