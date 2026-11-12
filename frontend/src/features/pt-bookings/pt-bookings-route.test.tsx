// Tầng kiểm thử frontend (Vitest, jsdom): US-27 bước 3 – route /member/pt-bookings trong App thật và link từ trang Member.
// Hợp đồng: App.tsx khai báo /member/pt-bookings trong ProtectedRoute role MEMBER; trang có tiêu đề "Lịch PT của tôi" (bước 3), role khác bị chặn (bước 4);
// trang chính /member có link "Lịch PT của tôi".
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../api/client';
import App from '../../App';
import type { AuthUser } from '../auth/auth.types';

// Không mở socket thật (chuông thông báo của Member dùng socket).
vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })), default: vi.fn() }));

const member: AuthUser = { id: 'c'.repeat(24), fullName: 'Hội viên C', phone: '+84901234567', roleCode: 'MEMBER' };
const asOf = '2026-11-20T03:05:00.000Z';
let requestSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: member });
  vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
  // Server giả: danh sách rỗng cho mọi GET /me/*.
  requestSpy = vi.fn(async (path: string) => {
    if (path.startsWith('/me/notifications/unread-count')) return { unreadCount: 0, asOf };
    return { memberLinked: true, items: [], page: 1, limit: 20, total: 0, totalPages: 0, unreadCount: 0, asOf };
  });
  vi.spyOn(apiClient, 'request').mockImplementation(requestSpy as never);
  vi.spyOn(apiClient, 'requestOnce').mockImplementation(requestSpy as never);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

describe('US-27 bước 3: route /member/pt-bookings', () => {
  it('US-27-TC12: MEMBER mở /member/pt-bookings → thấy trang "Lịch PT của tôi" và trang tải lịch riêng', async () => {
    window.history.pushState({}, '', '/member/pt-bookings');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Lịch PT của tôi' })).toBeDefined();
    await waitFor(() => expect(requestSpy.mock.calls.some(call => String(call[0]).startsWith('/me/pt-bookings'))).toBe(true));
  });

  it('US-27-TC12: trang chính của MEMBER có link "Lịch PT của tôi" tới /member/pt-bookings', async () => {
    window.history.pushState({}, '', '/member');
    render(<App />);

    const link = await screen.findByRole('link', { name: 'Lịch PT của tôi' });
    expect(link.getAttribute('href')).toBe('/member/pt-bookings');
  });
});

// US-27 bước 4 – truy cập chéo ở giao diện: role khác MEMBER gõ thẳng đường dẫn cũng không mở được trang, không gọi API lịch PT.
describe('US-27 bước 4: route /member/pt-bookings chặn role khác', () => {
  const ptCalls = () => requestSpy.mock.calls.map(call => String(call[0])).filter(path => path.startsWith('/me/pt-'));

  it.each(['TRAINER', 'STAFF', 'ADMIN'] as const)('US-27-TC07: %s gõ thẳng /member/pt-bookings → "Không có quyền truy cập", không gọi API /me/pt-*', async role => {
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: { ...member, roleCode: role } });
    window.history.pushState({}, '', '/member/pt-bookings');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Không có quyền truy cập' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Lịch PT của tôi' })).toBeNull();
    expect(ptCalls()).toEqual([]);
  });

  it('US-27-TC07: chưa đăng nhập gõ thẳng /member/pt-bookings → về /login, không gọi API /me/pt-*', async () => {
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'anonymous', user: null });
    window.history.pushState({}, '', '/member/pt-bookings');
    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(screen.queryByRole('heading', { name: 'Lịch PT của tôi' })).toBeNull();
    expect(ptCalls()).toEqual([]);
  });

  it('US-27-TC07: link "Lịch PT của tôi" không có ở trang chính của PT', async () => {
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: { ...member, roleCode: 'TRAINER' } });
    window.history.pushState({}, '', '/trainer');
    render(<App />);

    await screen.findByRole('link', { name: 'Ca làm việc' });
    expect(screen.queryByRole('link', { name: 'Lịch PT của tôi' })).toBeNull();
  });
});
