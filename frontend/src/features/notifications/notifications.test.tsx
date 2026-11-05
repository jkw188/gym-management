// Tầng kiểm thử frontend (Vitest, jsdom): EN-03 bước 3, phần frontend tối thiểu (EN-03-F07).
// Kiểm tra socket chỉ mở sau login bằng token trong bộ nhớ, sync từ cursor cuối, gộp theo id, tách theo account (TC06, TC07, TC14, TC15).
// Hợp đồng test đặt ra cho Builder (EN-03 bước 3):
//   ApiClient.getAccessToken(): string | null  trả access token đang giữ trong bộ nhớ (null khi chưa đăng nhập).
//   NotificationFeed (src/features/notifications/notification-feed.ts):
//     new NotificationFeed(client: ApiClient); start(); stop(); getItems(): NotificationItem[]; subscribe(listener): () => void
//     Theo dõi trạng thái đăng nhập của client: đăng nhập thì io('<gốc backend>/notifications', { auth: { accessToken } ... })
//     (auth có thể là object hoặc hàm callback); mỗi lần 'connect' gọi GET /api/notifications/sync từ cursor cuối;
//     'notification.created' thì gộp theo id và emit 'notification.ack' { notificationId }.
//     Logout/đổi account: disconnect socket, xóa items và cursor của account cũ.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api/client';
import type { AuthResponse, AuthUser } from '../auth/auth.types';
import { NotificationFeed } from './notification-feed';

// ---------- Socket giả thay cho socket.io-client ----------
type Handler = (...args: unknown[]) => void;
const fake = vi.hoisted(() => {
  class FakeSocket {
    connected = false;
    private handlers = new Map<string, Handler[]>();
    emit = vi.fn();
    disconnect = vi.fn(() => { this.connected = false; return this; });
    close = vi.fn(() => { this.connected = false; return this; });
    connect = vi.fn(() => this);
    io = { on: vi.fn(), off: vi.fn() };
    on(event: string, handler: Handler) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]); return this; }
    once(event: string, handler: Handler) { return this.on(event, handler); }
    off(event?: string) { if (event) this.handlers.delete(event); else this.handlers.clear(); return this; }
    removeAllListeners() { this.handlers.clear(); return this; }
    // Test gọi để giả lập server gửi sự kiện.
    fire(event: string, ...args: unknown[]) {
      if (event === 'connect') this.connected = true;
      if (event === 'disconnect') this.connected = false;
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }
  const sockets: FakeSocket[] = [];
  const io = vi.fn((..._args: unknown[]) => { const socket = new FakeSocket(); sockets.push(socket); return socket; });
  return { sockets, io };
});
vi.mock('socket.io-client', () => ({ io: fake.io, default: fake.io }));

const url = 'http://localhost:3000/api';
const userA: AuthUser = { id: 'a'.repeat(24), fullName: 'Hội viên A', phone: '+84901234567', roleCode: 'MEMBER' };
const userB: AuthUser = { id: 'b'.repeat(24), fullName: 'Hội viên B', phone: '+84907654321', roleCode: 'MEMBER' };
const authA: AuthResponse = { accessToken: 'access-A', tokenType: 'Bearer', expiresIn: 900, user: userA };
const authB: AuthResponse = { accessToken: 'access-B', tokenType: 'Bearer', expiresIn: 900, user: userB };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noContent = () => new Response(null, { status: 204 });

function item(id: string, sequence: string) {
  return { id, eventKey: `SERVICE_SALE_SETTLED:${id}`, title: `Thông báo ${id}`, body: 'Gói Gym 1 tháng', sequence, createdAt: '2026-11-05T03:00:00.000Z' };
}
const created = (id: string) => {
  const { sequence: _sequence, ...payload } = item(id, '0');
  return payload;
};

// Đọc accessToken trong options của io(): auth có thể là object hoặc hàm callback.
function tokenOf(options: unknown): string | undefined {
  const auth = (options as { auth?: unknown }).auth;
  if (typeof auth === 'function') {
    let value: unknown;
    auth((data: unknown) => { value = data; });
    return (value as { accessToken?: string } | undefined)?.accessToken;
  }
  return (auth as { accessToken?: string } | undefined)?.accessToken;
}

