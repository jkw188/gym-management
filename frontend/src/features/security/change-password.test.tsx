// Tầng kiểm thử frontend (Vitest): form đổi mật khẩu của US-67 bước 3.
// Test trang giả lập securityApi; riêng phần "không tự gửi lại" dùng ApiClient thật với fetch giả.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError, apiClient } from '../../api/client';
import { ChangePasswordPage } from './ChangePasswordPage';
import { securityApi } from './security.api';

const currentPassword = '  Mật khẩu cũ có dấu cách  ';
const newPassword = 'MậtKhẩuMới-US67-456';
const success = { message: 'Đã đổi mật khẩu, vui lòng đăng nhập lại', reauthenticationRequired: true as const };

function LoginProbe() {
  const location = useLocation();
  return <p>Trang đăng nhập {location.search}</p>;
}

function renderPage() {
  return render(<MemoryRouter initialEntries={['/member/security']}><Routes>
    <Route path="/member/security" element={<ChangePasswordPage />} />
    <Route path="/login" element={<LoginProbe />} />
  </Routes></MemoryRouter>);
}

async function fillForm(confirm = newPassword) {
  await userEvent.type(screen.getByLabelText('Mật khẩu hiện tại'), currentPassword);
  await userEvent.type(screen.getByLabelText('Mật khẩu mới'), newPassword);
  await userEvent.type(screen.getByLabelText('Xác nhận mật khẩu mới'), confirm);
}

function submitButton() {
  return screen.getByRole('button', { name: 'Đổi mật khẩu' });
}

async function submitForm(confirm = newPassword) {
  await fillForm(confirm);
  await userEvent.click(submitButton());
}

function apiError(message: string, status?: number, code?: string, details?: { field: string; message: string }[], retryAfter?: number) {
  return new ApiError(message, status, undefined, details, retryAfter, code);
}

