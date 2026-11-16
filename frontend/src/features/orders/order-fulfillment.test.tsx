import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient, ApiError } from '../../api/client';
import { OrderFulfillment } from './OrderFulfillment';
import { OrdersPage } from './OrdersPage';
import { ordersApi, orderDate, type FulfilledOrder, type OrderDetail } from './orders.api';

const row: OrderDetail = { id: 'a'.repeat(24), code: `ORD-${'a'.repeat(24)}`, channel: 'WEBSITE', status: 'CONFIRMED', version: 2,
  transactionId: 'b'.repeat(24), transactionStatus: 'SETTLED', memberId: 'c'.repeat(24), total: '25000', reservationState: 'HELD', reservationExpiresAt: '2035-11-15T17:00:00.000Z',
  createdAt: '2035-11-14T17:00:00.000Z', updatedAt: '2035-11-14T17:00:00.000Z', asOf: '2035-11-14T17:00:00.000Z', expired: false,
  permittedActions: { prepare: false, prepareBlockedReason: 'ORDER_ALREADY_CONFIRMED', fulfill: true, fulfillBlockedReason: null },
  recipient: { name: 'Người nhận snapshot', phone: '+84901234567' }, pickupLocation: 'Quầy fixture', confirmedAt: '2035-11-14T17:00:00.000Z', confirmedBy: 'f'.repeat(24),
  fulfilledAt: null, fulfilledBy: null, movementIds: [],
  items: [{ id: 'd'.repeat(24), productId: 'e'.repeat(24), skuSnapshot: 'OLD-SKU', nameSnapshot: 'Tên snapshot', quantity: 1, unitPrice: '25000', lineTotal: '25000' }],
  invoice: { id: '1'.repeat(24), invoiceNo: 'INV-FIXTURE', totalAmount: '25000', issuedAt: '2035-11-14T17:00:00.000Z' }, refunds: [] };
const fulfilled: FulfilledOrder = { id: row.id, code: row.code, status: 'COMPLETED', reservationState: 'CONSUMED', version: 3,
  fulfilledAt: '2035-11-14T18:00:00.000Z', fulfilledBy: 'f'.repeat(24), movementIds: ['2'.repeat(24)], notificationState: 'STORED' };
const completed: OrderDetail = { ...row, ...fulfilled, permittedActions: { ...row.permittedActions, fulfill: false, fulfillBlockedReason: 'ORDER_ALREADY_COMPLETED' } };
const acknowledgment = 'Tôi đã đối chiếu người nhận, chứng từ thu hợp lệ và bàn giao đủ sản phẩm thực tế';
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(ordersApi, 'list').mockResolvedValue({ items: [row], total: 1, totalPages: 1, page: 1, limit: 20 });
  vi.spyOn(ordersApi, 'detail').mockResolvedValue(row);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });
async function open() { render(<OrdersPage />); await userEvent.click(await screen.findByRole('button', { name: `Mở ${row.code}` })); await screen.findByRole('heading', { name: row.code }); }
async function submit() { await userEvent.click(screen.getByLabelText(acknowledgment)); await userEvent.click(screen.getByRole('button', { name: 'Xác nhận đã bàn giao' })); }

