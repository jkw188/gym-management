import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError, apiClient } from '../../api/client';
import { AuthProvider } from '../auth/AuthProvider';
import { AccountRoleDialog } from './AccountRoleDialog';
import { UsersPage } from './UsersPage';
import { usersApi, type AccessRole, type ChangeStatusResult, type UserAccount } from './users.api';

const account: UserAccount = { id: 'a'.repeat(24), fullName: 'Test Admin', phone: '+84901234567', roleCode: 'ADMIN', roleName: 'Admin',
  status: 'ACTIVE', version: 4, createdAt: '2026-10-25T01:00:00Z', updatedAt: '2026-10-25T01:00:00Z' };
const reason = 'Điều chỉnh trách nhiệm tài khoản';
const roles: AccessRole[] = [
  { code: 'ADMIN', name: 'Admin', permissions: [{ code: 'accounts.changeRole', name: 'Phân quyền tài khoản' }, { code: 'auth.me', name: 'Xem phiên' }] },
  { code: 'STAFF', name: 'Nhân viên', permissions: [{ code: 'auth.me', name: 'Xem phiên' }] },
  { code: 'TRAINER', name: 'PT', permissions: [{ code: 'auth.me', name: 'Xem phiên' }] },
  { code: 'MEMBER', name: 'Hội viên', permissions: [{ code: 'auth.me', name: 'Xem phiên' }] },
];
const changed: ChangeStatusResult = { user: { ...account, roleCode: 'STAFF', roleName: 'Nhân viên', version: 5 }, changed: true, reauthenticationRequired: false };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.spyOn(usersApi, 'statusDetail').mockResolvedValue(account);
  vi.spyOn(usersApi, 'accessRoles').mockResolvedValue({ items: roles });
});

function show(ownAccount = false, strict = false) {
  const callbacks = { onSaved: vi.fn(), onClose: vi.fn(), onUnauthenticated: vi.fn() };
  const component = <AccountRoleDialog id={account.id} ownAccount={ownAccount} {...callbacks} />;
  render(strict ? <StrictMode>{component}</StrictMode> : component);
  return callbacks;
}
async function fill() {
  await screen.findByLabelText('Vai trò đích');
  fireEvent.change(screen.getByLabelText('Vai trò đích'), { target: { value: 'STAFF' } });
  fireEvent.change(screen.getByLabelText('Lý do đổi vai trò'), { target: { value: `  ${reason}  ` } });
  fireEvent.click(screen.getByRole('checkbox'));
}
const submitButton = () => screen.getByRole('button', { name: 'Xác nhận phân quyền' }) as HTMLButtonElement;

