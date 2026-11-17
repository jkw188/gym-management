import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { ApiError, apiClient } from '../../api/client';
import { resolveReturnTo } from '../auth/auth.routes';
import { stockReceiptsApi } from '../stock/stock-receipts.api';
import { InventoryPage } from './InventoryPage';
import { inventoryApi, type InventoryBalance, type Movement, type MovementPage } from './inventory.api';

const id = 'a'.repeat(24), sourceId = 'b'.repeat(24);
const balance: InventoryBalance = { productId: id, categoryId: 'c'.repeat(24), sku: 'WATER', name: 'Nước', productStatus: 'INACTIVE', effectiveActive: false,
  inventoryState: 'VALID', onHand: 10, reserved: 3, available: 7, version: 2, asOf: '2026-11-15T00:00:00Z' };
const movement: Movement = { id: 'd'.repeat(24), productId: id, sequence: 2, kind: 'RECEIPT_POST', skuSnapshot: 'WATER', nameSnapshot: 'Tên lúc nhập',
  onHandDelta: 5, reservedDelta: 0, beforeOnHand: 5, beforeReserved: 3, afterOnHand: 10, afterReserved: 3, createdAt: '2026-11-01T17:00:00Z',
  sourceType: 'STOCK_RECEIPT', sourceId, sourceCode: 'RCV_TEST', sourcePath: `/stock-receipts/${sourceId}`, asOf: balance.asOf };
