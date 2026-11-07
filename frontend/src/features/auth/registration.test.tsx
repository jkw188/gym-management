import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ApiClient, ApiError, apiClient } from '../../api/client';
import { AuthProvider } from './AuthProvider';
import { LoginPage } from './LoginPage';
import { RegisterPage } from './RegisterPage';
import { registrationApi, type RegisterResult } from './registration.api';
import { rolePaths } from './auth.routes';
import type { AuthSnapshot, RoleCode } from './auth.types';

const password = '  Mật khẩu US-01 😀  ';
const input = { fullName: 'Nguyễn Văn A', phone: '0901234567', password };
const result: RegisterResult = { id: 'a'.repeat(24), nextAction: 'LOGIN' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Path() { const location = useLocation(); return <div aria-label="Đường dẫn">{location.pathname + location.search}</div>; }
function setup(snapshot: AuthSnapshot = { status: 'anonymous', user: null }) {
  vi.spyOn(apiClient, 'getSnapshot').mockReturnValue(snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
  return render(<MemoryRouter initialEntries={['/register']}><AuthProvider><Path /><Routes>
    <Route path="/register" element={<RegisterPage />} /><Route path="/login" element={<LoginPage />} />
    {Object.values(rolePaths).map(path => <Route key={path} path={path} element={<p>Không gian tài khoản</p>} />)}
  </Routes></AuthProvider></MemoryRouter>);
}
async function fill(browser: ReturnType<typeof userEvent.setup>, email?: string) {
  await browser.type(screen.getByLabelText('Họ tên'), input.fullName);
  await browser.type(screen.getByLabelText('Số điện thoại'), input.phone);
  if (email) await browser.type(screen.getByLabelText('Email (tùy chọn)'), email);
  await browser.type(screen.getByLabelText('Mật khẩu'), password);
  await browser.type(screen.getByLabelText('Xác nhận mật khẩu'), password);
}

describe('US-01 public registration client', () => {
  it.each([409, 503, 401])('sends one POST on status %s and never refreshes or authenticates', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { code: 'REGISTRATION_CONFLICT', message: 'Không đăng ký được' } }, status));
    const client = new ApiClient('http://localhost:3000/api', fetcher);
    await expect(client.publicPost('/auth/register', input)).rejects.toMatchObject({ status });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('http://localhost:3000/api/auth/register');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
    expect(client.getAccessToken()).toBeNull();
  });

  it('does not repeat a POST after transport failure or a lost/malformed success response', async () => {
    for (const fetcher of [vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline')),
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{', { status: 201 }))]) {
      const client = new ApiClient('http://localhost:3000/api', fetcher);
      await expect(client.publicPost('/auth/register', input)).rejects.toBeInstanceOf(ApiError);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});

describe('US-01 RegisterPage acceptance', () => {
  it.each([undefined, 'member@example.com'])('TC01/13: submits allowed fields only, blocks double submit, and reaches login (email=%s)', async email => {
    setup();
    const browser = userEvent.setup();
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const login = vi.spyOn(apiClient, 'login');
    let complete!: (value: RegisterResult) => void;
    const register = vi.spyOn(registrationApi, 'register').mockReturnValue(new Promise(resolve => { complete = resolve; }));
    await fill(browser, email);
    const passwordInput = screen.getByLabelText('Mật khẩu') as HTMLInputElement;
    expect(passwordInput.type).toBe('password');
    await browser.click(screen.getByRole('button', { name: 'Hiện mật khẩu' }));
    expect(passwordInput.type).toBe('text');
    expect(screen.getByLabelText('Xác nhận mật khẩu')).toHaveProperty('type', 'text');
    await browser.dblClick(screen.getByRole('button', { name: 'Đăng ký' }));
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({ ...input, ...(email ? { email } : {}) });
    expect(screen.getByRole('button', { name: 'Đang đăng ký…' })).toHaveProperty('disabled', true);
    expect(passwordInput.matches(':disabled')).toBe(true);
    complete(result);
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain('Đã tạo tài khoản');
    expect(screen.getByLabelText('Đường dẫn').textContent).toBe('/login?reason=registered');
    expect(screen.getByLabelText('Mật khẩu')).toHaveProperty('value', '');
    expect(login).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
  });

  it('TC03/13: local invalid fields and confirm mismatch focus the first error; keyboard submit works', async () => {
    setup(); const browser = userEvent.setup();
    const register = vi.spyOn(registrationApi, 'register').mockResolvedValue(result);
    await browser.click(screen.getByRole('button', { name: 'Đăng ký' }));
    expect(register).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Họ tên')));
    await fill(browser);
    await browser.clear(screen.getByLabelText('Xác nhận mật khẩu'));
    await browser.type(screen.getByLabelText('Xác nhận mật khẩu'), 'wrong');
    await browser.keyboard('{Enter}');
    expect(await screen.findByText('Xác nhận mật khẩu không khớp.')).toBeDefined();
    expect(register).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Xác nhận mật khẩu')));
    await browser.clear(screen.getByLabelText('Xác nhận mật khẩu'));
    await browser.type(screen.getByLabelText('Xác nhận mật khẩu'), password);
    await browser.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeDefined();
  });

  it('TC13: backend field errors render beside the field with focus and preserved draft', async () => {
    setup(); const browser = userEvent.setup();
    vi.spyOn(registrationApi, 'register').mockRejectedValue(new ApiError('Dữ liệu không hợp lệ', 400, 'request-1', [{ field: 'phone', message: 'Số điện thoại không hợp lệ trên server' }]));
    await fill(browser); await browser.click(screen.getByRole('button', { name: 'Đăng ký' }));
    const phone = screen.getByLabelText('Số điện thoại');
    expect(await screen.findByText('Số điện thoại không hợp lệ trên server')).toBeDefined();
    expect(phone.getAttribute('aria-describedby')).toBe('register-phone-error');
    await waitFor(() => expect(document.activeElement).toBe(phone));
    expect(screen.getByLabelText('Họ tên')).toHaveProperty('value', input.fullName);
    expect(screen.getByLabelText('Mật khẩu')).toHaveProperty('value', password);
  });

  it.each([
    new ApiError('Không thể dùng thông tin định danh', 409, undefined, undefined, undefined, 'REGISTRATION_CONFLICT'),
    new ApiError('Vui lòng liên hệ quầy để hỗ trợ', 409, undefined, undefined, undefined, 'REGISTRATION_NEEDS_HELP'),
    new ApiError('Vai trò chưa được cấu hình', 409, undefined, undefined, undefined, 'ROLE_NOT_CONFIGURED'),
    new ApiError('Quá nhiều yêu cầu', 429, undefined, undefined, 60, 'TOO_MANY_REQUESTS'),
    new ApiError('Dịch vụ chưa sẵn sàng', 503, undefined, undefined, undefined, 'SERVICE_UNAVAILABLE'),
    new ApiError('Không kết nối được máy chủ'),
  ])('TC08/10–13: preserves input and safely shows %s without an automatic resubmit', async error => {
    setup(); const browser = userEvent.setup();
    const register = vi.spyOn(registrationApi, 'register').mockRejectedValue(error);
    await fill(browser); await browser.click(screen.getByRole('button', { name: 'Đăng ký' }));
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(alert.textContent).toContain(error.status === undefined ? 'Chưa xác định được kết quả đăng ký' : error.message);
    if (error.retryAfter) expect(alert.textContent).toContain('60 giây');
    expect(screen.getByLabelText('Số điện thoại')).toHaveProperty('value', input.phone);
    expect(screen.getByRole('link', { name: 'Chuyển sang đăng nhập' })).toHaveProperty('href', expect.stringContaining('/login'));
    expect(register).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Đăng ký' })).toHaveProperty('disabled', false);
  });

  it.each(Object.keys(rolePaths) as RoleCode[])('authenticated %s is redirected to their role page', roleCode => {
    const register = vi.spyOn(registrationApi, 'register');
    setup({ status: 'authenticated', user: { id: result.id, fullName: 'Test', phone: input.phone, roleCode } });
    expect(screen.getByText('Không gian tài khoản')).toBeDefined();
    expect(screen.getByLabelText('Đường dẫn').textContent).toBe(rolePaths[roleCode]);
    expect(register).not.toHaveBeenCalled();
  });

  it('does not show the registration form before session restore or during logout', () => {
    setup({ status: 'checking', user: null });
    expect(screen.queryByRole('button', { name: 'Đăng ký' })).toBeNull();
    cleanup(); vi.restoreAllMocks();
    setup({ status: 'loggingOut', user: null });
    expect(screen.queryByRole('button', { name: 'Đăng ký' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Đang đăng xuất…' })).toBeDefined();
  });
});
