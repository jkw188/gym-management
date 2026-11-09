// Tầng kiểm thử frontend (Vitest, jsdom): US-17 bước 4 – route /member/memberships trong App thật.
// "Không chỉ ẩn menu" (US-17-TC04): role khác MEMBER gõ thẳng đường dẫn cũng không mở được trang, không gọi API cá nhân.
// Hợp đồng: App.tsx khai báo /member/memberships trong ProtectedRoute role MEMBER; trang có tiêu đề "Gói tập của tôi".
// Sai role thì ProtectedRoute có sẵn của US-02 hiện "Không có quyền truy cập"; chưa đăng nhập thì về /login.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../api/client';
import App from '../../App';
import type { AuthSnapshot, AuthUser, RoleCode } from '../auth/auth.types';

// Không mở socket thật (chuông thông báo của Member dùng socket).
vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })), default: vi.fn() }));

const userOf = (roleCode: RoleCode): AuthUser => ({ id: 'c'.repeat(24), fullName: `Người dùng ${roleCode}`, phone: '+84901234567', roleCode });
let requestSpy: ReturnType<typeof vi.fn>;

function signIn(snapshot: AuthSnapshot) {
  vi.spyOn(apiClient, 'getSnapshot').mockReturnValue(snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
}

beforeEach(() => {
  // Server giả: danh sách rỗng cho mọi GET /me/*, để trang Member tải được nếu được phép mở.
  requestSpy = vi.fn(async (path: string) => {
    if (path.startsWith('/me/memberships') || path.startsWith('/me/service-sales')) {
      return { memberLinked: true, items: [], page: 1, limit: 20, total: 0, totalPages: 0, asOf: '2026-11-09T03:00:00.000Z' };
    }
    if (path.startsWith('/me/notifications/unread-count')) return { unreadCount: 0, asOf: '2026-11-09T03:00:00.000Z' };
    return { items: [], page: 1, limit: 20, total: 0, totalPages: 0, unreadCount: 0, asOf: '2026-11-09T03:00:00.000Z' };
  });
  vi.spyOn(apiClient, 'request').mockImplementation(requestSpy as never);
  vi.spyOn(apiClient, 'requestOnce').mockImplementation(requestSpy as never);
  window.history.pushState({}, '', '/member/memberships');
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

const membershipCalls = () => requestSpy.mock.calls.map(call => String(call[0]))
  .filter(path => path.startsWith('/me/memberships') || path.startsWith('/me/service-sales'));

describe('US-17 bước 4: route /member/memberships', () => {
  it('US-17-TC04: MEMBER mở /member/memberships → thấy trang "Gói tập của tôi"', async () => {
    signIn({ status: 'authenticated', user: userOf('MEMBER') });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Gói tập của tôi' })).toBeDefined();
    await waitFor(() => expect(membershipCalls().length).toBeGreaterThan(0));
  });

  it.each(['TRAINER', 'STAFF', 'ADMIN'] as const)('US-17-TC04: %s gõ thẳng /member/memberships → không mở trang, không gọi API gói cá nhân', async role => {
    signIn({ status: 'authenticated', user: userOf(role) });
    render(<App />);

    // ProtectedRoute (US-02) chặn tại chỗ bằng thông báo "Không có quyền truy cập", không chuyển trang.
    expect(await screen.findByRole('heading', { name: 'Không có quyền truy cập' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Gói tập của tôi' })).toBeNull();
    expect(membershipCalls()).toEqual([]);
  });

  it('US-17-TC04: chưa đăng nhập gõ thẳng /member/memberships → về đăng nhập, không gọi API gói cá nhân', async () => {
    signIn({ status: 'anonymous', user: null });
    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(screen.queryByRole('heading', { name: 'Gói tập của tôi' })).toBeNull();
    expect(membershipCalls()).toEqual([]);
  });

  it('US-17-TC04: link "Gói tập của tôi" chỉ có ở trang chính của MEMBER, không có ở PT', async () => {
    signIn({ status: 'authenticated', user: userOf('TRAINER') });
    window.history.pushState({}, '', '/trainer');
    render(<App />);
    await screen.findByRole('link', { name: 'Ca làm việc' });
    expect(screen.queryByRole('link', { name: 'Gói tập của tôi' })).toBeNull();
    cleanup();

    signIn({ status: 'authenticated', user: userOf('MEMBER') });
    window.history.pushState({}, '', '/member');
    render(<App />);
    expect(await screen.findByRole('link', { name: 'Gói tập của tôi' })).toBeDefined();
  });
});
