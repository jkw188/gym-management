// Tầng kiểm thử frontend (Vitest, jsdom): US-19 bước 3 – nút "Gia hạn" trên trang /member/memberships.
// Chọn cách trả, xem trước, tạo kỳ gia hạn, trạng thái chờ thu tách khỏi quyền hiện tại, nguồn cũ, lỗi mạng (TC01, TC03, TC08, TC12).
// Hợp đồng test đặt ra cho Builder (US-19 bước 3; field renewal sinh viên chốt 2026-11-17):
//   Vẫn là MyMembershipsPage (src/features/memberships/MyMembershipsPage.tsx). Gọi backend qua file *.api.ts cùng thư mục:
//     GET  /me/memberships, /me/service-sales                (US-17; item membership có renewal {previousSaleId, planVersion} | null)
//     POST /me/service-renewals/preview                      body ĐÚNG 3 field {previousSaleId, planVersion, preferredPaymentMethod}
//     POST /me/service-renewals                              cùng body + header Idempotency-Key
//     GET  /me/transactions/:id/payment-instructions         (US-18)
//   Không gửi memberId/accountId/channel/endDate/amountDue, không gọi confirm-payment.
//   Giao diện:
//   - Gói có renewal != null: trong <article aria-label={planName}> có nút "Gia hạn". renewal null/thiếu: không có nút.
//   - Bấm "Gia hạn" mở vùng <section aria-labelledby> (role region) "Gia hạn gói": radio "Tiền mặt tại quầy" (CASH) và
//     "Chuyển khoản" (TRANSFER), nút "Xem trước". Xem trước hiện số tiền dạng 300.000 và ngày dự kiến dd/mm/yyyy từ server;
//     canProceed=true mới có nút "Xác nhận gia hạn".
//   - canProceed=false + PENDING_SALE_EXISTS → chữ "yêu cầu ... chờ"; preview 409 PLAN_NOT_AVAILABLE → chữ "ngừng bán";
//     cả hai không có nút "Xác nhận gia hạn".
//   - Lỗi SOURCE_NOT_LATEST / SOURCE_NOT_ELIGIBLE / PLAN_CHANGED → role="alert" có chữ "đã thay đổi" + nút "Tải lại";
//     không tự gửi yêu cầu mới; bấm "Tải lại" mới gọi lại GET /me/memberships.
//   - Lỗi mạng/503 khi tạo → role="alert" + nút "Thử lại" gửi lại CÙNG Idempotency-Key; đổi cách trả thì key mới.
//   - Lỗi mạng khi xem trước → role="alert", không hiện "0"/"miễn phí", không có nút "Xác nhận gia hạn".
//   - Kết quả PENDING: vùng "Kết quả gia hạn" có mã giao dịch + "Chờ xác nhận thu"; KHÔNG hiện ngày hết hạn mới như quyền đã cấp;
//     tải hướng dẫn thanh toán và tải lại GET /me/service-sales. Kết quả SETTLED (0đ): chữ "hoàn tất", không gọi
//     payment-instructions, tải lại GET /me/memberships để thấy kỳ mới riêng.
//   - apiClient.subscribe báo đổi account → xóa ngay vùng gia hạn và dữ liệu của account cũ.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import type { AuthSnapshot, AuthUser } from '../auth/auth.types';
import { MyMembershipsPage } from './MyMembershipsPage';

const userA: AuthUser = { id: 'a'.repeat(24), fullName: 'Hội viên A', phone: '+84901234567', roleCode: 'MEMBER' };
const userB: AuthUser = { id: 'b'.repeat(24), fullName: 'Hội viên B', phone: '+84907654321', roleCode: 'MEMBER' };
const asOf = '2026-11-01T03:00:00.000Z';

const sourceSaleId = '5'.repeat(24);
const membershipId = '6'.repeat(24);
const transactionId = '7'.repeat(24);
const renewalSaleId = '8'.repeat(24);
const code = `TX-${transactionId}`;
const planName = 'Gym 30 ngày';

