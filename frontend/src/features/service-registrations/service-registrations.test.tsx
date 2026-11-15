// Tầng kiểm thử frontend (Vitest, jsdom): US-18 bước 3 – trang /member/service-registrations.
// Wizard chọn gói/ngày/cách trả, xem trước, tạo, hướng dẫn chờ thu, lịch sử và tự hủy đúng quyền (TC01–TC09, TC11, TC12).
// Hợp đồng test đặt ra cho Builder (US-18 bước 3, sinh viên chốt 2026-11-15):
//   src/features/service-registrations/ServiceRegistrationPage.tsx: export function ServiceRegistrationPage()
//   Gọi backend qua file *.api.ts cùng thư mục (apiClient.request / apiClient.publicGet), đường dẫn:
//     GET  /catalog/plans                                  danh mục gói (US-13), lấy id + version của gói
//     GET  /me/service-sales                               lịch sử mua (US-17) có channel, canCancel, transactionVersion
//     POST /me/service-registrations/preview               body ĐÚNG 4 field {planId, planVersion, startDate, preferredPaymentMethod}
//     POST /me/service-registrations                       cùng body + header Idempotency-Key
//     GET  /me/transactions/:id/payment-instructions       hướng dẫn thanh toán
//     POST /me/service-sales/:id/cancel                    body {version, reason} + header Idempotency-Key
//   Không bao giờ gửi memberId/accountId/createdBy/role/channel, không gọi confirm-payment.
//   Giao diện:
//   - Tiêu đề h2 "Đăng ký gói tập". Các vùng <section aria-labelledby> (role region): "Chọn gói", "Xem trước",
//     "Kết quả đăng ký", "Hướng dẫn thanh toán", "Yêu cầu mua gói của tôi".
//   - Ô chọn gói <select> nhãn "Gói tập" (option chứa tên gói); ô ngày nhãn "Ngày bắt đầu" (input date, YYYY-MM-DD);
//     radio "Tiền mặt tại quầy" (CASH) và "Chuyển khoản" (TRANSFER); nút "Xem trước"; sau khi xem trước được
//     (canProceed=true) mới có nút "Xác nhận đăng ký".
//   - Tiền hiển thị dạng 300.000 lấy từ server (amountDue), ngày dạng dd/mm/yyyy (expectedEndDate).
//   - canProceed=false: CURRENT_SERVICE_EXISTS → "đã có gói cùng loại"; PENDING_SALE_EXISTS → "đang có yêu cầu ... chờ";
//     không có nút "Xác nhận đăng ký".
//   - Lỗi: MEMBER_PROFILE_REQUIRED / memberLinked=false → "chưa được liên kết hồ sơ hội viên" + "quầy";
//     PLAN_CHANGED → "Gói đã thay đổi" và tải lại danh mục; 400 → message trong error.details;
//     RECEIVING_ACCOUNTS_NOT_CONFIGURED → "Chuyển khoản hiện không khả dụng" và gợi ý "Tiền mặt";
//     lỗi mạng/503 khi tạo → role="alert" + nút "Thử lại" gửi lại CÙNG Idempotency-Key; đổi dữ liệu form thì key mới.
//   - Kết quả PENDING: mã giao dịch + "Chờ nhân viên xác nhận thu", không có chữ "đã kích hoạt", không có nút xác nhận thu;
//     rồi tải hướng dẫn thanh toán: mã, số tiền, cashInstruction; mỗi transferOption là <article aria-label={bankName}>
//     có số tài khoản, tên chủ tài khoản và nội dung chuyển khoản.
//     Kết quả SETTLED (0đ): chữ "hoàn tất" và "miễn phí", không gọi payment-instructions.
//   - Lịch sử: mỗi lần mua là <article aria-label={planName}>; nhãn "Chờ xác nhận thu" (PENDING), "Đã hủy" (CANCELLED),
//     "Đã thanh toán" (SETTLED). Nút "Hủy yêu cầu" CHỈ khi canCancel=true. PENDING có nút "Xem hướng dẫn thanh toán".
//     Hủy: ô "Lý do hủy" (10–500 ký tự sau trim, nút "Xác nhận hủy" bị khóa khi chưa đủ), gửi version = transactionVersion,
//     xong tải lại lịch sử. Đang gửi thì nút bị khóa (chống bấm kép).
//   - apiClient.subscribe báo đổi account → xóa ngay dữ liệu account cũ.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import type { AuthSnapshot, AuthUser } from '../auth/auth.types';
import { ServiceRegistrationPage } from './ServiceRegistrationPage';

