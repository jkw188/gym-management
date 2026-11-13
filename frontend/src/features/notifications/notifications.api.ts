// Tầng giao diện – gọi API (EN-03 bước 3): GET /api/notifications/sync qua ApiClient (tự gắn Bearer token).
import type { ApiClient } from '../../api/client';
import type { SyncResponse } from './notifications.types';

// EN-03-TC07: lấy các thông báo sau cursor cuối; không có cursor thì lấy từ đầu.
export function fetchSync(client: ApiClient, cursor: string | null): Promise<SyncResponse> {
  const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  return client.request<SyncResponse>(`/notifications/sync${query}`);
}
