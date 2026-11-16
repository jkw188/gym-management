import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { apiClient, ApiError } from '../../api/client';
import { resolveReturnTo } from '../auth/auth.routes';
import { OrdersPage } from './OrdersPage';
import { ordersApi, orderDate, type OrderDetail, type PreparedOrder } from './orders.api';

const row: OrderDetail = { id: 'a'.repeat(24), code: `ORD-${'a'.repeat(24)}`, channel: 'WEBSITE', status: 'PENDING', version: 0,
  transactionId: 'b'.repeat(24), transactionStatus: 'PENDING', memberId: 'c'.repeat(24), total: '25000', reservationState: 'HELD', reservationExpiresAt: '2035-11-15T17:00:00.000Z',
  createdAt: '2035-11-14T17:00:00.000Z', updatedAt: '2035-11-14T17:00:00.000Z', asOf: '2035-11-14T17:00:00.000Z', expired: false,
  permittedActions: { fulfill: false, fulfillBlockedReason: 'ORDER_NOT_PREPARED', prepare: true, prepareBlockedReason: null }, recipient: { name: 'Người nhận snapshot', phone: '+84901234567' }, pickupLocation: 'Quầy fixture', confirmedAt: null, confirmedBy: null, fulfilledAt: null, fulfilledBy: null, movementIds: [],
  items: [{ id: 'd'.repeat(24), productId: 'e'.repeat(24), skuSnapshot: 'OLD-SKU', nameSnapshot: 'Tên snapshot', quantity: 1, unitPrice: '25000', lineTotal: '25000' }], invoice: null, refunds: [] };
