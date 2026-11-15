import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, apiClient } from '../../api/client';
import { MemberHistory } from '../members/MemberHistory';
import { membersApi, type MemberMembership } from '../members/members.api';
import { ServiceRenewalPanel } from './ServiceRenewalPanel';
import { renewalsApi, type RenewalPreview } from './renewals.api';
import { salesApi, type SaleDetail, type SalePlan } from './sales.api';

const memberId = '123456789012345678901234';
const source: MemberMembership = { membershipId: '223456789012345678901234', saleId: '323456789012345678901234', kind: 'PT', planName: 'PT 30',
  startDate: '2026-11-01', endDate: '2026-11-30', storedStatus: 'ACTIVE', timeState: 'CURRENT', sessionsQuota: 10, sessionsUsed: 3, transactionStatus: 'SETTLED' };
const plan: SalePlan = { id: '423456789012345678901234', name: 'PT 30', kind: 'PT', planVersion: 2, durationDays: 30, price: '500000', sessions: 12, benefits: 'Quyền lợi kỳ mới' };
const preview: RenewalPreview = { previousSaleId: source.saleId, sourceEndDate: source.endDate, amountDue: plan.price, expectedStartDate: '2026-12-01',
  expectedEndDate: '2026-12-30', planVersion: 2, asOf: '2026-11-14T03:00:00Z', canProceed: true };
const result: SaleDetail = { saleId: '523456789012345678901234', transactionId: '623456789012345678901234', transactionCode: 'TX-renewal',
  transactionStatus: 'PENDING', transactionVersion: 0, amountDue: plan.price, planName: plan.name, planId: plan.id, operation: 'RENEW', previousSaleId: source.saleId,
  sessions: 12, benefits: plan.benefits, requestedStartDate: preview.expectedStartDate, startDate: preview.expectedStartDate, endDate: preview.expectedEndDate, notificationState: 'NOT_CREATED' };
const options = { onLockedChange: vi.fn(), onRefresh: vi.fn() };
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(salesApi, 'catalog').mockResolvedValue({ items: [plan] });
  vi.spyOn(salesApi, 'detail').mockResolvedValue({ ...result, saleId: source.saleId });
  vi.spyOn(renewalsApi, 'preview').mockResolvedValue(preview);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });
function mount() { return render(<ServiceRenewalPanel memberId={memberId} source={source} {...options} />, { wrapper: MemoryRouter }); }
async function open() {
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Xem trước gia hạn' }));
  await screen.findByRole('button', { name: 'Xác nhận tạo gia hạn' });
  return user;
}

