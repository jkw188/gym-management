import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import App from '../../App';
import type { AuthSnapshot } from '../auth/auth.types';
import { CashFlowReportsPage } from './CashFlowReportsPage';
import type { CashFlowDetail, CashFlowPage, CashMetrics } from './cash-flow.api';

vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })) }));
const id = 'a'.repeat(24), at = '2026-11-17T05:00:00.000Z';
const metrics: CashMetrics = { totals: { grossReceipts: '0', refundPaid: '100000', netCash: '-100000' },
  knownTotals: { label: 'COMPLETE', grossReceipts: '0', refundPaid: '100000', netCash: '-100000' } };
const page: CashFlowPage = { ...metrics, range: { fromDate: '2026-11-01', toDate: '2026-11-17', timezone: 'Asia/Ho_Chi_Minh',
  start: '2026-10-31T17:00:00Z', endExclusive: '2026-11-17T17:00:00Z', effectiveTo: at, isOngoing: true },
  observedAt: at, metricVersion: 'S08-V1', dataQuality: 'COMPLETE', invalidRecordCount: 0, warningCodes: [],
  filter: { kind: 'ALL', paymentMethod: 'ALL', payoutMethod: 'ALL', paymentMethodScope: 'RECEIPTS_ONLY', payoutMethodScope: 'SUCCEEDED_REFUNDS_ONLY' },
  byKind: { GYM: metrics, PT: metrics, RETAIL: metrics, UNKNOWN: metrics },
  byDate: [{ date: '2026-11-17', isComplete: false, ...metrics }],
  byMethod: { receipts: { CASH: metrics, TRANSFER: metrics, UNKNOWN: metrics }, refunds: { CASH: metrics, TRANSFER: metrics, UNKNOWN: metrics } },
  currentOutstandingRefunds: { scope: 'CURRENT_AT_OBSERVED_AT', dateFilterApplied: false, methodFiltersApplied: false, kind: 'ALL',
    observedAt: at, outstandingRefundAmount: '70000', count: 2, knownAmount: '70000', knownCount: 2, dataQuality: 'COMPLETE' },
  items: [{ eventId: `RECEIPT:${id}`, id, eventType: 'RECEIPT', occurredAt: '2026-11-01T16:59:59.000Z', amount: '300000',
    kind: 'RETAIL', method: 'TRANSFER', status: 'SUCCEEDED', paymentId: id, refundId: null, transactionId: 'b'.repeat(24), transactionCode: 'TX-LATE',
    orderId: 'c'.repeat(24), orderCode: 'ORDER-LATE', returnId: null, invoiceId: null, invoiceCode: null, lateReceipt: true, warningCodes: [] }],
  page: 1, limit: 20, total: 21, totalPages: 2, eventFilter: { eventType: 'ALL', q: '' } };
