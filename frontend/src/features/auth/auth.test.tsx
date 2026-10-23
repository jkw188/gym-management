import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiClient, ApiError, apiClient } from '../../api/client';
import { AuthProvider } from './AuthProvider';
import { HomeRedirect, ProtectedRoute, RoleShell } from './AuthRoutes';
import { LoginPage } from './LoginPage';
import { resolveReturnTo, rolePaths } from './auth.routes';
import type { AuthResponse, AuthSnapshot, AuthUser, RoleCode } from './auth.types';

const user: AuthUser = { id: 'a'.repeat(24), fullName: 'Test User', phone: '+84901234567', roleCode: 'MEMBER' };
const authenticated: AuthSnapshot = { status: 'authenticated', user };
const authResponse: AuthResponse = { accessToken: 'access-1', tokenType: 'Bearer', expiresIn: 900, user };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const unauthorized = () => json({ error: { message: 'Cần xác thực' } }, 401);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('TC17–18: memory tokens, restore and bounded single-flight retries', () => {
  it('calls browser fetch with the global receiver required by native Web APIs', async () => {
    const fetcher = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(json({ status: 'ok' }));
    });
    const client = new ApiClient('http://localhost:3000/api', fetcher);
    await expect(client.publicGet('/health/live')).resolves.toEqual({ status: 'ok' });
  });

  it('restores with refresh then me; sends cookie requests and keeps tokens out of browser storage', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(authResponse)).mockResolvedValueOnce(json(user));
    const client = new ApiClient('http://localhost:3000/api', fetcher);
    const local = vi.spyOn(Storage.prototype, 'setItem');
    expect(client.getSnapshot().status).toBe('checking');
    await client.restore();
    expect(client.getSnapshot()).toEqual(authenticated);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toMatch(/\/auth\/refresh$/);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({ Authorization: 'Bearer access-1' });
    expect(local).not.toHaveBeenCalled();
  });

  it('coalesces concurrent 401s into one rotation and retries each request only once', async () => {
    let refreshes = 0;
    const businessCalls = new Map<string, number>();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) return json(authResponse);
      if (url.endsWith('/auth/refresh')) { refreshes++; await new Promise(resolve => setTimeout(resolve, 15)); return json({ ...authResponse, accessToken: 'access-2' }); }
      if (url.endsWith('/auth/me')) return json(user);
      const count = (businessCalls.get(url) ?? 0) + 1;
      businessCalls.set(url, count);
      if (count === 1) return unauthorized();
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access-2');
      return json({ ok: true });
    });
    const client = new ApiClient('http://localhost:3000/api', fetcher);
    await client.login(user.phone, 'exact password');
    await expect(Promise.all([client.request('/first'), client.request('/second'), client.request('/third')])).resolves.toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshes).toBe(1);
    expect([...businessCalls.values()]).toEqual([2, 2, 2]);
  });

  it('does not rotate again for a late 401 sent with the previous access token', async () => {
    let lateResponse!: (response: Response) => void;
    const late = new Promise<Response>(resolve => { lateResponse = resolve; });
    let lateCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/login') || url.endsWith('/auth/refresh')) return json(authResponse);
      if (url.endsWith('/auth/me')) return json(user);
      if (url.endsWith('/late') && lateCalls++ === 0) return late;
      if (url.endsWith('/first') && new Headers(init?.headers).get('Authorization') === 'Bearer access-1') return unauthorized();
      return json({ ok: true });
    });
    // Each rotation returns a new token.
    fetcher.mockImplementationOnce(async () => json(authResponse));
    const client = new ApiClient('http://localhost:3000/api', fetcher);
    await client.login(user.phone, 'exact password');
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => String(input).endsWith('/auth/refresh') ? json({ ...authResponse, accessToken: 'access-2' }) : original(input, init));
    const pending = client.request('/late');
    await client.request('/first');
    lateResponse(unauthorized());
    await pending;
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('a failed refresh becomes anonymous without loops; a second 401 also stops after one retry', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => String(input).endsWith('/auth/login') ? json(authResponse) : unauthorized());
    const client = new ApiClient('http://localhost:3000/api', fetcher);
    await client.login(user.phone, 'exact password');
    await expect(client.request('/private')).rejects.toMatchObject({ status: 401 });
    expect(client.getSnapshot().status).toBe('anonymous');
    expect(fetcher).toHaveBeenCalledTimes(3);

    let privateCalls = 0;
    fetcher.mockImplementation(async input => {
      if (String(input).endsWith('/private')) { privateCalls++; return unauthorized(); }
      return json(String(input).endsWith('/auth/me') ? user : authResponse);
    });
    await client.login(user.phone, 'exact password');
    await expect(client.request('/private')).rejects.toMatchObject({ status: 401 });
    expect(privateCalls).toBe(2);
    expect(client.getSnapshot().status).toBe('anonymous');
  });

  it('preserves authenticated role on 403 and network errors, with no refresh', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(authResponse)).mockResolvedValueOnce(json({ error: { message: 'Không có quyền' } }, 403)).mockRejectedValueOnce(new TypeError('offline'));
    const client = new ApiClient('http://localhost:3000/api', fetcher);
    await client.login(user.phone, 'exact password');
    await expect(client.request('/admin')).rejects.toMatchObject({ status: 403 });
    expect(client.getSnapshot()).toEqual(authenticated);
    await expect(client.request('/private')).rejects.toThrow('Không kết nối được máy chủ');
    expect(client.getSnapshot()).toEqual(authenticated);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('restore 401 becomes anonymous; restore network error remains checking with retry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(unauthorized());
    const client = new ApiClient('http://localhost:3000/api', fetcher);
    await client.restore();
    expect(client.getSnapshot()).toEqual({ status: 'anonymous', user: null });
    fetcher.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(json(authResponse)).mockResolvedValueOnce(json(user));
    const retryable = new ApiClient('http://localhost:3000/api', fetcher);
    await retryable.restore();
    expect(retryable.getSnapshot()).toMatchObject({ status: 'checking', user: null, error: expect.any(String) });
    await retryable.restore();
    expect(retryable.getSnapshot()).toEqual(authenticated);
  });
});

