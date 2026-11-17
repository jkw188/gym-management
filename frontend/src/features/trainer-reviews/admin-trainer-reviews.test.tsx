import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import App from '../../App';
import type { AuthSnapshot } from '../auth/auth.types';
import { AdminTrainerReviewsPage } from './AdminTrainerReviewsPage';
import type { AdminReview, AdminReviewPage, AdminTrainerSummary, ReviewMetrics } from './admin-trainer-reviews.api';

vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })) }));
const trainerId = 'a'.repeat(24), reviewId = 'b'.repeat(24), bookingId = 'c'.repeat(24);
const metrics: ReviewMetrics = { reviewCount: 4, ratingSum: 8, averageRating: 2, distribution: { '1': 3, '2': 0, '3': 0, '4': 0, '5': 1 } };
const zero: ReviewMetrics = { reviewCount: 0, ratingSum: 0, averageRating: null, distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } };
const review: AdminReview = { id: reviewId, trainerId, trainerNameSnapshot: 'PT lúc gửi', memberDisplayName: 'Học viên lúc gửi',
  rating: 5, comment: '<img src=x onerror=alert(1)> https://outside.test', createdAt: '2026-11-10T03:00:00Z',
  booking: { id: bookingId, startAt: '2026-09-01T02:00:00Z', endAt: '2026-09-01T03:00:00Z' } };
const common = { page: 1, limit: 20, total: 25, totalPages: 2, asOf: '2026-11-17T03:00:00Z',
  range: { fromDate: '2026-10-19', toDate: '2026-11-17' }, totals: metrics, invalidReviewCount: 2 };
let summary: AdminReviewPage<AdminTrainerSummary>;
let list: AdminReviewPage<AdminReview>;
let snapshot: AuthSnapshot;
let subscribers: Set<() => void>;
let calls: string[];
let fail: boolean;
let hold: Promise<void> | undefined;
let rejectDetail: boolean;