describe('US-67 trang đổi mật khẩu', () => {
  let requireLogin: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    requireLogin = vi.spyOn(apiClient, 'requireLogin').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('US-67-TC13: form có nhãn cho 3 ô mật khẩu, mặc định ẩn và bấm nút thì hiện', async () => {
    renderPage();

    for (const label of ['Mật khẩu hiện tại', 'Mật khẩu mới', 'Xác nhận mật khẩu mới']) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.type).toBe('password');
      await userEvent.click(screen.getByRole('button', { name: `Hiện ${label.toLowerCase()}` }));
      expect(input.type).toBe('text');
      await userEvent.click(screen.getByRole('button', { name: `Ẩn ${label.toLowerCase()}` }));
      expect(input.type).toBe('password');
    }
  });

  it('US-67-TC13: xác nhận không khớp thì không gọi API, báo lỗi và focus đúng ô', async () => {
    const change = vi.spyOn(securityApi, 'changePassword').mockResolvedValue(success);
    renderPage();

    await submitForm('KhácMậtKhẩuMới-US67');

    expect(change).not.toHaveBeenCalled();
    const confirm = screen.getByLabelText('Xác nhận mật khẩu mới');
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    expect(confirm.getAttribute('aria-invalid')).toBe('true');
  });

  it('US-67-TC13: chỉ gửi currentPassword và newPassword nguyên văn, không gửi confirm', async () => {
    const change = vi.spyOn(securityApi, 'changePassword').mockResolvedValue(success);
    renderPage();

    await submitForm();

    expect(change).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledWith({ currentPassword, newPassword });
  });

  it('US-67-TC13: đang gửi thì nút bị khóa, bấm nhiều lần chỉ gọi API một lần', async () => {
    let finish: (value: typeof success) => void = () => {};
    const change = vi.spyOn(securityApi, 'changePassword').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    renderPage();
    await fillForm();

    await userEvent.click(submitButton());
    await userEvent.click(submitButton());

    expect(change).toHaveBeenCalledTimes(1);
    expect(submitButton()).toHaveProperty('disabled', true);
    expect(requireLogin).not.toHaveBeenCalled(); // Chưa có 200 thì chưa được xóa auth.
    finish(success);
    await screen.findByText(/Trang đăng nhập/);
  });

  it('US-67-TC13: nhận 200 thì xóa auth một lần và chuyển về đăng nhập kèm thông báo đã đổi', async () => {
    vi.spyOn(securityApi, 'changePassword').mockResolvedValue(success);
    renderPage();

    await submitForm();

    expect(await screen.findByText('Trang đăng nhập ?reason=password-changed')).toBeDefined();
    expect(requireLogin).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['CURRENT_PASSWORD_INVALID', 'Mật khẩu hiện tại không đúng', 'Mật khẩu hiện tại'],
    ['PASSWORD_UNCHANGED', 'Mật khẩu mới phải khác mật khẩu hiện tại', 'Mật khẩu mới'],
  ])('US-67-TC13: lỗi %s hiện đúng ô, focus ô đó và giữ phiên để thử lại', async (code, message, label) => {
    vi.spyOn(securityApi, 'changePassword').mockRejectedValue(apiError(message, 400, code));
    renderPage();

    await submitForm();

    const input = screen.getByLabelText(label);
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(message)).toBeDefined();
    expect(requireLogin).not.toHaveBeenCalled();
    expect(submitButton()).toHaveProperty('disabled', false);
  });

  it('US-67-TC13: lỗi VALIDATION_ERROR của newPassword hiện đúng ô và focus ô đó', async () => {
    vi.spyOn(securityApi, 'changePassword').mockRejectedValue(apiError('Dữ liệu không hợp lệ', 400, 'VALIDATION_ERROR',
      [{ field: 'newPassword', message: 'Mật khẩu không được chứa khoảng trắng' }]));
    renderPage();

    await submitForm();

    const input = screen.getByLabelText('Mật khẩu mới');
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(screen.getByText('Mật khẩu không được chứa khoảng trắng')).toBeDefined();
  });

  it('US-67-TC10: bị 429 thì hiện thông báo giới hạn, không xóa phiên và không tự gửi lại', async () => {
    const change = vi.spyOn(securityApi, 'changePassword').mockRejectedValue(apiError('Quá nhiều lần thử', 429, 'TOO_MANY_REQUESTS', undefined, 600));
    renderPage();

    await submitForm();

    expect(await screen.findByText(/Quá nhiều lần thử/)).toBeDefined();
    expect(requireLogin).not.toHaveBeenCalled();
    expect(change).toHaveBeenCalledTimes(1);
  });

  // US-67-TC11: không biết chắc mật khẩu đã đổi hay chưa thì về đăng nhập, không tự gửi lại.
  it.each([
    ['mất kết nối hoặc mất response', apiError('Không kết nối được máy chủ.')],
    ['máy chủ trả 503', apiError('Dịch vụ chưa sẵn sàng', 503, 'SERVICE_UNAVAILABLE')],
  ])('US-67-TC11: %s thì về đăng nhập, không báo chắc chắn và không tự gửi lại', async (_label, error) => {
    const change = vi.spyOn(securityApi, 'changePassword').mockRejectedValue(error);
    renderPage();

    await submitForm();

    expect(await screen.findByText('Trang đăng nhập ?reason=password-unconfirmed')).toBeDefined();
    expect(change).toHaveBeenCalledTimes(1);
    expect(requireLogin).toHaveBeenCalledTimes(1);
  });

  it('US-67-TC13: lỗi 401 CREDENTIALS_CHANGED thì xóa auth và về đăng nhập, không tự gửi lại', async () => {
    const change = vi.spyOn(securityApi, 'changePassword').mockRejectedValue(apiError('Thông tin đăng nhập đã thay đổi', 401, 'CREDENTIALS_CHANGED'));
    renderPage();

    await submitForm();

    expect(await screen.findByText(/Trang đăng nhập/)).toBeDefined();
    expect(change).toHaveBeenCalledTimes(1);
    expect(requireLogin).toHaveBeenCalledTimes(1);
  });

  it('US-67-TC12: mật khẩu không vào URL, localStorage, sessionStorage hoặc console', async () => {
    const logSpies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    vi.spyOn(securityApi, 'changePassword').mockResolvedValue(success);
    renderPage();

    await submitForm();
    const login = await screen.findByText(/Trang đăng nhập/);

    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    const logged = JSON.stringify(logSpies.flatMap(spy => spy.mock.calls));
    for (const secret of [currentPassword, newPassword]) {
      expect(login.textContent).not.toContain(secret);
      expect(stored).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
  });
});