const userA: AuthUser = { id: 'a'.repeat(24), fullName: 'Hội viên A', phone: '+84901234567', roleCode: 'MEMBER' };
const userB: AuthUser = { id: 'b'.repeat(24), fullName: 'Hội viên B', phone: '+84907654321', roleCode: 'MEMBER' };
const asOf = '2026-11-01T03:00:00.000Z';

const gymPlan = { id: '1'.repeat(24), code: 'GYM30', name: 'Gym 30 ngày', kind: 'GYM', durationDays: 30, sessionsQuota: 0,
  price: '300000', benefits: 'Tập Gym trong giờ mở cửa', version: 2 };
const ptPlan = { id: '2'.repeat(24), code: 'PT30', name: 'PT 10 buổi', kind: 'PT', durationDays: 30, sessionsQuota: 10,
  price: '1000000', benefits: '10 buổi PT', version: 0 };
const saleId = '5'.repeat(24);
const transactionId = '7'.repeat(24);
const code = `TX-${transactionId}`;

type Call = { path: string; route: string; method: string; body?: Record<string, unknown>; headers: Headers };
type Handler = (call: Call) => unknown;

const quote = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  planVersion: body.planVersion, amountDue: '300000', kind: 'GYM', requestedStartDate: body.startDate,
  expectedEndDate: '2026-12-04', canProceed: true, ...extra,
});
const pendingResult = (extra: Record<string, unknown> = {}) => ({
  saleId, transactionId, transactionCode: code, transactionStatus: 'PENDING', amountDue: '300000',
  requestedStartDate: '2026-11-05', startDate: '2026-11-05', endDate: '2026-12-04', notificationState: 'NOT_CREATED',
  channel: 'SELF_SERVICE', ...extra,
});
const cashInstructions = (extra: Record<string, unknown> = {}) => ({
  transactionCode: code, amountDue: '300000', preferredPaymentMethod: 'CASH',
  cashInstruction: 'Thanh toán tiền mặt tại quầy lễ tân, đọc mã giao dịch cho nhân viên.', ...extra,
});
const historyItem = (id: string, planName: string, extra: Record<string, unknown> = {}) => ({
  id, transactionId: `${id.slice(0, 23)}9`, operation: 'REGISTER', status: 'PENDING', amountDue: '300000', planName,
  benefits: 'Quyền lợi', policy: '{}', startDate: '2026-11-05', endDate: '2026-12-04', listPrice: '300000',
  creditAmount: '0', sessionsQuota: 0, channel: 'SELF_SERVICE', canCancel: true, transactionVersion: 0, ...extra,
});
const page = (items: unknown[], memberLinked = true) => ({ memberLinked, items, page: 1, limit: 20, total: items.length,
  totalPages: items.length ? 1 : 0, asOf });

// ---------- Server giả ở tầng apiClient ----------
let snapshot: AuthSnapshot;
let authListeners: Array<() => void>;
let calls: Call[];
let handlers: Record<string, Handler>;
let history: unknown[];

async function fakeServer(path: string, init: RequestInit | AbortSignal = {}): Promise<unknown> {
  const options = init instanceof AbortSignal ? {} : init;
  const route = path.split('?')[0].replace(/[a-f0-9]{24}/g, ':id');
  const call: Call = { path, route, method: (options.method ?? 'GET').toUpperCase(),
    body: options.body ? JSON.parse(String(options.body)) : undefined, headers: new Headers(options.headers) };
  calls.push(call);
  const handler = handlers[`${call.method} ${route}`];
  if (!handler) throw new Error(`Đường dẫn không có trong hợp đồng US-18: ${call.method} ${path}`);
  return handler(call);
}

const apiError = (status: number, errorCode: string, message = 'Lỗi', details?: { field: string; message: string }[]) =>
  new ApiError(message, status, 'req-1', details, undefined, errorCode);
const networkError = () => new ApiError('Không kết nối được máy chủ.');
// Promise giữ request lại để thử bấm kép trong lúc đang gửi.
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

