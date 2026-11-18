// Tầng kiểm thử frontend (Vitest, jsdom): US-20 bước 3 – trang so sánh/đề nghị nâng cấp /member/memberships/:id/upgrade.
// Gói đích, báo giá từ server, xác nhận điều khoản, chờ thu, hết hạn báo giá, lỗi mạng, số buổi mang sang (TC01, TC04, TC06–TC09, TC13).
// Hợp đồng test đặt ra cho Builder (US-20 bước 3, theo mục 2 của spec):
//   Trang MembershipUpgradePage (src/features/memberships/MembershipUpgradePage.tsx), route /member/memberships/:id/upgrade.
//   Gọi backend qua file *.api.ts cùng thư mục:
//     GET  /me/memberships                                  (US-17; để hiện quyền lợi gói hiện tại)
//     GET  /me/memberships/:id/upgrade-options              (US-20 bước 1)
//     POST /me/service-upgrades/preview                     body ĐÚNG 6 field {sourceMembershipId, sourceVersion, targetPlanId,
//                                                           targetPlanVersion, policyVersion, preferredPaymentMethod}
//     POST /me/service-upgrades                             cùng body + header Idempotency-Key
//     GET  /me/transactions/:id/payment-instructions        (US-18)
//   Không gửi memberId/credit/amountDue/quota/channel, không gọi confirm-payment, không gọi API hủy booking.
//   Giao diện:
//   - Tiêu đề "Nâng cấp gói". Vùng (role region) "Gói hiện tại": tên gói, quyền lợi, ngày hết hạn dd/mm/yyyy.
//   - Mỗi gói đích là <article aria-label={name}>: giá dạng 600.000, "30 ngày", nút "Chọn gói này". items=[] → chữ "Chưa có gói".
//   - Radio "Tiền mặt tại quầy" (CASH) / "Chuyển khoản" (TRANSFER), nút "Xem báo giá".
//   - Vùng "Báo giá nâng cấp" hiện đúng số server trả: số ngày còn/tổng ngày, rawCredit/appliedCredit/excessCredit, amountDue,
//     quota đã dùng/giữ chỗ (PT), hạn báo giá (giờ VN, dd/mm/yyyy); câu phần dư không hoàn/không thành ví.
//   - Checkbox "Tôi đồng ý điều khoản nâng cấp"; nút "Gửi đề nghị nâng cấp" bị disabled tới khi tích. canProceed=false → không gửi được.
//   - Kết quả PENDING: vùng "Kết quả nâng cấp" có mã giao dịch, "Chờ xác nhận thu", câu gói hiện tại vẫn còn hiệu lực;
//     KHÔNG hiện ngày hết hạn mới như quyền đã cấp; tải hướng dẫn thanh toán; có link "Lịch sử giao dịch" tới /member/memberships.
//   - Kết quả SETTLED (phải thu 0): chữ "hoàn tất", không gọi payment-instructions, tải lại GET /me/memberships.
//   - Lỗi 409 QUOTE_EXPIRED → role="alert" chữ "hết hạn" + nút "Xem báo giá mới"; không tự gửi lại; báo giá mới phải tích lại điều khoản
//     và dùng Idempotency-Key mới.
//   - Lỗi 409 SOURCE_CHANGED/PLAN_CHANGED/POLICY_CHANGED/POLICY_NOT_ALLOWED → alert "đã thay đổi" + nút "Tải lại" (gọi lại options).
//   - Lỗi 409 BOOKING_CONFLICT/QUOTA_INSUFFICIENT → alert nhắc lịch/buổi PT, không tự hủy buổi, không gửi lại.
//   - Lỗi mạng/503 khi tạo → alert + nút "Thử lại" gửi lại CÙNG Idempotency-Key và cùng body.
//   - Lỗi mạng khi xem báo giá → alert, không hiện 0đ/miễn phí, không có nút gửi.
//   - apiClient.subscribe báo đổi account → xóa ngay báo giá/kết quả của account cũ.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import type { AuthSnapshot, AuthUser } from '../auth/auth.types';
import { MembershipUpgradePage } from './MembershipUpgradePage';

const userA: AuthUser = { id: 'a'.repeat(24), fullName: 'Hội viên A', phone: '+84901234567', roleCode: 'MEMBER' };
const userB: AuthUser = { id: 'b'.repeat(24), fullName: 'Hội viên B', phone: '+84907654321', roleCode: 'MEMBER' };
const asOf = '2026-11-16T03:00:00.000Z';

