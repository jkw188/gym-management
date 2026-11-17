import { apiClient } from '../../api/client';
import type { RoleCode } from '../auth/auth.types';

export interface BroadcastInput { audience: 'ALL_ACTIVE' | 'ROLES'; roles?: RoleCode[]; title: string; body: string }
export interface BroadcastPreview {
  previewId: string; version: number; expiresAt: string; snapshotAt: string; recipientCount: number;
  audienceSummary: string; title: string; body: string;
}
export interface BroadcastSent { broadcastId: string; notificationId: string; status: 'SENT'; recipientCount: number; dispatchStatus: string }
export interface BroadcastDetail extends BroadcastPreview {
  broadcastId: string; status: 'PREVIEW' | 'SENT'; notificationId?: string; dispatchStatus: string | null;
  counts: { snapshot: number; sent: number; delivered: number; read: number }; createdAt: string; sentAt?: string; asOf: string;
}
export interface BroadcastPage { items: BroadcastDetail[]; page: number; limit: number; total: number; totalPages: number; asOf: string }
export interface PendingBroadcast { id: string; version: number; key: string }
const pendingStorageKey = 'gym-pending-broadcast';
// Chỉ giữ định danh/khóa, không lưu nội dung hay token. Một lệnh chưa rõ kết quả phải được resolve trước lệnh mới.
export const pendingBroadcast = {
  clear() { try { sessionStorage.removeItem(pendingStorageKey); } catch { /* Trình duyệt chặn storage: vẫn giữ khóa trong bộ nhớ màn hình. */ } },
  read(actorId: string): PendingBroadcast | null {
    try {
      const value = JSON.parse(sessionStorage.getItem(pendingStorageKey) ?? 'null') as (PendingBroadcast & { actorId: string }) | null;
      if (!value) return null;
      if (value.actorId !== actorId || !/^[a-f\d]{24}$/i.test(value.id) || !Number.isInteger(value.version) || value.version < 0 ||
        !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value.key)) {
        this.clear(); return null;
      }
      return { id: value.id, version: value.version, key: value.key };
    } catch { this.clear(); return null; }
  },
  save(actorId: string, command: PendingBroadcast) {
    try { sessionStorage.setItem(pendingStorageKey, JSON.stringify({ actorId, ...command })); } catch { /* Giữ khóa trong bộ nhớ nếu storage bị chặn. */ }
  },
};
let previousActor: string | null = null;
apiClient.subscribe(() => {
  const snapshot = apiClient.getSnapshot();
  const actor = snapshot.status === 'authenticated' ? snapshot.user?.id ?? null : null;
  if (previousActor && actor !== previousActor) pendingBroadcast.clear();
  if (actor) pendingBroadcast.read(actor); // Lần restore đầu cũng loại khóa của account khác.
  previousActor = actor;
});
const base = '/admin/notification-broadcasts';
export const broadcastsApi = {
  preview(input: BroadcastInput) { return apiClient.request<BroadcastPreview>(`${base}/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }); },
  send(id: string, version: number, key: string) { return apiClient.request<BroadcastSent>(`${base}/${encodeURIComponent(id)}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ version }),
  }); },
  lookup(key: string) { return apiClient.request<{ responseBody: BroadcastSent }>(`/operations/NOTIFICATION_BROADCAST_SEND/${encodeURIComponent(key)}`); },
  detail(id: string, signal?: AbortSignal) { return apiClient.request<BroadcastDetail>(`${base}/${encodeURIComponent(id)}`, { signal }); },
  list(query: { status: string; fromDate: string; toDate: string; page: number; limit: number }, signal?: AbortSignal) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== '') params.set(key, String(value));
    return apiClient.request<BroadcastPage>(`${base}?${params}`, { signal });
  },
};