describe('US-08 TC16: role dialog and UsersPage', () => {
  it('shows the current role/version, fixed matrix and a single role; validates reason and confirmation', async () => {
    const submit = vi.spyOn(usersApi, 'changeRole').mockResolvedValue(changed);
    const callbacks = show();
    await screen.findByLabelText('Vai trò đích');
    expect(screen.getByRole('table', { name: 'Ma trận quyền cố định' })).toBeDefined();
    expect((screen.getByLabelText('Vai trò đích') as HTMLSelectElement).multiple).toBe(false);
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(submitButton().disabled).toBe(true);
    await fill();
    fireEvent.change(screen.getByLabelText('Lý do đổi vai trò'), { target: { value: ' short ' } });
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(submitButton());
    expect(submit).not.toHaveBeenCalled(); expect(screen.getByRole('alert').textContent).toContain('10–500');
    fireEvent.change(screen.getByLabelText('Lý do đổi vai trò'), { target: { value: `  ${reason}  ` } });
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(submitButton());
    await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledWith(changed));
    expect(submit).toHaveBeenCalledExactlyOnceWith(account.id, { roleCode: 'STAFF', version: 4, reason });
  });

  it('blocks duplicate submit/close while waiting and updates only after 200', async () => {
    let finish!: (result: ChangeStatusResult) => void;
    const submit = vi.spyOn(usersApi, 'changeRole').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const callbacks = show(); await fill();
    const form = submitButton().closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(submit).toHaveBeenCalledTimes(1); expect(callbacks.onSaved).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Đóng' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Admin — Hoạt động — phiên bản 4/)).toBeDefined();
    await act(async () => finish(changed));
    expect(callbacks.onSaved).toHaveBeenCalledWith(changed);
  });

  it.each(['VERSION_CONFLICT', 'LAST_ACTIVE_ADMIN', 'ROLE_IN_USE', 'ROLE_NOT_CONFIGURED'])('409 %s preserves draft and requires explicit reload/reconfirmation without retry', async code => {
    const submit = vi.spyOn(usersApi, 'changeRole').mockRejectedValue(new ApiError(code, 409, 'request-us08', undefined, undefined, code));
    show(); await fill(); fireEvent.click(submitButton());
    await screen.findByText(new RegExp(`${code}.*request-us08`));
    expect(submitButton().disabled).toBe(true);
    expect((screen.getByLabelText('Vai trò đích') as HTMLSelectElement).value).toBe('STAFF');
    expect((screen.getByLabelText('Lý do đổi vai trò') as HTMLTextAreaElement).value.trim()).toBe(reason);
    vi.mocked(usersApi.statusDetail).mockResolvedValueOnce({ ...account, version: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại tài khoản và quyền' }));
    await screen.findByText(/phiên bản 5/);
    expect(submit).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Vai trò đích') as HTMLSelectElement).value).toBe('STAFF');
  });

  it.each([new ApiError('Mất kết nối'), new ApiError('Chưa xác định', 503)])('lost response/503 requires GET and cannot report success or replay', async failure => {
    const submit = vi.spyOn(usersApi, 'changeRole').mockRejectedValue(failure);
    const callbacks = show(); await fill(); fireEvent.click(submitButton());
    await screen.findByText(/Chưa xác định được kết quả thao tác/);
    expect(submitButton().disabled).toBe(true); expect(callbacks.onSaved).not.toHaveBeenCalled();
    vi.mocked(usersApi.statusDetail).mockResolvedValueOnce(changed.user);
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại tài khoản và quyền' }));
    await screen.findByText(/Nhân viên — Hoạt động — phiên bản 5/);
    expect(submit).toHaveBeenCalledTimes(1); expect(callbacks.onSaved).not.toHaveBeenCalled();
  });

  it('self-demotion warns about login and GET 401 after uncertain response returns to login without refresh', async () => {
    vi.spyOn(usersApi, 'changeRole').mockRejectedValue(new ApiError('Mất kết nối'));
    const refresh = vi.spyOn(apiClient, 'refreshSession');
    const callbacks = show(true); await fill();
    expect(screen.getByText(/Bạn đang tự hạ quyền Admin/)).toBeDefined();
    fireEvent.click(submitButton()); await screen.findByText(/Chưa xác định được kết quả thao tác/);
    vi.mocked(usersApi.statusDetail).mockRejectedValueOnce(new ApiError('Đăng nhập lại', 401));
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại tài khoản và quyền' }));
    await waitFor(() => expect(callbacks.onUnauthenticated).toHaveBeenCalledTimes(1));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('catalog configuration failure and empty catalog block changes; StrictMode reload can recover', async () => {
    vi.mocked(usersApi.accessRoles).mockRejectedValue(new ApiError('PERMISSION_CATALOG_NOT_READY', 503));
    const submit = vi.spyOn(usersApi, 'changeRole');
    show(false, true);
    await screen.findByText('PERMISSION_CATALOG_NOT_READY');
    expect(screen.queryByLabelText('Vai trò đích')).toBeNull();
    vi.mocked(usersApi.accessRoles).mockResolvedValueOnce({ items: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại tài khoản và quyền' }));
    await screen.findByText(/Danh mục quyền chưa đủ bốn vai trò/);
    vi.mocked(usersApi.accessRoles).mockResolvedValueOnce({ items: roles });
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại tài khoản và quyền' }));
    await screen.findByLabelText('Vai trò đích'); expect(submitButton().disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it('role PATCH and catalog GET use requestOnce so 401 cannot refresh or replay', async () => {
    vi.mocked(usersApi.accessRoles).mockRestore();
    const once = vi.spyOn(apiClient, 'requestOnce').mockResolvedValueOnce({ items: roles }).mockRejectedValueOnce(new ApiError('Đăng nhập lại', 401));
    const request = vi.spyOn(apiClient, 'request');
    await usersApi.accessRoles();
    await expect(usersApi.changeRole(account.id, { roleCode: 'STAFF', version: 4, reason })).rejects.toMatchObject({ status: 401 });
    expect(once).toHaveBeenCalledTimes(2); expect(request).not.toHaveBeenCalled();
    expect(JSON.parse((once.mock.calls[1][1] as RequestInit).body as string)).toEqual({ roleCode: 'STAFF', version: 4, reason });
  });

  it('UsersPage clears cached auth and navigates to login after successful self-demotion', async () => {
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: account });
    vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
    vi.spyOn(apiClient, 'restore').mockResolvedValue();
    const requireLogin = vi.spyOn(apiClient, 'requireLogin').mockImplementation(() => {});
    const refresh = vi.spyOn(apiClient, 'refreshSession');
    vi.spyOn(usersApi, 'roles').mockResolvedValue({ items: roles });
    vi.spyOn(usersApi, 'list').mockResolvedValue({ items: [account], page: 1, limit: 20, total: 1, totalPages: 1 });
    vi.spyOn(usersApi, 'changeRole').mockResolvedValue({ ...changed, reauthenticationRequired: true });
    render(<MemoryRouter initialEntries={['/admin/users']}><AuthProvider><Routes>
      <Route path="/admin/users" element={<UsersPage />} /><Route path="/login" element={<h2>Đăng nhập lại</h2>} />
    </Routes></AuthProvider></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Phân quyền Test Admin' }));
    await fill(); fireEvent.click(submitButton());
    await screen.findByRole('heading', { name: 'Đăng nhập lại' });
    expect(requireLogin).toHaveBeenCalledTimes(1); expect(refresh).not.toHaveBeenCalled();
  });
});