function mockAuth(snapshot: AuthSnapshot) {
  vi.spyOn(apiClient, 'getSnapshot').mockReturnValue(snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
}
function routes(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><AuthProvider><Routes>
    <Route path="/" element={<HomeRedirect />} /><Route path="/login" element={<LoginPage />} />
    {(Object.entries(rolePaths) as [RoleCode, string][]).map(([role, route]) => <Route key={role} element={<ProtectedRoute role={role} />}>
      <Route path={route} element={<RoleShell role={role} />} /></Route>)}
  </Routes></AuthProvider></MemoryRouter>);
}

describe('TC02/17–19/22: login and role routes', () => {
  it.each(Object.keys(rolePaths) as RoleCode[])('authenticated %s visiting login reaches only their shell', async role => {
    mockAuth({ status: 'authenticated', user: { ...user, roleCode: role } });
    routes('/login');
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Đăng nhập thành công.');
    expect(screen.queryByRole('heading', { name: 'Đăng nhập' })).toBeNull();
  });

  it('never renders protected content while checking and offers retry on restore errors', async () => {
    mockAuth({ status: 'checking', user: null, error: 'Mất kết nối' });
    routes('/admin');
    expect(screen.queryByText('Đăng nhập thành công.')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Mất kết nối');
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(apiClient.restore).toHaveBeenCalledTimes(2);
  });

  it('anonymous protected access shows login, and wrong roles get an explicit forbidden state', () => {
    mockAuth({ status: 'anonymous', user: null });
    routes('/admin');
    expect(screen.getByRole('heading', { name: 'Đăng nhập' })).toBeDefined();
    cleanup(); vi.restoreAllMocks();
    mockAuth(authenticated); routes('/admin');
    expect(screen.getByRole('heading', { name: 'Không có quyền truy cập' })).toBeDefined();
    expect(screen.queryByText('Đăng nhập thành công.')).toBeNull();
  });

  it('uses labels, local validation, password toggle, pending deduplication, and preserves form on network failure', async () => {
    mockAuth({ status: 'anonymous', user: null });
    let fail!: (error: Error) => void;
    const pending = new Promise<AuthUser>((_resolve, reject) => { fail = reject; });
    const login = vi.spyOn(apiClient, 'login').mockReturnValue(pending);
    routes('/login');
    const browser = userEvent.setup();
    await browser.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(login).not.toHaveBeenCalled();
    const phoneInput = screen.getByLabelText('Số điện thoại') as HTMLInputElement;
    const passwordInput = screen.getByLabelText('Mật khẩu') as HTMLInputElement;
    expect(passwordInput.type).toBe('password');
    await browser.type(phoneInput, '0901234567'); await browser.type(passwordInput, '  exact password  ');
    await browser.click(screen.getByRole('button', { name: 'Hiện mật khẩu' }));
    expect(passwordInput.type).toBe('text');
    await browser.dblClick(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(login).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledWith('0901234567', '  exact password  ');
    expect(screen.getByRole('button', { name: 'Đang đăng nhập…' })).toHaveProperty('disabled', true);
    fail(new ApiError('Không kết nối được máy chủ.'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Không kết nối được máy chủ.'));
    expect(phoneInput.value).toBe('0901234567'); expect(passwordInput.value).toBe('  exact password  ');
    expect(screen.getByRole('button', { name: 'Đăng nhập' })).toHaveProperty('disabled', false);
  });

  it.each(['https://evil.example', '//evil.example', '/admin', '/member/../admin', '/member\\evil', '/%2f%2fevil.example', 'javascript:alert(1)'])('TC19: rejects returnTo %s for Member', target => {
    expect(resolveReturnTo(target, 'MEMBER')).toBe('/member');
  });
  it('permits a matching internal role path and preserves its query/hash', () => {
    expect(resolveReturnTo('/member?tab=profile#top', 'MEMBER')).toBe('/member?tab=profile#top');
  });
});
