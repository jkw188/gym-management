import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import App from '../../App';
import type { AuthSnapshot } from '../auth/auth.types';
import { TrainerPerformancePage } from './TrainerPerformancePage';
import { trainerPerformanceApi, type PerformanceDetail, type PerformanceList, type PerformanceMetrics, type PerformanceSource } from './trainer-performance.api';

vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })) }));
const id = 'a'.repeat(24), shiftId = 'b'.repeat(24), at = '2026-11-18T05:00:00Z';
const metrics: PerformanceMetrics = { plannedMilliseconds: '14400000', plannedHours: '4', completedShiftHours: '0',
  completedBookingMilliseconds: '7200000', completedBookingHours: '2', knownActualHours: '2.3333', actualTotalHours: null,
  knownPlannedHours: '4', knownCompletedBookingHours: '2', shiftCount: 2, completedShiftCount: 0, completedBookingCount: 2,
  missingCount: 0, openCount: 1, overlappingShiftCount: 0, overlappingBookingCount: 0, invalidSourceCount: 0,
  utilizationRate: 50, utilizationStatus: 'AVAILABLE', reviewCount: 1, averageRating: 4, ratingDistribution: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 0 },
  dataQuality: 'PARTIAL', warningCodes: ['ATTENDANCE_OPEN'], invalidRecordCount: 0 };
const list: PerformanceList = { range: { fromDate: '2026-11-01', toDate: '2026-11-18', timezone: 'Asia/Ho_Chi_Minh',
  start: '2026-10-31T17:00:00Z', endExclusive: '2026-11-18T17:00:00Z', effectiveTo: at, isOngoing: true }, observedAt: at,
  metricVersion: 'S08-V1', dataQuality: 'PARTIAL', warningCodes: ['ATTENDANCE_OPEN'], invalidRecordCount: 0, totals: metrics,
  items: [{ id, displayName: 'PT An', status: 'INACTIVE', summary: metrics }], page: 1, limit: 20, total: 21, totalPages: 2,
  filter: { trainerId: null, q: '', qScope: 'TABLE_ONLY' } };
const source: PerformanceSource = { id: shiftId, trainerId: id, shiftId, bookingId: null, status: 'CONFIRMED',
  startAt: '2026-10-31T16:00:00Z', endAt: '2026-10-31T18:00:00Z', clippedStartAt: '2026-10-31T17:00:00Z', clippedEndAt: '2026-10-31T18:00:00Z',
  rawMilliseconds: '7200000', clippedMilliseconds: '3600000', completedAt: null, recordedAt: at, actorId: id, rating: null,
  sourceLink: `/api/work-shifts/${shiftId}/attendance`, dataIssue: [] };
