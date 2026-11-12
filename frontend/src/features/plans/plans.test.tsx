import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import { PlanForm } from './PlanForm';
import { PolicyForm } from './PolicyForm';
import { PlansPage } from './PlansPage';
import { findCreatedPolicy, formatVnd, plansApi, type CatalogPage, type Plan, type PlanPolicy } from './plans.api';

const gym: Plan = { id: '123456789012345678901234', code: 'GYM_30', name: 'Gym 30 ngày', kind: 'GYM', durationDays: 30, sessionsQuota: 0,
  price: '500000', benefits: 'Tập luyện', status: 'ACTIVE', version: 0, createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z' };
const target: Plan = { ...gym, id: '123456789012345678901235', code: 'GYM_90', price: '900000' };
const policy: PlanPolicy = { id: '123456789012345678901236', fromPlanId: gym.id, toPlanId: target.id, status: 'ACTIVE', note: '',
  version: 0, ruleCode: 'PRORATED_REMAINING_DAYS_V1', createdAt: gym.createdAt, updatedAt: gym.updatedAt };
const page = <T,>(items: T[]): CatalogPage<T> => ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0 });

beforeEach(() => {
  vi.spyOn(plansApi, 'list').mockResolvedValue(page([gym, target]));
  vi.spyOn(plansApi, 'policies').mockResolvedValue(page([policy]));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function fillPlan(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Mã gói'), 'PT_30');
  await user.type(screen.getByLabelText('Tên gói'), 'PT 30 ngày');
  await user.type(screen.getByLabelText('Giá (VND)'), '900000');
  await user.type(screen.getByLabelText('Quyền lợi'), 'Huấn luyện cá nhân');
}

describe('US-12 TC15: catalog and forms', () => {
  it('lists VND/status/quota, filters and switches to policies', async () => {
    const user = userEvent.setup(); render(<PlansPage />);
    expect(screen.getByText('Đang tải danh mục…')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Sửa / đổi trạng thái GYM_30' })).toBeTruthy();
    expect(screen.getByText('500.000 ₫')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Lọc loại gói'), 'PT');
    await waitFor(() => expect(plansApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'PT', page: 1 }), expect.any(AbortSignal)));
    await user.click(screen.getByRole('tab', { name: 'Chuyển đổi' }));
    expect(await screen.findByRole('button', { name: `Sửa chính sách ${policy.id}` })).toBeTruthy();
    expect(screen.getByText(policy.ruleCode)).toBeTruthy();
  });
  it('shows empty/error and retries loading', async () => {
    vi.mocked(plansApi.list).mockRejectedValueOnce(new ApiError('Mất kết nối')).mockResolvedValueOnce(page([]));
    const user = userEvent.setup(); render(<PlansPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText('Chưa có dữ liệu phù hợp.')).toBeTruthy();
  });
  it('kind toggle controls quota, sends price as string and prevents double submit', async () => {
    const user = userEvent.setup(), saved = vi.fn();
    let resolve!: (plan: Plan) => void;
    const create = vi.spyOn(plansApi, 'create').mockReturnValue(new Promise(done => { resolve = done; }));
    render(<PlanForm onClose={vi.fn()} onSaved={saved} />);
    expect(screen.queryByLabelText('Số buổi PT')).toBeNull();
    await fillPlan(user);
    await user.selectOptions(screen.getByLabelText('Loại gói'), 'PT');
    fireEvent.change(screen.getByLabelText('Số buổi PT'), { target: { value: '12' } });
    await user.click(screen.getByRole('button', { name: 'Lưu gói' }));
    fireEvent.submit(screen.getByLabelText('Tên gói').closest('form')!);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'PT', sessionsQuota: 12, price: '900000' }));
    expect((screen.getByRole('button', { name: 'Đang xử lý…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve(gym)); expect(saved).toHaveBeenCalledOnce();
  });
  it('switching PT back to GYM resets quota to zero', async () => {
    const user = userEvent.setup(), create = vi.spyOn(plansApi, 'create').mockResolvedValue(gym);
    render(<PlanForm onClose={vi.fn()} onSaved={vi.fn()} />); await fillPlan(user);
    await user.selectOptions(screen.getByLabelText('Loại gói'), 'PT');
    await user.selectOptions(screen.getByLabelText('Loại gói'), 'GYM');
    await user.click(screen.getByRole('button', { name: 'Lưu gói' }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'GYM', sessionsQuota: 0 }));
  });
  it('400 field error appears beside input and preserves draft', async () => {
    vi.spyOn(plansApi, 'update').mockRejectedValue(new ApiError('Dữ liệu không hợp lệ', 400, 'req-12', [{ field: 'price', message: 'Giá phải nguyên' }]));
    const user = userEvent.setup(); render(<PlanForm initial={gym} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Lưu gói' }));
    await screen.findByRole('alert');
    const input = screen.getByLabelText('Giá (VND)') as HTMLInputElement;
    expect(input.value).toBe('500000'); expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Mã tra cứu: req-12')).toBeTruthy();
  });
  it('409 keeps draft until explicit reload; immutable code/kind omitted from PATCH', async () => {
    const update = vi.spyOn(plansApi, 'update').mockRejectedValue(new ApiError('Dữ liệu đã thay đổi', 409, undefined, undefined, undefined, 'VERSION_CONFLICT'));
    const detail = vi.spyOn(plansApi, 'detail').mockResolvedValue({ ...gym, name: 'Tên mới từ server', version: 1 });
    const user = userEvent.setup(); render(<PlanForm initial={gym} onClose={vi.fn()} onSaved={vi.fn()} />);
    const name = screen.getByLabelText('Tên gói') as HTMLInputElement;
    await user.clear(name); await user.type(name, 'Bản nhập đang sửa');
    await user.click(screen.getByRole('button', { name: 'Lưu gói' }));
    expect(await screen.findByRole('alert')).toBeTruthy(); expect(name.value).toBe('Bản nhập đang sửa'); expect(detail).not.toHaveBeenCalled();
    const input = update.mock.calls[0][1]; expect(input).not.toHaveProperty('code'); expect(input).not.toHaveProperty('kind'); expect(input.version).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Bỏ bản nhập và tải lại gói' }));
    await waitFor(() => expect(name.value).toBe('Tên mới từ server'));
  });
  it('uncertain POST disables resubmission until code lookup; found plan is shown for review', async () => {
    const create = vi.spyOn(plansApi, 'create').mockRejectedValue(new ApiError('Mất phản hồi'));
    const user = userEvent.setup(); render(<PlanForm onClose={vi.fn()} onSaved={vi.fn()} />); await fillPlan(user);
    await user.click(screen.getByRole('button', { name: 'Lưu gói' }));
    await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: 'Lưu gói' }) as HTMLButtonElement).disabled).toBe(true);
    vi.mocked(plansApi.list).mockResolvedValue(page([{ ...gym, code: 'PT_30' }]));
    await user.click(screen.getByRole('button', { name: 'Tra cứu mã gói trước khi thử lại' }));
    expect(await screen.findByText(/Đã tìm thấy mã gói/)).toBeTruthy(); expect(create).toHaveBeenCalledOnce();
    expect((screen.getByLabelText('Mã gói') as HTMLInputElement).disabled).toBe(true);
  });
  it('POLICY_CONFLICT shows the edge to stop and keeps entered price', async () => {
    vi.spyOn(plansApi, 'update').mockRejectedValue(new ApiError('Ngừng chính sách liên quan', 409, undefined,
      [{ field: 'policy', message: `${policy.id}: GYM_30 → GYM_90` }], undefined, 'POLICY_CONFLICT'));
    const user = userEvent.setup(); render(<PlanForm initial={gym} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Lưu gói' }));
    expect(await screen.findByText(`policy: ${policy.id}: GYM_30 → GYM_90`)).toBeTruthy();
    expect((screen.getByLabelText('Giá (VND)') as HTMLInputElement).value).toBe(gym.price);
  });
  it('creates an INACTIVE policy draft without client-defined rule; pending prevents repeated POST', async () => {
    const user = userEvent.setup(); let resolve!: (value: PlanPolicy) => void;
    const create = vi.spyOn(plansApi, 'createPolicy').mockReturnValue(new Promise(done => { resolve = done; }));
    render(<PolicyForm onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect((screen.getByLabelText('Gói nguồn') as HTMLSelectElement).disabled).toBe(false));
    await user.selectOptions(screen.getByLabelText('Gói nguồn'), gym.id); await user.selectOptions(screen.getByLabelText('Gói đích'), target.id);
    await user.click(screen.getByRole('button', { name: 'Lưu chính sách' }));
    fireEvent.submit(screen.getByLabelText('Ghi chú').closest('form')!);
    expect(create).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledWith({ fromPlanId: gym.id, toPlanId: target.id, status: 'INACTIVE', note: '' });
    await act(async () => resolve(policy));
  });
  it('policy PATCH preserves draft on version conflict and reloads by pair only on request', async () => {
    const update = vi.spyOn(plansApi, 'updatePolicy').mockRejectedValue(new ApiError('Phiên bản cũ', 409, undefined, undefined, undefined, 'VERSION_CONFLICT'));
    const user = userEvent.setup(); render(<PolicyForm initial={policy} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText('Ghi chú'), 'Bản nhập'); await user.click(screen.getByRole('button', { name: 'Lưu chính sách' }));
    await screen.findByRole('alert'); expect((screen.getByLabelText('Ghi chú') as HTMLTextAreaElement).value).toBe('Bản nhập');
    expect(update).toHaveBeenCalledWith(policy.id, { version: 0, status: 'ACTIVE', note: 'Bản nhập' });
    expect(plansApi.policies).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Bỏ bản nhập và tải lại chính sách' }));
    await waitFor(() => expect((screen.getByLabelText('Ghi chú') as HTMLTextAreaElement).value).toBe(''));
  });
  it('pair recovery searches beyond first page; money formatting keeps integer precision', async () => {
    vi.mocked(plansApi.policies).mockResolvedValueOnce({ ...page([]), total: 101, totalPages: 2 })
      .mockResolvedValueOnce({ ...page([policy]), page: 2, total: 101, totalPages: 2 });
    expect(await findCreatedPolicy(gym.id, target.id)).toEqual(policy);
    expect(plansApi.policies).toHaveBeenLastCalledWith({ page: 2, limit: 100, fromPlanId: gym.id });
    expect(formatVnd('999999999999')).toBe('999.999.999.999 ₫');
  });
  it('write API uses admin endpoints and no automatic replay', async () => {
    const requestOnce = vi.spyOn(apiClient, 'requestOnce').mockResolvedValue(gym);
    const { id: _id, version: _version, status: _status, createdAt: _created, updatedAt: _updated, ...input } = gym;
    await plansApi.create(input);
    expect(requestOnce).toHaveBeenCalledWith('/admin/plans', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
  });
});
