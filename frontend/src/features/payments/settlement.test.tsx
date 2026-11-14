import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import { PaymentReviewForm } from './PaymentReviewForm';
import { paymentsApi, type SettlementResult, type TransactionItem } from './payments.api';
import type { AuthSnapshot } from '../auth/auth.types';

const transaction: TransactionItem = { id: 'a'.repeat(24), code: 'TX-001', amountDue: '300000', kind: 'GYM', status: 'PENDING',
  member: null, version: 0, createdAt: '2026-11-14T03:00:00Z' };
const settled: SettlementResult = { transactionId: transaction.id, transactionCode: transaction.code, status: 'SETTLED',
  paymentId: 'b'.repeat(24), invoiceId: 'c'.repeat(24), invoiceNo: `INV-${'c'.repeat(24)}`, saleId: 'd'.repeat(24), membershipId: 'e'.repeat(24),
  startDate: '2026-11-14', endDate: '2026-12-13', notificationState: 'STORED' };
const snapshot: AuthSnapshot = { status: 'authenticated', user: { id: '1'.repeat(24), roleCode: 'STAFF', fullName: 'Staff', phone: '+84912345678' } };
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(apiClient, 'getSnapshot').mockReturnValue(snapshot);
  vi.spyOn(paymentsApi, 'preview').mockResolvedValue({ canConfirm: true, reviewState: 'READY', blockingCodes: [], amountDue: '300000', asOf: transaction.createdAt });
  vi.spyOn(paymentsApi, 'confirm').mockResolvedValue(settled);
  vi.spyOn(paymentsApi, 'operation').mockResolvedValue({ status: 'COMMITTED', responseStatus: 200, responseBody: settled });
  vi.spyOn(paymentsApi, 'detail').mockResolvedValue({ transaction, payments: [], asOf: transaction.createdAt });
  vi.spyOn(paymentsApi, 'invoice').mockResolvedValue({ id: settled.invoiceId, invoiceNo: settled.invoiceNo, totalAmount: '300000',
    buyerSnapshot: '{"fullName":"Tên lúc thu"}', issuedAt: transaction.createdAt, transactionId: transaction.id, transactionCode: transaction.code,
    serviceLine: { saleId: settled.saleId, planId: 'f'.repeat(24), kind: 'GYM', planName: 'Gói gốc', benefits: 'Điều khoản gốc', policySnapshot: 'REGISTER_V1',
      listPrice: '300000', creditAmount: '0', sessions: 0, startDate: settled.startDate, endDate: settled.endDate } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });
