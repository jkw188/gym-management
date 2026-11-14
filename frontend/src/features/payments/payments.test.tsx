import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import type { AuthSnapshot } from '../auth/auth.types';
import { paymentsApi, type TransactionDetail, type TransactionItem } from './payments.api';
import { PaymentReviewForm } from './PaymentReviewForm';
import { TransactionsPage } from './TransactionsPage';
import App from '../../App';

vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })) }));

const item: TransactionItem = { id: 'a'.repeat(24), code: 'TX-001', kind: 'GYM', amountDue: '300000', status: 'PENDING',
  createdAt: '2026-11-14T03:00:00Z', version: 0, memberId: 'b'.repeat(24),
  member: { id: 'b'.repeat(24), memberCode: 'HV-001', fullName: 'Nguyễn An', phone: '+84912345678' } };
const detail: TransactionDetail = { transaction: item, payments: [], asOf: item.createdAt,
  sale: { id: 'c'.repeat(24), planId: 'd'.repeat(24), planName: 'Gym 30 ngày', benefits: 'Tập Gym', listPrice: '300000',
    creditAmount: '0', sessions: 0, startDate: '2026-11-14', endDate: '2026-12-13', policySnapshot: 'Điều khoản gốc' } };
const ready = { canConfirm: true, reviewState: 'READY' as const, blockingCodes: [], amountDue: '300000', asOf: item.createdAt };
let snapshot: AuthSnapshot;
let notify: () => void;
beforeEach(() => {
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
  snapshot = { status: 'authenticated', user: { id: '1'.repeat(24), roleCode: 'STAFF', fullName: 'Staff', phone: '+84912345678' } };
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(listener => { notify = listener; return () => {}; });
  vi.spyOn(paymentsApi, 'list').mockResolvedValue({ items: [item], page: 1, limit: 20, total: 21, totalPages: 2 });
  vi.spyOn(paymentsApi, 'detail').mockResolvedValue(detail);
  vi.spyOn(paymentsApi, 'preview').mockResolvedValue(ready);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function fillCash() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Số tiền đối chiếu (VND)'), '300000');
  await user.type(screen.getByLabelText('Căn cứ kiểm tra thực tế'), 'Đã đếm đủ tiền mặt thực nhận');
  await user.click(screen.getByRole('checkbox'));
  return user;
}

describe('US21 staff lookup and manual review', () => {
  it('TC02/14: filters pending by default, paginates real API and opens detail snapshots', async () => {
    const user = userEvent.setup(); render(<TransactionsPage />);
    await screen.findByRole('button', { name: 'Chi tiết TX-001' });
    expect(paymentsApi.list).toHaveBeenCalledWith(expect.objectContaining({ status: 'PENDING', page: 1 }));
    await user.click(screen.getByRole('button', { name: 'Trang sau' }));
    await waitFor(() => expect(paymentsApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
    await user.type(screen.getByLabelText('Mã giao dịch'), 'TX-00');
    await user.selectOptions(screen.getByLabelText('Loại dịch vụ'), 'PT');
    await user.selectOptions(screen.getByLabelText('Trạng thái'), 'SETTLED');
    fireEvent.change(screen.getByLabelText('Tạo đến ngày'), { target: { value: '2026-11-30' } });
    await user.click(screen.getByRole('button', { name: 'Tìm' }));
    await waitFor(() => expect(paymentsApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'TX-00', kind: 'PT', status: 'SETTLED', createdTo: '2026-11-30', page: 1 })));
    await user.click(await screen.findByRole('button', { name: 'Chi tiết TX-001' }));
    const section = await screen.findByRole('region', { name: 'Chi tiết giao dịch' });
    expect(await within(section).findByText(/Gói: Gym 30 ngày/)).toBeTruthy();
    expect(within(section).getByText(/Điều khoản gốc/)).toBeTruthy();
  });

  it('TC04/06/14: screenshot-only is not sufficient; no auto confirmation after READY; edit invalidates result', async () => {
    const requests = vi.spyOn(apiClient, 'request');
    render(<PaymentReviewForm transaction={item} />);
    expect(screen.getByText(/Chưa đủ căn cứ/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Kiểm tra đối chiếu' }) as HTMLButtonElement).disabled).toBe(true);
    const user = await fillCash();
    await user.click(screen.getByRole('button', { name: 'Kiểm tra đối chiếu' }));
    expect(await screen.findByText(/Đủ điều kiện tại thời điểm/)).toBeTruthy();
    expect(paymentsApi.preview).toHaveBeenCalledWith(item.id, { method: 'CASH', amount: '300000', evidenceNote: 'Đã đếm đủ tiền mặt thực nhận' });
    expect(requests).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: /Xác nhận thu/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(screen.getByLabelText('Số tiền đối chiếu (VND)'));
    await user.type(screen.getByLabelText('Số tiền đối chiếu (VND)'), '299999');
    expect(screen.queryByText(/Đủ điều kiện tại thời điểm/)).toBeNull();
    expect(screen.getByText('300.000 đ')).toBeTruthy();
  });

  it('TC05/08/14: sends the actual transfer timestamp/reference and renders blocking reasons', async () => {
    vi.mocked(paymentsApi.preview).mockResolvedValue({ ...ready, canConfirm: false, reviewState: 'BLOCKED', blockingCodes: ['PAYMENT_REFERENCE_USED'] });
    render(<PaymentReviewForm transaction={item} />);
    const user = await fillCash();
    await user.selectOptions(screen.getByLabelText('Phương thức'), 'TRANSFER');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    await user.type(screen.getByLabelText('Mã tài khoản nhận đã cấu hình'), 'GYM_MAIN');
    await user.type(screen.getByLabelText('Tham chiếu ngân hàng thực tế'), ' AbC-01 ');
    await user.type(screen.getByLabelText('Thời điểm báo có (ISO8601 kèm múi giờ)'), '2026-11-14T10:00:00+07:00');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Kiểm tra đối chiếu' }));
    expect(await screen.findByText(/Tham chiếu đã được sử dụng/)).toBeTruthy();
    expect(paymentsApi.preview).toHaveBeenCalledWith(item.id, expect.objectContaining({ method: 'TRANSFER', receivingAccountCode: 'GYM_MAIN',
      bankReference: 'AbC-01', receivedAt: '2026-11-14T10:00:00+07:00' }));
  });

  it('TC13/14: list network error offers Retry, not empty success; free/settled transaction has no collection form', async () => {
    vi.mocked(paymentsApi.list).mockRejectedValueOnce(new ApiError('Mất kết nối'));
    vi.mocked(paymentsApi.detail).mockResolvedValue({ ...detail, transaction: { ...item, amountDue: '0', status: 'SETTLED' } });
    render(<TransactionsPage />); const user = userEvent.setup();
    await screen.findByRole('alert'); expect(screen.queryByText('Không có giao dịch phù hợp.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Thử lại' }));
    await user.click(await screen.findByRole('button', { name: 'Chi tiết TX-001' }));
    await screen.findByText(/Gói 0 đồng không cần thanh toán/);
    expect(screen.queryByRole('form', { name: 'Đối chiếu khoản thu' })).toBeNull();
  });

  it('TC14: preserves input after preview error and disables the form while pending', async () => {
    vi.mocked(paymentsApi.preview).mockRejectedValueOnce(new ApiError('Máy chủ chưa sẵn sàng', 503));
    render(<PaymentReviewForm transaction={item} />); const user = await fillCash();
    await user.click(screen.getByRole('button', { name: 'Kiểm tra đối chiếu' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Số tiền đối chiếu (VND)') as HTMLInputElement).value).toBe('300000');
    expect((screen.getByLabelText('Căn cứ kiểm tra thực tế') as HTMLTextAreaElement).value).toContain('Đã đếm đủ');
    let finish!: (value: typeof ready) => void;
    vi.mocked(paymentsApi.preview).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await user.click(screen.getByRole('button', { name: 'Kiểm tra đối chiếu' }));
    expect(screen.getByLabelText('Số tiền đối chiếu (VND)').matches(':disabled')).toBe(true);
    await act(async () => finish(ready)); await screen.findByText(/Đủ điều kiện tại thời điểm/);
  });

  it('clears sensitive data on logout/account change and ignores late responses', async () => {
    let resolve!: (value: TransactionDetail) => void;
    vi.mocked(paymentsApi.detail).mockImplementation(() => new Promise(done => { resolve = done; }));
    render(<TransactionsPage />); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Chi tiết TX-001' }));
    act(() => { snapshot = { status: 'anonymous', user: null }; notify(); });
    await act(async () => resolve(detail));
    expect(screen.queryByText(/Nguyễn An/)).toBeNull();
    expect(screen.queryByText(/Điều khoản gốc/)).toBeNull();
  });

  it.each(['MEMBER', 'TRAINER'] as const)('route rejects %s before requesting internal transactions', async role => {
    snapshot = { status: 'authenticated', user: { id: '1'.repeat(24), roleCode: role, fullName: 'User', phone: '+84912345678' } };
    window.history.replaceState({}, '', '/staff/transactions');
    render(<App />);
    expect(await screen.findByText('Không có quyền truy cập')).toBeTruthy();
    expect(paymentsApi.list).not.toHaveBeenCalled();
  });
});
