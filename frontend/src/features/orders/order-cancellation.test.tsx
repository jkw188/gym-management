import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../api/client';
import { OrderCancellation } from './OrderCancellation';
import { cancellationApi, type CancelResult, type OwnOrder } from './order-cancellation.api';
import { MyOrdersPage } from './MyOrdersPage';
import { RefundsPage } from '../refunds/RefundsPage';
import { refundsApi } from '../refunds/refunds.api';
import { resolveReturnTo } from '../auth/auth.routes';

const target = { id: 'a'.repeat(24), status: 'PENDING', version: 2, total: '50000', transactionStatus: 'SETTLED', reservationState: 'HELD', refunds: [] };
const result: CancelResult = { id: target.id, code: `ORD-${target.id}`, status: 'CANCELLED', version: 3, reservationState: 'RELEASED', cancelledAt: '2035-11-14T17:00:00Z', transactionStatus: 'SETTLED', refundState: 'PENDING', refundAmount: '50000', refundId: 'b'.repeat(24), notificationState: 'STORED' };
beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });
const confirm = async () => {
  await userEvent.type(screen.getByLabelText('Lý do hủy'), '  Khách yêu cầu hủy toàn bộ đơn  ');
  await userEvent.click(screen.getByLabelText('Tôi xác nhận hủy toàn bộ đơn chưa bàn giao'));
  await userEvent.click(screen.getByRole('button', { name: 'Xác nhận hủy đơn' }));
};
describe('US-45 TC16: deliberate cancel, immutable recovery keys and financial wording', () => {
  it('returns to the requested own-order/refund route after login and restricts other roles', () => {
    expect(resolveReturnTo('/member/orders?page=2', 'MEMBER')).toBe('/member/orders?page=2');
    expect(resolveReturnTo('/staff/refunds', 'STAFF')).toBe('/staff/refunds');
    expect(resolveReturnTo('/admin/refunds', 'ADMIN')).toBe('/admin/refunds');
    expect(resolveReturnTo('/staff/refunds', 'MEMBER')).toBe('/member');
  });
  it('requires reason and acknowledgement, prevents double submit and labels pending refund correctly', async () => {
    let finish!: (value: CancelResult) => void;
    const send = vi.spyOn(cancellationApi, 'send').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const changed = vi.fn().mockResolvedValue(undefined), lock = vi.fn();
    render(<OrderCancellation order={target} own onLockedChange={lock} onChanged={changed} />);
    expect(screen.getByRole('button', { name: 'Xác nhận hủy đơn' })).toHaveProperty('disabled', true);
    await confirm();
    expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0]).toEqual([target.id, { key: expect.any(String), operation: 'ORDER_CANCEL_OWN', body: { version: 2, reason: 'Khách yêu cầu hủy toàn bộ đơn' } }]);
    expect(screen.queryByRole('button', { name: 'Xác nhận hủy đơn' })).toBeNull(); finish(result);
    await screen.findByText(/Đã hủy đơn.*Chờ hoàn/); expect(changed).toHaveBeenCalledOnce(); expect(sessionStorage.length).toBe(0);
    expect(screen.queryByText(/Đã hoàn/)).toBeNull(); expect(screen.queryByLabelText('Tham chiếu ngân hàng')).toBeNull();
  });
  it('network loss and lookup404 keep the original payload across remount; replay uses the same key', async () => {
    const send = vi.spyOn(cancellationApi, 'send').mockRejectedValueOnce(new ApiError('Mất phản hồi')).mockResolvedValueOnce(result);
    const lookup = vi.spyOn(cancellationApi, 'lookup').mockRejectedValue(new ApiError('Chưa thấy kết quả', 404, undefined, undefined, undefined, 'OPERATION_UNKNOWN'));
    const changed = vi.fn().mockResolvedValue(undefined);
    render(<OrderCancellation order={target} onLockedChange={vi.fn()} onChanged={changed} />); await confirm(); await screen.findByText('Mất phản hồi');
    const first = send.mock.calls[0][1]; cleanup();
    render(<OrderCancellation order={{ ...target, version: 5 }} onLockedChange={vi.fn()} onChanged={changed} />);
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả hủy / khoản muộn' })); await screen.findByText('Chưa thấy kết quả');
    expect(lookup).toHaveBeenCalledWith(first); expect(sessionStorage.length).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu hủy / khoản muộn' })); await screen.findByText(/Đã hủy đơn/);
    expect(send.mock.calls[1][1]).toEqual(first);
  });
  it.each([401, 403])('revoked auth %s keeps recovery key and prevents retry as a new command', async status => {
    vi.spyOn(cancellationApi, 'send').mockRejectedValue(new ApiError('Phiên hoặc quyền đã thay đổi', status));
    render(<OrderCancellation order={target} onLockedChange={vi.fn()} onChanged={vi.fn()} />); await confirm(); await screen.findByText('Phiên hoặc quyền đã thay đổi');
    expect(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu hủy / khoản muộn' })).toHaveProperty('disabled', true); expect(sessionStorage.length).toBe(1);
  });
  it('completed order has no cancellation; cancelled order exposes a separate late transfer form with VN timestamp', async () => {
    const changed = vi.fn().mockResolvedValue(undefined), lock = vi.fn();
    const { rerender } = render(<OrderCancellation order={{ ...target, status: 'COMPLETED', reservationState: 'CONSUMED' }} onLockedChange={lock} onChanged={changed} />);
    expect(screen.queryByRole('button', { name: 'Xác nhận hủy đơn' })).toBeNull();
    rerender(<OrderCancellation order={{ ...target, status: 'CANCELLED', transactionStatus: 'CANCELLED', reservationState: 'RELEASED' }} onLockedChange={lock} onChanged={changed} />);
    const send = vi.spyOn(cancellationApi, 'send').mockRejectedValue(new ApiError('Cần đối soát khoản thu', 409, undefined, undefined, undefined, 'PAYMENT_REFERENCE_USED'));
    fireEvent.change(screen.getByLabelText('Mã tài khoản nhận'), { target: { value: 'GYM_MAIN' } });
    fireEvent.change(screen.getByLabelText('Tham chiếu ngân hàng'), { target: { value: 'BANK-REAL-REFERENCE' } });
    fireEvent.change(screen.getByLabelText('Thời điểm báo có (Việt Nam)'), { target: { value: '2035-11-15T00:00' } });
    fireEvent.change(screen.getByLabelText('Căn cứ đối soát'), { target: { value: 'Đối soát chứng từ nhận tiền thật' } });
    await userEvent.click(screen.getByLabelText('Tôi đã đối chiếu chứng từ khoản chuyển thực tế'));
    await userEvent.click(screen.getByRole('button', { name: 'Ghi khoản muộn và nghĩa vụ chờ hoàn' })); await screen.findByText('Cần đối soát khoản thu');
    expect(send.mock.calls[0][1]).toMatchObject({ operation: 'RETAIL_LATE_RECEIPT', body: { method: 'TRANSFER', amount: '50000', receivedAt: '2035-11-14T17:00:00.000Z' } });
    expect(screen.getByText(/không chứng minh chưa nhận tiền/)).toBeDefined();
  });
  it('member sees own expired held state and pending amount, with no bank reference', async () => {
    const row: OwnOrder = { ...target, status: 'CANCELLED', transactionStatus: 'CANCELLED', reservationState: 'RELEASED', code: result.code, channel: 'POS', reservationExpiresAt: result.cancelledAt,
      asOf: result.cancelledAt, expired: true, cancellationReason: 'Hết hạn giữ hàng', cancelledAt: result.cancelledAt, items: [], refunds: [{ id: result.refundId!, status: 'PENDING', amount: '50000' }] };
    vi.spyOn(cancellationApi, 'ownList').mockResolvedValue({ items: [row], total: 1, totalPages: 1, memberLinked: true });
    vi.spyOn(cancellationApi, 'ownDetail').mockResolvedValueOnce({ ...row, status: 'PENDING', transactionStatus: 'PENDING', reservationState: 'HELD', cancelledAt: null, cancellationReason: null, refunds: [] }).mockResolvedValue(row);
    render(<MyOrdersPage />); await userEvent.click(await screen.findByRole('button', { name: `Xem ${row.code}` }));
    await screen.findByText(/Đã hết hạn.*Chưa xác nhận kho đã được giải phóng/);
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại đơn' }));
    await screen.findByText(/Khoản hoàn:.*Chờ hoàn/); expect(screen.queryByLabelText('Tham chiếu ngân hàng')).toBeNull();
    expect(screen.queryByText(/Chưa xác nhận kho đã được giải phóng/)).toBeNull();
  });
  it('refund queue supports empty/loading/error, read-only detail and no payout mutation', async () => {
    const item = { id: result.refundId!, orderId: target.id, paymentId: 'c'.repeat(24), returnId: null, source: 'CANCELLATION', reference: `RF:${result.refundId}`, amount: '50000', status: 'PENDING', createdAt: result.cancelledAt, refundedAt: null };
    const list = vi.spyOn(refundsApi, 'list').mockResolvedValueOnce({ items: [], total: 0, totalPages: 0 }).mockResolvedValueOnce({ items: [item], total: 1, totalPages: 1 });
    vi.spyOn(refundsApi, 'detail').mockResolvedValue({ ...item, createdBy: null, actorType: 'SYSTEM', orderCode: result.code, cancellationReason: 'Hết hạn giữ hàng', cancelledAt: result.cancelledAt, payment: null });
    render(<RefundsPage />); await screen.findByText('Không có nghĩa vụ phù hợp.');
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
    await userEvent.click(await screen.findByRole('button', { name: `Xem ${item.reference}` })); await screen.findByRole('heading', { name: item.reference });
    expect(screen.queryByRole('button', { name: /đánh dấu|xác nhận hoàn|thực chi/i })).toBeNull(); expect(list).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByText(/Chờ hoàn là nghĩa vụ/)).toBeDefined());
  });
});