const detail: PerformanceDetail = { ...list, observedAt: '2026-11-18T05:01:00Z', trainer: list.items[0], summary: metrics, sourcePages: {
  shifts: { items: [source], page: 1, limit: 20, total: 21, totalPages: 2 },
  attendance: { items: [], page: 1, limit: 20, total: 0, totalPages: 0 }, bookings: { items: [], page: 1, limit: 20, total: 0, totalPages: 0 },
  reviews: { items: [], page: 1, limit: 20, total: 0, totalPages: 0 },
} };
let snapshot: AuthSnapshot, paths: string[], subscribers: Set<() => void>;
beforeEach(() => {
  snapshot = { status: 'authenticated', user: { id, fullName: 'Admin', phone: '0900000000', roleCode: 'ADMIN' } };
  paths = []; subscribers = new Set();
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(listener => { subscribers.add(listener); return () => subscribers.delete(listener); });
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
  vi.spyOn(apiClient, 'request').mockImplementation(async (path, init) => {
    paths.push(path); expect(init?.method ?? 'GET').toBe('GET');
    if (path.startsWith(`/reports/trainers/${id}/performance?`)) return structuredClone(detail);
    if (path.startsWith('/reports/trainers/performance?')) return structuredClone(list);
    if (path.startsWith('/me/notifications')) return { count: 0 };
    if (path.startsWith('/work-shifts/')) throw new ApiError('Không có quyền xem nguồn', 403);
    throw new Error(`Unexpected request ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('US52 reporting UI', () => {
  it('separates planned/completed/actual, preserves null attendance and labels partial known totals', async () => {
    render(<TrainerPerformancePage />);
    const summary = await screen.findByLabelText('Chỉ số hiệu suất');
    expect(summary.textContent).toContain('4,00 giờ (2 ca)');
    expect(summary.textContent).toContain('0,00 giờ (0 ca)');
    expect(summary.textContent).toContain('2,33 giờ; thiếu 0 ca, đang mở 1 ca');
    expect(summary.textContent).toContain('Chưa đủ dữ liệu'); expect(summary.textContent).toContain('PARTIAL');
    expect(within(summary).getByText('50%').title).toContain('7200000 ms; mẫu số 14400000 ms');
    expect(screen.getByText('PT An (INACTIVE)')).toBeTruthy(); expect(screen.getByText(/Kỳ chưa kết thúc/)).toBeTruthy();
  });
  it('preserves displayed filters until submit and resolves default range on table pagination', async () => {
    render(<TrainerPerformancePage />); await screen.findByLabelText('Chỉ số hiệu suất');
    fireEvent.change(screen.getByLabelText('Từ ngày (VN)'), { target: { value: '2026-11-02' } });
    fireEvent.change(screen.getByLabelText('Mã PT (để trống xem tất cả)'), { target: { value: id } });
    expect(paths).toHaveLength(1); expect(screen.getByText(/Kỳ đang hiển thị: 2026-11-01/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Xem báo cáo' }));
    await waitFor(() => expect(paths).toHaveLength(2)); expect(paths.at(-1)).toContain(`trainerId=${id}`);
    await screen.findByLabelText('Chỉ số hiệu suất');
    await userEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
    expect(paths.at(-1)).toContain('page=2'); expect(paths.at(-1)).toContain('fromDate=2026-11-01');
  });
  it('drills into sourceID across period edge, paginates each source and respects independent source permission', async () => {
    render(<TrainerPerformancePage />); await screen.findByLabelText('Chỉ số hiệu suất');
    await userEvent.click(screen.getByRole('button', { name: 'Chi tiết PT An' }));
    const region = await screen.findByLabelText('Chi tiết nguồn hiệu suất');
    expect(region.textContent).toContain('12:01'); expect(region.textContent).toContain('7200000 ms'); expect(region.textContent).toContain('3600000 ms');
    const shifts = within(region).getByLabelText('Ca công bố');
    await userEvent.click(within(shifts).getByRole('button', { name: 'Trang sau' }));
    await waitFor(() => expect(paths.at(-1)).toContain('shiftPage=2'));
    expect(paths.at(-1)).toContain('attendancePage=1'); expect(paths.at(-1)).toContain('reviewPage=1');
    await screen.findByLabelText('Chi tiết nguồn hiệu suất');
    await userEvent.click(screen.getByRole('button', { name: `Xem nguồn ${shiftId}` }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Không có quyền xem nguồn');
    expect(paths.at(-1)).toBe(`/work-shifts/${shiftId}/attendance`);
  });
  it('shows zero denominator as not applicable and rejects arbitrary source links', async () => {
    const zero = structuredClone(list); zero.totals.utilizationRate = null; zero.totals.utilizationStatus = 'NOT_APPLICABLE';
    vi.mocked(apiClient.request).mockResolvedValue(zero); render(<TrainerPerformancePage />);
    expect((await screen.findAllByText('Không áp dụng')).length).toBeGreaterThan(0);
    expect(() => trainerPerformanceApi.source({ ...source, sourceLink: 'https://outside.test' })).toThrow('Liên kết nguồn không hợp lệ');
  });
  it('opens the original review by ID even when the booking is outside the report period', async () => {
    const reviewId = 'c'.repeat(24), reviewDetail = structuredClone(detail);
    reviewDetail.sourcePages.reviews = { items: [{ ...source, id: reviewId, status: 'SUBMITTED', rating: 4, shiftId: null,
      bookingId: 'd'.repeat(24), sourceLink: `/api/admin/trainer-reviews/${reviewId}` }], page: 1, limit: 20, total: 1, totalPages: 1 };
    const original = vi.mocked(apiClient.request).getMockImplementation()!;
    vi.mocked(apiClient.request).mockImplementation(async (path, init) => {
      if (path.startsWith(`/reports/trainers/${id}/performance?`)) return reviewDetail;
      if (path === `/admin/trainer-reviews/${reviewId}`) return { id: reviewId, trainerId: id, trainerNameSnapshot: 'PT An', memberDisplayName: 'Hội viên',
        rating: 4, comment: '<script>text only</script>', createdAt: at, booking: { id: 'd'.repeat(24), startAt: '2026-10-20T01:00:00Z', endAt: '2026-10-20T02:00:00Z' } };
      return original(path, init);
    });
    render(<TrainerPerformancePage />); await screen.findByLabelText('Chỉ số hiệu suất');
    await userEvent.click(screen.getByRole('button', { name: 'Chi tiết PT An' }));
    await screen.findByLabelText('Chi tiết nguồn hiệu suất');
    await userEvent.click(screen.getByRole('button', { name: `Xem nguồn ${reviewId}` }));
    expect(await screen.findByText('Hội viên: <script>text only</script>')).toBeTruthy();
    expect(screen.getByLabelText('Nguồn đối chiếu').textContent).toContain('20/10/2026');
    expect(document.querySelector('script')).toBeNull();
  });
  it('distinguishes loading, empty,503 and refresh without displaying fabricated zeros', async () => {
    let resolve!: (v: PerformanceList) => void;
    vi.mocked(apiClient.request).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    render(<TrainerPerformancePage />); expect(screen.getByText('Đang tải báo cáo…')).toBeTruthy();
    await act(async () => resolve({ ...list, items: [], total: 0, totalPages: 0 }));
    expect(await screen.findByText('Không có PT phù hợp.')).toBeTruthy();
    vi.mocked(apiClient.request).mockRejectedValueOnce(new ApiError('DB chưa sẵn sàng', 503));
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại nguồn' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'DB chưa sẵn sàng');
    expect(screen.queryByLabelText('Chỉ số hiệu suất')).toBeNull(); expect(screen.queryByText('Không có PT phù hợp.')).toBeNull();
    await act(async () => window.dispatchEvent(new Event('online'))); await screen.findByLabelText('Chỉ số hiệu suất');
  });
  it('ignores stale responses and clears reports on logout', async () => {
    let resolve!: (v: PerformanceList) => void;
    vi.mocked(apiClient.request).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    render(<TrainerPerformancePage />);
    await userEvent.click(screen.getByRole('button', { name: 'Xem báo cáo' })); await screen.findByLabelText('Chỉ số hiệu suất');
    await act(async () => resolve({ ...list, observedAt: '2000-01-01T00:00:00Z' })); expect(screen.queryByText(/2000/)).toBeNull();
    await act(async () => { snapshot = { status: 'anonymous', user: null }; subscribers.forEach(f => f()); });
    expect(screen.queryByLabelText('Chỉ số hiệu suất')).toBeNull();
  });
  it.each(['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as const)('protects report route for %s', async role => {
    snapshot = { ...snapshot, user: { ...snapshot.user!, roleCode: role } };
    window.history.replaceState(null, '', '/admin/reports/trainers'); render(<App />);
    if (role === 'ADMIN') await screen.findByLabelText('Chỉ số hiệu suất');
    else { await screen.findByRole('heading', { name: 'Không có quyền truy cập' }); expect(paths.some(p => p.startsWith('/reports/trainers'))).toBe(false); }
  });
});