const syncCalls = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) =>
  fetcher.mock.calls.map(([input, init]) => ({ url: String(input), init })).filter(call => call.url.includes('/notifications/sync'));

describe('EN-03 bước 3: frontend NotificationFeed', () => {
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  let client: ApiClient;
  let feed: NotificationFeed;

  beforeEach(() => {
    fake.sockets.length = 0;
    fake.io.mockClear();
    fetcher = vi.fn<typeof fetch>();
    client = new ApiClient(url, fetcher, null);
    feed = new NotificationFeed(client);
  });

  afterEach(() => {
    feed.stop();
    vi.restoreAllMocks();
  });

  async function loginAs(auth: AuthResponse) {
    fetcher.mockResolvedValueOnce(json(auth));
    await client.login(auth.user.phone, 'password');
  }

  it('EN-03-TC14: chưa đăng nhập thì không mở socket; đăng nhập xong mới mở socket tới /notifications', async () => {
    feed.start();
    expect(fake.io).not.toHaveBeenCalled();

    await loginAs(authA);

    await vi.waitFor(() => expect(fake.io).toHaveBeenCalledTimes(1));
    expect(String(fake.io.mock.calls[0][0])).toBe('http://localhost:3000/notifications');
  });

  it('EN-03-TC14: token gửi trong auth của handshake, không nằm trên URL hay localStorage/sessionStorage', async () => {
    feed.start();
    await loginAs(authA);
    await vi.waitFor(() => expect(fake.io).toHaveBeenCalledTimes(1));

    const [socketUrl, options] = fake.io.mock.calls[0];
    expect(tokenOf(options)).toBe('access-A');
    expect(String(socketUrl)).not.toContain('access-A');
    expect(JSON.stringify((options as { query?: unknown }).query ?? {})).not.toContain('access-A');
    expect(JSON.stringify({ ...localStorage })).not.toContain('access-A');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('access-A');
  });

  it('EN-03-TC07: khi socket kết nối thì gọi REST sync bằng Bearer token và hiện các thông báo đã lỡ', async () => {
    feed.start();
    await loginAs(authA);
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(1));
    fetcher.mockResolvedValueOnce(json({ items: [item('n1', '1'), item('n2', '2')], nextCursor: 'cursor-2', hasMore: false }));

    fake.sockets[0].fire('connect');

    await vi.waitFor(() => expect(feed.getItems().map(entry => entry.id)).toEqual(['n1', 'n2']));
    const [call] = syncCalls(fetcher);
    expect(call.url.startsWith(`${url}/notifications/sync`)).toBe(true);
    expect(new URL(call.url).searchParams.get('cursor')).toBeNull();
    expect(new Headers(call.init?.headers).get('Authorization')).toBe('Bearer access-A');
  });

  it('EN-03-TC07: reconnect thì sync tiếp từ cursor cuối, không tải lại từ đầu', async () => {
    feed.start();
    await loginAs(authA);
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(1));
    fetcher.mockResolvedValueOnce(json({ items: [item('n1', '1')], nextCursor: 'cursor-1', hasMore: false }));
    fake.sockets[0].fire('connect');
    await vi.waitFor(() => expect(feed.getItems()).toHaveLength(1));

    fetcher.mockResolvedValueOnce(json({ items: [item('n2', '2')], nextCursor: 'cursor-2', hasMore: false }));
    fake.sockets[0].fire('disconnect', 'transport close');
    fake.sockets[0].fire('connect');

    await vi.waitFor(() => expect(feed.getItems().map(entry => entry.id)).toEqual(['n1', 'n2']));
    const calls = syncCalls(fetcher);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1].url).searchParams.get('cursor')).toBe('cursor-1');
  });

  it('EN-03-TC06: nhận notification.created trùng id (server emit lại) thì chỉ giữ một thông báo', async () => {
    feed.start();
    await loginAs(authA);
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(1));
    fetcher.mockResolvedValueOnce(json({ items: [], nextCursor: null, hasMore: false }));
    fake.sockets[0].fire('connect');
    await vi.waitFor(() => expect(syncCalls(fetcher)).toHaveLength(1));

    fake.sockets[0].fire('notification.created', created('n9'));
    fake.sockets[0].fire('notification.created', created('n9'));

    await vi.waitFor(() => expect(feed.getItems().map(entry => entry.id)).toEqual(['n9']));
  });

  it('EN-03-TC06: thông báo đã nhận qua socket rồi lại có trong REST sync thì không nhân đôi', async () => {
    feed.start();
    await loginAs(authA);
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(1));
    fake.sockets[0].fire('notification.created', created('n5'));
    fetcher.mockResolvedValueOnce(json({ items: [item('n5', '5'), item('n6', '6')], nextCursor: 'cursor-6', hasMore: false }));

    fake.sockets[0].fire('connect');

    await vi.waitFor(() => expect(syncCalls(fetcher)).toHaveLength(1));
    await vi.waitFor(() => expect(feed.getItems().map(entry => entry.id).sort()).toEqual(['n5', 'n6']));
  });

  it('EN-03-TC13: nhận notification.created thì gửi notification.ack đúng {notificationId}', async () => {
    feed.start();
    await loginAs(authA);
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(1));

    fake.sockets[0].fire('notification.created', created('n7'));

    // Tham số thứ ba (callback ack của Socket.IO) có hay không đều được; chỉ kiểm tên sự kiện và dữ liệu.
    await vi.waitFor(() => {
      const ackCall = fake.sockets[0].emit.mock.calls.find(([event]) => event === 'notification.ack');
      expect(ackCall?.[1]).toEqual({ notificationId: 'n7' });
    });
  });

  it('EN-03-TC15: không tự đánh dấu đã đọc: chỉ gọi sync và chỉ emit ack, không gọi API/sự kiện read nào', async () => {
    feed.start();
    await loginAs(authA);
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(1));
    fetcher.mockResolvedValueOnce(json({ items: [item('n1', '1')], nextCursor: 'cursor-1', hasMore: false }));
    fake.sockets[0].fire('connect');
    fake.sockets[0].fire('notification.created', created('n2'));
    await vi.waitFor(() => expect(feed.getItems()).toHaveLength(2));

    // Bỏ lệnh gọi đầu tiên (đăng nhập); mọi lệnh sau đó chỉ là GET /notifications/sync.
    const callsAfterLogin = fetcher.mock.calls.slice(1);
    expect(callsAfterLogin.every(([input]) => String(input).includes('/notifications/sync'))).toBe(true);
    expect(callsAfterLogin.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    const events = fake.sockets[0].emit.mock.calls.map(([event]) => event);
    expect(events.every(event => event === 'notification.ack')).toBe(true);
  });

  it('EN-03-TC14: logout thì ngắt socket và xóa danh sách thông báo của account cũ', async () => {
    feed.start();
    await loginAs(authA);
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(1));
    fetcher.mockResolvedValueOnce(json({ items: [item('n1', '1')], nextCursor: 'cursor-A', hasMore: false }));
    fake.sockets[0].fire('connect');
    await vi.waitFor(() => expect(feed.getItems()).toHaveLength(1));

    fetcher.mockResolvedValueOnce(noContent());
    await client.logout();

    await vi.waitFor(() => expect(fake.sockets[0].disconnect.mock.calls.length + fake.sockets[0].close.mock.calls.length).toBeGreaterThan(0));
    expect(feed.getItems()).toEqual([]);
  });

  it('EN-03-TC14: đổi sang account khác thì mở socket mới bằng token mới, sync lại từ đầu (không dùng cursor/cache của account cũ)', async () => {
    feed.start();
    await loginAs(authA);
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(1));
    fetcher.mockResolvedValueOnce(json({ items: [item('a1', '1')], nextCursor: 'cursor-A', hasMore: false }));
    fake.sockets[0].fire('connect');
    await vi.waitFor(() => expect(feed.getItems()).toHaveLength(1));
    fetcher.mockResolvedValueOnce(noContent());
    await client.logout();

    await loginAs(authB);
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(2));
    expect(tokenOf(fake.io.mock.calls[1][1])).toBe('access-B');
    fetcher.mockResolvedValueOnce(json({ items: [item('b1', '7')], nextCursor: 'cursor-B', hasMore: false }));
    fake.sockets[1].fire('connect');

    await vi.waitFor(() => expect(feed.getItems().map(entry => entry.id)).toEqual(['b1']));
    const calls = syncCalls(fetcher);
    expect(new URL(calls[calls.length - 1].url).searchParams.get('cursor')).toBeNull();
    expect(new Headers(calls[calls.length - 1].init?.headers).get('Authorization')).toBe('Bearer access-B');
  });

  it('EN-03-TC14: sync lặp lại cùng dữ liệu sau reconnect thì không nhân đôi nội dung', async () => {
    feed.start();
    await loginAs(authA);
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(1));
    fetcher.mockResolvedValueOnce(json({ items: [item('n1', '1'), item('n2', '2')], nextCursor: 'cursor-2', hasMore: false }));
    fake.sockets[0].fire('connect');
    await vi.waitFor(() => expect(feed.getItems()).toHaveLength(2));

    fetcher.mockResolvedValueOnce(json({ items: [item('n2', '2')], nextCursor: 'cursor-2', hasMore: false }));
    fake.sockets[0].fire('connect');

    await vi.waitFor(() => expect(syncCalls(fetcher)).toHaveLength(2));
    expect(feed.getItems().map(entry => entry.id)).toEqual(['n1', 'n2']);
  });

  // ---------- Bổ sung sau review bước 3: kết nối lại sau khi bị từ chối và cursor không còn hợp lệ ----------
  // EN-03-F06: "JWT hết hạn ... client làm refresh HTTP US-02 rồi reconnect bằng access mới".
  // EN-03-F07: "reconnect có backoff". EN-03-TC07: "Không mất notification; REST sync khôi phục được".
  // Hợp đồng: kết nối lại bằng socket.connect() trên socket cũ HOẶC gọi io() mới đều được; token lấy theo auth mới nhất.
  describe('kết nối lại và khôi phục sync', () => {
    const authA2: AuthResponse = { ...authA, accessToken: 'access-A2' };
    const syncError = () => json({ error: { code: 'VALIDATION_ERROR', message: 'Cursor không hợp lệ' }, requestId: 'req-1' }, 400);
    const unavailable = () => json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Cơ sở dữ liệu chưa sẵn sàng' }, requestId: 'req-2' }, 503);
    const unauthorized = () => json({ error: { code: 'UNAUTHORIZED', message: 'Cần đăng nhập lại' }, requestId: 'req-3' }, 401);

    // Trả response theo đường dẫn; refreshResponses lần lượt dùng cho mỗi lần POST /auth/refresh.
    function routeFetch(options: { refreshResponses?: Array<() => Response>; sync?: (cursor: string | null) => Response }) {
      const refreshResponses = [...(options.refreshResponses ?? [])];
      fetcher.mockImplementation(async input => {
        const target = new URL(String(input));
        if (target.pathname.endsWith('/auth/refresh')) return (refreshResponses.shift() ?? (() => json(authA2)))();
        if (target.pathname.endsWith('/auth/me')) return json(userA);
        if (target.pathname.endsWith('/notifications/sync')) {
          return (options.sync ?? (() => json({ items: [], nextCursor: null, hasMore: false })))(target.searchParams.get('cursor'));
        }
        throw new Error(`Unexpected request ${target.pathname}`);
      });
    }

    const refreshCalls = () => fetcher.mock.calls.filter(([input]) => String(input).includes('/auth/refresh')).length;
    // Số lần thử kết nối lại sau socket đầu tiên: connect() trên các socket + số lần io() mới.
    const reconnectAttempts = () => fake.sockets.reduce((total, socket) => total + socket.connect.mock.calls.length, 0) + fake.io.mock.calls.length - 1;
    // Token sẽ dùng ở lần kết nối tới: socket.auth (nếu code gán lại) hoặc auth trong options của io() mới nhất.
    function nextHandshakeToken(): string | undefined {
      const socket = fake.sockets[fake.sockets.length - 1] as unknown as { auth?: unknown };
      if (socket.auth !== undefined) return tokenOf({ auth: socket.auth });
      return tokenOf(fake.io.mock.calls[fake.io.mock.calls.length - 1][1]);
    }

    async function connectedAsA() {
      feed.start();
      await loginAs(authA);
      await vi.waitFor(() => expect(fake.sockets).toHaveLength(1));
    }

    afterEach(() => { vi.useRealTimers(); });

    it('EN-03-TC14: handshake kết nối lại bị từ chối (connect_error vì access hết hạn) thì refresh HTTP rồi kết nối lại bằng access mới', async () => {
      await connectedAsA();
      routeFetch({});
      vi.useFakeTimers();

      fake.sockets[0].fire('connect_error', new Error('UNAUTHORIZED'));
      await vi.advanceTimersByTimeAsync(60000);

      expect(refreshCalls()).toBeGreaterThanOrEqual(1);
      expect(reconnectAttempts()).toBeGreaterThanOrEqual(1);
      expect(nextHandshakeToken()).toBe('access-A2');
    });

    it('EN-03-TC14: server ngắt socket và refresh lỗi 503 thì thử lại có backoff (không dồn dập), refresh được thì kết nối lại', async () => {
      await connectedAsA();
      routeFetch({ refreshResponses: [unavailable, unavailable] });
      vi.useFakeTimers();

      fake.sockets[0].fire('disconnect', 'io server disconnect');
      await vi.advanceTimersByTimeAsync(500);
      // Backoff: trong nửa giây đầu chỉ được thử refresh tối đa một lần.
      expect(refreshCalls()).toBeLessThanOrEqual(1);

      await vi.advanceTimersByTimeAsync(120000);
      expect(refreshCalls()).toBeGreaterThanOrEqual(3);
      expect(reconnectAttempts()).toBeGreaterThanOrEqual(1);
      expect(nextHandshakeToken()).toBe('access-A2');
    });

    it('EN-03-TC14: connect_error mà refresh trả 401 (phiên đã bị thu hồi) thì dừng hẳn: không kết nối lại, xóa danh sách', async () => {
      await connectedAsA();
      routeFetch({ refreshResponses: [unauthorized, unauthorized, unauthorized, unauthorized, unauthorized] });
      vi.useFakeTimers();

      fake.sockets[0].fire('connect_error', new Error('UNAUTHORIZED'));
      await vi.advanceTimersByTimeAsync(120000);

      expect(client.getSnapshot().status).toBe('anonymous');
      expect(reconnectAttempts()).toBe(0);
      expect(refreshCalls()).toBe(1);
      expect(feed.getItems()).toEqual([]);
    });

    it('EN-03-TC07: cursor cũ bị server từ chối (400) thì vẫn khôi phục được: sync lại từ đầu, không nhân đôi', async () => {
      await connectedAsA();
      let cursorAccepted = true;
      routeFetch({
        sync: cursor => {
          if (cursor === null) return json({ items: [item('n1', '1'), item('n2', '2')], nextCursor: 'cursor-new-2', hasMore: false });
          if (cursor === 'cursor-1' && cursorAccepted) return json({ items: [], nextCursor: 'cursor-1', hasMore: false });
          return syncError();
        },
      });
      // Lần đầu chỉ có n1 (sync từ đầu trả n1 với cursor-1).
      fetcher.mockResolvedValueOnce(json({ items: [item('n1', '1')], nextCursor: 'cursor-1', hasMore: false }));
      fake.sockets[0].fire('connect');
      await vi.waitFor(() => expect(feed.getItems()).toHaveLength(1));

      // Khóa ký cursor đổi (ví dụ đổi secret): cursor-1 không còn hợp lệ. Kết nối lại hai lần cho chắc.
      cursorAccepted = false;
      fake.sockets[0].fire('disconnect', 'transport close');
      fake.sockets[0].fire('connect');
      await vi.waitFor(() => expect(syncCalls(fetcher).length).toBeGreaterThanOrEqual(2));
      fake.sockets[0].fire('disconnect', 'transport close');
      fake.sockets[0].fire('connect');

      await vi.waitFor(() => expect(feed.getItems().map(entry => entry.id).sort()).toEqual(['n1', 'n2']));
      const calls = syncCalls(fetcher);
      expect(calls.slice(1).some(call => new URL(call.url).searchParams.get('cursor') === null)).toBe(true);
    });
  });
});