describe('US-44 TC13: physical handover acknowledgement, pending, conflicts and recovery', () => {
  it('shows recipient/items/invoice/deadline; SETTLED never automatically calls fulfill; explicit acknowledgement prevents double submit', async () => {
    let finish!: (value: FulfilledOrder) => void;
    const fulfill = vi.spyOn(ordersApi, 'fulfill').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await open(); expect(fulfill).not.toHaveBeenCalled();
    expect(screen.getByText(/Người nhận snapshot/)).toBeDefined(); expect(screen.getByText(/INV-FIXTURE/)).toBeDefined(); expect(screen.getByText(/OLD-SKU/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Xác nhận đã bàn giao' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByLabelText(acknowledgment));
    await userEvent.dblClick(screen.getByRole('button', { name: 'Xác nhận đã bàn giao' }));
    expect(fulfill).toHaveBeenCalledOnce(); expect(fulfill).toHaveBeenCalledWith(row.id, 2, expect.any(String));
    expect(screen.getByRole('button', { name: 'Về danh sách' })).toHaveProperty('disabled', true); expect(sessionStorage.length).toBe(1);
    vi.mocked(ordersApi.detail).mockResolvedValue(completed); finish(fulfilled);
    await screen.findByText(`Đã bàn giao đủ sản phẩm lúc ${orderDate(fulfilled.fulfilledAt)} · Nhân viên: ${fulfilled.fulfilledBy}.`);
    expect(screen.getByText('Đã bàn giao', { selector: 'strong' })).toBeDefined(); expect(screen.getByText(/Trả hàng cần quy trình riêng/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Xác nhận đã bàn giao' })).toBeNull(); expect(sessionStorage.length).toBe(0);
  });
  it('network loss keeps immutable key/version; lookup404 and observed detail cannot authorize another physical delivery', async () => {
    const fulfill = vi.spyOn(ordersApi, 'fulfill').mockRejectedValueOnce(new ApiError('Mất phản hồi')).mockResolvedValueOnce(fulfilled);
    const lookup = vi.spyOn(ordersApi, 'lookupFulfillment').mockRejectedValue(new ApiError('Chưa thấy kết quả', 404, undefined, undefined, undefined, 'OPERATION_UNKNOWN'));
    await open(); await submit(); await screen.findByText('Mất phản hồi');
    expect(screen.getByText(/Không giao lại sản phẩm vì mất phản hồi/)).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả bàn giao' })); await screen.findByText('Chưa thấy kết quả');
    expect(lookup).toHaveBeenCalledWith(fulfill.mock.calls[0][2]);
    vi.mocked(ordersApi.detail).mockResolvedValue(completed);
    await userEvent.click(screen.getByRole('button', { name: 'Kiểm tra trạng thái đơn' })); await screen.findByText(/Trạng thái hiện tại: Đã bàn giao/);
    expect(sessionStorage.length).toBe(1); expect(screen.queryByRole('button', { name: 'Xác nhận đã bàn giao' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu bàn giao' }));
    await screen.findByText(/Đã bàn giao đủ sản phẩm lúc/); expect(fulfill.mock.calls[1]).toEqual(fulfill.mock.calls[0]); expect(sessionStorage.length).toBe(0);
  });
  it('restores pending command after remount and resolves through lookup without another fulfill request', async () => {
    const fulfill = vi.spyOn(ordersApi, 'fulfill').mockRejectedValue(new ApiError('Chưa rõ kết quả', 503));
    const lookup = vi.spyOn(ordersApi, 'lookupFulfillment').mockResolvedValue({ status: 'COMMITTED', responseBody: fulfilled });
    await open(); await submit(); await screen.findByText('Chưa rõ kết quả');
    const key = fulfill.mock.calls[0][2]; cleanup();
    await open(); expect(screen.getByText(new RegExp(key))).toBeDefined();
    vi.mocked(ordersApi.detail).mockResolvedValue(completed);
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả bàn giao' })); await screen.findByText(/Đã bàn giao đủ sản phẩm lúc/);
    expect(lookup).toHaveBeenCalledWith(key); expect(fulfill).toHaveBeenCalledOnce();
  });
  it.each(['VERSION_CONFLICT', 'INVENTORY_INTEGRITY_ERROR', 'ORDER_ALREADY_COMPLETED'])('%s reloads state and resets acknowledgement without forcing stock or repeating delivery', async code => {
    vi.spyOn(ordersApi, 'fulfill').mockRejectedValue(new ApiError('Cần tải lại và đối chiếu', 409, undefined, undefined, undefined, code));
    await open(); vi.mocked(ordersApi.detail).mockResolvedValue(code === 'ORDER_ALREADY_COMPLETED' ? completed : { ...row, version: 3 });
    await submit(); await waitFor(() => expect(ordersApi.detail).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Cần tải lại và đối chiếu')).toBeDefined();
    if (code === 'ORDER_ALREADY_COMPLETED') await screen.findByText('Đã bàn giao', { selector: 'strong' });
    else { await screen.findByLabelText(acknowledgment); expect(screen.getByLabelText(acknowledgment)).toHaveProperty('checked', false); }
    expect(sessionStorage.length).toBe(0); expect(screen.queryByRole('button', { name: /ép/i })).toBeNull();
    if (code !== 'ORDER_ALREADY_COMPLETED') {
      vi.mocked(ordersApi.fulfill).mockResolvedValue(fulfilled); vi.mocked(ordersApi.detail).mockResolvedValue(completed);
      await submit(); await screen.findByText(/Đã bàn giao đủ sản phẩm lúc/);
      expect(screen.queryByText('Cần tải lại và đối chiếu')).toBeNull();
    }
  });
  it.each([401, 403])('auth failure %s keeps recovery key and removes retry permission', async status => {
    vi.spyOn(ordersApi, 'fulfill').mockRejectedValue(new ApiError('Phiên hoặc quyền đã thay đổi', status));
    await open(); await submit(); await screen.findByText('Phiên hoặc quyền đã thay đổi');
    expect(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu bàn giao' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Xác nhận đã bàn giao' })).toBeNull(); expect(sessionStorage.length).toBe(1);
  });
  it.each(['expired', 'POS', 'unpaid'])('does not expose handover for %s', async kind => {
    vi.mocked(ordersApi.detail).mockResolvedValue({ ...row, channel: kind === 'POS' ? 'POS' : 'WEBSITE', expired: kind === 'expired', transactionStatus: kind === 'unpaid' ? 'PENDING' : 'SETTLED',
      permittedActions: { ...row.permittedActions, fulfill: false, fulfillBlockedReason: kind } });
    const fulfill = vi.spyOn(ordersApi, 'fulfill'); await open(); expect(screen.queryByRole('button', { name: 'Xác nhận đã bàn giao' })).toBeNull(); expect(fulfill).not.toHaveBeenCalled();
  });
  it('uses the website endpoint, original version/key and operation namespace', async () => {
    const request = vi.spyOn(apiClient, 'request').mockResolvedValue(fulfilled);
    const key = crypto.randomUUID(); await ordersApi.fulfill(row.id, row.version, key); await ordersApi.lookupFulfillment(key);
    expect(request).toHaveBeenNthCalledWith(1, `/orders/${row.id}/fulfill`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ version: 2 }) });
    expect(request).toHaveBeenNthCalledWith(2, `/operations/ORDER_FULFILL_WEBSITE/${key}`);
  });
  it('rejects a mismatched lookup result and keeps the command available for reconciliation', async () => {
    vi.spyOn(ordersApi, 'fulfill').mockRejectedValue(new ApiError('Mất phản hồi'));
    vi.spyOn(ordersApi, 'lookupFulfillment').mockResolvedValue({ status: 'COMMITTED', responseBody: { ...fulfilled, id: '9'.repeat(24) } });
    const onCompleted = vi.fn(), onLockedChange = vi.fn();
    render(<OrderFulfillment order={row} expired={false} onCompleted={onCompleted} onLockedChange={onLockedChange} onConflict={vi.fn()} />);
    await submit(); await screen.findByText('Mất phản hồi'); await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả bàn giao' }));
    await screen.findByText('Kết quả chưa khớp đơn. Giữ nguyên khóa để đối chiếu.'); expect(onCompleted).not.toHaveBeenCalled(); expect(sessionStorage.length).toBe(1);
  });
});
