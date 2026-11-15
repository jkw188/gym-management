import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, apiClient } from '../../api/client';
import type { MemberMembership } from '../members/members.api';
import { salesApi, type SaleDetail } from './sales.api';
import { ServiceUpgradePanel } from './ServiceUpgradePanel';
import { upgradesApi, type UpgradePreview, type UpgradeTargets } from './upgrades.api';

const memberId = '123456789012345678901234';
const source: MemberMembership = { membershipId: '223456789012345678901234', saleId: '323456789012345678901234', kind: 'PT', planName: 'PT cũ',
  startDate: '2026-11-01', endDate: '2026-11-30', storedStatus: 'ACTIVE', timeState: 'CURRENT', sessionsQuota: 10, sessionsUsed: 3, transactionStatus: 'SETTLED' };
const target = { planId: '423456789012345678901234', planVersion: 2, policyVersion: 3, name: 'PT cao hơn', kind: 'PT' as const, price: '1500000', durationDays: 30, sessions: 12, benefits: 'Quyền lợi đích' };
const targets: UpgradeTargets = { source: { ...source, version: 4, benefits: 'Quyền lợi nguồn' }, items: [target], asOf: '2026-11-16T03:00:00Z' };
const preview: UpgradePreview = { baseValue: '900000', totalDays: 30, remainingDays: 15, rawCredit: '450000', appliedCredit: '450000', excessCredit: '0', amountDue: '1050000',
  asOfDate: '2026-11-16', quoteExpiresAt: '2099-11-16T17:00:00Z', sourceMembershipId: source.membershipId, sourceVersion: 4, previousSaleId: source.saleId,
  targetPlanId: target.planId, targetPlanVersion: 2, policyVersion: 3, targetListPrice: '1500000', quotaSummary: { used: 3, reserved: 2, requiredSessions: 5, targetSessions: 12 }, canProceed: true };
const input = { memberId, sourceMembershipId: source.membershipId, sourceVersion: 4, targetPlanId: target.planId, targetPlanVersion: 2, policyVersion: 3 };
const sale: SaleDetail = { saleId: '523456789012345678901234', transactionId: '623456789012345678901234', transactionCode: 'TX-UPGRADE', transactionStatus: 'PENDING',
  transactionVersion: 0, operation: 'UPGRADE', amountDue: '1050000', planName: target.name, benefits: target.benefits, sessions: 12,
  requestedStartDate: '2026-11-16', startDate: '2026-11-16', endDate: '2026-12-15', notificationState: 'NOT_CREATED', quote: preview };
const props = { memberId, source, onLockedChange: vi.fn(), onRefresh: vi.fn() };
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(upgradesApi, 'targets').mockResolvedValue(targets);
  vi.spyOn(upgradesApi, 'preview').mockResolvedValue(preview);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });
const mount = () => render(<ServiceUpgradePanel {...props} />, { wrapper: MemoryRouter });
async function open() {
  mount(); const user = userEvent.setup();
  await user.selectOptions(await screen.findByLabelText('Gói nâng cấp theo chính sách'), target.planId);
  await user.click(screen.getByRole('button', { name: 'Xem trước nâng cấp' }));
  await screen.findByRole('button', { name: 'Xác nhận tạo nâng cấp' });
  return user;
}
describe('US-16-TC17 upgrade UI and immutable financial commands', () => {
  it('compares source/target and displays server credit, quota and expiry before explicit confirmation', async () => {
    const create = vi.spyOn(upgradesApi, 'create').mockResolvedValue(sale);
    const user = await open();
    expect(screen.getByText(/Quyền lợi cũ: Quyền lợi nguồn/)).toBeTruthy();
    expect(screen.getByText(/Khấu trừ tính được: 450000 VND · Áp dụng: 450000 VND/)).toBeTruthy();
    expect(screen.getByText(/Phải thu: 1050000 VND/)).toBeTruthy();
    expect(screen.getByText(/Buổi đã dùng: 3 · BOOKED: 2 · Quota đích: 12/)).toBeTruthy();
    expect(upgradesApi.preview).toHaveBeenCalledWith(input); expect(create).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Xác nhận tạo nâng cấp' }));
    expect(await screen.findByText('Đề nghị chờ thu — gói nguồn và lịch PT chưa chuyển.')).toBeTruthy();
    expect(create.mock.calls[0][0]).toEqual(input);
    expect(screen.queryByText(/Đã thay thế gói nguồn/)).toBeNull();
  });
  it('shows capped excess without refund/wallet and invoice0 with carried used, not reset0', async () => {
    const free = { ...preview, rawCredit: '600000', appliedCredit: '500000', excessCredit: '100000', amountDue: '0', targetListPrice: '500000' };
    vi.mocked(upgradesApi.preview).mockResolvedValue(free);
    vi.spyOn(upgradesApi, 'create').mockResolvedValue({ ...sale, amountDue: '0', transactionStatus: 'SETTLED', quote: free, carriedSessionsUsed: 3, invoiceNumber: 'INV-ZERO', membershipId: 'new' });
    const user = await open();
    expect(screen.getByText(/Phần dư không hoàn: 100000 VND/)).toBeTruthy();
    expect(screen.getByText(/không tạo khoản thu 0/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Xác nhận tạo nâng cấp' }));
    expect(await screen.findByText(/Buổi đã dùng mang sang: 3/)).toBeTruthy();
    expect(screen.getByText(/Đã thay thế gói nguồn \(SUPERSEDED\)/)).toBeTruthy();
    expect(screen.queryByLabelText(/Số tiền thu/)).toBeNull();
  });
  it('blocks double clicks while the command is in flight', async () => {
    let finish!: (value: SaleDetail) => void;
    const create = vi.spyOn(upgradesApi, 'create').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await open(); const button = screen.getByRole('button', { name: 'Xác nhận tạo nâng cấp' });
    fireEvent.click(button); fireEvent.click(button); expect(create).toHaveBeenCalledTimes(1);
    await act(async () => finish(sale)); await screen.findByText(sale.transactionCode);
  });
  it('retains immutable key/input after lost reply, remount and lookup404, without auto-retry', async () => {
    const create = vi.spyOn(upgradesApi, 'create').mockRejectedValueOnce(new ApiError('Mất phản hồi', 503)).mockResolvedValue(sale);
    const lookup = vi.spyOn(upgradesApi, 'operation').mockRejectedValue(new ApiError('Unknown', 404));
    const user = await open(); await user.click(screen.getByRole('button', { name: 'Xác nhận tạo nâng cấp' }));
    await screen.findByRole('button', { name: 'Tra cứu kết quả nâng cấp' }); cleanup(); mount();
    await user.click(await screen.findByRole('button', { name: 'Tra cứu kết quả nâng cấp' }));
    await screen.findByText(/yêu cầu có thể vẫn đang xử lý/);
    expect(create).toHaveBeenCalledTimes(1); expect(lookup).toHaveBeenCalledWith(create.mock.calls[0][1]);
    await user.click(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu nâng cấp' }));
    await screen.findByText(sale.transactionCode); expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  });
  it.each(['SOURCE_CHANGED', 'QUOTE_EXPIRED', 'POLICY_CHANGED'])('requires reload and fresh confirmation after %s, never changes money automatically', async code => {
    const create = vi.spyOn(upgradesApi, 'create').mockRejectedValue(new ApiError('Xung đột', 409, undefined, undefined, undefined, code));
    const user = await open(); await user.click(screen.getByRole('button', { name: 'Xác nhận tạo nâng cấp' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Xác nhận tạo nâng cấp' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Xem trước nâng cấp' }) as HTMLButtonElement).disabled).toBe(true);
    expect(upgradesApi.preview).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Tải lại nguồn và chính sách' }));
    await waitFor(() => expect((screen.getByLabelText('Gói nâng cấp theo chính sách') as HTMLSelectElement).disabled).toBe(false));
    expect(upgradesApi.preview).toHaveBeenCalledTimes(1);
  });
  it('disables an expired preview without calling create or silently refreshing quote', async () => {
    vi.mocked(upgradesApi.preview).mockResolvedValue({ ...preview, quoteExpiresAt: '2000-01-01T17:00:00Z' });
    const create = vi.spyOn(upgradesApi, 'create').mockResolvedValue(sale);
    const user = await open();
    const button = screen.getByRole('button', { name: 'Xác nhận tạo nâng cấp' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(button); expect(create).not.toHaveBeenCalled(); expect(upgradesApi.preview).toHaveBeenCalledTimes(1);
  });
  it('blocks quota/booking conflicts and invalidates preview when selecting another target', async () => {
    vi.mocked(upgradesApi.preview).mockResolvedValue({ ...preview, canProceed: false, blockingCode: 'QUOTA_INSUFFICIENT' });
    const user = await open();
    expect((screen.getByRole('button', { name: 'Xác nhận tạo nâng cấp' }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText('Gói nâng cấp theo chính sách'), '');
    expect(screen.queryByRole('button', { name: 'Xác nhận tạo nâng cấp' })).toBeNull();
  });
  it('lookup committed result does not submit another upgrade', async () => {
    const create = vi.spyOn(upgradesApi, 'create').mockRejectedValue(new ApiError('Unknown', 503));
    vi.spyOn(upgradesApi, 'operation').mockResolvedValue({ status: 'COMMITTED', responseStatus: 201, responseBody: sale });
    const user = await open(); await user.click(screen.getByRole('button', { name: 'Xác nhận tạo nâng cấp' }));
    await user.click(await screen.findByRole('button', { name: 'Tra cứu kết quả nâng cấp' }));
    await screen.findByText(sale.transactionCode); expect(create).toHaveBeenCalledTimes(1);
  });
  it('uses one authenticated POST with key and only contract fields', async () => {
    const send = vi.spyOn(apiClient, 'requestOnce').mockResolvedValue(sale);
    await upgradesApi.create(input, 'same-key');
    expect(send).toHaveBeenCalledWith('/service-upgrades', expect.objectContaining({ method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'same-key' }, body: JSON.stringify(input) }));
  });
});
