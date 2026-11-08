import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError, apiClient } from '../../api/client';
import { AuthProvider } from '../auth/AuthProvider';
import { AccountStatusDialog } from './AccountStatusDialog';
import { UsersPage } from './UsersPage';
import { usersApi, type ChangeStatusResult, type UserAccount } from './users.api';

const account: UserAccount = { id: 'a'.repeat(24), fullName: 'Test Admin', phone: '+84901234567', roleCode: 'ADMIN', roleName: 'Admin',
  status: 'ACTIVE', version: 4, createdAt: '2026-10-25T01:00:00Z', updatedAt: '2026-10-25T01:00:00Z' };
const reason = 'Kiểm tra quyền truy cập';
const locked: ChangeStatusResult = { user: { ...account, status: 'LOCKED', version: 5 }, changed: true, reauthenticationRequired: false };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { vi.spyOn(usersApi, 'statusDetail').mockResolvedValue(account); });

function show(ownAccount = false, strict = false) {
  const callbacks = { onSaved: vi.fn(), onClose: vi.fn(), onUnauthenticated: vi.fn() };
  const component = <AccountStatusDialog id={account.id} ownAccount={ownAccount} {...callbacks} />;
  render(strict ? <StrictMode>{component}</StrictMode> : component);
  return callbacks;
}
async function fill() {
  await screen.findByLabelText('Lý do khóa / mở khóa');
  fireEvent.change(screen.getByLabelText('Lý do khóa / mở khóa'), { target: { value: `  ${reason}  ` } });
  fireEvent.click(screen.getByRole('checkbox'));
}

