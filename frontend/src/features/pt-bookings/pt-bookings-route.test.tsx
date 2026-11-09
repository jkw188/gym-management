// Tầng kiểm thử frontend (Vitest, jsdom): US-27 bước 3 – route /member/pt-bookings trong App thật và link từ trang Member.
// Hợp đồng: App.tsx khai báo /member/pt-bookings trong ProtectedRoute role MEMBER; trang có tiêu đề "Lịch PT của tôi";
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