const page = { items: [balance], page: 1, limit: 20, total: 1, totalPages: 1, asOf: balance.asOf };
const history: MovementPage = { items: [movement], page: 1, limit: 20, total: 1, totalPages: 1, range: { fromDate: '2026-10-17', toDate: '2026-11-15', timeZone: 'Asia/Ho_Chi_Minh' }, asOf: balance.asOf };
const show = () => render(<MemoryRouter initialEntries={['/staff/inventory']}><InventoryPage /></MemoryRouter>);
beforeEach(() => {
  vi.spyOn(inventoryApi, 'list').mockResolvedValue(page); vi.spyOn(inventoryApi, 'detail').mockResolvedValue(balance);
  vi.spyOn(inventoryApi, 'history').mockResolvedValue(history); vi.spyOn(inventoryApi, 'movement').mockResolvedValue(movement);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

describe('US-37 TC14: inventory UI, historical snapshots, loading/error/empty and protected source navigation', () => {
  it('shows current balances, inactive status, submits literal filters and handles empty/error/retry', async () => {
    show(); expect(screen.getByRole('status').textContent).toContain('Đang tải tồn kho');
    await screen.findByRole('button', { name: 'Xem kho WATER' });
    const row = screen.getByText('WATER · Nước').closest('tr')!;
    expect(within(row).getByText('10')).toBeDefined(); expect(within(row).getByText('3')).toBeDefined(); expect(within(row).getByText('7')).toBeDefined();
    expect(within(row).getByText(/INACTIVE/)).toBeDefined(); expect(screen.queryByRole('button', { name: /Sửa tồn/ })).toBeNull();
    vi.mocked(inventoryApi.list).mockResolvedValueOnce({ ...page, items: [], total: 0, totalPages: 0 });
    fireEvent.change(screen.getByLabelText('Tìm SKU / tên sản phẩm'), { target: { value: ' WATER.* ' } });
    fireEvent.change(screen.getByLabelText('Trạng thái sản phẩm'), { target: { value: 'INACTIVE' } });
    fireEvent.change(screen.getByLabelText('Tình trạng tồn'), { target: { value: 'ERROR' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lọc kho' })); await screen.findByText('Không có sản phẩm phù hợp.');
    expect(inventoryApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'WATER.*', productStatus: 'INACTIVE', stockState: 'ERROR', page: 1 }), expect.any(AbortSignal));
    vi.mocked(inventoryApi.list).mockRejectedValueOnce(new ApiError('Kho tạm không sẵn sàng', 503));
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại kho' })); await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' })); await screen.findByRole('button', { name: 'Xem kho WATER' });
  });
  it.each(['MISSING', 'INCONSISTENT'] as const)('warns %s and displays unknown balances as dashes, never fabricated zero', async inventoryState => {
    const invalid = { ...balance, inventoryState, onHand: null, reserved: null, available: null, version: null };
    vi.mocked(inventoryApi.list).mockResolvedValue({ ...page, items: [invalid] }); vi.mocked(inventoryApi.detail).mockResolvedValue(invalid);
    show(); await userEvent.click(await screen.findByRole('button', { name: 'Xem kho WATER' }));
    await screen.findByText(/Dữ liệu kho cần đối chiếu/);
    expect(within(screen.getByRole('region', { name: 'Chi tiết kho' })).getAllByText('—')).toHaveLength(4);
  });
  it('keeps current balance independent of period/page, preserves stored before/after and opens the exact allowlisted source', async () => {
    vi.mocked(inventoryApi.history).mockResolvedValue({ ...history, total: 21, totalPages: 2 }); show();
    await userEvent.click(await screen.findByRole('button', { name: 'Xem kho WATER' }));
    const detail = await screen.findByRole('region', { name: 'Chi tiết kho' });
    await screen.findByText('Tên lúc nhập', { exact: false });
    expect(within(detail).getByText('Khả dụng hiện tại').nextElementSibling?.textContent).toBe('7');
    fireEvent.change(screen.getByLabelText('Từ ngày biến động'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('Đến ngày biến động'), { target: { value: '2026-11-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lọc biến động' }));
    await waitFor(() => expect(inventoryApi.history).toHaveBeenLastCalledWith(id, expect.objectContaining({ fromDate: '2026-11-01', toDate: '2026-11-01', page: 1 }), expect.any(AbortSignal)));
    await userEvent.click(screen.getByRole('button', { name: 'Trang biến động sau' }));
    await waitFor(() => expect(inventoryApi.history).toHaveBeenLastCalledWith(id, expect.objectContaining({ page: 2 }), expect.any(AbortSignal)));
    expect(within(detail).getByText('5 / 3')).toBeDefined(); expect(within(detail).getByText('10 / 3')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Xem biến động 2' }));
    const link = await screen.findByRole('link', { name: 'Mở phiếu nguồn' }); expect(link.getAttribute('href')).toBe(`/staff/stock-receipts?documentId=${sourceId}`);
    expect(screen.queryByText(/VND/)).toBeNull();
  });
  it('handles empty history and failed detail/history loads with retry; refreshes data on window focus', async () => {
    vi.mocked(inventoryApi.history).mockRejectedValueOnce(new ApiError('Không tải được sổ'));
    vi.mocked(inventoryApi.detail).mockRejectedValueOnce(new ApiError('Không tải được số dư'));
    show(); await userEvent.click(await screen.findByRole('button', { name: 'Xem kho WATER' }));
    await screen.findByText('Không tải được sổ'); await screen.findByText('Không tải được số dư');
    vi.mocked(inventoryApi.history).mockResolvedValue({ ...history, items: [], total: 0, totalPages: 0 });
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại chi tiết kho' })); await screen.findByText('Chưa có biến động trong kỳ đã chọn.');
    const count = vi.mocked(inventoryApi.list).mock.calls.length; fireEvent(window, new Event('focus'));
    await waitFor(() => expect(inventoryApi.list).toHaveBeenCalledTimes(count + 1));
  });
  it('never renders a foreign/untrusted source URL', async () => {
    vi.mocked(inventoryApi.movement).mockResolvedValue({ ...movement, sourcePath: 'https://untrusted.invalid/cost' });
    show(); await userEvent.click(await screen.findByRole('button', { name: 'Xem kho WATER' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Xem biến động 2' }));
    await screen.findByText(/Quyền xem phiếu và giá nhập/); expect(screen.queryByRole('link', { name: 'Mở phiếu nguồn' })).toBeNull();
  });
  it.each(['/admin', '/staff'])('opens verified ISSUE source only for Admin (%s)', async home => {
    vi.mocked(inventoryApi.movement).mockResolvedValue({ ...movement, kind: 'ISSUE_POST', sourceType: 'STOCK_ISSUE', sourcePath: `/stock-issues/${sourceId}` });
    render(<MemoryRouter initialEntries={[`${home}/inventory`]}><InventoryPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Xem kho WATER' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Xem biến động 2' }));
    await screen.findByText(/Quyền xem phiếu và giá nhập/);
    const link = screen.queryByRole('link', { name: 'Mở phiếu nguồn' });
    if (home === '/admin') expect(link?.getAttribute('href')).toBe(`/admin/stock-issues?documentId=${sourceId}`);
    else expect(link).toBeNull();
  });
  it.each(['MEMBER', 'TRAINER'] as const)('rejects %s before issuing any inventory reads', async roleCode => {
    authenticate(roleCode);
    for (const path of ['/staff/inventory', '/admin/inventory']) {
      window.history.pushState({}, '', path); render(<App />); await screen.findByRole('heading', { name: 'Không có quyền truy cập' }); cleanup();
    }
    expect(inventoryApi.list).not.toHaveBeenCalled();
  });
  it.each(['STAFF', 'ADMIN'] as const)('supports %s routes/returnTo and respects source endpoint 403', async roleCode => {
    authenticate(roleCode); const home = `/${roleCode.toLowerCase()}`, path = `${home}/inventory`;
    expect(resolveReturnTo(path, roleCode)).toBe(path); window.history.pushState({}, '', path); render(<App />);
    await screen.findByRole('button', { name: 'Xem kho WATER' }); cleanup();
    vi.spyOn(stockReceiptsApi, 'detail').mockRejectedValue(new ApiError('Không có quyền xem phiếu nguồn', 403));
    vi.spyOn(stockReceiptsApi, 'list').mockResolvedValue({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
    window.history.pushState({}, '', `${home}/stock-receipts?documentId=${sourceId}`); render(<App />);
    await screen.findByText('Không có quyền xem phiếu nguồn');
    expect(stockReceiptsApi.detail).toHaveBeenCalledWith(sourceId, expect.any(AbortSignal)); expect(screen.queryByText(/5.000 VND/)).toBeNull();
  });
});
function authenticate(roleCode: 'STAFF' | 'ADMIN' | 'MEMBER' | 'TRAINER') {
  vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: { id, fullName: 'Test', phone: '0901234567', roleCode } });
  vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {}); vi.spyOn(apiClient, 'restore').mockResolvedValue();
  vi.spyOn(apiClient, 'request').mockResolvedValue({ unreadCount: 0, items: [] });
}