beforeEach(() => {
  snapshot = { status: 'authenticated', user: { id: 'd'.repeat(24), fullName: 'Admin', phone: '0900000000', roleCode: 'ADMIN' } };
  summary = { ...common, items: [
    { ...metrics, trainerId, currentTrainerName: 'PT hiện tại', status: 'INACTIVE' },
    { ...zero, trainerId: 'e'.repeat(24), currentTrainerName: 'PT chưa đánh giá', status: 'ACTIVE' },
  ] };
  list = { ...common, items: [review] };
  calls = []; subscribers = new Set(); fail = false; hold = undefined; rejectDetail = false;
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(listener => { subscribers.add(listener); return () => subscribers.delete(listener); });
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
  vi.spyOn(apiClient, 'request').mockImplementation(async (path, init) => {
    calls.push(path); expect(init?.method ?? 'GET').toBe('GET');
    if (hold) await hold;
    if (fail) throw new ApiError('Máy chủ chưa sẵn sàng', 503);
    const [route, query] = path.split('?');
    const params = new URLSearchParams(query);
    if (params.get('fromDate') === '2026-12-31') throw new ApiError('Bộ lọc sai', 400, undefined, [{ field: 'fromDate', message: 'fromDate không được sau hôm nay' }]);
    if (route === '/admin/trainer-reviews/summary') return structuredClone({ ...summary, page: Number(params.get('page') ?? 1) });
    if (route === '/admin/trainer-reviews') return structuredClone({ ...list, page: Number(params.get('page') ?? 1) });
    if (route === `/admin/trainer-reviews/${reviewId}`) {
      if (rejectDetail) throw new ApiError('Không tìm thấy đánh giá', 404);
      return structuredClone(review);
    }
    if (route.startsWith('/me/notifications')) return { count: 0 };
    throw new Error(`Unexpected path ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const summaryRegion = () => screen.getByRole('region', { name: 'Tổng hợp theo PT' });
const listRegion = () => screen.getByRole('region', { name: 'Nhận xét gốc' });
const ready = async () => {
  await screen.findByText('PT hiện tại');
  await screen.findByRole('button', { name: 'Mở đánh giá gốc' });
};

describe('US-33: Admin summary và nhận xét gốc', () => {
  it('TC04/05/07: lấy totals toàn tập từ server, 2 số lẻ, phân bố, INACTIVE và null rõ', async () => {
    render(<AdminTrainerReviewsPage />); await ready();
    const totals = screen.getByRole('region', { name: 'Tổng toàn tập lọc' });
    expect(within(totals).getByText('Số lượt: 4')).toBeTruthy();
    expect(within(totals).getByText('Điểm trung bình: 2.00')).toBeTruthy();
    expect(within(totals).getByText(/1 sao: 3.*5 sao: 1/)).toBeTruthy();
    expect(screen.getByText(/Ngừng hoạt động/)).toBeTruthy();
    expect(screen.getByText('Điểm trung bình: — (Chưa có đánh giá)')).toBeTruthy();
    expect(screen.queryByText('Điểm trung bình: 0.00')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('2 đánh giá không hợp lệ');
  });

  it('TC06: phân trang nhận xét và PT độc lập, không làm thay đổi tổng toàn tập', async () => {
    render(<AdminTrainerReviewsPage />); await ready();
    await userEvent.click(within(listRegion()).getByRole('button', { name: 'Trang sau' }));
    await waitFor(() => expect(calls.at(-1)).toBe('/admin/trainer-reviews?page=2'));
    expect(calls.filter(path => path.startsWith('/admin/trainer-reviews/summary'))).toHaveLength(1);
    await screen.findByRole('button', { name: 'Mở đánh giá gốc' });
    await userEvent.click(within(summaryRegion()).getByRole('button', { name: 'Trang sau' }));
    await waitFor(() => expect(calls.at(-1)).toBe('/admin/trainer-reviews/summary?page=2'));
    expect(calls.filter(path => path.startsWith('/admin/trainer-reviews?'))).toHaveLength(2);
    await screen.findByText('PT hiện tại');
    expect(within(screen.getByRole('region', { name: 'Tổng toàn tập lọc' })).getByText('Điểm trung bình: 2.00')).toBeTruthy();
  });

  it('TC03/06/08: bộ lọc PT/điểm/kỳ gửi áp dụng vào cả hai API, quay về trang 1, UI ghi rõ', async () => {
    render(<AdminTrainerReviewsPage />); await ready();
    fireEvent.change(screen.getByLabelText('Mã PT (để trống xem toàn phòng)'), { target: { value: trainerId } });
    fireEvent.change(screen.getByLabelText('Từ ngày gửi'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('Đến ngày gửi'), { target: { value: '2026-11-17' } });
    fireEvent.change(screen.getByLabelText('Điểm'), { target: { value: '5' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lọc' })); await ready();
    for (const path of calls.slice(-2)) {
      const params = new URLSearchParams(path.split('?')[1]);
      expect(Object.fromEntries(params)).toEqual({ trainerId, fromDate: '2026-11-01', toDate: '2026-11-17', rating: '5', page: '1' });
    }
    expect(screen.getByText(`Bộ lọc áp dụng: PT ${trainerId} · Điểm 5.`)).toBeTruthy();
    expect(within(listRegion()).getByText(/Gửi lúc: 10:00 10\/11\/2026/)).toBeTruthy();
    expect(within(listRegion()).getByText(/Buổi tập: 09:00 01\/09\/2026/)).toBeTruthy();
  });

  it('TC09/10/11: drill-down GET nguồn, snapshot và mã buổi, HTML/URL chỉ là chữ, không có nút ghi', async () => {
    const view = render(<AdminTrainerReviewsPage />); await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Mở đánh giá gốc' }));
    const detail = await screen.findByRole('region', { name: 'Chi tiết đánh giá' });
    await within(detail).findByText(`Mã đánh giá: ${reviewId}`);
    expect(calls).toContain(`/admin/trainer-reviews/${reviewId}`);
    expect(within(detail).getByText(`Mã buổi: ${bookingId}`)).toBeTruthy();
    expect(within(detail).getByText(/PT lúc gửi: PT lúc gửi/)).toBeTruthy();
    expect(within(detail).getByText(review.comment)).toBeTruthy();
    expect(view.container.querySelector('img,script')).toBeNull();
    expect(view.container.querySelector('a[href="https://outside.test"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Sửa|Xóa|Ẩn|Trả lời/ })).toBeNull();
    rejectDetail = true;
    await userEvent.click(screen.getByRole('button', { name: 'Mở đánh giá gốc' }));
    await within(detail).findByRole('alert');
    expect(within(detail).queryByText(review.comment)).toBeNull();
  });

  it('TC08: lỗi kỳ hiện message cụ thể và xóa kết quả cũ để tránh hiểu sai tập lọc', async () => {
    render(<AdminTrainerReviewsPage />); await ready();
    fireEvent.change(screen.getByLabelText('Từ ngày gửi'), { target: { value: '2026-12-31' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lọc' }));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(screen.getAllByRole('alert')[0].textContent).toContain('fromDate không được sau hôm nay');
    expect(screen.queryByText('Điểm trung bình: 2.00')).toBeNull();
  });

  it('TC12: loading, DB lỗi, thử lại, online và empty phân biệt rõ', async () => {
    let release!: () => void; hold = new Promise<void>(resolve => { release = resolve; });
    render(<AdminTrainerReviewsPage />); expect(screen.getByText('Đang tải tổng hợp...')).toBeTruthy();
    fail = true; await act(async () => release());
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(screen.queryByText(/Chưa có đánh giá/)).toBeNull();
    fail = false; hold = undefined;
    await userEvent.click(within(summaryRegion()).getByRole('button', { name: 'Thử lại' })); await ready();
    const previousCalls = calls.length;
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(calls.length).toBeGreaterThan(previousCalls)); await ready();
    summary = { ...common, items: [], totals: zero, total: 0, totalPages: 0, invalidReviewCount: 0 };
    list = { ...common, items: [], totals: zero, total: 0, totalPages: 0, invalidReviewCount: 0 };
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
    await screen.findByText('Không có PT trong trang này.');
    expect(screen.getByText('Chưa có đánh giá trong trang này.')).toBeTruthy();
  });

  it('TC12: đổi account/logout xóa số liệu và detail cũ, bỏ kết quả về muộn', async () => {
    render(<AdminTrainerReviewsPage />); await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Mở đánh giá gốc' }));
    await screen.findByText(`Mã đánh giá: ${reviewId}`);
    let release!: () => void; hold = new Promise<void>(resolve => { release = resolve; });
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
    act(() => { snapshot = { ...snapshot, user: { ...snapshot.user!, id: 'f'.repeat(24) } }; subscribers.forEach(listener => listener()); });
    expect(screen.queryByText(`Mã đánh giá: ${reviewId}`)).toBeNull();
    expect(screen.queryByText('PT hiện tại')).toBeNull();
    act(() => { snapshot = { status: 'anonymous', user: null }; subscribers.forEach(listener => listener()); });
    await act(async () => release());
    expect(screen.queryByText('PT hiện tại')).toBeNull();
    expect(screen.queryByText(review.comment)).toBeNull();
  });

  it('TC01: nút PT mở nhận xét với trainerId hiện tại, không dùng endpoint public', async () => {
    render(<AdminTrainerReviewsPage />); await ready();
    await userEvent.click(screen.getAllByRole('button', { name: 'Xem nhận xét của PT' })[0]); await ready();
    for (const path of calls.slice(-2)) expect(new URLSearchParams(path.split('?')[1]).get('trainerId')).toBe(trainerId);
    expect(screen.getByLabelText<HTMLInputElement>('Mã PT (để trống xem toàn phòng)').value).toBe(trainerId);
  });

  it.each(['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as const)('TC02: route thật chỉ cho Admin (%s)', async role => {
    snapshot = { ...snapshot, user: { ...snapshot.user!, roleCode: role } };
    window.history.replaceState(null, '', '/admin/trainer-reviews'); render(<App />);
    if (role === 'ADMIN') { await screen.findByRole('heading', { name: 'Tổng hợp đánh giá PT' }); await ready(); }
    else { await screen.findByRole('heading', { name: 'Không có quyền truy cập' }); expect(calls.filter(path => path.startsWith('/admin/trainer-reviews'))).toHaveLength(0); }
  });
  it('Admin có link truy cập từ trang chính', async () => {
    window.history.replaceState(null, '', '/admin'); render(<App />);
    expect((await screen.findByRole('link', { name: 'Tổng hợp đánh giá PT' })).getAttribute('href')).toBe('/admin/trainer-reviews');
  });
});
