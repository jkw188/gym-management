import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import App from '../../App';
import type { AuthSnapshot } from '../auth/auth.types';
import { TrainerActivityPage } from './TrainerActivityPage';
import { trainerActivityApi, type ActivityDetail, type ActivityList } from './trainer-activity.api';

vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })) }));
const trainerId = 'a'.repeat(24), shiftId = 'b'.repeat(24), bookingId = 'c'.repeat(24);
const summary = { shiftCount: 3, attendanceClosed: 1, attendanceOpen: 1, attendanceMissing: 1, actualMinutesTotal: 90,
  bookingCount: 5, completedCount: 2, cancelledCount: 1, pendingCompletionCount: 2 };
const asOf = '2026-11-17T03:00:00Z', range = { fromDate: '2026-10-19', toDate: '2026-11-17' };
const trainer = { id: trainerId, displayName: 'PT đã ngừng hoạt động', status: 'INACTIVE', dataIssue: [], summary };
const list: ActivityList = { items: [trainer], page: 1, limit: 20, total: 25, totalPages: 2, asOf, range, summary };
const detail: ActivityDetail = { trainer, asOf, range, summary,
  shiftsPage: { items: [{ id: shiftId, trainerId, startAt: '2026-11-01T01:00:00Z', endAt: '2026-11-02T01:00:00Z', status: 'CONFIRMED', location: 'Gym',
    dataIssue: [], attendance: { id: null, state: 'MISSING', checkInAt: null, checkOutAt: null, actualMinutes: null,
      recordedBy: null, checkedOutBy: null, version: null, lastCorrectedBy: null, lastCorrectedAt: null } }], page: 1, limit: 20, total: 30, totalPages: 2, asOf },
  bookingsPage: { items: [{ id: bookingId, trainerId, memberId: null, startAt: '2026-11-01T01:00:00Z', endAt: '2026-11-01T02:00:00Z',
    status: 'COMPLETED', completedAt: '2026-11-10T03:00:00Z', completedBy: trainerId, completionRevision: 1, dataIssue: ['MEMBER_MISSING'] }],
    page: 1, limit: 20, total: 5, totalPages: 1, asOf } };
