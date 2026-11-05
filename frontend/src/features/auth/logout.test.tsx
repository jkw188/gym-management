import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiClient, apiClient } from '../../api/client';
import { AuthProvider } from './AuthProvider';
import { ProtectedRoute, RoleShell } from './AuthRoutes';
import type { AuthResponse, AuthSnapshot, AuthUser } from './auth.types';

const user: AuthUser = { id: 'a'.repeat(24), fullName: 'Test User', phone: '+84901234567', roleCode: 'MEMBER' };
const authResponse: AuthResponse = { accessToken: 'access-1', tokenType: 'Bearer', expiresIn: 900, user };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noContent = () => new Response(null, { status: 204 });
const url = 'http://localhost:3000/api';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function fakeChannel() {
  const listeners: ((event: MessageEvent) => void)[] = [];
  return {
    postMessage: vi.fn(),
    addEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => { listeners.push(listener); }),
    receive: (data: unknown) => listeners.forEach(listener => listener({ data } as MessageEvent)),
  };
}

async function loggedIn(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, channel = fakeChannel()) {
  fetcher.mockResolvedValueOnce(json(authResponse));
  const client = new ApiClient(url, fetcher, channel);
  await client.login(user.phone, 'password');
  return client;
}

describe('US-03 frontend logout', () => {
  it('TC01: sends Bearer + cookie, becomes Guest after 204 and notifies other tabs without token', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const channel = fakeChannel();
    const client = await loggedIn(fetcher, channel);
    fetcher.mockResolvedValueOnce(noContent());
    await expect(client.logout()).resolves.toBe('revoked');
    const [path, init] = fetcher.mock.calls[1];
    expect(path).toBe(`${url}/auth/logout`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: '{}',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-1' } });
    expect(client.getSnapshot()).toEqual({ status: 'anonymous', user: null });
    expect(channel.postMessage).toHaveBeenCalledWith('logout');
  });

  it('TC11: network error keeps the token for retry and shows an unconfirmed message', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = await loggedIn(fetcher);
    fetcher.mockRejectedValueOnce(new TypeError('offline'));
    await expect(client.logout()).rejects.toThrow();
    expect(client.getSnapshot()).toMatchObject({ status: 'loggingOut', user: null, error: 'Chưa xác nhận đăng xuất, hãy thử lại.' });
    fetcher.mockResolvedValueOnce(noContent());
    await expect(client.logout()).resolves.toBe('revoked');
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).get('Authorization')).toBe('Bearer access-1');
  });

  it('F03: a 401 clears local state but is not reported as a server revocation', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = await loggedIn(fetcher);
    fetcher.mockResolvedValueOnce(json({ error: { message: 'Cần xác thực' } }, 401));
    await expect(client.logout()).resolves.toBe('unverified');
    expect(client.getSnapshot()).toEqual({ status: 'anonymous', user: null });
  });

  it('F05: waits for a running refresh and logs out with the newest Bearer', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = await loggedIn(fetcher);
    let finishRefresh!: () => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = () => resolve(json({ ...authResponse, accessToken: 'access-2' })); }))
      .mockResolvedValueOnce(json(user)).mockResolvedValueOnce(noContent());
    const refresh = client.refreshSession();
    const logout = client.logout();
    expect(client.getSnapshot().status).toBe('loggingOut');
    expect(client.refreshSession()).toBe(refresh);
    finishRefresh();
    await refresh;
    await expect(logout).resolves.toBe('revoked');
    expect(new Headers(fetcher.mock.calls[3][1]?.headers).get('Authorization')).toBe('Bearer access-2');
    expect(client.getSnapshot().status).toBe('anonymous');
  });

  it('TC12: a slow private response finishing after logout is discarded', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = await loggedIn(fetcher);
    let finish!: () => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(json({ secret: true })); }))
      .mockResolvedValueOnce(noContent());
    const slow = client.request('/private');
    await client.logout();
    finish();
    await expect(slow).rejects.toMatchObject({ status: 401 });
    await expect(client.request('/private')).rejects.toThrow();
  });

  it('TC12: another tab receiving the logout event clears its memory', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const channel = fakeChannel();
    const client = await loggedIn(fetcher, channel);
    channel.receive('logout');
    expect(client.getSnapshot()).toEqual({ status: 'anonymous', user: null });
  });
});

describe('US-03 logout UI', () => {
  function mockAuth(snapshot: AuthSnapshot) {
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue(snapshot);
    vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
    vi.spyOn(apiClient, 'restore').mockResolvedValue();
  }
  function renderMember() {
    return render(<MemoryRouter initialEntries={['/member']}><AuthProvider><Routes>
      <Route path="/" element={<p>Trang Guest</p>} />
      <Route element={<ProtectedRoute role="MEMBER" />}><Route path="/member" element={<RoleShell role="MEMBER" />} /></Route>
    </Routes></AuthProvider></MemoryRouter>);
  }

  it('hides private data while logging out and offers retry after an unconfirmed logout', async () => {
    mockAuth({ status: 'loggingOut', user: null, error: 'Chưa xác nhận đăng xuất, hãy thử lại.' });
    const logout = vi.spyOn(apiClient, 'logout').mockResolvedValue('revoked');
    renderMember();
    expect(screen.queryByText('Test User')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Chưa xác nhận đăng xuất, hãy thử lại.');
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Trang Guest')).toBeDefined();
  });
});
