import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { membersApi } from '../members/members.api';
import { ordersApi, type OrderDetail } from '../orders/orders.api';
import { cancellationApi, type CancelResult } from '../orders/order-cancellation.api';
import { paymentsApi } from '../payments/payments.api';
import { PosPage } from './PosPage';
import { posApi, type PosCreated, type PosQuote } from './pos.api';

const id = 'a'.repeat(24), productId = 'b'.repeat(24), transactionId = 'c'.repeat(24);
const product = { id: productId, sku: 'WATER', name: 'Nước uống', price: '25000', available: 3, productVersion: 0 };
const quote: PosQuote = { quoteToken: 'signed-quote-kept-only-in-memory', quoteExpiresAt: '2035-11-14T17:10:00Z', total: '25000', pickupLocation: 'Quầy A', buyer: { name: 'Khách lẻ', phone: '' },
  items: [{ productId, sku: product.sku, name: product.name, quantity: 1, unitPrice: '25000', lineTotal: '25000' }] };
const created: PosCreated = { id, code: `ORD-${id}`, channel: 'POS', status: 'CONFIRMED', total: '25000', transactionId, transactionStatus: 'PENDING', version: 0 };
const row: OrderDetail = { ...created, memberId: null, reservationState: 'HELD', transactionStatus: 'PENDING',
  createdAt: '2035-11-14T17:00:00Z', updatedAt: '2035-11-14T17:00:00Z', asOf: '2035-11-14T17:00:00Z', reservationExpiresAt: '2035-11-15T17:00:00Z', expired: false,
  recipient: { name: 'Khách lẻ', phone: '' }, pickupLocation: 'Quầy A', confirmedAt: '2035-11-14T17:00:00Z', confirmedBy: 'staff', fulfilledAt: null, fulfilledBy: null, movementIds: [],
  items: [{ id: productId, productId, skuSnapshot: 'WATER', nameSnapshot: 'Nước uống', quantity: 1, unitPrice: '25000', lineTotal: '25000' }], invoice: null, refunds: [],
  permittedActions: { prepare: false, prepareBlockedReason: 'ORDER_CHANNEL_MISMATCH', fulfill: false, fulfillBlockedReason: 'ORDER_NOT_SETTLED' } };
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(posApi, 'products').mockResolvedValue({ items: [product], total: 1, totalPages: 1, page: 1 });
  vi.spyOn(posApi, 'preview').mockResolvedValue(quote);
  vi.spyOn(posApi, 'create').mockResolvedValue(created);
  vi.spyOn(ordersApi, 'detail').mockResolvedValue(row);
  vi.spyOn(ordersApi, 'fulfill');
  vi.spyOn(paymentsApi, 'detail').mockResolvedValue({ transaction: { id: transactionId, code: 'TX-RETAIL', kind: 'RETAIL', amountDue: '25000', status: 'PENDING', member: null, version: 0, createdAt: row.createdAt }, payments: [], asOf: row.asOf });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });
