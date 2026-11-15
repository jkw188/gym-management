import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { ApiError, apiClient } from '../../api/client';
import type { AuthSnapshot } from '../auth/auth.types';
import { usersApi, type UserAccount } from '../users/users.api';
import { TrainerBlockers } from './TrainerBlockers';
import { TrainerForm } from './TrainerForm';
import { TrainersPage } from './TrainersPage';
import { trainersApi, type Trainer, type TrainerPage } from './trainers.api';

const trainer: Trainer = { id: 'a'.repeat(24), accountId: 'b'.repeat(24), fullName: 'PT An', specialty: 'Yoga',
  status: 'ACTIVE', version: 0, phone: '0901234567', email: 'pt@example.test', accountStatus: 'ACTIVE', roleCode: 'TRAINER',
  createdAt: '2035-11-15T00:00:00.000Z', updatedAt: '2035-11-15T00:00:00.000Z' };
const account: UserAccount = { id: trainer.accountId, fullName: trainer.fullName, phone: trainer.phone, email: trainer.email,
  roleCode: 'TRAINER', roleName: 'PT', status: 'ACTIVE', version: 0, createdAt: trainer.createdAt!, updatedAt: trainer.updatedAt! };
const page = <T,>(items: T[]): TrainerPage<T> => ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0 });
const blockers = { ...page([]), counts: { BOOKING: 0, SHIFT: 0, PUBLIC_SESSION: 0 }, asOf: trainer.createdAt! };