const prepared: PreparedOrder = { id: row.id, code: row.code, status: 'CONFIRMED', version: 1, confirmedAt: '2035-11-14T18:00:00.000Z', confirmedBy: 'f'.repeat(24), reservationExpiresAt: row.reservationExpiresAt, notificationState: 'STORED' };
const detail: OrderDetail = { ...row, ...prepared, permittedActions: { fulfill: false, fulfillBlockedReason: 'ORDER_NOT_PREPARED', prepare: false, prepareBlockedReason: 'ORDER_ALREADY_CONFIRMED' } };
const page = { items: [row], total: 1, totalPages: 1, page: 1, limit: 20 };
beforeEach(() => { vi.spyOn(ordersApi, 'list').mockResolvedValue(page); vi.spyOn(ordersApi, 'detail').mockResolvedValue(row); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });
async function open() { render(<OrdersPage />); await userEvent.click(await screen.findByRole('button', { name: `Mở ${row.code}` })); await screen.findByRole('heading', { name: row.code }); }
async function check() { await userEvent.click(screen.getByLabelText('Tôi đã kiểm tra và chuẩn bị đủ hàng thực tế')); }
describe('US-43 TC12: list/detail, command recovery and separate operational/payment states', () => {
  it('defaults WEBSITE/PENDING, loading, literal filter, VN dates, empty/error and retry', async () => {
    render(<OrdersPage />); expect(screen.getByRole('status').textContent).toContain('Đang tải');
    await screen.findByRole('button', { name: `Mở ${row.code}` });
    expect(ordersApi.list).toHaveBeenCalledWith(expect.objectContaining({ channel: 'WEBSITE', status: 'PENDING', page: 1, limit: 20 }), expect.any(AbortSignal));
    vi.mocked(ordersApi.list).mockResolvedValueOnce({ ...page, items: [], total: 0, totalPages: 0 });
    fireEvent.change(screen.getByLabelText('Mã đơn'), { target: { value: ' .* ' } });
    fireEvent.change(screen.getByLabelText('Từ ngày'), { target: { value: '2035-11-15' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lọc đơn' })); await screen.findByText('Không có đơn phù hợp.');
    expect(ordersApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: '.*', fromDate: '2035-11-15', page: 1 }), expect.any(AbortSignal));
    vi.mocked(ordersApi.list).mockRejectedValueOnce(new ApiError('Không tải được đơn'));
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách' })); await screen.findByText('Không tải được đơn');
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách' })); await screen.findByRole('button', { name: `Mở ${row.code}` });
    expect(orderDate('2035-11-14T17:00:00.000Z')).toContain('15/11/2035');
  });
  it('requires physical check, prevents double submit, reloads success without declaring paid or handed over', async () => {
    let finish!: (value: PreparedOrder) => void;
    const prepare = vi.spyOn(ordersApi, 'prepare').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await open(); expect(screen.getByText('Tên snapshot', { exact: false })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Xác nhận đã chuẩn bị' })).toHaveProperty('disabled', true);
    await check(); vi.mocked(ordersApi.detail).mockResolvedValue(detail);
    await userEvent.dblClick(screen.getByRole('button', { name: 'Xác nhận đã chuẩn bị' }));
    expect(prepare).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledWith(row.id, 0, expect.any(String));
    expect(screen.getByRole('button', { name: 'Về danh sách' })).toHaveProperty('disabled', true);
    finish(prepared); await screen.findByText('Đã xác nhận chuẩn bị hàng. Thanh toán và bàn giao là các bước riêng.');
    expect(screen.getByText('Đã chuẩn bị', { selector: 'strong' })).toBeDefined(); expect(screen.getByText('Chưa xác nhận thanh toán')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Xác nhận đã chuẩn bị' })).toBeNull();
  });
  it('conflict reloads latest state and version, then requires checking goods again', async () => {
    vi.spyOn(ordersApi, 'prepare').mockRejectedValue(new ApiError('Đơn đã thay đổi', 409, undefined, undefined, undefined, 'VERSION_CONFLICT'));
    await open(); await check(); vi.mocked(ordersApi.detail).mockResolvedValue({ ...row, version: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận đã chuẩn bị' })); await screen.findByText('Đơn đã thay đổi');
    await waitFor(() => expect(screen.getByText(/Phiên bản: 1/)).toBeDefined());
    expect(screen.getByLabelText('Tôi đã kiểm tra và chuẩn bị đủ hàng thực tế')).toHaveProperty('checked', false);
  });
  it('lost response preserves same key/version, lookup404 remains unresolved, same request replay resolves', async () => {
    const prepare = vi.spyOn(ordersApi, 'prepare').mockRejectedValueOnce(new ApiError('Mất kết nối')).mockResolvedValueOnce(prepared);
    const lookup = vi.spyOn(ordersApi, 'lookup').mockRejectedValue(new ApiError('Chưa thấy kết quả', 404, undefined, undefined, undefined, 'OPERATION_UNKNOWN'));
    await open(); await check(); await userEvent.click(screen.getByRole('button', { name: 'Xác nhận đã chuẩn bị' })); await screen.findByText('Mất kết nối');
    expect(screen.getByRole('button', { name: 'Về danh sách' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' })); await screen.findByText('Chưa thấy kết quả');
    expect(lookup).toHaveBeenCalledWith(prepare.mock.calls[0][2]);
    vi.mocked(ordersApi.detail).mockResolvedValue(detail);
    await userEvent.click(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu' }));
    await screen.findByText('Đã xác nhận chuẩn bị hàng. Thanh toán và bàn giao là các bước riêng.'); expect(prepare.mock.calls[1]).toEqual(prepare.mock.calls[0]);
  });
  it('lookup success resolves without another prepare', async () => {
    const prepare = vi.spyOn(ordersApi, 'prepare').mockRejectedValue(new ApiError('Chưa rõ kết quả', 503));
    vi.spyOn(ordersApi, 'lookup').mockResolvedValue({ status: 'COMMITTED', responseBody: prepared });
    await open(); await check(); await userEvent.click(screen.getByRole('button', { name: 'Xác nhận đã chuẩn bị' })); await screen.findByText('Chưa rõ kết quả');
    vi.mocked(ordersApi.detail).mockResolvedValue(detail);
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' })); await screen.findByText('Đã xác nhận chuẩn bị hàng. Thanh toán và bàn giao là các bước riêng.'); expect(prepare).toHaveBeenCalledOnce();
  });
  it('removes the action after backend denies permission', async () => {
    vi.spyOn(ordersApi, 'prepare').mockRejectedValue(new ApiError('Không có quyền chuẩn bị', 403));
    await open(); await check(); await userEvent.click(screen.getByRole('button', { name: 'Xác nhận đã chuẩn bị' }));
    await screen.findByText('Không có quyền chuẩn bị'); expect(screen.queryByRole('button', { name: 'Xác nhận đã chuẩn bị' })).toBeNull();
  });
  it.each(['expired', 'POS', 'permission'])('hides prepare when %s', async kind => {
    vi.mocked(ordersApi.detail).mockResolvedValue({ ...row, expired: kind === 'expired', channel: kind === 'POS' ? 'POS' : 'WEBSITE', permittedActions: { fulfill: false, fulfillBlockedReason: 'ORDER_NOT_PREPARED', prepare: false, prepareBlockedReason: kind } });
    await open(); expect(screen.queryByRole('button', { name: 'Xác nhận đã chuẩn bị' })).toBeNull();
    if (kind === 'expired') expect(screen.getByText(/Đã hết hạn giữ hàng, chờ xử lý hủy/)).toBeDefined();
  });
  it('detail failure reports error and keeps list usable', async () => {
    vi.mocked(ordersApi.detail).mockRejectedValue(new ApiError('Không đọc được đơn'));
    render(<OrdersPage />); await userEvent.click(await screen.findByRole('button', { name: `Mở ${row.code}` })); await screen.findByText('Không đọc được đơn');
    expect(screen.getByRole('button', { name: `Mở ${row.code}` })).toBeDefined();
  });
  it('does not describe a completed order as awaiting expiry cancellation', async () => {
    const completed: OrderDetail = { ...row, status: 'COMPLETED', reservationState: 'CONSUMED', transactionStatus: 'SETTLED', expired: true, permittedActions: { fulfill: false, fulfillBlockedReason: 'ORDER_NOT_PREPARED', prepare: false, prepareBlockedReason: 'INVALID_ORDER_STATE' } };
    vi.mocked(ordersApi.list).mockResolvedValue({ ...page, items: [completed] }); vi.mocked(ordersApi.detail).mockResolvedValue(completed);
    await open(); expect(screen.getByText('Đã bàn giao', { selector: 'strong' })).toBeDefined(); expect(screen.queryByText(/chờ xử lý hủy/)).toBeNull();
  });
  it.each(['MEMBER', 'TRAINER'] as const)('rejects %s routes before any order API', async roleCode => {
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: { id: 'f'.repeat(24), fullName: 'Fixture', phone: '0901234567', roleCode } });
    vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {}); vi.spyOn(apiClient, 'restore').mockResolvedValue(); vi.spyOn(apiClient, 'request').mockResolvedValue({ unreadCount: 0, items: [] });
    for (const path of ['/staff/orders', '/admin/orders']) { window.history.pushState({}, '', path); render(<App />); await screen.findByRole('heading', { name: 'Không có quyền truy cập' }); cleanup(); }
    expect(ordersApi.list).not.toHaveBeenCalled();
  });
  it.each(['STAFF', 'ADMIN'] as const)('opens and restores order route for %s', async roleCode => {
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: { id: 'f'.repeat(24), fullName: 'Fixture', phone: '0901234567', roleCode } });
    vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {}); vi.spyOn(apiClient, 'restore').mockResolvedValue();
    const path = `/${roleCode.toLowerCase()}/orders`; window.history.pushState({}, '', path); render(<App />);
    await screen.findByRole('heading', { name: 'Chuẩn bị và bàn giao đơn hàng website' }); expect(resolveReturnTo(path, roleCode)).toBe(path);
  });
});