// Dùng ApiClient thật với một "máy chủ giả" trả lời theo đường dẫn.
// Nhờ vậy test không phụ thuộc việc refresh đặt ở trang hay ở tầng gọi API, chỉ kiểm tra kết quả.
describe('US-67 gọi API đổi mật khẩu với ApiClient thật', () => {
  const url = 'http://localhost:3000/api';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const user = { id: 'a'.repeat(24), fullName: 'Test User', phone: '+84901234567', roleCode: 'MEMBER' };
  type ChangePasswordHandler = (token: string | null) => Response | Promise<Response>;

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // login cấp access-1; refresh cấp access-2, hoặc trả 401 (expired), hoặc mất kết nối (offline); change-password do từng test quyết định.
  function fakeServer(changePassword: ChangePasswordHandler, refresh: 'ok' | 'expired' | 'offline' = 'ok') {
    return vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      const token = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '') ?? null;
      if (path.endsWith('/auth/login')) return json({ accessToken: 'access-1', tokenType: 'Bearer', expiresIn: 900, user });
      if (path.endsWith('/auth/refresh')) {
        if (refresh === 'offline') throw new TypeError('offline');
        return refresh === 'expired' ? json({ error: { code: 'UNAUTHORIZED', message: 'Hết phiên' } }, 401)
          : json({ accessToken: 'access-2', tokenType: 'Bearer', expiresIn: 900, user });
      }
      if (path.endsWith('/auth/me')) return json(user);
      if (path.endsWith('/auth/change-password')) return changePassword(token);
      return json({ error: { code: 'NOT_FOUND', message: 'Không có' } }, 404);
    });
  }

  // Nạp lại module với fetch giả, vì apiClient được tạo một lần lúc import.
  async function loadLoggedIn(fetcher: ReturnType<typeof fakeServer>) {
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE_URL', url);
    vi.stubGlobal('fetch', fetcher);
    const client = await import('../../api/client');
    await client.apiClient.login(user.phone, 'password');
    return client;
  }

  function changePasswordCalls(fetcher: ReturnType<typeof fakeServer>) {
    return fetcher.mock.calls.filter(([path]) => String(path).endsWith('/auth/change-password'));
  }

  // Render trang bằng đúng module vừa nạp lại, để trang dùng apiClient có fetch giả.
  async function renderRealPage() {
    const router = await import('react-router-dom');
    const { ChangePasswordPage: RealPage } = await import('./ChangePasswordPage');
    function RealLoginProbe() {
      const location = router.useLocation();
      return <p>Trang đăng nhập {location.search}</p>;
    }
    render(<router.MemoryRouter initialEntries={['/member/security']}><router.Routes>
      <router.Route path="/member/security" element={<RealPage />} />
      <router.Route path="/login" element={<RealLoginProbe />} />
    </router.Routes></router.MemoryRouter>);
  }

  it('US-67-TC13: gọi đúng endpoint một lần, có Bearer và body chỉ có 2 field', async () => {
    const fetcher = fakeServer(() => json(success));
    await loadLoggedIn(fetcher);
    const { securityApi: realApi } = await import('./security.api');

    await realApi.changePassword({ currentPassword, newPassword });

    const calls = changePasswordCalls(fetcher);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]?.method).toBe('POST');
    expect(new Headers(calls[0][1]?.headers).get('Authorization')).toMatch(/^Bearer access-[12]$/);
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ currentPassword, newPassword });
  });

  it('US-67-TC13: nhận 401 CREDENTIALS_CHANGED không refresh rồi gửi lại mật khẩu cũ', async () => {
    const fetcher = fakeServer(() => json({ error: { code: 'CREDENTIALS_CHANGED', message: 'Đã thay đổi' } }, 401));
    await loadLoggedIn(fetcher);
    const { securityApi: realApi } = await import('./security.api');

    await expect(realApi.changePassword({ currentPassword, newPassword })).rejects.toMatchObject({ status: 401, code: 'CREDENTIALS_CHANGED' });

    expect(changePasswordCalls(fetcher)).toHaveLength(1);
  });

  it('US-67-TC11: mất kết nối thì chỉ gửi một lần', async () => {
    const fetcher = fakeServer(() => { throw new TypeError('offline'); });
    await loadLoggedIn(fetcher);
    const { securityApi: realApi } = await import('./security.api');

    await expect(realApi.changePassword({ currentPassword, newPassword })).rejects.toBeInstanceOf(Error);

    expect(changePasswordCalls(fetcher)).toHaveLength(1);
  });

  // Access token chỉ sống 15 phút. Phiên còn gia hạn được thì đổi mật khẩu phải thành công, không bị đẩy về đăng nhập.
  it('US-67-TC13: access token đã hết hạn nhưng phiên còn gia hạn được thì vẫn đổi thành công, chỉ gửi một lần', async () => {
    const fetcher = fakeServer(token => token === 'access-2'
      ? json(success)
      : json({ error: { code: 'UNAUTHORIZED', message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn' } }, 401));
    await loadLoggedIn(fetcher);
    await renderRealPage();

    await submitForm();

    expect(await screen.findByText('Trang đăng nhập ?reason=password-changed')).toBeDefined();
    const calls = changePasswordCalls(fetcher);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0][1]?.headers).get('Authorization')).toBe('Bearer access-2');
  });

  it('US-67-TC13: phiên không gia hạn được thì về đăng nhập và không gửi mật khẩu', async () => {
    const fetcher = fakeServer(() => json({ error: { code: 'UNAUTHORIZED', message: 'Hết phiên' } }, 401), 'expired');
    await loadLoggedIn(fetcher);
    await renderRealPage();

    await submitForm();

    expect(await screen.findByText(/Trang đăng nhập/)).toBeDefined();
    expect(changePasswordCalls(fetcher)).toHaveLength(0);
  });

  // Sinh viên chốt qua /sua-loi (7c7757d): mất kết nối lúc gia hạn phiên thì mật khẩu chưa gửi, nên ở lại form và giữ phiên.
  it('US-67-TC13: mất kết nối lúc gia hạn phiên thì ở lại form, giữ phiên và báo mật khẩu chưa được gửi', async () => {
    const fetcher = fakeServer(() => json(success), 'offline');
    const client = await loadLoggedIn(fetcher);
    await renderRealPage();

    await submitForm();

    expect(await screen.findByText(/mật khẩu chưa được gửi/i)).toBeDefined();
    expect(screen.queryByText(/Trang đăng nhập/)).toBeNull();
    expect(changePasswordCalls(fetcher)).toHaveLength(0);
    expect(client.apiClient.getSnapshot().status).toBe('authenticated');
    expect(submitButton()).toHaveProperty('disabled', false);
  });
});
