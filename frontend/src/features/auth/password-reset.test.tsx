// Tầng kiểm thử frontend (Vitest): giao diện quên mật khẩu US-05 bước 4 (/forgot-password và /reset-password).
// Dựng nguyên App ở đúng đường dẫn và giả lập máy chủ bằng fetch giả, nên test chỉ dựa vào route, hợp đồng API
// trong spec và chữ trên màn hình, không phụ thuộc tên file/component bên trong.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const url = 'http://localhost:3000/api';
const identifier = '0901234567';
const challenge = 'C'.repeat(43);
const otpWithZero = '012345';
const newPassword = 'MậtKhẩuMớiUS-05-456';
const publicMessage = 'Nếu tài khoản đủ điều kiện, mã xác thực sẽ được gửi đến email đã lưu';
const successMessage = 'Đã cập nhật mật khẩu, vui lòng đăng nhập lại';

// Nhãn và chữ trên giao diện (spec không ghi, tester đặt; cần sinh viên xác nhận).
const ui = {
  identifier: 'Số điện thoại hoặc email',
  sendCode: 'Gửi mã',
  otp: 'Mã xác thực',
  newPassword: 'Mật khẩu mới',
  confirmPassword: 'Xác nhận mật khẩu mới', // không bắt buộc có; nếu có thì test điền giống mật khẩu mới
  submit: 'Đặt lại mật khẩu',
  resend: 'Gửi lại mã',
  restart: 'Bắt đầu lại',
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const error = (code: string, message: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code, message } }, status, headers);

type Handler = (body: Record<string, unknown>) => Response | Promise<Response>;

// Máy chủ giả: ghi lại mọi lần gọi; mặc định request trả 202 echo challenge, confirm trả 200.
function fakeServer(handlers: { request?: Handler; confirm?: Handler } = {}) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (path.endsWith('/auth/refresh')) return error('UNAUTHORIZED', 'Cần xác thực', 401);
    if (path.endsWith('/auth/password-reset/request')) {
      return handlers.request ? handlers.request(body) : json({ message: publicMessage, challenge: (body.challenge as string) ?? challenge }, 202);
    }
    if (path.endsWith('/auth/password-reset/confirm')) {
      return handlers.confirm ? handlers.confirm(body) : json({ message: successMessage });
    }
    return error('NOT_FOUND', 'Không có', 404);
  });
}

function callsTo(fetcher: ReturnType<typeof fakeServer>, endpoint: 'request' | 'confirm') {
  return fetcher.mock.calls
    .filter(([path]) => String(path).endsWith(`/auth/password-reset/${endpoint}`))
    .map(([, init]) => ({ method: init?.method, body: JSON.parse(String(init?.body)) as Record<string, unknown> }));
}

// Nạp lại App với fetch giả (apiClient được tạo một lần lúc import) rồi mở đúng đường dẫn.
async function renderApp(fetcher: ReturnType<typeof fakeServer>, path = '/forgot-password') {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', url);
  vi.stubGlobal('fetch', fetcher);
  window.history.pushState({}, '', path);
  const client = await import('../../api/client');
  const requireLogin = vi.spyOn(client.apiClient, 'requireLogin');
  const { default: App } = await import('../../App');
  render(<App />);
  return { requireLogin };
}

async function requestCode(user = userEvent.setup()) {
  await user.type(await screen.findByLabelText(ui.identifier), identifier);
  await user.click(screen.getByRole('button', { name: ui.sendCode }));
  await screen.findByLabelText(ui.otp);
}

async function fillReset(user = userEvent.setup(), otp = otpWithZero) {
  await user.type(screen.getByLabelText(ui.otp), otp);
  await user.type(screen.getByLabelText(ui.newPassword), newPassword);
  const confirmInput = screen.queryByLabelText(ui.confirmPassword);
  if (confirmInput) await user.type(confirmInput, newPassword);
}

