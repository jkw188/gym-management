import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiClient, ApiError } from '../../api/client';
import { ReturnsPage } from './ReturnsPage';
import { returnsApi } from './returns.api';
import { RefundPayout } from '../refunds/RefundPayout';
import type { RefundDetail } from '../refunds/refunds.api';
import { resolveReturnTo } from '../auth/auth.routes';

const id = 'a'.repeat(24), itemId = 'b'.repeat(24), refundId = 'c'.repeat(24);
const eligibility = { id, code: `ORD-${id}`, channel: 'POS', status: 'COMPLETED', version: 3, fulfilledAt: '2026-11-16T10:00:00Z', returnDeadline: '2026-11-22T17:00:00Z', eligible: true,
  items: [{ id: itemId, name: 'Sản phẩm gốc', sku: 'SKU1', quantity: 2, remaining: 1, unitPrice: '25000' }] };
const refund: RefundDetail = { id: refundId, orderId: id, paymentId: itemId, returnId: id, source: 'RETURN', reference: `RF:${refundId}`, amount: '25000', status: 'PENDING', version: 0,
  createdAt: '2026-11-16T10:00:00Z', refundedAt: null, createdBy: id, actorType: 'USER', orderCode: eligibility.code, cancellationReason: null, cancelledAt: null, payment: null };
beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });
async function fillReturn() {
  fireEvent.change(screen.getByLabelText('ID đơn gốc'), { target: { value: id } }); await userEvent.click(screen.getByRole('button', { name: 'Tìm đơn gốc' }));
  await screen.findByText(/Còn trả: 1\/2/);
  fireEvent.change(screen.getByLabelText('Số nhận SKU1'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Tình trạng SKU1'), { target: { value: 'Hộp bị hỏng, không bán lại được' } });
  fireEvent.change(screen.getByLabelText('Lý do nhận trả'), { target: { value: 'Khách yêu cầu trả sau khi kiểm hàng' } });
  await userEvent.click(screen.getByLabelText('Đã thực nhận và kiểm tra tình trạng từng sản phẩm'));
  await userEvent.click(screen.getByRole('button', { name: 'Xác nhận nhận hàng' }));
}
async function fillPayout() {
  fireEvent.change(screen.getByLabelText('Bằng chứng đối soát'), { target: { value: 'Đã kiểm tra phiếu chi thực tế' } });
  fireEvent.change(screen.getByLabelText('Thời điểm thực chi (giờ Việt Nam)'), { target: { value: '2026-11-17T09:00' } });
  fireEvent.change(screen.getByLabelText('Số phiếu chi'), { target: { value: 'PC-0001' } });
  await userEvent.click(screen.getByLabelText('Đã xác minh tiền được trả thật, chứng từ chưa dùng khoản khác'));
  await userEvent.click(screen.getByRole('button', { name: 'Xác nhận đã hoàn tiền' }));
}
describe('US46 UI', () => {
  it('routes only Staff/Admin to returns', () => {
    expect(resolveReturnTo('/staff/returns', 'STAFF')).toBe('/staff/returns');
    expect(resolveReturnTo('/admin/returns', 'ADMIN')).toBe('/admin/returns');
    expect(resolveReturnTo('/staff/returns', 'MEMBER')).toBe('/member');
  });
  it('receives actual condition with snapshot version, keeps goods and money wording separate', async () => {
    vi.spyOn(returnsApi, 'list').mockResolvedValue({ items: [], total: 0, totalPages: 0 }); vi.spyOn(returnsApi, 'eligibility').mockResolvedValue(eligibility);
    const send = vi.spyOn(apiClient, 'request').mockResolvedValue({ returnId: id, refundId, amount: '25000', refundState: 'PENDING', movementIds: [], orderVersion: 4 });
    render(<ReturnsPage />); await screen.findByText('Chưa có phiếu trả phù hợp.'); await fillReturn();
    await screen.findByText('Đã nhận hàng trả. Khoản hoàn được đối soát và xác minh thực chi riêng.');
    expect(send).toHaveBeenCalledOnce(); const input = send.mock.calls[0][1]!;
    expect(JSON.parse(input.body as string)).toMatchObject({ version: 3, items: [{ orderItemId: itemId, quantity: 1, restockable: false, conditionNote: 'Hộp bị hỏng, không bán lại được' }] });
    expect(sessionStorage.length).toBe(0);
  });
  it('lost response/remount/lookup404 retains original version, target and key', async () => {
    const request = vi.spyOn(apiClient, 'request').mockRejectedValueOnce(new ApiError('Mất phản hồi')).mockRejectedValueOnce(new ApiError('Chưa thấy kết quả', 404)).mockResolvedValueOnce({ id: refundId });
    const changed = vi.fn().mockResolvedValue(undefined);
    render(<RefundPayout refund={refund} onChanged={changed} />); await fillPayout(); await screen.findByText('Mất phản hồi');
    const first = request.mock.calls[0]; expect(JSON.parse(first[1]!.body as string)).toMatchObject({ version: 0, paidOutAt: '2026-11-17T02:00:00.000Z', amount: '25000', cashVoucherReference: 'PC-0001' });
    cleanup(); render(<RefundPayout refund={{ ...refund, version: 8 }} onChanged={changed} />);
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' })); await screen.findByText('Chưa thấy kết quả'); expect(sessionStorage.length).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu' })); await screen.findByText('Đã xác minh thực chi hoàn tiền.');
    expect(request.mock.calls[2]).toEqual(first); expect(changed).toHaveBeenCalledOnce();
  });
  it.each([401, 403])('auth %s prevents replay and preserves unresolved key', async status => {
    vi.spyOn(apiClient, 'request').mockRejectedValue(new ApiError('Phiên hoặc quyền đã đổi', status));
    render(<RefundPayout refund={refund} onChanged={vi.fn()} />); await fillPayout(); await screen.findByText('Phiên hoặc quyền đã đổi');
    expect(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu' })).toHaveProperty('disabled', true); expect(sessionStorage.length).toBe(1);
  });
  it('clears previous actor evidence when account changes', async () => {
    let actor = 'old'; const listeners = new Set<() => void>();
    let auth = { ...apiClient.getSnapshot(), user: { id: actor } as NonNullable<ReturnType<typeof apiClient.getSnapshot>['user']> };
    vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => auth);
    vi.spyOn(apiClient, 'subscribe').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; });
    vi.spyOn(returnsApi, 'list').mockResolvedValue({ items: [], total: 0, totalPages: 0 }); vi.spyOn(returnsApi, 'eligibility').mockResolvedValue(eligibility);
    render(<ReturnsPage />); await screen.findByText('Chưa có phiếu trả phù hợp.');
    fireEvent.change(screen.getByLabelText('ID đơn gốc'), { target: { value: id } }); await userEvent.click(screen.getByRole('button', { name: 'Tìm đơn gốc' })); await screen.findByText(/Còn trả: 1\/2/);
    fireEvent.change(screen.getByLabelText('Tình trạng SKU1'), { target: { value: 'Nội dung chỉ nhân viên cũ thấy' } });
    act(() => { actor = 'new'; auth = { ...auth, user: { ...auth.user, id: actor } }; listeners.forEach(listener => listener()); });
    await waitFor(() => expect(screen.queryByDisplayValue('Nội dung chỉ nhân viên cũ thấy')).toBeNull());
  });
});
