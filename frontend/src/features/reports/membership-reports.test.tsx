import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import App from '../../App';
import type { AuthSnapshot } from '../auth/auth.types';
import { MembershipReportsPage } from './MembershipReportsPage';
import type { MembershipReportDetail, MembershipReportPage } from './membership-reports.api';

vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })) }));
const id = 'a'.repeat(24), at = '2026-11-10T03:30:00.000Z';
const page: MembershipReportPage = { asOfAt: at, observedAt: '2026-11-17T05:00:00.000Z', metricVersion: 'S08-V1',
  dataQuality: 'COMPLETE', totalMembers: 4, activeMembers: 2, inactiveMembers: 2, activeRate: 50, activeMemberships: 3,
  byKind: { GYM: { activeMembers: 2, activeMemberships: 2 }, PT: { activeMembers: 1, activeMemberships: 1 } },
  knownTotals: { totalMembers: 4, activeMembers: 2, activeMemberships: 3 }, warningCodes: [], invalidRecordCount: 0,
  filter: { kind: 'ALL', activity: 'ALL', q: '' }, page: 1, limit: 20, total: 21, totalPages: 2,
  items: [{ memberId: id, code: `HV-${id}`, displayName: 'Hội viên A', linkedAccount: false, qualifyingMembershipCount: 2, activity: 'ACTIVE' }] };
const detail: MembershipReportDetail = { ...page, observedAt: '2026-11-17T05:01:00.000Z', member: page.items[0],
  memberships: [{ membershipId: 'b'.repeat(24), serviceSaleId: 'c'.repeat(24), transactionId: 'd'.repeat(24),
    kind: 'GYM', planId: null, planNameSnapshot: 'Gói cũ', startDate: '2026-11-01', endDate: '2026-11-30',
    effectiveStart: '2026-11-01T00:00:00Z', effectiveEnd: at, currentStatus: 'SUPERSEDED', currentTransactionStatus: 'SETTLED',
    qualifies: false, reasonCodes: ['OUTSIDE_EFFECTIVE_INTERVAL'] }] };