// URL và bộ nhớ trình duyệt không được chứa bí mật (challenge, OTP, mật khẩu).
function expectNoSecretInUrl(...secrets: string[]) {
  for (const secret of secrets) expect(decodeURIComponent(window.location.href)).not.toContain(secret);
}

describe('US-05 giao diện quên mật khẩu', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    window.history.pushState({}, '', '/');
  });

  // ---------- Yêu cầu mã ----------

  it('US-05-TC16: gửi đúng một request {identifier}, rồi chuyển sang /reset-password và hiện thông báo chung', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);

    await requestCode();

    expect(callsTo(fetcher, 'request')).toEqual([{ method: 'POST', body: { identifier } }]);
    expect(window.location.pathname).toBe('/reset-password');
    expect(screen.getByText(publicMessage)).toBeDefined();
  });

  it('US-05-TC16: challenge chỉ giữ trong bộ nhớ, không nằm trên URL, localStorage hay sessionStorage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const fetcher = fakeServer();
    await renderApp(fetcher);

    await requestCode();

    expectNoSecretInUrl(challenge);
    for (const [, value] of setItem.mock.calls) expect(String(value)).not.toContain(challenge);
  });

  it('US-05-TC16: bấm "Gửi mã" nhiều lần khi đang chờ chỉ gửi một request', async () => {
    let finish: (response: Response) => void = () => {};
    const fetcher = fakeServer({ request: () => new Promise(resolve => { finish = resolve; }) });
    await renderApp(fetcher);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(ui.identifier), identifier);

    await user.click(screen.getByRole('button', { name: ui.sendCode }));
    await user.click(screen.getByRole('button', { name: ui.sendCode }));

    expect(callsTo(fetcher, 'request')).toHaveLength(1);
    finish(json({ message: publicMessage, challenge }, 202));
    await screen.findByLabelText(ui.otp);
  });

  it('US-05-TC16: mất kết nối khi yêu cầu mã thì báo lỗi, ở lại trang và không tự gửi lại', async () => {
    const fetcher = fakeServer({ request: () => { throw new TypeError('offline'); } });
    await renderApp(fetcher);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(ui.identifier), identifier);

    await user.click(screen.getByRole('button', { name: ui.sendCode }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(window.location.pathname).toBe('/forgot-password');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(callsTo(fetcher, 'request')).toHaveLength(1);
  });

  it('US-05-TC16: mở thẳng /reset-password khi chưa có challenge trong bộ nhớ thì quay về bước nhập định danh', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher, '/reset-password');

    expect(await screen.findByLabelText(ui.identifier)).toBeDefined();
    expect(window.location.pathname).toBe('/forgot-password');
    expect(callsTo(fetcher, 'request')).toHaveLength(0);
  });

  // ---------- Đặt lại mật khẩu ----------

  it('US-05-TC05: OTP có số 0 đầu được gửi nguyên dạng chuỗi "012345"; ô OTP không phải ô số', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    const user = userEvent.setup();
    await requestCode(user);
    expect((screen.getByLabelText(ui.otp) as HTMLInputElement).type).not.toBe('number');

    await fillReset(user);
    await user.click(screen.getByRole('button', { name: ui.submit }));

    await waitFor(() => expect(callsTo(fetcher, 'confirm')).toHaveLength(1));
    expect(callsTo(fetcher, 'confirm')[0]).toEqual({ method: 'POST', body: { challenge, otp: otpWithZero, newPassword } });
  });

  it('US-05-TC16: ô mật khẩu mới mặc định ẩn; URL không chứa challenge, OTP hay mật khẩu', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    const user = userEvent.setup();
    await requestCode(user);
    expect((screen.getByLabelText(ui.newPassword) as HTMLInputElement).type).toBe('password');

    await fillReset(user);
    await user.click(screen.getByRole('button', { name: ui.submit }));

    await waitFor(() => expect(callsTo(fetcher, 'confirm')).toHaveLength(1));
    expectNoSecretInUrl(challenge, otpWithZero, newPassword);
  });

  it('US-05-TC16: nhận 200 thì xóa phiên trên trình duyệt và chuyển về trang đăng nhập', async () => {
    const fetcher = fakeServer();
    const { requireLogin } = await renderApp(fetcher);
    const user = userEvent.setup();
    await requestCode(user);

    await fillReset(user);
    await user.click(screen.getByRole('button', { name: ui.submit }));

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(requireLogin).toHaveBeenCalled();
  });

  it('US-05-TC16: bấm "Đặt lại mật khẩu" nhiều lần khi đang chờ chỉ gửi một confirm', async () => {
    let finish: (response: Response) => void = () => {};
    const fetcher = fakeServer({ confirm: () => new Promise(resolve => { finish = resolve; }) });
    await renderApp(fetcher);
    const user = userEvent.setup();
    await requestCode(user);
    await fillReset(user);

    await user.click(screen.getByRole('button', { name: ui.submit }));
    await user.click(screen.getByRole('button', { name: ui.submit }));

    expect(callsTo(fetcher, 'confirm')).toHaveLength(1);
    finish(json({ message: successMessage }));
    await waitFor(() => expect(window.location.pathname).toBe('/login'));
  });

  // Spec: "Sau 200 thử login mới; mất response thì có thể đã đổi mật khẩu, không tự báo tài khoản chưa đổi".
  it('US-05-TC16: mất phản hồi khi confirm thì không tự gửi lại, hướng dẫn thử đăng nhập, không báo là chưa đổi', async () => {
    const fetcher = fakeServer({ confirm: () => { throw new TypeError('offline'); } });
    await renderApp(fetcher);
    const user = userEvent.setup();
    await requestCode(user);
    await fillReset(user);

    await user.click(screen.getByRole('button', { name: ui.submit }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/đăng nhập/i);
    expect(alert.textContent).not.toMatch(/chưa (được )?(đổi|cập nhật)/i);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(callsTo(fetcher, 'confirm')).toHaveLength(1);
  });

  // Mã sai/hết hạn/bị thay: cần flow mới thì người dùng tự xác nhận bắt đầu lại, giao diện không tự gửi.
  it('US-05-TC16: nhận 400 RESET_INVALID thì báo lỗi; chỉ khi bấm "Bắt đầu lại" mới về bước nhập định danh, không tự gửi request', async () => {
    const fetcher = fakeServer({ confirm: () => error('RESET_INVALID', 'Mã xác thực không hợp lệ hoặc đã hết hạn', 400) });
    await renderApp(fetcher);
    const user = userEvent.setup();
    await requestCode(user);
    await fillReset(user);

    await user.click(screen.getByRole('button', { name: ui.submit }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(window.location.pathname).toBe('/reset-password');
    await user.click(screen.getByRole('button', { name: ui.restart }));
    expect(window.location.pathname).toBe('/reset-password');
    await user.click(screen.getByRole('button', { name: 'Xác nhận bắt đầu lại' }));
    expect(await screen.findByLabelText(ui.identifier)).toBeDefined();
    expect(window.location.pathname).toBe('/forgot-password');
    expect(callsTo(fetcher, 'request')).toHaveLength(1);
  });

  // ---------- Gửi lại mã và đếm ngược 60 giây (đồng hồ giả) ----------

  it('US-05-TC16: hủy bắt đầu lại giữ challenge và OTP đang nhập, không phát sinh request', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    const user = userEvent.setup();
    await requestCode(user);
    await fillReset(user);
    await user.click(screen.getByRole('button', { name: ui.restart }));
    await user.click(screen.getByRole('button', { name: 'Giữ mã hiện tại' }));
    expect((screen.getByLabelText(ui.otp) as HTMLInputElement).value).toBe(otpWithZero);
    expect(callsTo(fetcher, 'request')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: ui.submit }));
    await waitFor(() => expect(callsTo(fetcher, 'confirm')).toHaveLength(1));
    expect(callsTo(fetcher, 'confirm')[0].body.challenge).toBe(challenge);
  });

  // Chỉ giả bộ hẹn giờ và Date; không dùng findBy/waitFor vì chúng cần bộ hẹn giờ thật.
  async function renderWithFakeTimers(fetcher: ReturnType<typeof fakeServer>) {
    await renderApp(fetcher);
    await screen.findByLabelText(ui.identifier);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    // React Testing Library sau mỗi thao tác chờ một setTimeout(0) và chỉ tự đẩy đồng hồ giả khi thấy biến `jest`.
    // Vitest không có biến này nên test sẽ treo; gán `jest` trỏ tới `vi` để thư viện nhận ra đồng hồ giả (gỡ ở afterEach).
    vi.stubGlobal('jest', vi);
    const user = userEvent.setup({ advanceTimers: ms => vi.advanceTimersByTime(ms) });
    await user.type(screen.getByLabelText(ui.identifier), identifier);
    await user.click(screen.getByRole('button', { name: ui.sendCode }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    return user;
  }

  async function passSeconds(seconds: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(seconds * 1000); });
  }

  function resendButton() {
    return screen.getByRole('button', { name: new RegExp(ui.resend) }) as HTMLButtonElement;
  }

  it('US-05-TC16: nút "Gửi lại mã" bị khóa trong 60 giây đếm ngược, hết 60 giây mới bấm được', async () => {
    const fetcher = fakeServer();
    await renderWithFakeTimers(fetcher);

    expect(resendButton().disabled).toBe(true);
    await passSeconds(59);
    expect(resendButton().disabled).toBe(true);
    await passSeconds(1);
    expect(resendButton().disabled).toBe(false);
  });

  it('US-05-TC16: gửi lại mã gửi kèm đúng challenge đang giữ, không đổi challenge, rồi đếm ngược lại từ đầu', async () => {
    const fetcher = fakeServer();
    const user = await renderWithFakeTimers(fetcher);
    await passSeconds(60);

    await user.click(resendButton());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(callsTo(fetcher, 'request')[1].body).toEqual({ identifier, challenge });
    expect(resendButton().disabled).toBe(true);
    await fillReset(user);
    await user.click(screen.getByRole('button', { name: ui.submit }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(callsTo(fetcher, 'confirm')[0].body.challenge).toBe(challenge);
  });

  it('US-05-TC16: gửi lại bị 429 thì không mất mã đang nhập, giữ challenge và không tự gửi lại khi hết Retry-After', async () => {
    let calls = 0;
    const fetcher = fakeServer({
      request: body => {
        calls += 1;
        return calls === 1 ? json({ message: publicMessage, challenge }, 202)
          : error('TOO_MANY_REQUESTS', 'Quá nhiều lần thử', 429, { 'Retry-After': '120' });
      },
    });
    const user = await renderWithFakeTimers(fetcher);
    await user.type(screen.getByLabelText(ui.otp), otpWithZero);
    await passSeconds(60);

    await user.click(resendButton());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await passSeconds(180);

    expect(callsTo(fetcher, 'request')).toHaveLength(2);
    expect((screen.getByLabelText(ui.otp) as HTMLInputElement).value).toBe(otpWithZero);
    await user.type(screen.getByLabelText(ui.newPassword), newPassword);
    const confirmInput = screen.queryByLabelText(ui.confirmPassword);
    if (confirmInput) await user.type(confirmInput, newPassword);
    await user.click(screen.getByRole('button', { name: ui.submit }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(callsTo(fetcher, 'confirm')[0].body).toEqual({ challenge, otp: otpWithZero, newPassword });
  });

  it('US-05-TC16: để trang mở lâu (hết giờ) không tự gửi lại request hay confirm nào', async () => {
    const fetcher = fakeServer();
    await renderWithFakeTimers(fetcher);

    await passSeconds(15 * 60);

    expect(callsTo(fetcher, 'request')).toHaveLength(1);
    expect(callsTo(fetcher, 'confirm')).toHaveLength(0);
  });
});