async function preview() {
  await userEvent.click(await screen.findByRole('button', { name: 'Thêm WATER' }));
  await userEvent.click(screen.getByRole('button', { name: 'Xem báo giá POS' }));
  await screen.findByRole('heading', { name: 'Xác nhận giá trước khi lập đơn' });
}
describe('US-53 TC14 POS counter workflow', () => {
  it('anonymous buyer allows empty contacts; create is separate from payment and handover, CASH amount is server due', async () => {
    render(<PosPage />); await preview();
    expect(posApi.preview).toHaveBeenCalledWith({ preferredPaymentMethod: 'CASH', items: [{ productId, quantity: 1 }] });
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lập POS' }));
    await screen.findByText('Đã lập POS · Chưa bàn giao');
    expect(screen.getByText('Chưa xác nhận thanh toán · 25.000 VND')).toBeDefined();
    expect(screen.getByLabelText(/Số tiền đối chiếu/)).toHaveProperty('value', '25000');
    expect(screen.getByLabelText(/Số tiền đối chiếu/)).toHaveProperty('readOnly', true);
    expect(screen.queryByRole('button', { name: 'Xác nhận đã bàn giao' })).toBeNull();
    expect(ordersApi.fulfill).not.toHaveBeenCalled();
    expect(JSON.stringify(sessionStorage)).not.toContain(quote.quoteToken);
  });
  it('member is explicitly selected and must be reselected after switching buyer type', async () => {
    vi.spyOn(membersApi, 'list').mockResolvedValue({ items: [{ id: 'd'.repeat(24), memberCode: 'HV-SELECTED', fullName: 'Hội viên đã chọn', phone: '+84901234567', accountLinked: true, entitlementSummary: { GYM: [], PT: [] } }], total: 1, page: 1, limit: 20, totalPages: 1, asOf: row.asOf, businessDate: '2035-11-15' });
    render(<PosPage />); await userEvent.click(await screen.findByRole('button', { name: 'Thêm WATER' }));
    await userEvent.selectOptions(screen.getByLabelText('Loại khách'), 'MEMBER');
    expect(screen.getByRole('button', { name: 'Xem báo giá POS' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Tìm hội viên' }));
    await userEvent.click(await screen.findByRole('button', { name: /HV-SELECTED/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Xem báo giá POS' }));
    await waitFor(() => expect(posApi.preview).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'd'.repeat(24) })));
    await userEvent.selectOptions(screen.getByLabelText('Loại khách'), 'ANONYMOUS');
    expect(screen.queryByRole('button', { name: 'Xác nhận lập POS' })).toBeNull();
  });
  it('successful payment refreshes order version and unlocks the independent handover step', async () => {
    vi.spyOn(paymentsApi, 'preview').mockResolvedValue({ canConfirm: true, reviewState: 'READY', blockingCodes: [], amountDue: '25000', asOf: row.asOf });
    const paid = { ...row, transactionStatus: 'SETTLED' as const, version: 1, permittedActions: { ...row.permittedActions, fulfill: true, fulfillBlockedReason: null } };
    vi.spyOn(paymentsApi, 'confirm').mockImplementation(async () => {
      vi.mocked(ordersApi.detail).mockResolvedValue(paid);
      return { kind: 'RETAIL', transactionId, transactionCode: 'TX-RETAIL', status: 'SETTLED', paymentId: 'payment', invoiceId: 'invoice', invoiceNo: 'INV-POS', orderId: id, orderCode: row.code, notificationState: 'NO_LINKED_ACCOUNT' };
    });
    render(<PosPage />); await preview(); await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lập POS' }));
    await userEvent.type(await screen.findByLabelText('Căn cứ kiểm tra thực tế'), 'Đã đếm đủ tiền mặt tại quầy');
    await userEvent.click(screen.getByLabelText('Tôi đã thực đếm số tiền nhận.'));
    await userEvent.click(screen.getByRole('button', { name: 'Kiểm tra đối chiếu' }));
    await userEvent.click(await screen.findByLabelText('Tôi xác nhận đã thực nhận đủ tiền và đã đối chiếu đúng giao dịch.'));
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận thu tiền' }));
    const ack = await screen.findByLabelText(/Tôi đã đối chiếu người nhận/); await userEvent.click(ack);
    expect(screen.getByRole('button', { name: 'Xác nhận đã bàn giao' })).toHaveProperty('disabled', false);
    expect(ordersApi.fulfill).not.toHaveBeenCalled();
  });
  it('zero-total can hand over only with explicit physical acknowledgement and the POS operation', async () => {
    vi.mocked(posApi.preview).mockResolvedValue({ ...quote, total: '0', items: quote.items.map(item => ({ ...item, unitPrice: '0', lineTotal: '0' })) });
    const free: OrderDetail = { ...row, total: '0', transactionStatus: 'SETTLED', invoice: { id: 'e'.repeat(24), invoiceNo: 'INV-ZERO', totalAmount: '0', issuedAt: row.createdAt }, permittedActions: { ...row.permittedActions, fulfill: true, fulfillBlockedReason: null } };
    vi.mocked(ordersApi.detail).mockResolvedValue(free);
    render(<PosPage />); await preview(); await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lập POS' }));
    const button = await screen.findByRole('button', { name: 'Xác nhận đã bàn giao' }); expect(button).toHaveProperty('disabled', true);
    expect(paymentsApi.detail).not.toHaveBeenCalled();
    const result = { id, code: row.code, status: 'COMPLETED' as const, reservationState: 'CONSUMED' as const, version: 1, fulfilledAt: row.asOf, fulfilledBy: 'staff', movementIds: ['movement'], notificationState: 'NO_LINKED_ACCOUNT' };
    vi.mocked(ordersApi.fulfill).mockResolvedValue(result); vi.mocked(ordersApi.detail).mockResolvedValue({ ...free, ...result, permittedActions: { ...free.permittedActions, fulfill: false } });
    await userEvent.click(screen.getByLabelText(/Tôi đã đối chiếu người nhận/)); await userEvent.click(button);
    await screen.findByText('Đã lập POS · Đã bàn giao'); expect(ordersApi.fulfill).toHaveBeenCalledWith(id, 0, expect.any(String), 'POS');
  });
  it('lost create response retains key, disables new intent and recovers after remount without storing quote token', async () => {
    vi.mocked(posApi.create).mockRejectedValue(new ApiError('Mất phản hồi', 503));
    const lookup = vi.spyOn(posApi, 'lookup').mockRejectedValueOnce(new ApiError('Chưa thấy kết quả', 404)).mockResolvedValue({ status: 'COMMITTED', responseBody: created });
    render(<PosPage />); await preview(); await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lập POS' }));
    await screen.findByRole('button', { name: 'Tra cứu kết quả lập POS' });
    const key = vi.mocked(posApi.create).mock.calls[0][1]; expect(JSON.stringify(sessionStorage)).not.toContain(quote.quoteToken);
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả lập POS' })); await screen.findByText('Chưa thấy kết quả');
    expect(screen.queryByRole('button', { name: 'Xác nhận lập POS' })).toBeNull();
    cleanup(); render(<PosPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả lập POS' })); await screen.findByText('Đã lập POS · Chưa bàn giao');
    expect(lookup).toHaveBeenLastCalledWith(key); expect(posApi.create).toHaveBeenCalledOnce();
  });
  it('stale quote retains contacts and selection but requires a new preview; forbidden disables creation', async () => {
    vi.mocked(posApi.create).mockRejectedValue(new ApiError('Giá thay đổi', 409, undefined, undefined, undefined, 'QUOTE_STALE'));
    render(<PosPage />); await userEvent.type(screen.getByLabelText('Tên khách (tùy chọn)'), 'Khách tại quầy'); await preview();
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lập POS' })); await screen.findByText('Giá thay đổi');
    expect(screen.getByLabelText('Tên khách (tùy chọn)')).toHaveProperty('value', 'Khách tại quầy');
    expect(screen.getByLabelText('Số lượng WATER')).toHaveProperty('value', '1'); expect(screen.queryByRole('button', { name: 'Xác nhận lập POS' })).toBeNull();
    vi.mocked(posApi.preview).mockRejectedValue(new ApiError('Không có quyền', 403));
    await userEvent.click(screen.getByRole('button', { name: 'Xem báo giá POS' })); await screen.findByText('Không có quyền');
    expect(screen.getByRole('group', { name: '1. Khách mua và sản phẩm' })).toHaveProperty('disabled', true);
  });
  it('loading/empty and out-of-stock prevent selection', async () => {
    vi.mocked(posApi.products).mockResolvedValue({ items: [{ ...product, available: 0 }], total: 1, totalPages: 1, page: 1 });
    render(<PosPage />); expect(screen.getByText('Đang tải sản phẩm…')).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Thêm WATER' })).toHaveProperty('disabled', true);
    vi.mocked(posApi.products).mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 });
    await userEvent.click(screen.getByRole('button', { name: 'Tìm sản phẩm' })); await screen.findByText('Không có sản phẩm đang bán phù hợp.');
  });
  // Hủy đơn POS mở thành cửa sổ nổi (đồng bộ với trang Đơn hàng): bấm "Hủy đơn" mới thấy form, gửi đúng một lệnh hủy hỗ trợ.
  it('hủy đơn POS: form ẩn tới khi bấm "Hủy đơn", xác nhận gửi một lệnh ORDER_CANCEL_SUPPORT rồi cửa sổ đóng', async () => {
    const result: CancelResult = { id, code: created.code, status: 'CANCELLED', version: 1, reservationState: 'RELEASED', cancelledAt: '2035-11-14T18:00:00Z',
      transactionStatus: 'CANCELLED', refundState: 'NONE', refundAmount: '0', notificationState: 'STORED' };
    const send = vi.spyOn(cancellationApi, 'send').mockResolvedValue(result);
    render(<PosPage />); await preview();
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lập POS' }));
    await screen.findByText('Đã lập POS · Chưa bàn giao');
    expect(screen.queryByLabelText('Lý do hủy')).toBeNull();

    vi.mocked(ordersApi.detail).mockResolvedValue({ ...row, status: 'CANCELLED', version: 1, reservationState: 'RELEASED', transactionStatus: 'CANCELLED' });
    await userEvent.click(screen.getByRole('button', { name: 'Hủy đơn' }));
    await userEvent.type(within(await screen.findByRole('dialog')).getByLabelText('Lý do hủy'), 'Khách đổi ý tại quầy');
    await userEvent.click(screen.getByLabelText('Tôi xác nhận hủy toàn bộ đơn chưa bàn giao'));
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận hủy đơn' }));
    await screen.findByText(/Đã hủy đơn/);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]).toEqual([id, { key: expect.any(String), operation: 'ORDER_CANCEL_SUPPORT', body: { version: 0, reason: 'Khách đổi ý tại quầy' } }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