let snapshot: AuthSnapshot;
let subscribers: Set<() => void>;
let calls: string[];
let fail = false;
let hold: Promise<void> | undefined;
beforeEach(() => {
  snapshot = { status: 'authenticated', user: { id: 'd'.repeat(24), fullName: 'Admin', phone: '0900000000', roleCode: 'ADMIN' } };
  subscribers = new Set(); calls = []; fail = false; hold = undefined;
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(listener => { subscribers.add(listener); return () => subscribers.delete(listener); });
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
  vi.spyOn(apiClient, 'request').mockImplementation(async (path, init) => {
    calls.push(path); expect(init?.method ?? 'GET').toBe('GET');
    if (hold) await hold;
    if (fail) throw new ApiError('Máy chủ chưa sẵn sàng', 503);
    if (path.startsWith('/admin/trainers/activity?')) return structuredClone(list);
    if (path.startsWith(`/admin/trainers/${trainerId}/activity?`)) return structuredClone(detail);
    if (path === `/work-shifts/${shiftId}/attendance`) return { asOf, state: 'MISSING', shift: detail.shiftsPage.items[0], events: [] };
    if (path === `/admin/pt-bookings/${bookingId}`) return { id: bookingId, startAt: detail.bookingsPage.items[0].startAt,
      endAt: detail.bookingsPage.items[0].endAt, status: 'COMPLETED', completionRevision: 1, completedBy: trainerId,
      quotaSource: { membershipId: 'e'.repeat(24), sessionsUsed: null, sessionsQuota: null },
      events: [{ action: 'COMPLETE', actorId: trainerId, occurredAt: asOf, beforeStatus: 'BOOKED', afterStatus: 'COMPLETED', reason: '<script>evil()</script>' }] };
    if (path.startsWith('/me/notifications')) return { count: 0 };
    throw new Error(`Unexpected path ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const open = async () => { render(<TrainerActivityPage />); await userEvent.click(await screen.findByRole('button', { name: /Đối chiếu PT/ })); return screen.findByRole('region', { name: 'Đối chiếu PT' }); };

describe('US-32 UI', () => {
  it('TC01/03/05/08: displays independent regions, missing minutes, full timestamps and server totals', async () => {
    const region = await open();
    expect(within(region).getByRole('region', { name: 'Ca và chấm công' })).toBeTruthy();
    expect(within(region).getByRole('region', { name: 'Buổi PT' })).toBeTruthy();
    expect(within(region).getByText('Thời lượng thực: Chưa có dữ liệu hợp lệ')).toBeTruthy();
    expect(within(region).getByText(/10:00 10\/11\/2026/)).toBeTruthy();
    expect(within(region).getByText(/08:00 02\/11\/2026/)).toBeTruthy();
    expect(within(region).getByText(/MEMBER_MISSING/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Tổng toàn bộ tập lọc' })).getByText(/90 phút/)).toBeTruthy();
  });
  it('TC04/08: applies PT/VN-date filters and resets source pagination', async () => {
    render(<TrainerActivityPage />); await screen.findByText(/Kỳ 2026/);
    fireEvent.change(screen.getByLabelText('Mã PT (tùy chọn)'), { target: { value: trainerId } });
    fireEvent.change(screen.getByLabelText('Từ ngày'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('Đến ngày'), { target: { value: '2026-11-30' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lọc' }));
    await screen.findByText(/Kỳ 2026/);
    const query = new URLSearchParams(calls.at(-1)?.split('?')[1]);
    expect(query.get('trainerId')).toBe(trainerId); expect(query.get('fromDate')).toBe('2026-11-01'); expect(query.get('page')).toBe('1');
    await userEvent.click(screen.getByRole('button', { name: /Đối chiếu PT/ }));
    const shifts = await screen.findByRole('region', { name: 'Ca và chấm công' });
    await userEvent.click(within(shifts).getByRole('button', { name: 'Trang sau' }));
    await screen.findByRole('region', { name: 'Ca và chấm công' });
    const sourceQuery = new URLSearchParams(calls.at(-1)?.split('?')[1]);
    expect(sourceQuery.get('shiftPage')).toBe('2'); expect(sourceQuery.get('bookingPage')).toBe('1');
  });
  it('TC09/11: drills down only to allowlisted GET sources; audit text never becomes a link or HTML', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Xem nguồn ca/chấm công' }));
    await screen.findByRole('region', { name: 'Chi tiết nguồn' }); expect(calls).toContain(`/work-shifts/${shiftId}/attendance`);
    await userEvent.click(screen.getByRole('button', { name: 'Xem nguồn buổi PT' }));
    await screen.findByText(/evil/);
    expect(document.querySelector('script')).toBeNull(); expect(calls).toContain(`/admin/pt-bookings/${bookingId}`);
    expect(screen.getByText(/đã dùng Chưa có dữ liệu/)).toBeTruthy();
    const count = calls.length;
    expect(() => trainerActivityApi.booking('https://evil.test')).toThrow(); expect(calls).toHaveLength(count);
  });
  it('TC12: loading/error/retry does not replace unavailable data with zero totals', async () => {
    let release!: () => void; hold = new Promise<void>(resolve => { release = resolve; });
    render(<TrainerActivityPage />); expect(screen.getByText('Đang tải báo cáo...')).toBeTruthy();
    fail = true; await act(async () => { release(); });
    await screen.findByRole('alert'); expect(screen.queryByText(/90 phút/)).toBeNull();
    fail = false; hold = undefined; await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    await screen.findByText(/90 phút/);
  });
  it('TC12: empty response shows no sources or fabricated performance percentage', async () => {
    vi.mocked(apiClient.request).mockResolvedValueOnce({ ...list, items: [], total: 0, totalPages: 0,
      summary: Object.fromEntries(Object.keys(summary).map(key => [key, 0])) });
    render(<TrainerActivityPage />);
    await screen.findByText('Không có PT hoặc nguồn phù hợp.');
    expect(screen.getByText('0 bản ghi; trang 0/0')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Đối chiếu PT' })).toBeNull();
    expect(document.body.textContent).not.toContain('0%');
  });
  it('TC09/12: refresh reloads committed sources and account change immediately clears old data', async () => {
    await open(); const previousCalls = calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại dữ liệu' }));
    await screen.findByRole('region', { name: 'Đối chiếu PT' }); expect(calls.length).toBeGreaterThan(previousCalls);
    act(() => { snapshot = { status: 'anonymous', user: null }; subscribers.forEach(listener => listener()); });
    expect(screen.queryByText(/90 phút/)).toBeNull(); expect(screen.queryByText(/ngừng hoạt động —/)).toBeNull();
  });
  it.each(['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as const)('TC02: actual route accepts only ADMIN (%s)', async role => {
    snapshot = { ...snapshot, user: { ...snapshot.user!, roleCode: role } };
    window.history.replaceState(null, '', '/admin/trainers/activity'); render(<App />);
    if (role === 'ADMIN') await screen.findByRole('heading', { name: 'Đối chiếu chấm công và buổi PT' });
    else { await screen.findByRole('heading', { name: 'Không có quyền truy cập' }); expect(calls.filter(path => path.startsWith('/admin/trainers'))).toHaveLength(0); }
  });
});