const membershipId = '6'.repeat(24);
const sourceSaleId = '5'.repeat(24);
const targetPlanId = '3'.repeat(24);
const transactionId = '7'.repeat(24);
const upgradeSaleId = '8'.repeat(24);
const code = `TX-${transactionId}`;

// Gói hiện tại GYM30 01/11/2026 – 30/11/2026; hôm nay 16/11 còn 15/30 ngày; đích GYM_VIP 600.000đ → phải thu 450.000đ.
const membership = (extra: Record<string, unknown> = {}) => ({
  id: membershipId, planName: 'Gym 30 ngày', serviceSaleId: sourceSaleId, transactionId: '9'.repeat(24), operation: 'REGISTER',
  storedStatus: 'ACTIVE', timeState: 'CURRENT', kind: 'GYM', benefits: 'Tập Gym trong giờ mở cửa', startDate: '2026-11-01',
  endDate: '2026-11-30', sessionsQuota: 0, sessionsUsed: 0, sessionsReserved: 0, sessionsAvailable: 0, renewal: null, ...extra,
});
const page = (items: unknown[]) => ({ memberLinked: true, items, page: 1, limit: 20, total: items.length,
  totalPages: items.length ? 1 : 0, asOf });
const target = (extra: Record<string, unknown> = {}) => ({ targetPlanId, targetPlanVersion: 2, policyVersion: 1, name: 'Gym VIP',
  price: '600000', durationDays: 30, sessionsQuota: 0, ...extra });
const optionsOf = (items: unknown[] = [target()], sourceVersion = 4) => ({ items, sourceVersion, asOf });
const quote = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  baseValue: '300000', totalDays: 30, remainingDays: 15, rawCredit: '150000', appliedCredit: '150000', excessCredit: '0',
  amountDue: '450000', asOfDate: '2026-11-16', quoteExpiresAt: '2026-11-16T17:00:00.000Z',
  sourceMembershipId: body.sourceMembershipId, sourceVersion: body.sourceVersion, targetPlanId: body.targetPlanId,
  targetPlanVersion: body.targetPlanVersion, policyVersion: body.policyVersion, targetListPrice: '600000', targetDurationDays: 30,
  targetSessions: 0, quotaSummary: { used: 0, reserved: 0, targetSessions: 0, requiredSessions: 0 }, canProceed: true, ...extra,
});
const pendingResult = (extra: Record<string, unknown> = {}) => ({
  saleId: upgradeSaleId, transactionId, transactionCode: code, transactionStatus: 'PENDING', operation: 'UPGRADE',
  channel: 'SELF_SERVICE', sourceMembershipId: membershipId, previousSaleId: sourceSaleId, amountDue: '450000',
  creditAmount: '150000', startDate: '2026-11-16', endDate: '2026-12-15',
  quote: { rawCredit: '150000', appliedCredit: '150000', excessCredit: '0' }, ...extra,
});
const expectedBody = (method: 'CASH' | 'TRANSFER' = 'CASH') => ({ sourceMembershipId: membershipId, sourceVersion: 4,
  targetPlanId, targetPlanVersion: 2, policyVersion: 1, preferredPaymentMethod: method });

type Call = { path: string; route: string; method: string; body?: Record<string, unknown>; headers: Headers };
type Handler = (call: Call) => unknown;

// ---------- Server giả ở tầng apiClient ----------
let snapshot: AuthSnapshot;
let authListeners: Array<() => void>;
let calls: Call[];
let handlers: Record<string, Handler>;

async function fakeServer(path: string, init: RequestInit | AbortSignal = {}): Promise<unknown> {
  const options = init instanceof AbortSignal ? {} : init;
  const route = path.split('?')[0].replace(/[a-f0-9]{24}/g, ':id');
  const call: Call = { path, route, method: (options.method ?? 'GET').toUpperCase(),
    body: options.body ? JSON.parse(String(options.body)) : undefined, headers: new Headers(options.headers) };
  calls.push(call);
  const handler = handlers[`${call.method} ${route}`];
  if (!handler) throw new Error(`Đường dẫn không có trong hợp đồng US-20: ${call.method} ${path}`);
  return handler(call);
}

const apiError = (status: number, errorCode: string, message = 'Lỗi') => new ApiError(message, status, 'req-1', undefined, undefined, errorCode);
const networkError = () => new ApiError('Không kết nối được máy chủ.');

