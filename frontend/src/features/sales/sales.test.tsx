import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { ServiceSalePanel } from './ServiceSalePanel';
import { salesApi, type SaleDetail, type SalePlan } from './sales.api';

const memberId = '123456789012345678901234';
const plan: SalePlan = { id: '223456789012345678901234', name: 'Gym 30', kind: 'GYM', planVersion: 2,
  durationDays: 30, price: '300000', sessions: 0, benefits: 'Quyền lợi từ danh mục' };
const result: SaleDetail = { saleId: '323456789012345678901234', transactionId: '423456789012345678901234',
  transactionCode: 'TX-test', transactionStatus: 'PENDING', transactionVersion: 0, amountDue: '300000', planName: plan.name,
  sessions: 0, benefits: plan.benefits, requestedStartDate: '2026-11-11', startDate: '2026-11-11', endDate: '2026-12-10', notificationState: 'NOT_CREATED' };
const preview = { planVersion: 2, amountDue: '300000', kind: 'GYM' as const, requestedStartDate: '2026-11-11', expectedEndDate: '2026-12-10', canProceed: true };

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(salesApi, 'catalog').mockResolvedValue({ items: [plan] });
  vi.spyOn(salesApi, 'pending').mockResolvedValue({ items: [], page: 1, total: 0 });
  vi.spyOn(salesApi, 'preview').mockResolvedValue(preview);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });

async function open() {
  const user = userEvent.setup();
  render(<ServiceSalePanel memberId={memberId} />);
  await user.click(screen.getByRole('button', { name: 'Đăng ký gói' }));
  await screen.findByRole('option', { name: 'Gym 30 (GYM)' });
  await user.selectOptions(screen.getByLabelText('Gói đang bán'), plan.id);
  fireEvent.change(screen.getByLabelText('Ngày bắt đầu yêu cầu (Việt Nam)'), { target: { value: '2026-11-11' } });
  await user.click(screen.getByRole('button', { name: 'Xem trước đăng ký' }));
  await screen.findByRole('button', { name: 'Xác nhận tạo đăng ký' });
  return user;
}