// Kỳ nguồn 01/11/2026 – 30/11/2026; kỳ gia hạn dự kiến 01/12/2026 – 30/12/2026.
const membership = (extra: Record<string, unknown> = {}) => ({
  id: membershipId, planName, serviceSaleId: sourceSaleId, transactionId: '9'.repeat(24), operation: 'REGISTER',
  storedStatus: 'ACTIVE', timeState: 'CURRENT', kind: 'GYM', benefits: 'Tập Gym', startDate: '2026-11-01', endDate: '2026-11-30',
  sessionsQuota: 0, sessionsUsed: 0, sessionsReserved: 0, sessionsAvailable: 0,
  renewal: { previousSaleId: sourceSaleId, planVersion: 3 }, ...extra,
});
const quote = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  previousSaleId: body.previousSaleId, sourceEndDate: '2026-11-30', amountDue: '300000', expectedStartDate: '2026-12-01',
  expectedEndDate: '2026-12-30', planVersion: body.planVersion, asOf, canProceed: true, ...extra,
});
const pendingResult = (extra: Record<string, unknown> = {}) => ({
  saleId: renewalSaleId, transactionId, transactionCode: code, transactionStatus: 'PENDING', operation: 'RENEW',
  previousSaleId: sourceSaleId, channel: 'SELF_SERVICE', amountDue: '300000', creditAmount: '0', durationDays: 30,
  startDate: '2026-12-01', endDate: '2026-12-30', ...extra,
});
const page = (items: unknown[], memberLinked = true) => ({ memberLinked, items, page: 1, limit: 20, total: items.length,
  totalPages: items.length ? 1 : 0, asOf });

type Call = { path: string; route: string; method: string; body?: Record<string, unknown>; headers: Headers };
type Handler = (call: Call) => unknown;

// ---------- Server giả ở tầng apiClient ----------
let snapshot: AuthSnapshot;
let authListeners: Array<() => void>;
let calls: Call[];
let handlers: Record<string, Handler>;
let memberships: unknown[];

async function fakeServer(path: string, init: RequestInit | AbortSignal = {}): Promise<unknown> {
  const options = init instanceof AbortSignal ? {} : init;
  const route = path.split('?')[0].replace(/[a-f0-9]{24}/g, ':id');
  const call: Call = { path, route, method: (options.method ?? 'GET').toUpperCase(),
    body: options.body ? JSON.parse(String(options.body)) : undefined, headers: new Headers(options.headers) };
  calls.push(call);
  const handler = handlers[`${call.method} ${route}`];
  if (!handler) throw new Error(`Đường dẫn không có trong hợp đồng US-19: ${call.method} ${path}`);
  return handler(call);
}

const apiError = (status: number, errorCode: string, message = 'Lỗi') => new ApiError(message, status, 'req-1', undefined, undefined, errorCode);
const networkError = () => new ApiError('Không kết nối được máy chủ.');

