import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ApiClient, ApiError, apiClient } from '../../api/client';
import { AuthProvider } from '../auth/AuthProvider';
import { ProtectedRoute } from '../auth/AuthRoutes';
import { resolveReturnTo } from '../auth/auth.routes';
import type { AuthSnapshot } from '../auth/auth.types';
import { UserForm } from './UserForm';
import { UsersPage } from './UsersPage';
import { usersApi, type UserAccount, type UserRole } from './users.api';

const account: UserAccount = { id: 'a'.repeat(24), fullName: 'Test Admin', phone: '+84901234567', email: 'admin@example.com',
  roleCode: 'ADMIN', roleName: 'Quản trị viên', status: 'ACTIVE', version: 0, createdAt: '2026-10-23T01:00:00.000Z', updatedAt: '2026-10-23T01:00:00.000Z' };
const roles: UserRole[] = [{ code: 'ADMIN', name: 'Quản trị viên' }, { code: 'MEMBER', name: 'Hội viên' }];
const page = { items: [account], page: 1, limit: 20, total: 1, totalPages: 1 };
const password = '  exact password 123  ';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function fillCreate() {
  fireEvent.change(screen.getByLabelText('Họ tên'), { target: { value: 'New Member' } });
  fireEvent.change(screen.getByLabelText('Số điện thoại'), { target: { value: '0901234568' } });
  fireEvent.change(screen.getByLabelText('Vai trò'), { target: { value: 'MEMBER' } });
  fireEvent.change(screen.getByLabelText('Mật khẩu ban đầu'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Xác nhận mật khẩu'), { target: { value: password } });
}

function renderPage(snapshot: AuthSnapshot = { status: 'authenticated', user: account }) {
  vi.spyOn(apiClient, 'getSnapshot').mockReturnValue(snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
  function LoginDestination() { const location = useLocation(); return <h2>Đăng nhập lại {location.search}</h2>; }
  return render(<MemoryRouter initialEntries={['/admin/users']}><AuthProvider><Routes>
    <Route element={<ProtectedRoute role="ADMIN" />}><Route path="/admin/users" element={<UsersPage />} /></Route>
    <Route path="/login" element={<LoginDestination />} />
  </Routes></AuthProvider></MemoryRouter>);
}

describe('US-06 create/edit form', () => {
  it('validates confirm password locally, submits only API fields and prevents duplicate submit', async () => {
    const onSaved = vi.fn();
    let finish!: (value: UserAccount) => void;
    const create = vi.spyOn(usersApi, 'create').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<UserForm roles={roles} onClose={vi.fn()} onSaved={onSaved} onReload={vi.fn()} />);
    fillCreate();
    fireEvent.change(screen.getByLabelText('Xác nhận mật khẩu'), { target: { value: 'wrong confirmation' } });
    await userEvent.click(screen.getByRole('button', { name: 'Tạo tài khoản' }));
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('không khớp');
    fireEvent.change(screen.getByLabelText('Xác nhận mật khẩu'), { target: { value: password } });
    await userEvent.dblClick(screen.getByRole('button', { name: 'Tạo tài khoản' }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ fullName: 'New Member', phone: '0901234568', password, roleCode: 'MEMBER' });
    expect(screen.getByRole('button', { name: 'Đang lưu…' })).toHaveProperty('disabled', true);
    finish(account);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(account, true, false));
  });

  it.each([
    new ApiError('Dữ liệu không hợp lệ', 400, 'req-validation', [{ field: 'phone', message: 'Số điện thoại không hợp lệ' }], undefined, 'VALIDATION_ERROR'),
    new ApiError('Số điện thoại đã tồn tại', 409, 'req-duplicate', [{ field: 'phone', message: 'Số điện thoại đã tồn tại' }], undefined, 'PHONE_ALREADY_EXISTS'),
  ])('renders server field errors and keeps the draft (%s)', async failure => {
    vi.spyOn(usersApi, 'create').mockRejectedValue(failure);
    render(<UserForm roles={roles} onClose={vi.fn()} onSaved={vi.fn()} onReload={vi.fn()} />);
    fillCreate();
    await userEvent.click(screen.getByRole('button', { name: 'Tạo tài khoản' }));
    await waitFor(() => expect(screen.getByLabelText('Số điện thoại').getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByLabelText('Số điện thoại')).toHaveProperty('value', '0901234568');
    expect(screen.getByLabelText('Họ tên')).toHaveProperty('value', 'New Member');
    expect(screen.getByText(`Mã tra cứu: ${failure.requestId}`)).toBeDefined();
  });

  it('edit omits security fields, uses the original version and explicitly removes blank email', async () => {
    const update = vi.spyOn(usersApi, 'update').mockResolvedValue({ ...account, email: undefined, version: 1 });
    render(<UserForm account={account} roles={roles} onClose={vi.fn()} onSaved={vi.fn()} onReload={vi.fn()} />);
    expect(screen.queryByLabelText('Mật khẩu ban đầu')).toBeNull();
    expect(screen.queryByLabelText('Vai trò')).toBeNull();
    expect(screen.queryByLabelText('Trạng thái')).toBeNull();
    fireEvent.change(screen.getByLabelText('Email (tùy chọn)'), { target: { value: '' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(account.id, { email: null, version: 0 }));
  });

  it('version conflict retains draft and reloads only after explicit confirmation', async () => {
    const reload = vi.fn();
    const update = vi.spyOn(usersApi, 'update').mockRejectedValue(new ApiError('Tài khoản đã thay đổi', 409, undefined, undefined, undefined, 'VERSION_CONFLICT'));
    render(<UserForm account={account} roles={roles} onClose={vi.fn()} onSaved={vi.fn()} onReload={reload} />);
    fireEvent.change(screen.getByLabelText('Họ tên'), { target: { value: 'My Unsaved Name' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    expect(await screen.findByText('Tài khoản đã thay đổi')).toBeDefined();
    expect(screen.getByLabelText('Họ tên')).toHaveProperty('value', 'My Unsaved Name');
    expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toHaveProperty('disabled', true);
    expect(update).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Tải bản mới' }));
    expect(reload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Giữ bản nháp' }));
    expect(reload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Tải bản mới' }));
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận tải lại' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a lost POST response preserves input, warns to search first and never auto resubmits', async () => {
    const create = vi.spyOn(usersApi, 'create').mockRejectedValue(new ApiError('Mất kết nối'));
    render(<UserForm roles={roles} onClose={vi.fn()} onSaved={vi.fn()} onReload={vi.fn()} />);
    fillCreate();
    await userEvent.click(screen.getByRole('button', { name: 'Tạo tài khoản' }));
    expect(await screen.findByText(/Yêu cầu có thể đã được xử lý/)).toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Họ tên')).toHaveProperty('value', 'New Member');
  });
});

describe('US-06 Admin route and list/detail integration', () => {
  beforeEach(() => {
    vi.spyOn(usersApi, 'list').mockResolvedValue(page);
    vi.spyOn(usersApi, 'roles').mockResolvedValue({ items: roles });
    vi.spyOn(usersApi, 'detail').mockResolvedValue(account);
  });

  it.each(['MEMBER', 'STAFF', 'TRAINER'] as const)('denies %s before making Users API calls', async roleCode => {
    renderPage({ status: 'authenticated', user: { ...account, roleCode } });
    expect(screen.getByRole('alert').textContent).toContain('không có quyền');
    expect(usersApi.list).not.toHaveBeenCalled();
  });

  it('keeps Users hidden while checking, and redirects anonymous users to login with returnTo', () => {
    renderPage({ status: 'checking', user: null });
    expect(screen.queryByRole('heading', { name: 'Quản lý tài khoản' })).toBeNull();
    expect(usersApi.list).not.toHaveBeenCalled();
    cleanup(); vi.restoreAllMocks();
    renderPage({ status: 'anonymous', user: null });
    expect(screen.getByRole('heading').textContent).toContain('returnTo=%2Fadmin%2Fusers');
    expect(resolveReturnTo('/admin/users?q=test', 'ADMIN')).toBe('/admin/users?q=test');
    expect(resolveReturnTo('/admin/users', 'MEMBER')).toBe('/member');
  });

  it('filters, pages and loads current detail before editing', async () => {
    vi.mocked(usersApi.list).mockResolvedValue({ ...page, total: 30, totalPages: 2 });
    renderPage();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Test Admin')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
    await waitFor(() => expect(usersApi.list).toHaveBeenLastCalledWith({ page: 2, limit: 20 }, expect.any(AbortSignal)));
    fireEvent.change(screen.getByLabelText('Tìm tên, email hoặc số điện thoại'), { target: { value: '[.*]' } });
    fireEvent.change(screen.getByLabelText('Lọc vai trò'), { target: { value: 'ADMIN' } });
    await userEvent.click(screen.getByRole('button', { name: 'Áp dụng bộ lọc' }));
    await waitFor(() => expect(usersApi.list).toHaveBeenLastCalledWith({ page: 1, limit: 20, q: '[.*]', roleCode: 'ADMIN', status: '' }, expect.any(AbortSignal)));
    await userEvent.click(await screen.findByRole('button', { name: 'Xem và sửa Test Admin' }));
    expect(await screen.findByRole('heading', { name: 'Thông tin tài khoản' })).toBeDefined();
    expect(usersApi.detail).toHaveBeenCalledWith(account.id, expect.any(AbortSignal));
  });

  it('shows created ID even when the following list load fails, and reload never repeats POST', async () => {
    const create = vi.spyOn(usersApi, 'create').mockResolvedValue({ ...account, id: 'b'.repeat(24) });
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo tài khoản mới' }));
    fillCreate();
    vi.mocked(usersApi.list).mockRejectedValueOnce(new ApiError('List offline'));
    await userEvent.click(screen.getByRole('button', { name: 'Tạo tài khoản' }));
    expect(await screen.findByText(`Đã tạo tài khoản ${'b'.repeat(24)}.`)).toBeDefined();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'List offline Hãy dùng nút tải lại danh sách.');
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách' }));
    await screen.findByRole('table');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['phone', 'email'] as const)('own %s change clears local access and navigates to login without refreshing', async field => {
    const requireLogin = vi.spyOn(apiClient, 'requireLogin').mockImplementation(() => {});
    const refresh = vi.spyOn(apiClient, 'refreshSession');
    const value = field === 'phone' ? '+84908888888' : 'new@example.com';
    vi.spyOn(usersApi, 'update').mockResolvedValue({ ...account, [field]: value, version: 1 });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Xem và sửa Test Admin' }));
    fireEvent.change(await screen.findByLabelText(field === 'phone' ? 'Số điện thoại' : 'Email (tùy chọn)'), { target: { value } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    expect(await screen.findByRole('heading', { name: /Đăng nhập lại/ })).toHaveProperty('textContent', 'Đăng nhập lại ?reason=identity-changed');
    expect(requireLogin).toHaveBeenCalledTimes(1); expect(refresh).not.toHaveBeenCalled();
  });

  it('own name change keeps the session and updates the shared display name', async () => {
    const requireLogin = vi.spyOn(apiClient, 'requireLogin');
    const updateCurrentUser = vi.spyOn(apiClient, 'updateCurrentUser').mockImplementation(() => {});
    vi.spyOn(usersApi, 'update').mockResolvedValue({ ...account, fullName: 'New Admin Name', version: 1 });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Xem và sửa Test Admin' }));
    fireEvent.change(await screen.findByLabelText('Họ tên'), { target: { value: 'New Admin Name' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    await screen.findByText(`Đã lưu tài khoản ${account.id}.`);
    expect(requireLogin).not.toHaveBeenCalled();
    expect(updateCurrentUser).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'New Admin Name' }));
  });

  it('handles an empty list and allows retry when roles are unavailable', async () => {
    vi.mocked(usersApi.list).mockResolvedValue({ ...page, items: [], total: 0, totalPages: 0 });
    vi.mocked(usersApi.roles).mockRejectedValueOnce(new ApiError('Roles offline'));
    renderPage();
    expect(await screen.findByText('Không có tài khoản phù hợp.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Tạo tài khoản mới' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại vai trò' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tạo tài khoản mới' })).toHaveProperty('disabled', false));
  });
});

describe('US-06 shared client safety', () => {
  it('retains server error code and never retries POST on an ambiguous network failure', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { code: 'VERSION_CONFLICT', message: 'Conflict' } }, 409))
      .mockRejectedValueOnce(new TypeError('offline'));
    const client = new ApiClient('http://localhost:3000/api', transport);
    await expect(client.request('/users/id', { method: 'PATCH' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(client.request('/users', { method: 'POST' })).rejects.toBeInstanceOf(ApiError);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('discarding local access prevents an in-flight refresh from restoring the old session', async () => {
    let complete!: (response: Response) => void;
    const transport = vi.fn<typeof fetch>().mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const client = new ApiClient('http://localhost:3000/api', transport);
    const refresh = client.refreshSession();
    client.requireLogin();
    complete(json({ accessToken: 'old-access', user: account }));
    await expect(refresh).rejects.toMatchObject({ status: 401 });
    expect(client.getSnapshot()).toEqual({ status: 'anonymous', user: null });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('a stale refresh cannot clear a newly logged-in session after identity changes', async () => {
    let complete!: (response: Response) => void;
    const transport = vi.fn<typeof fetch>().mockReturnValueOnce(new Promise(resolve => { complete = resolve; }))
      .mockResolvedValueOnce(json({ accessToken: 'new-access', user: account }));
    const client = new ApiClient('http://localhost:3000/api', transport);
    const oldRefresh = client.refreshSession();
    client.requireLogin();
    await client.login(account.phone, password);
    complete(json({ accessToken: 'old-access', user: account }));
    await expect(oldRefresh).rejects.toMatchObject({ status: 401 });
    expect(client.getSnapshot()).toEqual({ status: 'authenticated', user: account });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