describe('US14 TC16: confirmation, pending/free states and safe retries', () => {
  it('loads only on request, previews server terms and never calls activation/payment for a pending sale', async () => {
    const create = vi.spyOn(salesApi, 'create').mockResolvedValue(result);
    const user = await open();
    expect(salesApi.preview).toHaveBeenCalledWith({ memberId, planId: plan.id, planVersion: 2, startDate: '2026-11-11' });
    await user.click(screen.getByRole('button', { name: 'Xác nhận tạo đăng ký' }));
    expect(await screen.findByText('Chờ thu tiền — chưa cấp gói.')).toBeTruthy();
    expect(screen.queryByText(/Đã hoàn tất/)).toBeNull();
    expect(create.mock.calls[0][0]).toEqual({ memberId, planId: plan.id, planVersion: 2, startDate: '2026-11-11' });
    expect(Object.keys(create.mock.calls[0][0])).not.toContain('price');
  });

  it('blocks repeated clicks while create is in flight', async () => {
    let finish!: (value: SaleDetail) => void;
    const create = vi.spyOn(salesApi, 'create').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await open();
    const button = screen.getByRole('button', { name: 'Xác nhận tạo đăng ký' });
    fireEvent.click(button); fireEvent.click(button);
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => finish(result));
    expect(await screen.findByText(result.transactionCode)).toBeTruthy();
  });

  it('retains the same immutable input/key on network failure, including unmount/remount', async () => {
    const create = vi.spyOn(salesApi, 'create').mockRejectedValueOnce(new ApiError('Mất kết nối')).mockResolvedValue(result);
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Xác nhận tạo đăng ký' }));
    await screen.findByRole('button', { name: 'Kiểm tra / gửi lại cùng yêu cầu' });
    expect(screen.getByLabelText('Gói đang bán').matches(':disabled')).toBe(true);
    cleanup(); render(<ServiceSalePanel memberId={memberId} />);
    await user.click(screen.getByRole('button', { name: 'Đăng ký gói' }));
    const retry = await screen.findByRole('button', { name: 'Kiểm tra / gửi lại cùng yêu cầu' });
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    await user.click(retry);
    await screen.findByText(result.transactionCode);
    expect(create).toHaveBeenCalledTimes(2); expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
    expect(sessionStorage.length).toBe(0);
  });

  it('shows free basis and actual dates/documents without a zero-payment form', async () => {
    vi.mocked(salesApi.catalog).mockResolvedValue({ items: [{ ...plan, price: '0' }] });
    vi.mocked(salesApi.preview).mockResolvedValue({ ...preview, amountDue: '0' });
    vi.spyOn(salesApi, 'create').mockResolvedValue({ ...result, amountDue: '0', transactionStatus: 'SETTLED',
      startDate: '2026-11-12', endDate: '2026-12-11', membershipId: 'membership', invoiceId: 'invoice', invoiceNumber: 'INV-test', notificationState: 'NO_LINKED_ACCOUNT' });
    const user = await open();
    expect(screen.getByText(/Miễn phí theo giá 0/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Xác nhận tạo đăng ký' }));
    expect(await screen.findByText(/Kỳ thực tế: 2026-11-12 → 2026-12-11/)).toBeTruthy();
    expect(screen.getByText('Chứng từ: INV-test')).toBeTruthy();
    expect(screen.getByText('Thông báo đã lưu; hội viên chưa có tài khoản nhận.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Hủy đăng ký chờ' })).toBeNull();
    expect(screen.queryByLabelText(/Số tiền thu/)).toBeNull();
  });

  it('invalidates preview when terms change and requires an explicit reload/review on PLAN_CHANGED', async () => {
    vi.spyOn(salesApi, 'create').mockRejectedValue(new ApiError('Gói đã đổi', 409, 'req', undefined, undefined, 'PLAN_CHANGED'));
    const user = await open();
    fireEvent.change(screen.getByLabelText('Ngày bắt đầu yêu cầu (Việt Nam)'), { target: { value: '2026-11-12' } });
    expect(screen.queryByRole('button', { name: 'Xác nhận tạo đăng ký' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Xem trước đăng ký' }));
    await user.click(await screen.findByRole('button', { name: 'Xác nhận tạo đăng ký' }));
    expect(await screen.findByText(/Điều khoản đã đổi/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Xác nhận tạo đăng ký' })).toBeNull();
  });

  it('opens a pending registration, validates cancellation reason, sends transaction version and retries the same cancel key', async () => {
    vi.mocked(salesApi.pending).mockResolvedValue({ items: [{ saleId: result.saleId, transactionCode: result.transactionCode, kind: 'GYM' }], page: 1, total: 1 });
    vi.spyOn(salesApi, 'detail').mockResolvedValue({ ...result, transactionVersion: 4 });
    const cancel = vi.spyOn(salesApi, 'cancel').mockRejectedValueOnce(new ApiError('Mất mạng')).mockResolvedValue({ saleId: result.saleId, transactionId: result.transactionId, status: 'CANCELLED' });
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Mở đăng ký chờ' }));
    await user.click(await screen.findByRole('button', { name: 'Hủy đăng ký chờ' }));
    const confirm = screen.getByRole('button', { name: 'Xác nhận hủy' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Lý do hủy (10–500 ký tự)'), 'Chọn sai ngày bắt đầu');
    await user.click(confirm);
    await user.click(await screen.findByRole('button', { name: 'Kiểm tra / gửi lại cùng yêu cầu' }));
    expect(await screen.findByText(/Đã hủy đăng ký chờ/)).toBeTruthy();
    expect(cancel.mock.calls[0][1]).toEqual({ version: 4, reason: 'Chọn sai ngày bắt đầu' });
    expect(cancel.mock.calls[1]).toEqual(cancel.mock.calls[0]);
  });
});