describe('US-07 status confirmation', () => {
  it('loads the latest version and validates confirmation/reason before submitting an explicit status', async () => {
    const submit = vi.spyOn(usersApi, 'changeStatus').mockResolvedValue(locked);
    const callbacks = show();
    await screen.findByLabelText('Lý do khóa / mở khóa');
    expect((screen.getByRole('button', { name: 'Xác nhận khóa' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Lý do khóa / mở khóa'), { target: { value: ' short ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận khóa' }));
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('10–500');
    fireEvent.change(screen.getByLabelText('Lý do khóa / mở khóa'), { target: { value: `  ${reason}  ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận khóa' }));
    await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledWith(locked));
    expect(submit).toHaveBeenCalledExactlyOnceWith(account.id, { status: 'LOCKED', version: 4, reason });
    expect(screen.getByText(/Hồ sơ PT, gói tập, lịch hẹn và đơn hàng/)).toBeDefined();
  });

  it('prevents duplicate submit and close while pending; does not update optimistically', async () => {
    let finish!: (result: ChangeStatusResult) => void;
    const submit = vi.spyOn(usersApi, 'changeStatus').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const callbacks = show(); await fill();
    const form = screen.getByRole('button', { name: 'Xác nhận khóa' }).closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(submit).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Đóng' }) as HTMLButtonElement).disabled).toBe(true);
    expect(callbacks.onSaved).not.toHaveBeenCalled();
    expect(screen.getByText(/Hoạt động — phiên bản 4/)).toBeDefined();
    await act(async () => finish(locked));
    expect(callbacks.onSaved).toHaveBeenCalledWith(locked);
  });

  it.each(['VERSION_CONFLICT', 'LAST_ACTIVE_ADMIN'])('409 %s blocks resubmit until explicit GET/reconfirmation', async code => {
    const submit = vi.spyOn(usersApi, 'changeStatus').mockRejectedValue(new ApiError(code, 409, 'request-test', undefined, undefined, code));
    show(); await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận khóa' }));
    await screen.findByText(new RegExp(`${code}.*request-test`));
    expect((screen.getByRole('button', { name: 'Xác nhận khóa' }) as HTMLButtonElement).disabled).toBe(true);
    expect(usersApi.statusDetail).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại trạng thái' }));
    await waitFor(() => expect(usersApi.statusDetail).toHaveBeenCalledTimes(2));
    expect(submit).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it.each([new ApiError('Mất kết nối'), new ApiError('Chưa xác định kết quả', 503)])('lost response/503 requires GET and never replays the PATCH', async error => {
    const submit = vi.spyOn(usersApi, 'changeStatus').mockRejectedValue(error);
    show(); await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận khóa' }));
    await screen.findByText(/Chưa xác định được kết quả thao tác/);
    expect((screen.getByRole('button', { name: 'Xác nhận khóa' }) as HTMLButtonElement).disabled).toBe(true);
    vi.mocked(usersApi.statusDetail).mockResolvedValueOnce(locked.user);
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại trạng thái' }));
    await screen.findByRole('button', { name: 'Xác nhận mở khóa' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Đã khóa — phiên bản 5/)).toBeDefined();
  });

  it('warns about self-lock; GET 401 after losing the response returns to login without refresh', async () => {
    vi.spyOn(usersApi, 'changeStatus').mockRejectedValue(new ApiError('Mất kết nối'));
    const refresh = vi.spyOn(apiClient, 'refreshSession');
    const callbacks = show(true); await fill();
    expect(screen.getByText(/Bạn đang tự khóa tài khoản/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận khóa' }));
    await screen.findByText(/Chưa xác định được kết quả thao tác/);
    vi.mocked(usersApi.statusDetail).mockRejectedValueOnce(new ApiError('Cần đăng nhập lại', 401));
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại trạng thái' }));
    await waitFor(() => expect(callbacks.onUnauthenticated).toHaveBeenCalledTimes(1));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('loads in StrictMode and can recover from a detail failure', async () => {
    vi.mocked(usersApi.statusDetail).mockRejectedValue(new ApiError('DB chưa sẵn sàng', 503));
    show(false, true);
    await screen.findByText('DB chưa sẵn sàng');
    vi.mocked(usersApi.statusDetail).mockResolvedValueOnce(account);
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại trạng thái' }));
    await screen.findByLabelText('Lý do khóa / mở khóa');
  });

  it('status GET and PATCH use requestOnce, avoiding automatic refresh and replay', async () => {
    vi.mocked(usersApi.statusDetail).mockRestore();
    const once = vi.spyOn(apiClient, 'requestOnce').mockResolvedValueOnce(account).mockRejectedValueOnce(new ApiError('Cần đăng nhập lại', 401));
    const request = vi.spyOn(apiClient, 'request');
    await usersApi.statusDetail(account.id);
    await expect(usersApi.changeStatus(account.id, { status: 'LOCKED', version: 4, reason })).rejects.toMatchObject({ status: 401 });
    expect(once).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
    expect(JSON.parse((once.mock.calls[1][1] as RequestInit).body as string)).toEqual({ status: 'LOCKED', version: 4, reason });
  });

  it('UsersPage clears the session and returns to login after successful self-lock', async () => {
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: account });
    vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
    vi.spyOn(apiClient, 'restore').mockResolvedValue();
    const requireLogin = vi.spyOn(apiClient, 'requireLogin').mockImplementation(() => {});
    const refresh = vi.spyOn(apiClient, 'refreshSession');
    vi.spyOn(usersApi, 'roles').mockResolvedValue({ items: [{ code: 'ADMIN', name: 'Admin' }] });
    vi.spyOn(usersApi, 'list').mockResolvedValue({ items: [account], page: 1, limit: 20, total: 1, totalPages: 1 });
    vi.spyOn(usersApi, 'changeStatus').mockResolvedValue({ ...locked, reauthenticationRequired: true });
    render(<MemoryRouter initialEntries={['/admin/users']}><AuthProvider><Routes>
      <Route path="/admin/users" element={<UsersPage />} /><Route path="/login" element={<h2>Đăng nhập lại</h2>} />
    </Routes></AuthProvider></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Khóa / Mở khóa Test Admin' }));
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận khóa' }));
    await screen.findByRole('heading', { name: 'Đăng nhập lại' });
    expect(requireLogin).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