beforeEach(() => {
  vi.spyOn(trainersApi, 'list').mockResolvedValue(page([trainer]));
  vi.spyOn(trainersApi, 'detail').mockResolvedValue(trainer);
  vi.spyOn(trainersApi, 'blockers').mockResolvedValue(blockers);
  vi.spyOn(usersApi, 'list').mockResolvedValue(page([account]));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('US-23 admin UI', () => {
  it('loads, searches, filters and shows empty/error states with retry', async () => {
    render(<TrainersPage />);
    expect(screen.getByRole('status').textContent).toContain('Đang tải');
    await screen.findByText('PT An');
    vi.mocked(trainersApi.list).mockResolvedValueOnce(page([]));
    fireEvent.change(screen.getByLabelText('Tìm tên, số điện thoại hoặc chuyên môn'), { target: { value: 'literal.*' } });
    await userEvent.click(screen.getByRole('button', { name: 'Tìm PT' }));
    await screen.findByText('Chưa có hồ sơ PT phù hợp.');
    expect(trainersApi.list).toHaveBeenLastCalledWith({ page: 1, limit: 20, q: 'literal.*' }, expect.any(AbortSignal));
    vi.mocked(trainersApi.list).mockRejectedValueOnce(new ApiError('Mất kết nối'));
    fireEvent.change(screen.getByLabelText('Lọc trạng thái PT'), { target: { value: 'INACTIVE' } });
    expect((await screen.findByRole('alert')).textContent).toBe('Mất kết nối');
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    await screen.findByText('PT An');
  });
  it('creates using an existing active trainer account, trims specialty and prevents double submission', async () => {
    let finish!: (result: Trainer) => void;
    const create = vi.spyOn(trainersApi, 'create').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const saved = vi.fn(); render(<TrainerForm onClose={vi.fn()} onSaved={saved} />);
    await screen.findByRole('option', { name: /PT An/ });
    expect(usersApi.list).toHaveBeenCalledWith(expect.objectContaining({ roleCode: 'TRAINER', status: 'ACTIVE' }), expect.any(AbortSignal));
    fireEvent.change(screen.getByLabelText('Tài khoản PT'), { target: { value: trainer.accountId } });
    fireEvent.change(screen.getByLabelText('Chuyên môn'), { target: { value: '  Boxing  ' } });
    fireEvent.change(screen.getByLabelText('Trạng thái PT'), { target: { value: 'INACTIVE' } });
    await userEvent.dblClick(screen.getByRole('button', { name: 'Lưu hồ sơ PT' }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ accountId: trainer.accountId, specialty: 'Boxing', status: 'INACTIVE' }, expect.any(String));
    expect(saved).not.toHaveBeenCalled();
    finish({ ...trainer, specialty: 'Boxing', status: 'INACTIVE' });
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  });
  it('shows account picker empty/network errors and can retry without changing the draft', async () => {
    vi.mocked(usersApi.list).mockRejectedValueOnce(new ApiError('Không tải tài khoản'));
    render(<TrainerForm onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Chuyên môn'), { target: { value: 'Boxing' } });
    await screen.findByText('Không tải tài khoản');
    vi.mocked(usersApi.list).mockResolvedValueOnce(page([]));
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại tài khoản' }));
    await screen.findByText('Không có tài khoản PT đang hoạt động phù hợp.');
    expect(screen.getByLabelText('Chuyên môn')).toHaveProperty('value', 'Boxing');
  });
  it('edits professional fields only and retains input on conflict instead of overwriting', async () => {
    const update = vi.spyOn(trainersApi, 'update').mockRejectedValueOnce(new ApiError('Hồ sơ đã đổi', 409, 'req-23', undefined, undefined, 'VERSION_CONFLICT'));
    const saved = vi.fn(); render(<TrainerForm initial={trainer} onClose={vi.fn()} onSaved={saved} />);
    expect(screen.queryByLabelText('Tài khoản PT')).toBeNull();
    expect(screen.queryByLabelText('Số điện thoại')).toBeNull();
    fireEvent.change(screen.getByLabelText('Chuyên môn'), { target: { value: 'Boxing' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu hồ sơ PT' }));
    await screen.findByText('Hồ sơ đã đổi');
    expect(screen.getByLabelText('Chuyên môn')).toHaveProperty('value', 'Boxing');
    expect(screen.getByRole('button', { name: 'Lưu hồ sơ PT' })).toHaveProperty('disabled', true);
    expect(update).toHaveBeenCalledWith(trainer.id, { version: 0, specialty: 'Boxing' }, expect.any(String));
    expect(saved).not.toHaveBeenCalled();
    vi.mocked(trainersApi.detail).mockResolvedValueOnce({ ...trainer, specialty: 'Mới nhất', version: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại hồ sơ' }));
    await waitFor(() => expect(screen.getByLabelText('Chuyên môn')).toHaveProperty('value', 'Mới nhất'));
  });
  it('retains exact key/payload after response loss, locks the draft and only reports success after replay', async () => {
    const update = vi.spyOn(trainersApi, 'update').mockRejectedValueOnce(new ApiError('Chưa xác định kết quả', 503, undefined, undefined, undefined, 'OPERATION_OUTCOME_UNKNOWN'))
      .mockResolvedValueOnce({ ...trainer, specialty: 'Boxing', version: 1 });
    const saved = vi.fn(); render(<TrainerForm initial={trainer} onClose={vi.fn()} onSaved={saved} />);
    fireEvent.change(screen.getByLabelText('Chuyên môn'), { target: { value: 'Boxing' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu hồ sơ PT' }));
    await screen.findByText('Chưa xác định kết quả');
    expect(screen.getByRole('button', { name: 'Đóng form' })).toHaveProperty('disabled', true);
    expect(saved).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu' }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]).toEqual(update.mock.calls[1]);
  });
  it('looks up unknown outcome and keeps waiting on OPERATION_UNKNOWN', async () => {
    vi.spyOn(trainersApi, 'update').mockRejectedValueOnce(new ApiError('Mất mạng'));
    const lookup = vi.spyOn(trainersApi, 'lookup').mockRejectedValueOnce(new ApiError('Chưa thấy kết quả', 404, undefined, undefined, undefined, 'OPERATION_UNKNOWN'))
      .mockResolvedValueOnce({ status: 'COMMITTED', responseBody: trainer });
    const saved = vi.fn(); render(<TrainerForm initial={trainer} onClose={vi.fn()} onSaved={saved} />);
    fireEvent.change(screen.getByLabelText('Chuyên môn'), { target: { value: 'Boxing' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu hồ sơ PT' }));
    await screen.findByText('Mất mạng');
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' }));
    await screen.findByText('Chưa thấy kết quả'); expect(saved).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(lookup).toHaveBeenCalledWith('TRAINER_UPDATE', expect.any(String));
    expect(lookup.mock.calls[0]).toEqual(lookup.mock.calls[1]);
  });
  it('rechecks deactivation server-side after viewing no blockers and never displays false success', async () => {
    const saved = vi.fn();
    vi.spyOn(trainersApi, 'update').mockRejectedValueOnce(new ApiError('PT còn lịch chưa kết thúc', 409, undefined, undefined, undefined, 'TRAINER_HAS_ACTIVE_SCHEDULE'));
    render(<TrainerForm initial={trainer} onClose={vi.fn()} onSaved={saved} />);
    await userEvent.click(screen.getByRole('button', { name: 'Xem trở ngại' }));
    await screen.findByText('Không có trở ngại phù hợp.');
    fireEvent.change(screen.getByLabelText('Trạng thái PT'), { target: { value: 'INACTIVE' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu hồ sơ PT' }));
    await screen.findByText('PT còn lịch chưa kết thúc');
    expect(saved).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Trạng thái PT')).toHaveProperty('value', 'INACTIVE');
  });
  it('paginates blockers, filters kind and retries a failure', async () => {
    vi.mocked(trainersApi.blockers).mockResolvedValueOnce({ ...blockers, total: 21, totalPages: 2, counts: { ...blockers.counts, BOOKING: 21 },
      items: [{ id: 'c'.repeat(24), kind: 'BOOKING', startAt: trainer.createdAt!, endAt: trainer.createdAt!, status: 'BOOKED' }] });
    render(<TrainerBlockers trainerId={trainer.id} />);
    await screen.findByRole('link', { name: 'Mở hủy hỗ trợ' });
    vi.mocked(trainersApi.blockers).mockRejectedValueOnce(new ApiError('Lỗi tải trở ngại'));
    await userEvent.click(screen.getByRole('button', { name: 'Trở ngại sau' }));
    await screen.findByText('Lỗi tải trở ngại');
    expect(trainersApi.blockers).toHaveBeenLastCalledWith(trainer.id, 2, '', expect.any(AbortSignal));
    fireEvent.change(screen.getByLabelText('Loại trở ngại'), { target: { value: 'SHIFT' } });
    await screen.findByText('Không có trở ngại phù hợp.');
    expect(trainersApi.blockers).toHaveBeenLastCalledWith(trainer.id, 1, 'SHIFT', expect.any(AbortSignal));
  });
  it.each(['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as const)('protects the actual /admin/trainers route for %s', async role => {
    const snapshot = { status: 'authenticated', user: { ...account, roleCode: role } } as AuthSnapshot;
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue(snapshot);
    vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
    vi.spyOn(apiClient, 'restore').mockResolvedValue();
    window.history.replaceState(null, '', '/admin/trainers'); render(<App />);
    if (role === 'ADMIN') await screen.findByRole('heading', { name: 'Quản lý huấn luyện viên' });
    else { await screen.findByRole('heading', { name: 'Không có quyền truy cập' }); expect(trainersApi.list).not.toHaveBeenCalled(); }
  });
});
