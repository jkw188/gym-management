import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import { resolveReturnTo } from '../auth/auth.routes';
import { MemberDetailPage } from './MemberDetailPage';
import { MemberHistory } from './MemberHistory';
import { MembersPage } from './MembersPage';
import { membersApi, type MemberListItem, type MemberPage, type MemberMembership, type MemberTransaction } from './members.api';

const first: MemberListItem = { id: '123456789012345678901234', memberCode: 'HV-123456789012345678901234',
  fullName: '<img src=x>', phone: '+84912345678', accountLinked: false, entitlementSummary: { GYM: ['CURRENT'], PT: ['EXPIRED'] } };
const pageOf = <T,>(items: T[], page = 1, total = items.length): MemberPage<T> => ({ items, page, total, limit: 20,
  totalPages: Math.ceil(total / 20), asOf: '2026-11-08T18:00:00.000Z', businessDate: '2026-11-09' });
function listPage() { render(<MemoryRouter initialEntries={['/staff/members']}><MembersPage /></MemoryRouter>); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('US-11 TC14: list debounce, stale responses, pagination, error/retry and detail integration', () => {
  it('debounces search and immediately invalidates an old response even before the new request starts', async () => {
    vi.useFakeTimers();
    let finish!: (value: MemberPage<MemberListItem>) => void;
    const list = vi.spyOn(membersApi, 'list').mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(pageOf([{ ...first, fullName: 'Kết quả mới' }]));
    listPage();
    await act(async () => { vi.advanceTimersByTime(300); });
    fireEvent.change(screen.getByLabelText('Mã, tên hoặc số điện thoại'), { target: { value: 'An' } });
    await act(async () => finish(pageOf([first])));
    expect(screen.queryByText(first.fullName)).toBeNull();
    await act(async () => { vi.advanceTimersByTime(200); });
    fireEvent.change(screen.getByLabelText('Mã, tên hoặc số điện thoại'), { target: { value: 'Anh' } });
    await act(async () => { vi.advanceTimersByTime(299); });
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(list).toHaveBeenLastCalledWith({ q: 'Anh', kind: '', membershipState: '', page: 1, limit: 20 }, expect.any(AbortSignal));
    expect(screen.getByText(/Kết quả mới/)).toBeTruthy();
  });

  it('renders per-kind states, unlinked account, safe text and server pagination; resets page on filter change', async () => {
    const list = vi.spyOn(membersApi, 'list').mockResolvedValue(pageOf([first], 1, 21));
    listPage();
    const link = await screen.findByRole('link', { name: `${first.memberCode} — ${first.fullName}` });
    expect(link.getAttribute('href')).toBe(`/staff/members/${first.id}`);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('GYM: Đang hiệu lực')).toBeTruthy(); expect(screen.getByText('PT: Đã hết hạn')).toBeTruthy();
    expect(screen.getByText(/Chưa liên kết tài khoản/)).toBeTruthy();
    expect(screen.getByText(/ngày Việt Nam: 2026-11-09/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }), expect.any(AbortSignal)));
    fireEvent.change(screen.getByLabelText('Loại dịch vụ'), { target: { value: 'PT' } });
    fireEvent.change(screen.getByLabelText('Trạng thái gói'), { target: { value: 'EXPIRED' } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, kind: 'PT', membershipState: 'EXPIRED' }), expect.any(AbortSignal)));
  });

  it('keeps errors separate from empty results and retries with the active filter', async () => {
    const list = vi.spyOn(membersApi, 'list').mockRejectedValueOnce(new ApiError('Tạm mất kết nối', 503))
      .mockResolvedValue(pageOf([]));
    listPage();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Không tìm thấy hội viên phù hợp.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText('Không tìm thấy hội viên phù hợp.')).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('discards a membership history response after switching tabs; transactions show pending and missing records explicitly', async () => {
    let finish!: (value: MemberPage<MemberMembership>) => void;
    vi.spyOn(membersApi, 'memberships').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending: MemberTransaction = { id: first.id, code: 'GD-01', kind: 'PT', status: 'PENDING', amountDue: '150000', createdAt: '2026-11-08T18:00:00Z' };
    vi.spyOn(membersApi, 'transactions').mockResolvedValue(pageOf([pending]));
    render(<MemberHistory id={first.id} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lịch sử giao dịch' }));
    expect(await screen.findByText('GD-01 (PT)')).toBeTruthy();
    await act(async () => finish(pageOf([{ membershipId: first.id, saleId: first.id, kind: 'PT', planName: 'Gói cũ về trễ',
      startDate: '2026-11-01', endDate: '2026-11-30', storedStatus: 'ACTIVE', timeState: 'CURRENT', sessionsQuota: 12, sessionsUsed: 2, transactionStatus: 'SETTLED' }])));
    expect(screen.queryByText(/Gói cũ về trễ/)).toBeNull();
    expect(screen.getByText('Chờ thanh toán / chưa cấp gói')).toBeTruthy();
    expect(screen.getByText('Chưa có khoản thu đã xác nhận.')).toBeTruthy(); expect(screen.getByText('Chưa có chứng từ.')).toBeTruthy();
  });

  it('paginates histories on server and handles unavailable data with retry', async () => {
    const membership: MemberMembership = { membershipId: first.id, saleId: first.id, kind: 'PT', planName: 'PT trước đây',
      startDate: '2026-10-01', endDate: '2026-10-31', storedStatus: 'SUPERSEDED', timeState: 'NONE', sessionsQuota: 12, sessionsUsed: 3, transactionStatus: 'SETTLED' };
    const history = vi.spyOn(membersApi, 'memberships').mockRejectedValueOnce(new ApiError('Chưa tải được lịch sử', 503))
      .mockResolvedValue(pageOf([membership], 1, 21));
    render(<MemberHistory id={first.id} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại lịch sử' }));
    expect(await screen.findByText('Buổi đã dùng: 3/12')).toBeTruthy();
    expect(screen.getByText(/Đã được thay thế/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lịch sử sau' }));
    await waitFor(() => expect(history).toHaveBeenLastCalledWith(first.id, 2, expect.any(AbortSignal)));
  });

  it('detail displays profile version data, entitlements and fresh asOf, and refreshes without a write', async () => {
    const detail = { member: { ...first, version: 7, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z' },
      entitlementSummary: first.entitlementSummary, asOf: '2026-11-08T18:00:00Z', businessDate: '2026-11-09' };
    const read = vi.spyOn(membersApi, 'detail').mockResolvedValue(detail);
    vi.spyOn(membersApi, 'memberships').mockResolvedValue(pageOf([]));
    const write = vi.spyOn(membersApi, 'update');
    render(<MemoryRouter initialEntries={[`/admin/members/${first.id}`]}><Routes>
      <Route path="/admin/members/:id" element={<MemberDetailPage />} />
    </Routes></MemoryRouter>);
    expect(await screen.findByText('GYM: Đang hiệu lực')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Về danh sách hội viên' }).getAttribute('href')).toBe('/admin/members');
    read.mockResolvedValue({ ...detail, entitlementSummary: { GYM: ['EXPIRED'], PT: ['NONE'] } });
    fireEvent.click(screen.getByRole('button', { name: 'Làm mới hồ sơ và quyền lợi' }));
    expect(await screen.findByText('GYM: Đã hết hạn')).toBeTruthy(); expect(write).not.toHaveBeenCalled();
  });

  it('uses internal read-only API endpoints and allows list returnTo for the matching operator role', async () => {
    const client = vi.spyOn(apiClient, 'request').mockResolvedValue(pageOf([]));
    await membersApi.list({ q: '+84912345678', kind: 'PT', membershipState: 'EXPIRED', page: 2 });
    expect(client).toHaveBeenLastCalledWith('/members?q=%2B84912345678&kind=PT&membershipState=EXPIRED&page=2', { signal: undefined });
    await membersApi.transactions(first.id, 2);
    expect(client).toHaveBeenLastCalledWith(`/members/${first.id}/transactions?page=2&limit=20`, { signal: undefined });
    expect(resolveReturnTo('/staff/members?q=An', 'STAFF')).toBe('/staff/members?q=An');
    expect(resolveReturnTo('/admin/members', 'ADMIN')).toBe('/admin/members');
    expect(resolveReturnTo('/staff/members', 'MEMBER')).toBe('/member');
  });
});