beforeEach(() => {
  snapshot = { status: 'authenticated', user: userA };
  authListeners = [];
  calls = [];
  memberships = [membership()];
  handlers = {
    'GET /me/memberships': () => page(memberships),
    'GET /me/service-sales': () => page([]),
    'POST /me/service-renewals/preview': call => quote(call.body!),
    'POST /me/service-renewals': () => pendingResult(),
    'GET /me/transactions/:id/payment-instructions': () => ({ transactionCode: code, amountDue: '300000',
      preferredPaymentMethod: 'CASH', cashInstruction: 'Thanh toán tiền mặt tại quầy lễ tân.' }),
  };
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(listener => {
    authListeners.push(listener);
    return () => { authListeners = authListeners.filter(entry => entry !== listener); };
  });
  const spy = vi.fn(fakeServer);
  vi.spyOn(apiClient, 'request').mockImplementation(spy as never);
  vi.spyOn(apiClient, 'requestOnce').mockImplementation(spy as never);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderPage = () => render(<MemoryRouter initialEntries={['/member/memberships']}><MyMembershipsPage /></MemoryRouter>);
const callsTo = (method: string, route: string) => calls.filter(call => call.method === method && call.route === route);
const switchAccount = (user: AuthUser) => act(() => {
  snapshot = { status: 'authenticated', user };
  for (const listener of [...authListeners]) listener();
});

// Mở vùng gia hạn từ thẻ gói, chọn cách trả và bấm Xem trước.
async function openAndPreview(user: ReturnType<typeof userEvent.setup>, method: 'CASH' | 'TRANSFER' = 'CASH') {
  const card = await screen.findByRole('article', { name: planName });
  await user.click(within(card).getByRole('button', { name: 'Gia hạn' }));
  const panel = await screen.findByRole('region', { name: 'Gia hạn gói' });
  await user.click(within(panel).getByRole('radio', { name: method === 'CASH' ? /Tiền mặt tại quầy/ : /Chuyển khoản/ }));
  await user.click(within(panel).getByRole('button', { name: 'Xem trước' }));
  return panel;
}

async function previewThenConfirm(user: ReturnType<typeof userEvent.setup>, method: 'CASH' | 'TRANSFER' = 'CASH') {
  const panel = await openAndPreview(user, method);
  await user.click(await within(panel).findByRole('button', { name: 'Xác nhận gia hạn' }));
  return panel;
}

describe('US-19 bước 3: gia hạn trên trang /member/memberships', () => {
  // ---------------- Nút Gia hạn theo field renewal ----------------
  it('US-19-TC12: chỉ gói có renewal mới có nút "Gia hạn"', async () => {
    memberships = [
      membership(),
      membership({ id: '1'.repeat(24), planName: 'Gym tháng trước', serviceSaleId: '2'.repeat(24), timeState: 'EXPIRED',
        startDate: '2026-10-01', endDate: '2026-10-31', renewal: null }),
    ];
    renderPage();
    const tail = await screen.findByRole('article', { name: planName });
    expect(within(tail).getByRole('button', { name: 'Gia hạn' })).toBeDefined();
    const old = screen.getByRole('article', { name: 'Gym tháng trước' });
    expect(within(old).queryByRole('button', { name: 'Gia hạn' })).toBeNull();
  });

  // ---------------- TC01 / TC08: xem trước và tạo ----------------
  it('US-19-TC01: Xem trước gửi đúng 3 field lấy từ renewal, hiện số tiền và ngày dự kiến từ server, chưa tạo gì', async () => {
    const user = userEvent.setup();
    renderPage();
    const panel = await openAndPreview(user, 'CASH');

    expect(await within(panel).findByText(/300\.000/)).toBeDefined();
    expect(within(panel).getByText(/01\/12\/2026/)).toBeDefined();
    expect(within(panel).getByText(/30\/12\/2026/)).toBeDefined();
    const [sent] = callsTo('POST', '/me/service-renewals/preview');
    expect(sent.body).toEqual({ previousSaleId: sourceSaleId, planVersion: 3, preferredPaymentMethod: 'CASH' });
    expect(callsTo('POST', '/me/service-renewals')).toHaveLength(0);
  });

  it.each(['CASH', 'TRANSFER'] as const)('US-19-TC08: chọn %s rồi Xác nhận gia hạn gửi POST có Idempotency-Key và cùng body', async method => {
    const user = userEvent.setup();
    renderPage();
    await previewThenConfirm(user, method);

    await screen.findByRole('region', { name: 'Kết quả gia hạn' });
    const [created] = callsTo('POST', '/me/service-renewals');
    expect(created.body).toEqual({ previousSaleId: sourceSaleId, planVersion: 3, preferredPaymentMethod: method });
    expect(created.headers.get('Idempotency-Key')).toBeTruthy();
    expect(calls.some(call => call.path.includes('confirm-payment'))).toBe(false);
  });

  // ---------------- TC12: chưa thu thì không hứa quyền mới ----------------
  it('US-19-TC12: kết quả PENDING ghi "Chờ xác nhận thu" và mã giao dịch, không hiện ngày hết hạn mới như quyền đã cấp', async () => {
    const user = userEvent.setup();
    renderPage();
    await previewThenConfirm(user);

    const result = await screen.findByRole('region', { name: 'Kết quả gia hạn' });
    expect(within(result).getByText(/Chờ xác nhận thu/)).toBeDefined();
    expect(within(result).getByText(new RegExp(code))).toBeDefined();
    expect(within(result).queryByText(/30\/12\/2026/)).toBeNull();
    expect(within(result).queryByText(/đã kích hoạt|đã gia hạn thành công/i)).toBeNull();
    await waitFor(() => expect(callsTo('GET', '/me/transactions/:id/payment-instructions')).toHaveLength(1));
  });

  it('US-19-TC12: sau khi tạo PENDING thì tải lại danh sách giao dịch (/me/service-sales) để thấy yêu cầu chờ', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(callsTo('GET', '/me/service-sales').length).toBeGreaterThan(0));
    const before = callsTo('GET', '/me/service-sales').length;
    await previewThenConfirm(user);
    await screen.findByRole('region', { name: 'Kết quả gia hạn' });
    await waitFor(() => expect(callsTo('GET', '/me/service-sales').length).toBeGreaterThan(before));
  });

  it('US-19-TC08: gói 0đ → kết quả "hoàn tất", không gọi hướng dẫn thanh toán, tải lại danh sách gói để thấy kỳ mới', async () => {
    handlers['POST /me/service-renewals/preview'] = call => quote(call.body!, { amountDue: '0' });
    handlers['POST /me/service-renewals'] = () => pendingResult({ transactionStatus: 'SETTLED', amountDue: '0', membershipId: '4'.repeat(24) });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(callsTo('GET', '/me/memberships').length).toBeGreaterThan(0));
    const before = callsTo('GET', '/me/memberships').length;
    await previewThenConfirm(user);

    const result = await screen.findByRole('region', { name: 'Kết quả gia hạn' });
    expect(within(result).getByText(/hoàn tất/i)).toBeDefined();
    await waitFor(() => expect(callsTo('GET', '/me/memberships').length).toBeGreaterThan(before));
    expect(callsTo('GET', '/me/transactions/:id/payment-instructions')).toHaveLength(0);
  });

  // ---------------- TC03: không đủ điều kiện thì báo lý do ----------------
  it('US-19-TC03: preview canProceed=false PENDING_SALE_EXISTS → báo đang có yêu cầu chờ, không có nút Xác nhận gia hạn', async () => {
    handlers['POST /me/service-renewals/preview'] = call => quote(call.body!, { canProceed: false, blockingCode: 'PENDING_SALE_EXISTS' });
    const user = userEvent.setup();
    renderPage();
    const panel = await openAndPreview(user);
    expect(await within(panel).findByText(/yêu cầu.*chờ/i)).toBeDefined();
    expect(within(panel).queryByRole('button', { name: 'Xác nhận gia hạn' })).toBeNull();
  });

  it('US-19-TC03: preview 409 PLAN_NOT_AVAILABLE → báo gói ngừng bán, không có nút Xác nhận gia hạn', async () => {
    handlers['POST /me/service-renewals/preview'] = () => { throw apiError(409, 'PLAN_NOT_AVAILABLE', 'Gói không còn được bán'); };
    const user = userEvent.setup();
    renderPage();
    await openAndPreview(user);
    expect(await screen.findByText(/ngừng bán/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Xác nhận gia hạn' })).toBeNull();
  });

  // ---------------- TC12: nguồn cũ → tải lại có xác nhận, không tự tạo ----------------
  it.each(['SOURCE_NOT_LATEST', 'SOURCE_NOT_ELIGIBLE', 'PLAN_CHANGED'])(
    'US-19-TC12: tạo bị 409 %s → báo "đã thay đổi" + nút "Tải lại", không tự gửi yêu cầu mới', async errorCode => {
      handlers['POST /me/service-renewals'] = () => { throw apiError(409, errorCode, 'Dữ liệu đã đổi'); };
      const user = userEvent.setup();
      renderPage();
      await previewThenConfirm(user);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/đã thay đổi/);
      expect(callsTo('POST', '/me/service-renewals')).toHaveLength(1);
      const before = callsTo('GET', '/me/memberships').length;
      await user.click(screen.getByRole('button', { name: 'Tải lại' }));
      await waitFor(() => expect(callsTo('GET', '/me/memberships').length).toBeGreaterThan(before));
      expect(callsTo('POST', '/me/service-renewals')).toHaveLength(1);
    });

  it('US-19-TC12: xem trước bị 409 SOURCE_NOT_LATEST → báo "đã thay đổi" + nút "Tải lại", không có nút Xác nhận gia hạn', async () => {
    handlers['POST /me/service-renewals/preview'] = () => { throw apiError(409, 'SOURCE_NOT_LATEST', 'Kỳ nguồn đã cũ'); };
    const user = userEvent.setup();
    renderPage();
    await openAndPreview(user);
    expect((await screen.findByRole('alert')).textContent).toMatch(/đã thay đổi/);
    expect(screen.getByRole('button', { name: 'Tải lại' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Xác nhận gia hạn' })).toBeNull();
  });

  // ---------------- TC12: lỗi mạng giữ key ----------------
  it.each([['mất mạng', networkError], ['503', () => apiError(503, 'SERVICE_UNAVAILABLE', 'Tạm thời không khả dụng')]] as const)(
    'US-19-TC12: tạo bị %s → báo lỗi + "Thử lại" gửi lại CÙNG Idempotency-Key', async (_case, makeError) => {
      let attempt = 0;
      handlers['POST /me/service-renewals'] = () => { attempt += 1; if (attempt === 1) throw makeError(); return pendingResult(); };
      const user = userEvent.setup();
      renderPage();
      await previewThenConfirm(user);

      await screen.findByRole('alert');
      await user.click(screen.getByRole('button', { name: 'Thử lại' }));
      await screen.findByRole('region', { name: 'Kết quả gia hạn' });
      const sent = callsTo('POST', '/me/service-renewals');
      expect(sent).toHaveLength(2);
      expect(sent[1].headers.get('Idempotency-Key')).toBe(sent[0].headers.get('Idempotency-Key'));
      expect(sent[1].body).toEqual(sent[0].body);
    });

  it('US-19-TC12: lỗi mạng rồi đổi cách trả, xem trước lại và xác nhận → dùng Idempotency-Key mới', async () => {
    let attempt = 0;
    handlers['POST /me/service-renewals'] = () => { attempt += 1; if (attempt === 1) throw networkError(); return pendingResult(); };
    const user = userEvent.setup();
    renderPage();
    const panel = await previewThenConfirm(user, 'CASH');
    await screen.findByRole('alert');

    await user.click(within(panel).getByRole('radio', { name: /Chuyển khoản/ }));
    await user.click(within(panel).getByRole('button', { name: 'Xem trước' }));
    await user.click(await within(panel).findByRole('button', { name: 'Xác nhận gia hạn' }));
    await screen.findByRole('region', { name: 'Kết quả gia hạn' });
    const sent = callsTo('POST', '/me/service-renewals');
    expect(sent).toHaveLength(2);
    expect(sent[1].body!.preferredPaymentMethod).toBe('TRANSFER');
    expect(sent[1].headers.get('Idempotency-Key')).not.toBe(sent[0].headers.get('Idempotency-Key'));
  });

  it('US-19-TC12: xem trước bị lỗi mạng → báo lỗi, không hiện giá 0/miễn phí, không có nút Xác nhận gia hạn', async () => {
    handlers['POST /me/service-renewals/preview'] = () => { throw networkError(); };
    const user = userEvent.setup();
    renderPage();
    const panel = await openAndPreview(user);
    await screen.findByRole('alert');
    expect(within(panel).queryByText(/miễn phí/i)).toBeNull();
    expect(within(panel).queryByText(/(^|\s)0\s*(đ|₫|VND)/)).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Xác nhận gia hạn' })).toBeNull();
  });

  // ---------------- TC12: đổi account xóa dữ liệu cũ ----------------
  it('US-19-TC12: đổi account → vùng gia hạn và báo giá của account cũ biến mất ngay', async () => {
    const user = userEvent.setup();
    renderPage();
    const panel = await openAndPreview(user);
    await within(panel).findByText(/300\.000/);

    handlers['GET /me/memberships'] = () => page([]);
    switchAccount(userB);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Gia hạn gói' })).toBeNull());
    expect(screen.queryByText(/300\.000/)).toBeNull();
    expect(screen.queryByRole('article', { name: planName })).toBeNull();
  });
});
