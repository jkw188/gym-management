// Tầng kiểm thử frontend (Vitest, jsdom): US-20 bước 3 – route /member/memberships/:id/upgrade trong App thật và link "Nâng cấp".
// Hợp đồng: App.tsx khai báo route trong ProtectedRoute role MEMBER; trang có tiêu đề "Nâng cấp gói".
// Trên /member/memberships, thẻ gói đang hiệu lực (timeState CURRENT, storedStatus ACTIVE) có link "Nâng cấp" tới trang này;
// gói hết hạn/chờ hiệu lực không có link. Danh sách gói đích thật sự vẫn do backend quyết định (upgrade-options).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../api/client';
import App from '../../App';
import type { AuthSnapshot, AuthUser, RoleCode } from '../auth/auth.types';

// Không mở socket thật (chuông thông báo của Member dùng socket).
vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })), default: vi.fn() }));

const asOf = '2026-11-16T03:00:00.000Z';
const currentId = '6'.repeat(24);
const expiredId = '1'.repeat(24);
const userOf = (roleCode: RoleCode): AuthUser => ({ id: 'c'.repeat(24), fullName: `Người dùng ${roleCode}`, phone: '+84901234567', roleCode });
const membership = (id: string, planName: string, extra: Record<string, unknown> = {}) => ({
  id, planName, serviceSaleId: '5'.repeat(24), transactionId: '9'.repeat(24), operation: 'REGISTER', storedStatus: 'ACTIVE',
  timeState: 'CURRENT', kind: 'GYM', benefits: 'Tập Gym', startDate: '2026-11-01', endDate: '2026-11-30', sessionsQuota: 0,
  sessionsUsed: 0, sessionsReserved: 0, sessionsAvailable: 0, renewal: null, ...extra,
});
let requestSpy: ReturnType<typeof vi.fn>;

function signIn(snapshot: AuthSnapshot) {
  vi.spyOn(apiClient, 'getSnapshot').mockReturnValue(snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
}

beforeEach(() => {
  requestSpy = vi.fn(async (path: string) => {
    if (path.includes('/upgrade-options')) return { items: [], sourceVersion: 0, asOf };
    if (path.startsWith('/me/memberships')) {
      const items = [membership(currentId, 'Gym 30 ngày'),
        membership(expiredId, 'Gym tháng trước', { timeState: 'EXPIRED', startDate: '2026-10-01', endDate: '2026-10-31' })];
      return { memberLinked: true, items, page: 1, limit: 20, total: items.length, totalPages: 1, asOf };
    }
    if (path.startsWith('/me/notifications/unread-count')) return { unreadCount: 0, asOf };
    return { memberLinked: true, items: [], page: 1, limit: 20, total: 0, totalPages: 0, unreadCount: 0, asOf };
  });
  vi.spyOn(apiClient, 'request').mockImplementation(requestSpy as never);
  vi.spyOn(apiClient, 'requestOnce').mockImplementation(requestSpy as never);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

const upgradeCalls = () => requestSpy.mock.calls.map(call => String(call[0])).filter(path => path.includes('upgrade'));

describe('US-20 bước 3: route /member/memberships/:id/upgrade', () => {
  it('US-20-TC01: MEMBER mở thẳng /member/memberships/:id/upgrade → thấy trang "Nâng cấp gói", gọi options của đúng id', async () => {
    window.history.pushState({}, '', `/member/memberships/${currentId}/upgrade`);
    signIn({ status: 'authenticated', user: userOf('MEMBER') });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Nâng cấp gói' })).toBeDefined();
    await waitFor(() => expect(upgradeCalls()).toContain(`/me/memberships/${currentId}/upgrade-options`));
  });

  it.each(['TRAINER', 'STAFF', 'ADMIN'] as const)('US-20-TC02: %s gõ thẳng đường dẫn nâng cấp → không mở trang, không gọi API nâng cấp', async role => {
    window.history.pushState({}, '', `/member/memberships/${currentId}/upgrade`);
    signIn({ status: 'authenticated', user: userOf(role) });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Không có quyền truy cập' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Nâng cấp gói' })).toBeNull();
    expect(upgradeCalls()).toEqual([]);
  });

  it('US-20-TC01: trên "Gói tập của tôi", chỉ gói đang hiệu lực có link "Nâng cấp"; bấm thì mở trang nâng cấp', async () => {
    window.history.pushState({}, '', '/member/memberships');
    signIn({ status: 'authenticated', user: userOf('MEMBER') });
    render(<App />);
    const current = await screen.findByRole('article', { name: 'Gym 30 ngày' });
    const expired = screen.getByRole('article', { name: 'Gym tháng trước' });
    expect(within(expired).queryByRole('link', { name: 'Nâng cấp' })).toBeNull();
    const link = within(current).getByRole('link', { name: 'Nâng cấp' });
    expect(link.getAttribute('href')).toBe(`/member/memberships/${currentId}/upgrade`);

    await userEvent.setup().click(link);
    expect(await screen.findByRole('heading', { name: 'Nâng cấp gói' })).toBeDefined();
  });
});