async function ready() {
  const user = userEvent.setup(); render(<PaymentReviewForm transaction={transaction} />);
  await user.type(screen.getByLabelText('Số tiền đối chiếu (VND)'), '300000');
  await user.type(screen.getByLabelText('Căn cứ kiểm tra thực tế'), 'Đã đếm đủ tiền mặt thực nhận');
  await user.click(screen.getByLabelText('Tôi đã thực đếm số tiền nhận.'));
  await user.click(screen.getByRole('button', { name: 'Kiểm tra đối chiếu' }));
  await screen.findByRole('button', { name: 'Xác nhận thu tiền' });
  return user;
}
async function accept(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('Tôi xác nhận đã thực nhận đủ tiền và đã đối chiếu đúng giao dịch.'));
  await user.click(screen.getByRole('button', { name: 'Xác nhận thu tiền' }));
}
describe('US22 explicit confirmation and safe recovery', () => {
  it('TC17: READY needs a separate acknowledgement; blocks double submit and displays committed result/invoice', async () => {
    let finish!: (result: SettlementResult) => void;
    vi.mocked(paymentsApi.confirm).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const user = await ready();
    expect(paymentsApi.confirm).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Xác nhận thu tiền' }) as HTMLButtonElement).disabled).toBe(true);
    await accept(user);
    fireEvent.click(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu' }));
    expect(paymentsApi.confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Số tiền đối chiếu (VND)').matches(':disabled')).toBe(true);
    expect(sessionStorage.length).toBe(1);
    await act(async () => finish(settled));
    expect(await screen.findByText('Đã xác nhận khoản thu')).toBeTruthy();
    expect(screen.getByText(/Kỳ gói thực tế: 2026-11-14 – 2026-12-13/)).toBeTruthy();
    expect(screen.getByText('Thông báo đã được lưu.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Xem chứng từ' }));
    expect(await screen.findByText(/Tên lúc thu/)).toBeTruthy(); expect(screen.getByText(/Điều khoản gốc/)).toBeTruthy();
    expect(sessionStorage.length).toBe(0);
  });

  it('TC09/16/17: network failure retains immutable input/key across remount; unknown lookup never creates a new intent', async () => {
    vi.mocked(paymentsApi.confirm).mockRejectedValueOnce(new ApiError('Mất kết nối'));
    vi.mocked(paymentsApi.operation).mockRejectedValueOnce(new ApiError('Chưa thấy', 404, undefined, undefined, undefined, 'OPERATION_UNKNOWN'));
    const user = await ready(); await accept(user); await screen.findByRole('alert');
    const first = vi.mocked(paymentsApi.confirm).mock.calls[0];
    expect(screen.getByText(/Chưa xác định kết quả hệ thống/)).toBeTruthy();
    cleanup(); render(<PaymentReviewForm transaction={transaction} />);
    await user.click(await screen.findByRole('button', { name: 'Tra cứu kết quả xác nhận' }));
    await screen.findByText(/Chưa thấy kết quả theo khóa/);
    expect(paymentsApi.confirm).toHaveBeenCalledTimes(1);
    expect(paymentsApi.operation).toHaveBeenCalledWith(first[2]);
    expect(screen.getByLabelText('Số tiền đối chiếu (VND)').matches(':disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu' }));
    await screen.findByText('Đã xác nhận khoản thu');
    expect(vi.mocked(paymentsApi.confirm).mock.calls[1]).toEqual(first);
  });

  it('TC16: unknown commit can be recovered by GET operation without resubmitting a payment', async () => {
    vi.mocked(paymentsApi.confirm).mockRejectedValueOnce(new ApiError('Chưa xác định', 503, undefined, undefined, undefined, 'OPERATION_OUTCOME_UNKNOWN'));
    const user = await ready(); await accept(user); await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Tra cứu kết quả xác nhận' }));
    await screen.findByText('Đã xác nhận khoản thu');
    expect(paymentsApi.confirm).toHaveBeenCalledTimes(1); expect(sessionStorage.length).toBe(0);
  });

  it('TC04/17: reference conflict leaves input intact, requires another preview and never changes the reference automatically', async () => {
    vi.mocked(paymentsApi.confirm).mockRejectedValueOnce(new ApiError('Trùng mã', 409, undefined, undefined, undefined, 'PAYMENT_REFERENCE_USED'));
    const user = await ready();
    await user.selectOptions(screen.getByLabelText('Phương thức'), 'TRANSFER');
    await user.type(screen.getByLabelText('Mã tài khoản nhận đã cấu hình'), 'GYM_MAIN');
    await user.type(screen.getByLabelText('Tham chiếu ngân hàng thực tế'), 'AbC-01');
    await user.type(screen.getByLabelText('Thời điểm báo có (ISO8601 kèm múi giờ)'), '2026-11-14T10:00:00+07:00');
    await user.click(screen.getByLabelText(/Tôi đã kiểm tra báo có thực tế/));
    await user.click(screen.getByRole('button', { name: 'Kiểm tra đối chiếu' }));
    await screen.findByRole('button', { name: 'Xác nhận thu tiền' }); await accept(user);
    expect(await screen.findByText(/không tự đổi mã để vượt xung đột/)).toBeTruthy();
    expect((screen.getByLabelText('Tham chiếu ngân hàng thực tế') as HTMLInputElement).value).toBe('AbC-01');
    expect(screen.queryByRole('button', { name: 'Xác nhận thu tiền' })).toBeNull(); expect(sessionStorage.length).toBe(0);
  });

  it('TC17: reading invoice failure after settlement does not invalidate successful payment or notification state', async () => {
    vi.mocked(paymentsApi.invoice).mockRejectedValueOnce(new ApiError('Lỗi tải chứng từ', 503));
    const user = await ready(); await accept(user); await screen.findByText('Đã xác nhận khoản thu');
    await user.click(screen.getByRole('button', { name: 'Xem chứng từ' })); await screen.findByRole('alert');
    expect(screen.getByText('Đã xác nhận khoản thu')).toBeTruthy(); expect(screen.getByText('Thông báo đã được lưu.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tải lại chứng từ' })); await screen.findByText(/Tên lúc thu/);
    expect(paymentsApi.confirm).toHaveBeenCalledTimes(1);
  });

  it('JSON content type and retained idempotency key reach the transport for preview/confirm', async () => {
    vi.mocked(paymentsApi.preview).mockRestore(); vi.mocked(paymentsApi.confirm).mockRestore();
    const transport = vi.spyOn(apiClient, 'request').mockResolvedValue(settled);
    const input = { method: 'CASH' as const, amount: '300000', evidenceNote: 'Đã đếm tiền mặt thực nhận' }, key = crypto.randomUUID();
    await paymentsApi.preview(transaction.id, input); await paymentsApi.confirm(transaction.id, input, key);
    expect(transport.mock.calls[0][1]?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(transport.mock.calls[1][1]?.headers).toEqual({ 'Content-Type': 'application/json', 'Idempotency-Key': key });
  });
});