const detail: CashFlowDetail = { ...page, observedAt: '2026-11-17T05:01:00Z', event: page.items[0] };
let snapshot: AuthSnapshot, paths: string[], subscribers: Set<() => void>;
beforeEach(() => {
  snapshot = { status: 'authenticated', user: { id: 'e'.repeat(24), fullName: 'Admin', phone: '0900000000', roleCode: 'ADMIN' } };
  paths = []; subscribers = new Set();
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(listener => { subscribers.add(listener); return () => subscribers.delete(listener); });
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
  vi.spyOn(apiClient, 'request').mockImplementation(async (path, init) => {
    paths.push(path); expect(init?.method ?? 'GET').toBe('GET');
    if (path.startsWith(`/reports/cash-flow/events/RECEIPT/${id}?`)) return structuredClone(detail);
    if (path.startsWith('/reports/cash-flow/events?')) return structuredClone(page);
    if (path.startsWith('/me/notifications')) return { count: 0 };
    throw new Error(`Unexpected request ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('US-51 TC15: cash flow report UI', () => {
  it('one response renders signed money, VN date, current obligations and separate actual payment/payout groups', async () => {
    render(<CashFlowReportsPage />);
    await screen.findByLabelText('KPI dòng tiền');
    const region = screen.getByLabelText('KPI dòng tiền');
    expect(within(region).getByText('-100.000 ₫')).toBeTruthy();
    expect(screen.getByText(/hôm nay chưa kết thúc/)).toBeTruthy();
    expect(screen.getByText(/23:59:59/)).toBeTruthy();
    expect(screen.getByLabelText('Còn phải hoàn hiện tại').textContent).toContain('70.000 ₫ / 2');
    expect(screen.getByRole('table', { name: 'Theo phương thức' })).toBeTruthy();
    expect(paths).toHaveLength(1);
  });
  it('sends independent filters and preserves displayed range/observedAt until submit; paging resolves defaults', async () => {
    render(<CashFlowReportsPage />); await screen.findByLabelText('KPI dòng tiền');
    fireEvent.change(screen.getByLabelText('Từ ngày (VN)'), { target: { value: '2026-11-02' } });
    fireEvent.change(screen.getByLabelText('Đến ngày (VN)'), { target: { value: '2026-11-03' } });
    await userEvent.selectOptions(screen.getByLabelText('Phương thức thu'), 'TRANSFER');
    await userEvent.selectOptions(screen.getByLabelText('Phương thức chi hoàn'), 'CASH');
    await userEvent.selectOptions(screen.getByLabelText('Loại dịch vụ'), 'RETAIL');
    expect(paths).toHaveLength(1);
    expect(screen.getByText(/Kỳ đang hiển thị: 2026-11-01/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Xem báo cáo' }));
    await waitFor(() => expect(paths).toHaveLength(2));
    const query = new URLSearchParams(paths.at(-1)!.split('?')[1]);
    expect(Object.fromEntries(query)).toMatchObject({ fromDate: '2026-11-02', toDate: '2026-11-03', paymentMethod: 'TRANSFER', payoutMethod: 'CASH', kind: 'RETAIL', page: '1' });
    await screen.findByLabelText('KPI dòng tiền');
    await userEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
    expect(paths.at(-1)).toContain('page=2'); expect(paths.at(-1)).toContain('fromDate=2026-11-01');
  });
  it('drills down late receipt without a fabricated invoice, with a separately labeled snapshot', async () => {
    render(<CashFlowReportsPage />); await screen.findByLabelText('KPI dòng tiền');
    await userEvent.click(screen.getByRole('button', { name: `Xem nguồn RECEIPT:${id}` }));
    const source = await screen.findByLabelText('Chi tiết nguồn');
    expect(source.textContent).toContain('Khoản thu muộn của đơn hủy.'); expect(source.textContent).toContain('Không có hóa đơn');
    expect(source.textContent).toContain('snapshot riêng'); expect(source.textContent).toContain('12:01:00');
  });
  it('shows PARTIAL/null and exact known totals beyond safe Number without rounding', async () => {
    const partial = structuredClone(page); partial.dataQuality = 'PARTIAL'; partial.invalidRecordCount = 1;
    partial.warningCodes = ['EVENT_TIMESTAMP_INVALID']; partial.totals.grossReceipts = null; partial.totals.netCash = null;
    partial.knownTotals = { label: 'PARTIAL', grossReceipts: '9999999999990000', refundPaid: '1', netCash: '9999999999989999' };
    vi.mocked(apiClient.request).mockResolvedValue(partial);
    render(<CashFlowReportsPage />);
    expect(await screen.findByText('Dữ liệu PARTIAL')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('9.999.999.999.990.000 ₫');
    expect(within(screen.getByLabelText('KPI dòng tiền')).getAllByText('Không xác định')).toHaveLength(2);
  });
  it('distinguishes loading, empty and offline/503; online reloads the source', async () => {
    let resolve!: (value: CashFlowPage) => void;
    vi.mocked(apiClient.request).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    render(<CashFlowReportsPage />); expect(screen.getByText('Đang tải báo cáo...')).toBeTruthy();
    await act(async () => resolve({ ...page, items: [], total: 0, totalPages: 0 }));
    expect(await screen.findByText('Không có sự kiện phù hợp.')).toBeTruthy();
    vi.mocked(apiClient.request).mockRejectedValueOnce(new ApiError('DB chưa sẵn sàng', 503));
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại dữ liệu nguồn' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'DB chưa sẵn sàng');
    expect(screen.queryByLabelText('KPI dòng tiền')).toBeNull(); expect(screen.queryByText('Không có sự kiện phù hợp.')).toBeNull();
    await act(async () => window.dispatchEvent(new Event('online'))); await screen.findByLabelText('KPI dòng tiền');
  });
  it('ignores a stale period response and clears sensitive report data on logout', async () => {
    let oldResolve!: (value: CashFlowPage) => void;
    vi.mocked(apiClient.request).mockImplementationOnce(() => new Promise(r => { oldResolve = r; }));
    render(<CashFlowReportsPage />);
    fireEvent.change(screen.getByLabelText('Từ ngày (VN)'), { target: { value: '2026-11-02' } });
    await userEvent.click(screen.getByRole('button', { name: 'Xem báo cáo' })); await screen.findByLabelText('KPI dòng tiền');
    await act(async () => oldResolve({ ...page, observedAt: '2000-01-01T00:00:00Z' }));
    expect(screen.queryByText(/2000/)).toBeNull();
    await act(async () => { snapshot = { status: 'anonymous', user: null }; subscribers.forEach(listener => listener()); });
    expect(screen.queryByLabelText('KPI dòng tiền')).toBeNull(); expect(screen.getByText('Không có quyền truy cập.')).toBeTruthy();
  });
  it.each(['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as const)('route allows ADMIN only: %s', async role => {
    snapshot = { ...snapshot, user: { ...snapshot.user!, roleCode: role } };
    window.history.replaceState(null, '', '/admin/reports/cash-flow'); render(<App />);
    if (role === 'ADMIN') await screen.findByLabelText('KPI dòng tiền');
    else { await screen.findByRole('heading', { name: 'Không có quyền truy cập' }); expect(paths.some(p => p.startsWith('/reports/cash-flow'))).toBe(false); }
  });
});