describe('US-15-TC14: staff renewal UI, stale sources, immutable keys and distinct periods', () => {
  it('loads current plan, requires explicit preview/confirmation and displays pending without extending the old period', async () => {
    const create = vi.spyOn(renewalsApi, 'create').mockResolvedValue(result);
    mount();
    await screen.findByRole('button', { name: 'Xem trước gia hạn' });
    expect(create).not.toHaveBeenCalled(); expect(renewalsApi.preview).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Xem trước gia hạn' }));
    expect(renewalsApi.preview).toHaveBeenCalledWith({ memberId, previousSaleId: source.saleId, planVersion: 2 });
    expect(await screen.findByText(/chờ thu không kéo dài quyền kỳ cũ/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Xác nhận tạo gia hạn' }));
    expect(await screen.findByText('Gia hạn đang chờ thu — chưa cấp kỳ mới, kỳ cũ giữ nguyên.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Đối chiếu và thu gia hạn' }).getAttribute('href')).toBe('/staff/transactions');
    expect(create.mock.calls[0][0]).toEqual({ memberId, previousSaleId: source.saleId, planVersion: 2 });
    expect(screen.queryByText(/Đã cấp kỳ gia hạn riêng/)).toBeNull();
  });

  it('blocks double submission while the exact request is pending', async () => {
    let finish!: (value: SaleDetail) => void;
    const create = vi.spyOn(renewalsApi, 'create').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await open();
    const button = screen.getByRole('button', { name: 'Xác nhận tạo gia hạn' });
    fireEvent.click(button); fireEvent.click(button);
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => finish(result));
    await screen.findByText(result.transactionCode);
  });

  it('keeps input/key through network error, remount and lookup404, and only retries after user action', async () => {
    const create = vi.spyOn(renewalsApi, 'create').mockRejectedValueOnce(new ApiError('Mất kết nối')).mockResolvedValue(result);
    const lookup = vi.spyOn(renewalsApi, 'operation').mockRejectedValue(new ApiError('Chưa thấy kết quả', 404));
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Xác nhận tạo gia hạn' }));
    await screen.findByRole('button', { name: 'Tra cứu kết quả gia hạn' });
    expect(create).toHaveBeenCalledTimes(1);
    cleanup(); mount();
    await user.click(await screen.findByRole('button', { name: 'Tra cứu kết quả gia hạn' }));
    await screen.findByText(/yêu cầu có thể vẫn đang xử lý/);
    expect(create).toHaveBeenCalledTimes(1); expect(lookup).toHaveBeenCalledWith(create.mock.calls[0][1]);
    await user.click(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu gia hạn' }));
    await screen.findByText(result.transactionCode);
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
    expect(sessionStorage.length).toBe(0);
  });

  it('recovers a committed result via EN-02 lookup without resending', async () => {
    const create = vi.spyOn(renewalsApi, 'create').mockRejectedValue(new ApiError('Chưa rõ commit', 503));
    vi.spyOn(renewalsApi, 'operation').mockResolvedValue({ status: 'COMMITTED', responseStatus: 201, responseBody: result });
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Xác nhận tạo gia hạn' }));
    await user.click(await screen.findByRole('button', { name: 'Tra cứu kết quả gia hạn' }));
    expect(await screen.findByText(result.transactionCode)).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['SOURCE_NOT_LATEST', 'PLAN_CHANGED'])('requires reload and new preview after %s, never substitutes a newer source', async code => {
    const create = vi.spyOn(renewalsApi, 'create').mockRejectedValue(new ApiError('Xung đột', 409, 'request-id', undefined, undefined, code));
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Xác nhận tạo gia hạn' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Xác nhận tạo gia hạn' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Xem trước gia hạn' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Tải lại điều khoản và lịch sử' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Xem trước gia hạn' }) as HTMLButtonElement).disabled).toBe(false));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].previousSaleId).toBe(source.saleId);
    expect(renewalsApi.preview).toHaveBeenCalledTimes(1);
  });

  it('shows zero obligation and actual new period separately without a payment0 form', async () => {
    vi.mocked(salesApi.catalog).mockResolvedValue({ items: [{ ...plan, price: '0' }] });
    vi.mocked(renewalsApi.preview).mockResolvedValue({ ...preview, amountDue: '0' });
    vi.spyOn(renewalsApi, 'create').mockResolvedValue({ ...result, amountDue: '0', transactionStatus: 'SETTLED', membershipId: 'new-period', invoiceNumber: 'INV-zero' });
    const user = await open();
    expect(screen.getByText(/Nghĩa vụ miễn phí/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Xác nhận tạo gia hạn' }));
    expect(await screen.findByText(/Đã cấp kỳ gia hạn riêng: 2026-12-01/)).toBeTruthy();
    expect(screen.getByText('Chứng từ: INV-zero')).toBeTruthy();
    expect(screen.queryByLabelText(/Số tiền/)).toBeNull();
  });

  it('refreshes actual results after payment without recreating the renewal', async () => {
    const create = vi.spyOn(renewalsApi, 'create').mockResolvedValue(result);
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Xác nhận tạo gia hạn' }));
    await screen.findByText(result.transactionCode);
    vi.mocked(salesApi.detail).mockResolvedValue({ ...result, transactionStatus: 'SETTLED', membershipId: 'new', startDate: '2026-12-02', endDate: '2026-12-31' });
    await user.click(screen.getByRole('button', { name: 'Tải kết quả sau thanh toán' }));
    expect(await screen.findByText(/Đã cấp kỳ gia hạn riêng: 2026-12-02 → 2026-12-31/)).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('shows multiple historical periods and lets staff explicitly choose a sale from history', async () => {
    const latest = { ...source, saleId: result.saleId, membershipId: '723456789012345678901234', planName: 'PT kỳ tương lai', startDate: '2026-12-01', endDate: '2026-12-30' };
    vi.spyOn(membersApi, 'memberships').mockResolvedValue({ items: [latest, source], page: 1, limit: 20, total: 2, totalPages: 1,
      asOf: preview.asOf, businessDate: '2026-11-14' });
    render(<MemberHistory id={memberId} />, { wrapper: MemoryRouter });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Gia hạn PT kỳ tương lai' }));
    await user.click(await screen.findByRole('button', { name: 'Xem trước gia hạn' }));
    expect(renewalsApi.preview).toHaveBeenCalledWith({ memberId, previousSaleId: latest.saleId, planVersion: plan.planVersion });
    expect(screen.getByText('2026-11-01 → 2026-11-30')).toBeTruthy();
    expect(screen.getByText('2026-12-01 → 2026-12-30')).toBeTruthy();
  });

  it('sends a single API command with SALE_RENEW input/key, no client channel or price', async () => {
    const send = vi.spyOn(apiClient, 'requestOnce').mockResolvedValue(result);
    vi.mocked(renewalsApi.preview).mockRestore();
    const input = { memberId, previousSaleId: source.saleId, planVersion: 2 };
    await renewalsApi.create(input, 'same-key');
    expect(send).toHaveBeenCalledWith('/service-renewals', expect.objectContaining({ method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'same-key' }, body: JSON.stringify(input) }));
  });
});