beforeEach(() => {
  snapshot = { status: 'authenticated', user: userA };
  authListeners = [];
  calls = [];
  history = [];
  handlers = {
    'GET /catalog/plans': () => ({ items: [gymPlan, ptPlan], page: 1, limit: 20, total: 2, totalPages: 1 }),
    'GET /me/service-sales': () => page(history),
    'POST /me/service-registrations/preview': call => quote(call.body!),
    'POST /me/service-registrations': () => pendingResult(),
    'GET /me/transactions/:id/payment-instructions': () => cashInstructions(),
    'POST /me/service-sales/:id/cancel': call => ({ saleId: call.path.split('/')[3], transactionId, status: 'CANCELLED' }),
  };
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(listener => {
    authListeners.push(listener);
    return () => { authListeners = authListeners.filter(entry => entry !== listener); };
  });
  const spy = vi.fn(fakeServer);
  vi.spyOn(apiClient, 'request').mockImplementation(spy as never);
  vi.spyOn(apiClient, 'requestOnce').mockImplementation(spy as never);
  vi.spyOn(apiClient, 'publicGet').mockImplementation(spy as never);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderPage = () => render(<MemoryRouter initialEntries={['/member/service-registrations']}><ServiceRegistrationPage /></MemoryRouter>);
const region = (name: string) => screen.getByRole('region', { name });
const callsTo = (method: string, route: string) => calls.filter(call => call.method === method && call.route === route);
const switchAccount = (user: AuthUser) => act(() => {
  snapshot = { status: 'authenticated', user };
  for (const listener of [...authListeners]) listener();
});

// Điền form: chọn gói, ngày, cách trả.
async function fillForm(user: ReturnType<typeof userEvent.setup>, options: { plan?: string; date?: string; method?: 'CASH' | 'TRANSFER' } = {}) {
  const select = await screen.findByLabelText('Gói tập');
  await screen.findByRole('option', { name: new RegExp(options.plan ?? gymPlan.name) });
  await user.selectOptions(select, screen.getByRole('option', { name: new RegExp(options.plan ?? gymPlan.name) }));
  fireEvent.change(screen.getByLabelText('Ngày bắt đầu'), { target: { value: options.date ?? '2026-11-05' } });
  await user.click(screen.getByRole('radio', { name: (options.method ?? 'CASH') === 'CASH' ? /Tiền mặt tại quầy/ : /Chuyển khoản/ }));
}

async function previewThenConfirm(user: ReturnType<typeof userEvent.setup>, options: Parameters<typeof fillForm>[1] = {}) {
  await fillForm(user, options);
  await user.click(screen.getByRole('button', { name: 'Xem trước' }));
  await user.click(await screen.findByRole('button', { name: 'Xác nhận đăng ký' }));
}

describe('US-18 bước 3: trang /member/service-registrations', () => {
  // ---------------- TC01 ----------------
  it('US-18-TC01: Xem trước gửi đúng 4 field của gói đã chọn, hiện số tiền và ngày kết thúc từ server', async () => {
    const user = userEvent.setup();
    renderPage();
    await fillForm(user, { method: 'CASH' });
    await user.click(screen.getByRole('button', { name: 'Xem trước' }));

    const preview = await screen.findByRole('region', { name: 'Xem trước' });
    expect(within(preview).getByText(/300\.000/)).toBeDefined();
    expect(within(preview).getByText(/04\/12\/2026/)).toBeDefined();
    const [sent] = callsTo('POST', '/me/service-registrations/preview');
    expect(sent.body).toEqual({ planId: gymPlan.id, planVersion: 2, startDate: '2026-11-05', preferredPaymentMethod: 'CASH' });
    expect(callsTo('POST', '/me/service-registrations')).toHaveLength(0);
  });

  it('US-18-TC01: Xác nhận đăng ký gửi POST có Idempotency-Key và cùng body, hiện mã giao dịch chờ thu', async () => {
    const user = userEvent.setup();
    renderPage();
    await previewThenConfirm(user, { method: 'TRANSFER' });

    const result = await screen.findByRole('region', { name: 'Kết quả đăng ký' });
    expect(within(result).getByText(new RegExp(code))).toBeDefined();
    expect(within(result).getByText(/Chờ nhân viên xác nhận thu/)).toBeDefined();
    const [created] = callsTo('POST', '/me/service-registrations');
    expect(created.body).toEqual({ planId: gymPlan.id, planVersion: 2, startDate: '2026-11-05', preferredPaymentMethod: 'TRANSFER' });
    expect(created.headers.get('Idempotency-Key')).toBeTruthy();
  });

  // ---------------- TC02 ----------------
  it('US-18-TC02: lịch sử báo memberLinked=false → hướng dẫn liên hệ quầy, không có nút Xem trước', async () => {
    handlers['GET /me/service-sales'] = () => page([], false);
    renderPage();

    expect(await screen.findByText(/chưa được liên kết hồ sơ hội viên/)).toBeDefined();
    expect(screen.getByText(/quầy/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Xem trước' })).toBeNull();
    expect(callsTo('POST', '/me/service-registrations/preview')).toHaveLength(0);
  });

  it('US-18-TC02: Xem trước bị 409 MEMBER_PROFILE_REQUIRED → báo chưa liên kết, không có kết quả', async () => {
    handlers['POST /me/service-registrations/preview'] = () => { throw apiError(409, 'MEMBER_PROFILE_REQUIRED', 'Chưa liên kết'); };
    const user = userEvent.setup();
    renderPage();
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Xem trước' }));

    expect(await screen.findByText(/chưa được liên kết hồ sơ hội viên/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Xác nhận đăng ký' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Kết quả đăng ký' })).toBeNull();
  });

  it('US-18-TC02: cả luồng xem trước/tạo/hủy không gửi memberId, accountId, createdBy, role hay channel', async () => {
    history = [historyItem('6'.repeat(24), 'Gym yêu cầu cũ')];
    const user = userEvent.setup();
    renderPage();
    await previewThenConfirm(user);
    await screen.findByRole('region', { name: 'Kết quả đăng ký' });
    const card = await within(region('Yêu cầu mua gói của tôi')).findByRole('article', { name: 'Gym yêu cầu cũ' });
    await user.click(within(card).getByRole('button', { name: 'Hủy yêu cầu' }));
    await user.type(screen.getByLabelText('Lý do hủy'), 'Chọn nhầm gói tập');
    await user.click(screen.getByRole('button', { name: 'Xác nhận hủy' }));
    await waitFor(() => expect(callsTo('POST', '/me/service-sales/:id/cancel')).toHaveLength(1));

    for (const call of calls) {
      const text = JSON.stringify(call.body ?? {}) + call.path;
      for (const word of ['memberId', 'accountId', 'createdBy', 'role', 'channel']) expect(text).not.toContain(word);
    }
  });

  it('US-18-TC02: đổi account → xóa ngay dữ liệu của account cũ rồi tải lại', async () => {
    history = [historyItem('6'.repeat(24), 'Gym của A')];
    renderPage();
    await screen.findByRole('article', { name: 'Gym của A' });

    history = [];
    switchAccount(userB);
    expect(screen.queryByRole('article', { name: 'Gym của A' })).toBeNull();
    await waitFor(() => expect(callsTo('GET', '/me/service-sales').length).toBeGreaterThanOrEqual(2));
  });

  // ---------------- TC03 ----------------
  it.each([
    ['CURRENT_SERVICE_EXISTS', /đã có gói cùng loại/i],
    ['PENDING_SALE_EXISTS', /đang có yêu cầu.*chờ/i],
  ])('US-18-TC03: xem trước canProceed=false %s → báo lý do, không có nút Xác nhận đăng ký', async (blockingCode, text) => {
    handlers['POST /me/service-registrations/preview'] = call => quote(call.body!, { canProceed: false, blockingCode });
    const user = userEvent.setup();
    renderPage();
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Xem trước' }));

    expect(await screen.findByText(text)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Xác nhận đăng ký' })).toBeNull();
  });

  it('US-18-TC03: tạo bị 409 PLAN_CHANGED → báo gói đã thay đổi, tải lại danh mục, không hiện kết quả', async () => {
    handlers['POST /me/service-registrations'] = () => { throw apiError(409, 'PLAN_CHANGED', 'Gói đã thay đổi'); };
    const user = userEvent.setup();
    renderPage();
    await previewThenConfirm(user);

    expect(await screen.findByText(/Gói đã thay đổi/)).toBeDefined();
    await waitFor(() => expect(callsTo('GET', '/catalog/plans').length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole('region', { name: 'Kết quả đăng ký' })).toBeNull();
  });

  it('US-18-TC03: xem trước bị 400 ngày bắt đầu → hiện message trong error.details', async () => {
    handlers['POST /me/service-registrations/preview'] = () => {
      throw apiError(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', [{ field: 'startDate', message: 'Ngày bắt đầu không được trước hôm nay' }]);
    };
    const user = userEvent.setup();
    renderPage();
    await fillForm(user, { date: '2026-10-31' });
    await user.click(screen.getByRole('button', { name: 'Xem trước' }));

    expect(await screen.findByText(/Ngày bắt đầu không được trước hôm nay/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Xác nhận đăng ký' })).toBeNull();
  });

  // ---------------- TC04 ----------------
  it('US-18-TC04: số tiền lấy từ server, không tính theo giá danh mục trên trang', async () => {
    handlers['POST /me/service-registrations/preview'] = call => quote(call.body!, { amountDue: '280000' });
    handlers['POST /me/service-registrations'] = () => pendingResult({ amountDue: '280000' });
    handlers['GET /me/transactions/:id/payment-instructions'] = () => cashInstructions({ amountDue: '280000' });
    const user = userEvent.setup();
    renderPage();
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Xem trước' }));

    const preview = await screen.findByRole('region', { name: 'Xem trước' });
    expect(within(preview).getByText(/280\.000/)).toBeDefined();
    expect(within(preview).queryByText(/300\.000/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Xác nhận đăng ký' }));
    const result = await screen.findByRole('region', { name: 'Kết quả đăng ký' });
    expect(within(result).queryByText(/300\.000/)).toBeNull();
  });

  // ---------------- TC05 ----------------
  it('US-18-TC05: giao dịch chờ thu không ghi "đã kích hoạt", không có nút xác nhận thu, không gọi confirm-payment', async () => {
    const user = userEvent.setup();
    renderPage();
    await previewThenConfirm(user);
    const result = await screen.findByRole('region', { name: 'Kết quả đăng ký' });

    expect(within(result).queryByText(/đã kích hoạt/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /xác nhận (đã )?thu|đã thanh toán|đã chuyển khoản/i })).toBeNull();
    expect(calls.some(call => call.path.includes('confirm-payment'))).toBe(false);
  });

  // ---------------- TC06 ----------------
  it('US-18-TC06: gói 0đ → hiện hoàn tất/miễn phí, không gọi hướng dẫn thanh toán', async () => {
    handlers['POST /me/service-registrations/preview'] = call => quote(call.body!, { amountDue: '0' });
    handlers['POST /me/service-registrations'] = () => pendingResult({ transactionStatus: 'SETTLED', amountDue: '0',
      membershipId: '8'.repeat(24), invoiceId: '9'.repeat(24), notificationState: 'STORED' });
    const user = userEvent.setup();
    renderPage();
    await previewThenConfirm(user);

    const result = await screen.findByRole('region', { name: 'Kết quả đăng ký' });
    expect(within(result).getByText(/hoàn tất/i)).toBeDefined();
    expect(within(result).getByText(/miễn phí/i)).toBeDefined();
    expect(within(result).queryByText(/Chờ nhân viên xác nhận thu/)).toBeNull();
    expect(callsTo('GET', '/me/transactions/:id/payment-instructions')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Hướng dẫn thanh toán' })).toBeNull();
  });

  // ---------------- TC07 ----------------
  it('US-18-TC07: sau khi tạo CASH hiện hướng dẫn tiền mặt với mã và số tiền của server', async () => {
    const user = userEvent.setup();
    renderPage();
    await previewThenConfirm(user);

    const guide = await screen.findByRole('region', { name: 'Hướng dẫn thanh toán' });
    expect(within(guide).getByText(new RegExp(code))).toBeDefined();
    expect(within(guide).getByText(/300\.000/)).toBeDefined();
    expect(within(guide).getByText(/Thanh toán tiền mặt tại quầy lễ tân/)).toBeDefined();
    expect(callsTo('GET', '/me/transactions/:id/payment-instructions')[0].path).toBe(`/me/transactions/${transactionId}/payment-instructions`);
  });

  it('US-18-TC07: TRANSFER hiện từng tài khoản nhận với số tài khoản, tên và nội dung chuyển khoản = mã giao dịch', async () => {
    handlers['GET /me/transactions/:id/payment-instructions'] = () => cashInstructions({ preferredPaymentMethod: 'TRANSFER', transferOptions: [
      { receivingAccountCode: 'GYM_MAIN', bankName: 'Vietcombank', accountNumber: '0123456789', accountName: 'CONG TY GYM', transferContent: code },
      { receivingAccountCode: 'GYM_SUB', bankName: 'Techcombank', accountNumber: '9876543210', accountName: 'CONG TY GYM', transferContent: code },
    ] });
    const user = userEvent.setup();
    renderPage();
    await previewThenConfirm(user, { method: 'TRANSFER' });

    const guide = await screen.findByRole('region', { name: 'Hướng dẫn thanh toán' });
    const vcb = within(guide).getByRole('article', { name: 'Vietcombank' });
    expect(within(vcb).getByText(/0123456789/)).toBeDefined();
    expect(within(vcb).getByText(/CONG TY GYM/)).toBeDefined();
    expect(within(vcb).getByText(new RegExp(code))).toBeDefined();
    expect(within(within(guide).getByRole('article', { name: 'Techcombank' })).getByText(/9876543210/)).toBeDefined();
  });

  it('US-18-TC07: Xem hướng dẫn thanh toán từ lịch sử bị 404 → báo không tìm thấy giao dịch, không hiện hướng dẫn', async () => {
    history = [historyItem('6'.repeat(24), 'Gym đang chờ')];
    handlers['GET /me/transactions/:id/payment-instructions'] = () => { throw apiError(404, 'TRANSACTION_NOT_FOUND', 'Không tìm thấy giao dịch'); };
    const user = userEvent.setup();
    renderPage();
    const card = await within(await screen.findByRole('region', { name: 'Yêu cầu mua gói của tôi' })).findByRole('article', { name: 'Gym đang chờ' });
    await user.click(within(card).getByRole('button', { name: 'Xem hướng dẫn thanh toán' }));

    expect(await screen.findByText(/Không tìm thấy giao dịch/)).toBeDefined();
    expect(screen.queryByText(/Thanh toán tiền mặt tại quầy lễ tân/)).toBeNull();
  });

  // ---------------- TC08 ----------------
  it('US-18-TC08: TRANSFER bị 503 RECEIVING_ACCOUNTS_NOT_CONFIGURED → báo không khả dụng, chọn Tiền mặt thì xem trước được', async () => {
    handlers['POST /me/service-registrations/preview'] = call => {
      if (call.body!.preferredPaymentMethod === 'TRANSFER') throw apiError(503, 'RECEIVING_ACCOUNTS_NOT_CONFIGURED', 'Chưa cấu hình');
      return quote(call.body!);
    };
    const user = userEvent.setup();
    renderPage();
    await fillForm(user, { method: 'TRANSFER' });
    await user.click(screen.getByRole('button', { name: 'Xem trước' }));

    expect(await screen.findByText(/Chuyển khoản hiện không khả dụng/)).toBeDefined();
    expect(screen.getAllByText(/Tiền mặt/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Xác nhận đăng ký' })).toBeNull();

    await user.click(screen.getByRole('radio', { name: /Tiền mặt tại quầy/ }));
    await user.click(screen.getByRole('button', { name: 'Xem trước' }));
    expect(await screen.findByRole('button', { name: 'Xác nhận đăng ký' })).toBeDefined();
  });

  it('US-18-TC08: hướng dẫn không có transferOptions → không hiện số tài khoản nào', async () => {
    handlers['GET /me/transactions/:id/payment-instructions'] = () => cashInstructions({ preferredPaymentMethod: 'TRANSFER' });
    const user = userEvent.setup();
    renderPage();
    await previewThenConfirm(user);

    const guide = await screen.findByRole('region', { name: 'Hướng dẫn thanh toán' });
    expect(within(guide).queryAllByRole('article')).toHaveLength(0);
    expect(within(guide).queryByText(/Số tài khoản/i)).toBeNull();
    expect(within(guide).getByText(/Thanh toán tiền mặt tại quầy lễ tân/)).toBeDefined();
  });

  // ---------------- TC09 ----------------
  it('US-18-TC09: tạo bị lỗi mạng → có Thử lại, gửi lại CÙNG Idempotency-Key, hiện một kết quả', async () => {
    let attempts = 0;
    handlers['POST /me/service-registrations'] = () => { attempts += 1; if (attempts === 1) throw networkError(); return pendingResult(); };
    const user = userEvent.setup();
    renderPage();
    await previewThenConfirm(user);

    expect(await screen.findByRole('alert')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Thử lại' }));
    await screen.findByRole('region', { name: 'Kết quả đăng ký' });
    const keys = callsTo('POST', '/me/service-registrations').map(call => call.headers.get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(screen.getAllByText(new RegExp(code)).length).toBeGreaterThan(0);
  });

  it('US-18-TC09: sau lỗi 503 đổi ngày bắt đầu rồi đăng ký lại → dùng key mới', async () => {
    let attempts = 0;
    handlers['POST /me/service-registrations'] = () => { attempts += 1; if (attempts === 1) throw apiError(503, 'SERVICE_UNAVAILABLE', 'Tạm gián đoạn'); return pendingResult(); };
    const user = userEvent.setup();
    renderPage();
    await previewThenConfirm(user);
    expect(await screen.findByRole('button', { name: 'Thử lại' })).toBeDefined();

    fireEvent.change(screen.getByLabelText('Ngày bắt đầu'), { target: { value: '2026-11-06' } });
    await user.click(screen.getByRole('button', { name: 'Xem trước' }));
    await user.click(await screen.findByRole('button', { name: 'Xác nhận đăng ký' }));
    await screen.findByRole('region', { name: 'Kết quả đăng ký' });
    const created = callsTo('POST', '/me/service-registrations');
    expect(created).toHaveLength(2);
    expect(created[1].body!.startDate).toBe('2026-11-06');
    expect(created[1].headers.get('Idempotency-Key')).not.toBe(created[0].headers.get('Idempotency-Key'));
  });

  // ---------------- TC11 ----------------
  it('US-18-TC11: lịch sử chỉ có nút Hủy yêu cầu khi server báo canCancel=true', async () => {
    history = [
      historyItem('6'.repeat(24), 'Gym tự đăng ký'),
      historyItem('c'.repeat(24), 'Gym mua tại quầy', { channel: 'COUNTER', canCancel: false }),
      historyItem('d'.repeat(24), 'Gym đã thanh toán', { status: 'SETTLED', canCancel: false }),
      historyItem('e'.repeat(24), 'Gym đã hủy', { status: 'CANCELLED', canCancel: false, transactionVersion: 1 }),
    ];
    renderPage();
    const list = await screen.findByRole('region', { name: 'Yêu cầu mua gói của tôi' });

    const own = await within(list).findByRole('article', { name: 'Gym tự đăng ký' });
    expect(within(own).getByText(/Chờ xác nhận thu/)).toBeDefined();
    expect(within(own).getByRole('button', { name: 'Hủy yêu cầu' })).toBeDefined();
    const counter = within(list).getByRole('article', { name: 'Gym mua tại quầy' });
    expect(within(counter).queryByRole('button', { name: 'Hủy yêu cầu' })).toBeNull();
    expect(within(within(list).getByRole('article', { name: 'Gym đã thanh toán' })).getByText(/Đã thanh toán/)).toBeDefined();
    expect(within(within(list).getByRole('article', { name: 'Gym đã thanh toán' })).queryByRole('button', { name: 'Hủy yêu cầu' })).toBeNull();
    expect(within(within(list).getByRole('article', { name: 'Gym đã hủy' })).getByText(/Đã hủy/)).toBeDefined();
  });

  it('US-18-TC11: hủy cần lý do 10–500 ký tự, gửi version của server và Idempotency-Key, xong tải lại lịch sử', async () => {
    const id = '6'.repeat(24);
    history = [historyItem(id, 'Gym tự đăng ký', { transactionVersion: 3 })];
    handlers['POST /me/service-sales/:id/cancel'] = () => {
      history = [historyItem(id, 'Gym tự đăng ký', { status: 'CANCELLED', canCancel: false, transactionVersion: 4 })];
      return { saleId: id, transactionId, status: 'CANCELLED' };
    };
    const user = userEvent.setup();
    renderPage();
    const card = await within(await screen.findByRole('region', { name: 'Yêu cầu mua gói của tôi' })).findByRole('article', { name: 'Gym tự đăng ký' });
    await user.click(within(card).getByRole('button', { name: 'Hủy yêu cầu' }));

    await user.type(screen.getByLabelText('Lý do hủy'), '   ngắn   ');
    expect((screen.getByRole('button', { name: 'Xác nhận hủy' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(screen.getByLabelText('Lý do hủy'));
    await user.type(screen.getByLabelText('Lý do hủy'), 'Chọn sai ngày bắt đầu');
    await user.click(screen.getByRole('button', { name: 'Xác nhận hủy' }));

    await waitFor(() => expect(callsTo('POST', '/me/service-sales/:id/cancel')).toHaveLength(1));
    const [sent] = callsTo('POST', '/me/service-sales/:id/cancel');
    expect(sent.path).toBe(`/me/service-sales/${id}/cancel`);
    expect(sent.body).toEqual({ version: 3, reason: 'Chọn sai ngày bắt đầu' });
    expect(sent.headers.get('Idempotency-Key')).toBeTruthy();
    const reloaded = await within(region('Yêu cầu mua gói của tôi')).findByText(/Đã hủy/);
    expect(reloaded).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Hủy yêu cầu' })).toBeNull();
  });

  it('US-18-TC11: hủy bị 409 (nhân viên vừa thu tiền) → báo lỗi và tải lại lịch sử', async () => {
    const id = '6'.repeat(24);
    history = [historyItem(id, 'Gym tự đăng ký')];
    handlers['POST /me/service-sales/:id/cancel'] = () => {
      history = [historyItem(id, 'Gym tự đăng ký', { status: 'SETTLED', canCancel: false, transactionVersion: 1 })];
      throw apiError(409, 'INVALID_TRANSACTION_STATE', 'Trạng thái giao dịch không cho phép thao tác');
    };
    const user = userEvent.setup();
    renderPage();
    const card = await within(await screen.findByRole('region', { name: 'Yêu cầu mua gói của tôi' })).findByRole('article', { name: 'Gym tự đăng ký' });
    await user.click(within(card).getByRole('button', { name: 'Hủy yêu cầu' }));
    await user.type(screen.getByLabelText('Lý do hủy'), 'Chọn sai ngày bắt đầu');
    const before = callsTo('GET', '/me/service-sales').length;
    await user.click(screen.getByRole('button', { name: 'Xác nhận hủy' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    await waitFor(() => expect(callsTo('GET', '/me/service-sales').length).toBeGreaterThan(before));
    expect(await within(region('Yêu cầu mua gói của tôi')).findByText(/Đã thanh toán/)).toBeDefined();
  });

  // ---------------- TC12 ----------------
  it('US-18-TC12: bấm Xác nhận đăng ký hai lần khi đang gửi → chỉ một POST', async () => {
    const gate = deferred();
    handlers['POST /me/service-registrations'] = async () => { await gate.promise; return pendingResult(); };
    const user = userEvent.setup();
    renderPage();
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Xem trước' }));
    const confirm = await screen.findByRole('button', { name: 'Xác nhận đăng ký' });
    await user.click(confirm);
    await user.click(confirm);

    expect(callsTo('POST', '/me/service-registrations')).toHaveLength(1);
    gate.release();
    await screen.findByRole('region', { name: 'Kết quả đăng ký' });
    expect(callsTo('POST', '/me/service-registrations')).toHaveLength(1);
  });

  it('US-18-TC12: bấm Xác nhận hủy hai lần khi đang gửi → chỉ một POST', async () => {
    const id = '6'.repeat(24);
    history = [historyItem(id, 'Gym tự đăng ký')];
    const gate = deferred();
    handlers['POST /me/service-sales/:id/cancel'] = async () => { await gate.promise; return { saleId: id, transactionId, status: 'CANCELLED' }; };
    const user = userEvent.setup();
    renderPage();
    const card = await within(await screen.findByRole('region', { name: 'Yêu cầu mua gói của tôi' })).findByRole('article', { name: 'Gym tự đăng ký' });
    await user.click(within(card).getByRole('button', { name: 'Hủy yêu cầu' }));
    await user.type(screen.getByLabelText('Lý do hủy'), 'Chọn sai ngày bắt đầu');
    const confirm = screen.getByRole('button', { name: 'Xác nhận hủy' });
    await user.click(confirm);
    await user.click(confirm);

    expect(callsTo('POST', '/me/service-sales/:id/cancel')).toHaveLength(1);
    gate.release();
    await waitFor(() => expect(callsTo('GET', '/me/service-sales').length).toBeGreaterThanOrEqual(2));
    expect(callsTo('POST', '/me/service-sales/:id/cancel')).toHaveLength(1);
  });
});
