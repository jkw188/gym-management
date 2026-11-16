// Tầng kiểm thử frontend (Vitest, jsdom): US-18 bước 3 – route /member/service-registrations trong App thật.
// Chỉ MEMBER mở được trang tự đăng ký; role khác gõ thẳng đường dẫn cũng không mở, không gọi API cá nhân (TC02).
// Hợp đồng: App.tsx khai báo /member/service-registrations trong ProtectedRoute role MEMBER; trang có tiêu đề
// "Đăng ký gói tập"; trang chính của MEMBER có link "Đăng ký gói tập". Sai role → "Không có quyền truy cập" (US-02).
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
  // Server giả: danh mục và lịch sử rỗng để trang tải được nếu được phép mở.
  requestSpy = vi.fn(async (path: string) => {
    if (path.startsWith('/catalog/plans')) return { items: [], page: 1, limit: 20, total: 0, totalPages: 0 };
    if (path.startsWith('/me/notifications/unread-count')) return { unreadCount: 0, asOf: '2026-11-01T03:00:00.000Z' };
    return { memberLinked: true, items: [], page: 1, limit: 20, total: 0, totalPages: 0, unreadCount: 0, asOf: '2026-11-01T03:00:00.000Z' };
  });
  vi.spyOn(apiClient, 'request').mockImplementation(requestSpy as never);
  vi.spyOn(apiClient, 'requestOnce').mockImplementation(requestSpy as never);
  vi.spyOn(apiClient, 'publicGet').mockImplementation(requestSpy as never);
  window.history.pushState({}, '', '/member/service-registrations');
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

const personalCalls = () => requestSpy.mock.calls.map(call => String(call[0]))
  .filter(path => path.startsWith('/me/service-registrations') || path.startsWith('/me/service-sales'));

describe('US-18 bước 3: route /member/service-registrations', () => {
  it('US-18-TC02: MEMBER mở /member/service-registrations → thấy trang "Đăng ký gói tập"', async () => {
    signIn({ status: 'authenticated', user: userOf('MEMBER') });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Đăng ký gói tập' })).toBeDefined();
  });

  it.each(['TRAINER', 'STAFF', 'ADMIN'] as const)('US-18-TC02: %s gõ thẳng /member/service-registrations → không mở trang, không gọi API cá nhân', async role => {
    signIn({ status: 'authenticated', user: userOf(role) });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Không có quyền truy cập' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Đăng ký gói tập' })).toBeNull();
    expect(personalCalls()).toEqual([]);
  });

  it('US-18-TC02: chưa đăng nhập → về trang đăng nhập, không gọi API cá nhân', async () => {
    signIn({ status: 'anonymous', user: null });
    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(personalCalls()).toEqual([]);
  });

  it('US-18-TC02: link "Đăng ký gói tập" chỉ có ở trang chính của MEMBER, không có ở PT', async () => {
    signIn({ status: 'authenticated', user: userOf('TRAINER') });
    window.history.pushState({}, '', '/trainer');
    render(<App />);
    await screen.findByRole('link', { name: 'Ca làm việc' });
    expect(screen.queryByRole('link', { name: 'Đăng ký gói tập' })).toBeNull();
    cleanup();

    signIn({ status: 'authenticated', user: userOf('MEMBER') });
    window.history.pushState({}, '', '/member');
    render(<App />);
    expect((await screen.findByRole('link', { name: 'Đăng ký gói tập' })).getAttribute('href')).toBe('/member/service-registrations');
  });
});
