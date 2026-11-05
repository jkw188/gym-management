// Tầng giao diện – dữ liệu realtime (EN-03 bước 3, EN-03-F07): mở socket /notifications sau khi đăng nhập,
// đồng bộ REST từ cursor cuối mỗi lần kết nối, gộp thông báo theo id và ack; logout/đổi account thì xóa sạch.
import { io, type Socket } from 'socket.io-client';
import { ApiError, apiClient, type ApiClient } from '../../api/client';
import { fetchSync } from './notifications.api';
import type { NotificationItem } from './notifications.types';

// Backoff khi phải refresh rồi kết nối lại: 1s, 2s, 4s… tối đa 30s (EN-03-F07).
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

export class NotificationFeed {
  private socket: Socket | null = null;
  // Account đang sở hữu socket, items và cursor hiện tại (EN-03-TC14).
  private accountId: string | null = null;
  private items = new Map<string, NotificationItem>();
  private cursor: string | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubscribeAuth: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;

  constructor(private readonly client: ApiClient) {}

  // Theo dõi trạng thái đăng nhập của ApiClient.
  start(): void {
    if (this.unsubscribeAuth) return;
    this.unsubscribeAuth = this.client.subscribe(() => this.onAuthChange());
    this.onAuthChange();
  }

  stop(): void {
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    this.switchAccount(null);
  }

  getItems(): NotificationItem[] {
    return [...this.items.values()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // Chỉ account MEMBER (người nhận thông báo) mới mở socket; đổi account hoặc logout thì đóng socket cũ.
  private onAuthChange(): void {
    const snapshot = this.client.getSnapshot();
    const user = snapshot.status === 'authenticated' ? snapshot.user : null;
    const nextAccountId = user?.roleCode === 'MEMBER' ? user.id : null;
    if (nextAccountId !== this.accountId) this.switchAccount(nextAccountId);
  }

  // EN-03-TC14: ngắt socket, xóa items và cursor của account cũ; không dùng lại cho account khác.
  private switchAccount(accountId: string | null): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAttempt = 0;
    if (this.socket) {
      this.socket.off();
      this.socket.disconnect();
      this.socket = null;
    }
    this.accountId = accountId;
    this.items = new Map();
    this.cursor = null;
    this.publish();
    if (accountId) this.openSocket(accountId);
  }

  private openSocket(accountId: string): void {
    const origin = new URL(this.client.getBaseUrl()).origin;
    const socket = io(`${origin}/notifications`, {
      transports: ['websocket'],
      // EN-03-TC14: token gửi trong auth của handshake, lấy từ bộ nhớ mỗi lần (kết nối lại dùng token mới nhất).
      auth: callback => callback({ accessToken: this.client.getAccessToken() }),
      // Kết nối lại có backoff: chờ từ 1 giây, tăng dần tới tối đa 30 giây.
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
    });
    // EN-03-TC07: mỗi lần kết nối (cả kết nối lại) thì sync từ cursor cuối để lấy thông báo đã lỡ.
    socket.on('connect', () => {
      this.retryAttempt = 0;
      void this.syncMissed(accountId);
    });
    // Handshake bị server từ chối (vd. access token hết hạn sau khi mất mạng): socket.active = false nghĩa là
    // Socket.IO KHÔNG tự thử lại, nên feed tự refresh HTTP rồi kết nối lại (EN-03-F06). Lỗi mạng thì Socket.IO tự thử.
    socket.on('connect_error', () => {
      if (!socket.active) this.scheduleReconnect(socket, accountId);
    });
    socket.on('notification.created', (payload: NotificationItem) => {
      if (this.accountId !== accountId) return;
      this.merge([payload]);
      // EN-03-TC13: báo server đã nhận (delivered_at); KHÔNG đánh dấu đã đọc (EN-03-TC15).
      socket.emit('notification.ack', { notificationId: payload.id });
    });
    // Server chủ động ngắt (phiên hết hạn/bị thu hồi): refresh qua HTTP rồi kết nối lại bằng access token mới (EN-03-F06).
    socket.on('disconnect', (reason: string) => {
      if (reason === 'io server disconnect') void this.reconnectAfterRefresh(socket, accountId);
    });
    this.socket = socket;
  }

  // Socket này còn là socket của account hiện tại không (chưa logout/đổi account).
  private isCurrent(socket: Socket, accountId: string): boolean {
    return this.socket === socket && this.accountId === accountId;
  }

  // Hẹn lần refresh + kết nối lại tiếp theo, chờ lâu dần (backoff); chỉ giữ một lịch hẹn.
  private scheduleReconnect(socket: Socket, accountId: string): void {
    if (this.retryTimer || !this.isCurrent(socket, accountId)) return;
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retryAttempt, RETRY_MAX_MS);
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconnectAfterRefresh(socket, accountId);
    }, delay);
  }

  private async reconnectAfterRefresh(socket: Socket, accountId: string): Promise<void> {
    if (!this.isCurrent(socket, accountId)) return;
    try {
      await this.client.refreshSession();
    } catch {
      // 401: ApiClient đã về anonymous, onAuthChange tự đóng feed. Lỗi khác (503, mạng): còn đăng nhập thì thử lại sau.
      if (this.client.getSnapshot().status === 'authenticated') this.scheduleReconnect(socket, accountId);
      return;
    }
    // Kết nối lại mà vẫn bị từ chối thì connect_error hẹn lần sau với thời gian chờ dài hơn.
    if (this.isCurrent(socket, accountId)) socket.connect();
  }

  private async syncMissed(accountId: string): Promise<void> {
    try {
      let hasMore = true;
      while (hasMore) {
        const page = await fetchSync(this.client, this.cursor);
        // Bỏ kết quả về muộn của account cũ.
        if (this.accountId !== accountId) return;
        this.merge(page.items);
        if (page.nextCursor) this.cursor = page.nextCursor;
        hasMore = page.hasMore && page.items.length > 0;
      }
    } catch (error) {
      // 400: cursor không còn hợp lệ (vd. đổi secret ký cursor) → bỏ cursor, sync lại từ đầu; gộp theo id nên không nhân đôi.
      // Chỉ làm khi đang có cursor nên không lặp vô hạn.
      if (error instanceof ApiError && error.status === 400 && this.cursor !== null && this.accountId === accountId) {
        this.cursor = null;
        await this.syncMissed(accountId);
      }
      // Lỗi khác (mạng): lần kết nối sau sẽ sync lại từ cùng cursor, không mất thông báo.
    }
  }

  // EN-03-TC06, EN-03-TC14: gộp theo id nên emit lại hoặc sync trùng không nhân đôi thông báo.
  private merge(incoming: NotificationItem[]): void {
    for (const item of incoming) this.items.set(item.id, { ...this.items.get(item.id), ...item });
    if (incoming.length > 0) this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}

// Bản dùng chung cho cả ứng dụng; main.tsx gọi start(). US-47 (hộp thư) sẽ đọc thông báo từ đây.
export const notificationFeed = new NotificationFeed(apiClient);