beforeEach(() => {
  snapshot = { status: 'authenticated', user: userA };
  authListeners = [];
  calls = [];
  handlers = {
    'GET /me/memberships': () => page([membership()]),
    'GET /me/memberships/:id/upgrade-options': () => optionsOf(),
    'POST /me/service-upgrades/preview': call => quote(call.body!),
    'POST /me/service-upgrades': () => pendingResult(),
    'GET /me/transactions/:id/payment-instructions': () => ({ transactionCode: code, amountDue: '450000',
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

const renderPage = () => render(
  <MemoryRouter initialEntries={[`/member/memberships/${membershipId}/upgrade`]}>
    <Routes><Route path="/member/memberships/:id/upgrade" element={<MembershipUpgradePage />} /></Routes>
  </MemoryRouter>,
);
const callsTo = (method: string, route: string) => calls.filter(call => call.method === method && call.route === route);
const switchAccount = (user: AuthUser) => act(() => {
  snapshot = { status: 'authenticated', user };
  for (const listener of [...authListeners]) listener();
});
type User = ReturnType<typeof userEvent.setup>;

// Chọn gói đích, chọn cách trả và bấm "Xem báo giá"; trả về vùng báo giá.
async function chooseAndQuote(user: User, method: 'CASH' | 'TRANSFER' = 'CASH', name = 'Gym VIP') {
  const card = await screen.findByRole('article', { name });
  await user.click(within(card).getByRole('button', { name: 'Chọn gói này' }));
  await user.click(screen.getByRole('radio', { name: method === 'CASH' ? /Tiền mặt tại quầy/ : /Chuyển khoản/ }));
  await user.click(screen.getByRole('button', { name: 'Xem báo giá' }));
}
const quoteRegion = () => screen.findByRole('region', { name: 'Báo giá nâng cấp' });

async function quoteThenSubmit(user: User, method: 'CASH' | 'TRANSFER' = 'CASH') {
  await chooseAndQuote(user, method);
  await quoteRegion();
  await user.click(screen.getByRole('checkbox', { name: /Tôi đồng ý điều khoản nâng cấp/ }));
  await user.click(screen.getByRole('button', { name: 'Gửi đề nghị nâng cấp' }));
}

describe('US-20 bước 3: trang nâng cấp /member/memberships/:id/upgrade', () => {
  // ---------------- TC01: so sánh gói hiện tại và gói đích ----------------
  it('US-20-TC01: hiện gói hiện tại (tên, quyền lợi, hạn) và gói đích lấy từ upgrade-options của đúng membership', async () => {
    renderPage();
    const current = await screen.findByRole('region', { name: 'Gói hiện tại' });
    expect(within(current).getByText(/Gym 30 ngày/)).toBeDefined();
    expect(within(current).getByText(/Tập Gym trong giờ mở cửa/)).toBeDefined();
    expect(within(current).getByText(/30\/11\/2026/)).toBeDefined();

    const card = await screen.findByRole('article', { name: 'Gym VIP' });
    expect(within(card).getByText(/600\.000/)).toBeDefined();
    expect(within(card).getByText(/30 ngày/)).toBeDefined();
    expect(callsTo('GET', '/me/memberships/:id/upgrade-options')[0].path).toContain(membershipId);
  });

  it('US-20-TC01: upgrade-options trả items=[] → báo chưa có gói đích, không có nút Xem báo giá', async () => {
    handlers['GET /me/memberships/:id/upgrade-options'] = () => optionsOf([]);
    renderPage();
    expect(await screen.findByText(/Chưa có gói/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Xem báo giá' })).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('US-20-TC01: Xem báo giá gửi đúng 6 field (version lấy từ options), chưa tạo đề nghị', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseAndQuote(user, 'TRANSFER');
    await quoteRegion();
    const [sent] = callsTo('POST', '/me/service-upgrades/preview');
    expect(sent.body).toEqual(expectedBody('TRANSFER'));
    expect(callsTo('POST', '/me/service-upgrades')).toHaveLength(0);
  });

  it('US-20-TC01: options 404 (không phải gói của mình) → báo không tìm thấy, không hiện gói đích', async () => {
    handlers['GET /me/memberships/:id/upgrade-options'] = () => { throw apiError(404, 'NOT_FOUND', 'Không tìm thấy'); };
    renderPage();
    expect(await screen.findByText(/không tìm thấy/i)).toBeDefined();
    expect(screen.queryByRole('article')).toBeNull();
  });

  // ---------------- TC06 / TC13: hiển thị đúng số của server ----------------
  it('US-20-TC13: báo giá hiện số ngày còn, credit, phải thu và hạn báo giá đúng như server trả', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseAndQuote(user);
    const region = await quoteRegion();
    expect(within(region).getByText(/15\s*\/\s*30/)).toBeDefined();
    expect(within(region).getAllByText(/150\.000/).length).toBeGreaterThan(0);
    expect(within(region).getByText(/450\.000/)).toBeDefined();
    // quoteExpiresAt 2026-11-16T17:00Z = 00:00 ngày 17/11/2026 giờ Việt Nam.
    expect(within(region).getByText(/17\/11\/2026/)).toBeDefined();
  });

  it('US-20-TC06: credit vượt giá đích → hiện phần dư và nói rõ không hoàn/không thành ví, phải thu 0', async () => {
    handlers['POST /me/service-upgrades/preview'] = call => quote(call.body!, { rawCredit: '300000', appliedCredit: '200000',
      excessCredit: '100000', amountDue: '0', targetListPrice: '200000' });
    const user = userEvent.setup();
    renderPage();
    await chooseAndQuote(user);
    const region = await quoteRegion();
    expect(within(region).getByText(/100\.000/)).toBeDefined();
    expect(region.textContent).toMatch(/không (được )?(hoàn|chuyển thành ví|thành ví)/i);
  });

  it('US-20-TC13: gói PT hiện số buổi đã dùng và đang giữ chỗ từ quotaSummary (không reset về 0)', async () => {
    handlers['GET /me/memberships'] = () => page([membership({ kind: 'PT', planName: 'PT 10 buổi', sessionsQuota: 10, sessionsUsed: 3,
      sessionsReserved: 2, sessionsAvailable: 5 })]);
    handlers['GET /me/memberships/:id/upgrade-options'] = () => optionsOf([target({ name: 'PT 12 buổi', sessionsQuota: 12 })]);
    handlers['POST /me/service-upgrades/preview'] = call => quote(call.body!, { targetSessions: 12,
      quotaSummary: { used: 3, reserved: 2, targetSessions: 12, requiredSessions: 5 } });
    const user = userEvent.setup();
    renderPage();
    await chooseAndQuote(user, 'CASH', 'PT 12 buổi');
    const region = await quoteRegion();
    expect(region.textContent).toMatch(/đã dùng\D{0,20}3/i);
    expect(region.textContent).toMatch(/giữ chỗ\D{0,20}2/i);
  });

  // ---------------- Xác nhận điều khoản trước khi tạo ----------------
  it('US-20-TC13: chưa tích đồng ý điều khoản thì nút "Gửi đề nghị nâng cấp" bị khóa, không gửi POST', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseAndQuote(user);
    await quoteRegion();
    const submit = screen.getByRole('button', { name: 'Gửi đề nghị nâng cấp' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.click(submit);
    expect(callsTo('POST', '/me/service-upgrades')).toHaveLength(0);
  });

  it('US-20-TC08: báo giá canProceed=false (quota thiếu) → không gửi được đề nghị', async () => {
    handlers['POST /me/service-upgrades/preview'] = call => quote(call.body!, { canProceed: false, blockingCode: 'QUOTA_INSUFFICIENT' });
    const user = userEvent.setup();
    renderPage();
    await chooseAndQuote(user);
    await quoteRegion();
    const submit = screen.queryByRole('button', { name: 'Gửi đề nghị nâng cấp' }) as HTMLButtonElement | null;
    if (submit) {
      await user.click(screen.getByRole('checkbox', { name: /Tôi đồng ý điều khoản nâng cấp/ }));
      expect(submit.disabled).toBe(true);
    }
    expect(callsTo('POST', '/me/service-upgrades')).toHaveLength(0);
  });

  it.each(['CASH', 'TRANSFER'] as const)('US-20-TC09: chọn %s, tích điều khoản rồi gửi → POST có Idempotency-Key và đúng 6 field', async method => {
    const user = userEvent.setup();
    renderPage();
    await quoteThenSubmit(user, method);
    await screen.findByRole('region', { name: 'Kết quả nâng cấp' });
    const [created] = callsTo('POST', '/me/service-upgrades');
    expect(created.body).toEqual(expectedBody(method));
    expect(created.headers.get('Idempotency-Key')).toBeTruthy();
    expect(calls.some(call => call.path.includes('confirm-payment'))).toBe(false);
  });

  // ---------------- TC09 / TC13: chưa thu thì không báo chuyển sớm ----------------
  it('US-20-TC13: kết quả PENDING ghi "Chờ xác nhận thu", gói hiện tại vẫn hiệu lực, không hiện hạn mới như đã cấp', async () => {
    const user = userEvent.setup();
    renderPage();
    await quoteThenSubmit(user);
    const result = await screen.findByRole('region', { name: 'Kết quả nâng cấp' });
    expect(within(result).getByText(/Chờ xác nhận thu/)).toBeDefined();
    expect(within(result).getByText(new RegExp(code))).toBeDefined();
    expect(result.textContent).toMatch(/vẫn (còn )?(có )?hiệu lực/i);
    expect(within(result).queryByText(/15\/12\/2026/)).toBeNull();
    expect(within(result).queryByText(/đã nâng cấp thành công|đã kích hoạt/i)).toBeNull();
  });

  it('US-20-TC09: kết quả PENDING tải hướng dẫn thanh toán và có link "Lịch sử giao dịch" về /member/memberships', async () => {
    const user = userEvent.setup();
    renderPage();
    await quoteThenSubmit(user);
    const result = await screen.findByRole('region', { name: 'Kết quả nâng cấp' });
    await waitFor(() => expect(callsTo('GET', '/me/transactions/:id/payment-instructions')).toHaveLength(1));
    expect(await within(result).findByText(/Thanh toán tiền mặt tại quầy lễ tân/)).toBeDefined();
    expect(within(result).getByRole('link', { name: /Lịch sử giao dịch/ }).getAttribute('href')).toBe('/member/memberships');
  });

  it('US-20-TC06: phải thu 0 → kết quả "hoàn tất", không gọi hướng dẫn thanh toán, tải lại danh sách gói', async () => {
    handlers['POST /me/service-upgrades/preview'] = call => quote(call.body!, { rawCredit: '300000', appliedCredit: '200000',
      excessCredit: '100000', amountDue: '0' });
    handlers['POST /me/service-upgrades'] = () => pendingResult({ transactionStatus: 'SETTLED', amountDue: '0', creditAmount: '200000',
      membershipId: '4'.repeat(24) });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(callsTo('GET', '/me/memberships').length).toBeGreaterThan(0));
    const before = callsTo('GET', '/me/memberships').length;
    await quoteThenSubmit(user);
    const result = await screen.findByRole('region', { name: 'Kết quả nâng cấp' });
    expect(within(result).getByText(/hoàn tất/i)).toBeDefined();
    await waitFor(() => expect(callsTo('GET', '/me/memberships').length).toBeGreaterThan(before));
    expect(callsTo('GET', '/me/transactions/:id/payment-instructions')).toHaveLength(0);
  });

  // ---------------- TC07 / TC13: báo giá hết hạn ----------------
  it('US-20-TC07: tạo bị 409 QUOTE_EXPIRED → báo hết hạn, không tự gửi lại; "Xem báo giá mới" phải tích lại điều khoản và dùng key mới', async () => {
    let attempt = 0;
    handlers['POST /me/service-upgrades'] = () => { attempt += 1; if (attempt === 1) throw apiError(409, 'QUOTE_EXPIRED', 'Báo giá hết hạn'); return pendingResult(); };
    const user = userEvent.setup();
    renderPage();
    await quoteThenSubmit(user);

    expect((await screen.findByRole('alert')).textContent).toMatch(/hết hạn/i);
    expect(callsTo('POST', '/me/service-upgrades')).toHaveLength(1);
    const previewsBefore = callsTo('POST', '/me/service-upgrades/preview').length;
    await user.click(screen.getByRole('button', { name: 'Xem báo giá mới' }));
    await waitFor(() => expect(callsTo('POST', '/me/service-upgrades/preview').length).toBeGreaterThan(previewsBefore));
    await quoteRegion();
    const checkbox = screen.getByRole('checkbox', { name: /Tôi đồng ý điều khoản nâng cấp/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(callsTo('POST', '/me/service-upgrades')).toHaveLength(1);

    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Gửi đề nghị nâng cấp' }));
    await screen.findByRole('region', { name: 'Kết quả nâng cấp' });
    const sent = callsTo('POST', '/me/service-upgrades');
    expect(sent).toHaveLength(2);
    expect(sent[1].headers.get('Idempotency-Key')).not.toBe(sent[0].headers.get('Idempotency-Key'));
  });

  // ---------------- TC04: dữ liệu đổi sau khi đọc options ----------------
  it.each(['SOURCE_CHANGED', 'PLAN_CHANGED', 'POLICY_CHANGED', 'POLICY_NOT_ALLOWED'])(
    'US-20-TC04: tạo bị 409 %s → báo "đã thay đổi" + "Tải lại" đọc lại options, không tự gửi đề nghị mới', async errorCode => {
      handlers['POST /me/service-upgrades'] = () => { throw apiError(409, errorCode, 'Dữ liệu đã đổi'); };
      const user = userEvent.setup();
      renderPage();
      await quoteThenSubmit(user);

      expect((await screen.findByRole('alert')).textContent).toMatch(/đã thay đổi/);
      const before = callsTo('GET', '/me/memberships/:id/upgrade-options').length;
      await user.click(screen.getByRole('button', { name: 'Tải lại' }));
      await waitFor(() => expect(callsTo('GET', '/me/memberships/:id/upgrade-options').length).toBeGreaterThan(before));
      expect(callsTo('POST', '/me/service-upgrades')).toHaveLength(1);
    });

  // ---------------- TC08: lịch PT không phù hợp ----------------
  it.each(['BOOKING_CONFLICT', 'QUOTA_INSUFFICIENT'])(
    'US-20-TC08: tạo bị 409 %s → báo về buổi/lịch PT, không gọi API hủy buổi, không tự gửi lại', async errorCode => {
      handlers['POST /me/service-upgrades'] = () => { throw apiError(409, errorCode, 'Lịch PT không phù hợp'); };
      const user = userEvent.setup();
      renderPage();
      await quoteThenSubmit(user);

      expect((await screen.findByRole('alert')).textContent).toMatch(/buổi|lịch/i);
      expect(calls.some(call => /booking|cancel/.test(call.path))).toBe(false);
      expect(callsTo('POST', '/me/service-upgrades')).toHaveLength(1);
    });

  // ---------------- TC13: mất mạng giữ key ----------------
  it.each([['mất mạng', networkError], ['503', () => apiError(503, 'SERVICE_UNAVAILABLE', 'Tạm thời không khả dụng')]] as const)(
    'US-20-TC13: tạo bị %s → báo lỗi + "Thử lại" gửi lại CÙNG Idempotency-Key và cùng body', async (_case, makeError) => {
      let attempt = 0;
      handlers['POST /me/service-upgrades'] = () => { attempt += 1; if (attempt === 1) throw makeError(); return pendingResult(); };
      const user = userEvent.setup();
      renderPage();
      await quoteThenSubmit(user);

      await screen.findByRole('alert');
      await user.click(screen.getByRole('button', { name: 'Thử lại' }));
      await screen.findByRole('region', { name: 'Kết quả nâng cấp' });
      const sent = callsTo('POST', '/me/service-upgrades');
      expect(sent).toHaveLength(2);
      expect(sent[1].headers.get('Idempotency-Key')).toBe(sent[0].headers.get('Idempotency-Key'));
      expect(sent[1].body).toEqual(sent[0].body);
    });

  it('US-20-TC13: xem báo giá bị lỗi mạng → báo lỗi, không hiện 0đ/miễn phí, không có nút gửi đề nghị', async () => {
    handlers['POST /me/service-upgrades/preview'] = () => { throw networkError(); };
    const user = userEvent.setup();
    renderPage();
    await chooseAndQuote(user);
    await screen.findByRole('alert');
    expect(screen.queryByText(/miễn phí/i)).toBeNull();
    expect(screen.queryByText(/(^|\s)0\s*(đ|₫|VND)/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Gửi đề nghị nâng cấp' })).toBeNull();
  });

  // ---------------- TC13: đổi account ----------------
  it('US-20-TC13: đổi account → báo giá của account cũ biến mất ngay', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseAndQuote(user);
    const region = await quoteRegion();
    expect(within(region).getByText(/450\.000/)).toBeDefined();

    handlers['GET /me/memberships'] = () => page([]);
    handlers['GET /me/memberships/:id/upgrade-options'] = () => { throw apiError(404, 'NOT_FOUND', 'Không tìm thấy'); };
    switchAccount(userB);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Báo giá nâng cấp' })).toBeNull());
    expect(screen.queryByText(/450\.000/)).toBeNull();
  });
});