let snapshot: AuthSnapshot;
let subscribers: Set<() => void>;
let paths: string[];
beforeEach(() => {
  snapshot = { status: 'authenticated', user: { id: 'e'.repeat(24), fullName: 'Admin', phone: '0900000000', roleCode: 'ADMIN' } };
  subscribers = new Set(); paths = [];
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(listener => { subscribers.add(listener); return () => subscribers.delete(listener); });
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
  vi.spyOn(apiClient, 'request').mockImplementation(async (path, init) => {
    paths.push(path); expect(init?.method ?? 'GET').toBe('GET');
    if (path.startsWith(`/reports/memberships/members/${id}?`)) return structuredClone(detail);
    if (path.startsWith('/reports/memberships/members?')) return structuredClone(page);
    if (path.startsWith('/me/notifications')) return { count: 0 };
    throw new Error(`Unexpected request ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('US-50 TC15: membership report UI', () => {
  it('shows distinct member KPI, correct labels and exact VN timestamp', async () => {
    render(<MembershipReportsPage />);
    await screen.findByText('50%');
    expect(screen.getByText(/không phải số người đã check-in/)).toBeTruthy();
    expect(screen.getByText(/10:30:00,000/)).toBeTruthy();
    expect(screen.getByText('Chưa liên kết')).toBeTruthy();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    expect(paths).toHaveLength(1); // KPI and rows are from one response.
  });
  it('converts datetime-local from VN regardless of browser timezone and reloads KPI/table together', async () => {
    render(<MembershipReportsPage />); await screen.findByText('50%');
    fireEvent.change(screen.getByLabelText('Thời điểm theo giờ Việt Nam (UTC+07:00)'), { target: { value: '2026-11-10T10:29:59' } });
    await userEvent.selectOptions(screen.getByLabelText('Loại quyền'), 'PT');
    await userEvent.type(screen.getByLabelText('Tìm mã hoặc tên (chỉ lọc bảng)'), ' A ');
    await userEvent.click(screen.getByRole('button', { name: 'Xem báo cáo' }));
    await screen.findByText('50%');
    const query = new URLSearchParams(paths.at(-1)?.split('?')[1]);
    expect(query.get('asOfAt')).toBe('2026-11-10T03:29:59.000Z');
    expect(query.get('kind')).toBe('PT'); expect(query.get('q')).toBe('A'); expect(query.get('page')).toBe('1');
    await userEvent.click(screen.getByRole('button', { name: 'Trang sau' })); await screen.findByText('50%');
    expect(new URLSearchParams(paths.at(-1)?.split('?')[1]).get('page')).toBe('2');
  });
  it('shows historical sources with separate observedAt and current status labels', async () => {
    render(<MembershipReportsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Xem quyền nguồn Hội viên A' }));
    const region = await screen.findByRole('region', { name: 'Quyền nguồn' });
    expect(within(region).getByText(/request riêng, có observedAt riêng/)).toBeTruthy();
    expect(within(region).getByText(/Trạng thái hiện tại.*SUPERSEDED/)).toBeTruthy();
    expect(within(region).getByText(/Không được tính.*OUTSIDE_EFFECTIVE_INTERVAL/)).toBeTruthy();
    expect(new URLSearchParams(paths.at(-1)?.split('?')[1]).get('asOfAt')).toBe(at);
  });
  it('displays partial warning and unknown values without converting null to zero', async () => {
    vi.mocked(apiClient.request).mockResolvedValueOnce({ ...page, dataQuality: 'PARTIAL', activeMembers: null,
      activeMemberships: null, activeRate: null, warningCodes: ['SETTLED_AT_MISSING'], invalidRecordCount: 1 });
    render(<MembershipReportsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/SETTLED_AT_MISSING/)).toBeTruthy();
    expect(screen.getByText(/chưa phải tổng đầy đủ/)).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull(); expect(screen.getAllByText('Không xác định').length).toBeGreaterThan(0);
  });
  it('zero denominator shows Không áp dụng and empty list', async () => {
    vi.mocked(apiClient.request).mockResolvedValueOnce({ ...page, totalMembers: 0, activeMembers: 0, inactiveMembers: 0,
      activeRate: null, activeMemberships: 0, items: [], total: 0, totalPages: 0 });
    render(<MembershipReportsPage />);
    expect(await screen.findByText('Không áp dụng')).toBeTruthy();
    expect(screen.getByText('Không có hội viên phù hợp bộ lọc bảng.')).toBeTruthy();
    expect(screen.getByText('0 hội viên; trang 0/0')).toBeTruthy();
  });
  it('loading/503/refresh and logout clear previous source data', async () => {
    let reject!: (error: unknown) => void;
    vi.mocked(apiClient.request).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    render(<MembershipReportsPage />); expect(screen.getByText('Đang tải báo cáo...')).toBeTruthy();
    await act(async () => reject(new ApiError('Máy chủ chưa sẵn sàng', 503)));
    expect(await screen.findByRole('alert')).toBeTruthy(); expect(screen.queryByRole('table')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại dữ liệu nguồn' })); await screen.findByText('50%');
    act(() => { snapshot = { status: 'anonymous', user: null }; subscribers.forEach(listener => listener()); });
    await waitFor(() => expect(screen.queryByText('50%')).toBeNull());
    expect(screen.getByText('Không có quyền truy cập.')).toBeTruthy();
  });
  it.each(['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as const)('actual route admits only Admin (%s)', async role => {
    snapshot = { ...snapshot, user: { ...snapshot.user!, roleCode: role } };
    window.history.replaceState(null, '', '/admin/reports/memberships'); render(<App />);
    if (role === 'ADMIN') await screen.findByText('50%');
    else {
      await screen.findByRole('heading', { name: 'Không có quyền truy cập' });
      expect(paths.filter(path => path.startsWith('/reports/'))).toHaveLength(0);
    }
  });
});
