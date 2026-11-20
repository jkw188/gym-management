// Kiểm thử frontend (Vitest) – US-42-TC11: nhiều request cùng gặp 401 dùng chung một lần refresh,
// lý do SESSION_EXPIRED vẫn được giữ dù request nào khởi động refresh (bổ sung sau review bước 4).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, SESSION_EXPIRED } from '../../api/client';
import type { AuthResponse, AuthUser } from '../auth/auth.types';

const URL_API = 'http://localhost:3000/api';
const user: AuthUser = { id: 'a'.repeat(24), fullName: 'Member A', phone: '+84901234567', roleCode: 'MEMBER' };
const authResponse: AuthResponse = { accessToken: 'access-2', tokenType: 'Bearer', expiresIn: 900, user };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const unauthorized = () => json({ error: { code: 'UNAUTHORIZED', message: 'Cần xác thực' } }, 401);

// Server giả: /auth/refresh chỉ trả lời khi test gọi release(), để hai lời gọi kịp chồng lên nhau.
function slowRefresh(reply: () => Response) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher = vi.fn<typeof fetch>(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/auth/refresh')) { await gate; return reply(); }
    if (path.endsWith('/auth/me')) return json(user);
    return json({}, 404);
  });
  const refreshCalls = () => fetcher.mock.calls.filter(([input]) => String(input).endsWith('/auth/refresh')).length;
  return { fetcher, release, refreshCalls };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('US-42-TC11: refresh dùng chung giữ lý do phiên hết hạn', () => {
  it('US-42-TC11: refresh do restore() khởi động (không lý do), request sau gặp 401 có lý do → trang đăng nhập nhận SESSION_EXPIRED, chỉ 1 lần refresh', async () => {
    const server = slowRefresh(unauthorized);
    const client = new ApiClient(URL_API, server.fetcher);
    const first = client.restore();
    const second = client.refreshSession(SESSION_EXPIRED).catch(error => error);
    server.release();
    await first; await second;
    expect(server.refreshCalls()).toBe(1);
    expect(client.getSnapshot()).toMatchObject({ status: 'anonymous', user: null, loginReason: SESSION_EXPIRED });
  });

  it('US-42-TC11: request có lý do khởi động trước, lời gọi sau không lý do → vẫn giữ SESSION_EXPIRED', async () => {
    const server = slowRefresh(unauthorized);
    const client = new ApiClient(URL_API, server.fetcher);
    const first = client.refreshSession(SESSION_EXPIRED).catch(error => error);
    const second = client.refreshSession().catch(error => error);
    server.release();
    await first; await second;
    expect(server.refreshCalls()).toBe(1);
    expect(client.getSnapshot()).toMatchObject({ status: 'anonymous', loginReason: SESSION_EXPIRED });
  });

  it('US-42-TC11: mở app (restore) bị 401 mà không có request nào kèm lý do → không báo phiên hết hạn', async () => {
    const server = slowRefresh(unauthorized);
    const client = new ApiClient(URL_API, server.fetcher);
    const first = client.restore();
    server.release();
    await first;
    expect(client.getSnapshot().status).toBe('anonymous');
    expect(client.getSnapshot().loginReason).toBeUndefined();
  });

  it('US-42-TC11: lý do của lần refresh trước không dính sang lần refresh sau', async () => {
    let status = 401;
    const fetcher = vi.fn<typeof fetch>(async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/auth/refresh')) return status === 401 ? unauthorized() : json(authResponse);
      if (path.endsWith('/auth/me')) return json(user);
      return json({}, 404);
    });
    const client = new ApiClient(URL_API, fetcher);
    await client.refreshSession(SESSION_EXPIRED).catch(() => undefined);
    expect(client.getSnapshot().loginReason).toBe(SESSION_EXPIRED);
    await client.refreshSession().catch(() => undefined);
    expect(client.getSnapshot()).toMatchObject({ status: 'anonymous' });
    expect(client.getSnapshot().loginReason).toBeUndefined();
    status = 200;
    await expect(client.refreshSession()).resolves.toEqual(user);
  });
});
