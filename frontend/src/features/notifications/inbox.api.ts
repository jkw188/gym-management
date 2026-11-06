// Tầng giao diện – gọi API (US-47 bước 3): inbox thông báo của chính member qua ApiClient (tự gắn Bearer token).
// Chỉ có 3 lệnh đọc (GET) và 1 lệnh ghi là mark-read; không gửi accountId vì server lấy từ phiên đăng nhập.
import { apiClient } from '../../api/client';

export type ReadState = 'ALL' | 'UNREAD' | 'READ';

export interface InboxQuery { readState: ReadState; page: number; limit: number }

export interface InboxItem { id: string; title: string; bodyPreview: string; createdAt: string; readAt?: string; deliveredAt?: string }

export interface InboxPage {
  items: InboxItem[]; page: number; limit: number; total: number; totalPages: number; unreadCount: number; asOf: string;
}

export interface InboxDetail { id: string; title: string; body: string; createdAt: string; readAt?: string; deliveredAt?: string }

export const inboxApi = {
  list(query: InboxQuery) {
    const params = new URLSearchParams({ readState: query.readState, page: String(query.page), limit: String(query.limit) });
    return apiClient.request<InboxPage>(`/me/notifications?${params.toString()}`);
  },
  unreadCount() {
    return apiClient.request<{ unreadCount: number; asOf: string }>('/me/notifications/unread-count');
  },
  detail(id: string) {
    return apiClient.request<InboxDetail>(`/me/notifications/${encodeURIComponent(id)}`);
  },
  // US-47-F03: body luôn là {}; gọi lại nhiều lần server vẫn trả readAt của lần đầu.
  markRead(id: string) {
    return apiClient.request<{ id: string; readAt: string }>(`/me/notifications/${encodeURIComponent(id)}/read`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
  },
};
