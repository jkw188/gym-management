// Tầng kiểm thử frontend (Vitest, jsdom): US-41 bước 4 – trang đặt hàng /member/checkout của Member (giỏ → xem giá/quầy → người nhận/cách trả → xác nhận một lần).
// Dựng nguyên App với fetch giả (khuôn giống cart.test.tsx), test chỉ dựa vào route, hợp đồng API US-41 mục 5 và chữ trên màn hình (TC18).
// Hợp đồng giao diện do tester đặt (spec không ghi chữ cụ thể; cần sinh viên xác nhận):
//   - File frontend/src/features/checkout/CheckoutPage.tsx, checkout.api.ts (gọi qua apiClient). Route /member/checkout chỉ cho MEMBER.
//   - Mở trang: GET /me/cart lấy version → POST /me/orders/preview {cartVersion}. Đang tải: "Đang tải". KHÔNG tự gửi POST /me/orders.
//   - h1 "Đặt hàng". Hiện tên, số lượng, thành tiền từng dòng; "Tổng cộng" + tổng dạng "60.000 ₫" (0 → "0 ₫"); địa điểm nhận từ server.
//   - Giỏ trống (canCheckout false hoặc preview 409 CART_EMPTY): chữ "Giỏ hàng trống" + liên kết "Quay lại giỏ hàng" (/member/cart), không có nút xác nhận.
//   - Ô "Tên người nhận", "Số điện thoại người nhận"; radio "Tiền mặt" (CASH, chọn sẵn) và "Chuyển khoản" (TRANSFER).
//     Chọn chuyển khoản → có chữ "chờ nhân viên xác minh". Không bao giờ có nút kiểu "Tôi đã trả/thanh toán/chuyển khoản".
//     Tên sau trim < 2 hoặc > 120 ký tự → "Tên người nhận từ 2 đến 120 ký tự", không gửi.
//   - Nút "Xác nhận đặt hàng" → POST /me/orders có Idempotency-Key UUID v4, body đúng {cartVersion, quoteToken, recipientName, recipientPhone, preferredPaymentMethod};
//     khóa nút khi đang gửi (bấm đúp chỉ một POST).
//   - 201: chữ "Đã tạo đơn" + mã đơn; trạng thái đơn "Chờ xác nhận" và trạng thái tiền hiển thị riêng: PENDING → "Chưa thanh toán", SETTLED → "Đã thanh toán";
//     hạn giữ hàng theo giờ Việt Nam (dd/mm/yyyy, HH:mm); liên kết "Xem đơn hàng của tôi" (/member/orders). Không có chữ "đã nhận hàng"/"đã bàn giao".
//   - 409 QUOTE_STALE / QUOTE_EXPIRED / CART_VERSION_CONFLICT: role="alert" có "đã thay đổi", tự tải lại giỏ + preview, GIỮ tên/SĐT đã nhập,
//     không tự gửi lại; bấm xác nhận lần nữa dùng quote mới và Idempotency-Key MỚI (ý định mới).
//   - Lỗi mạng/503 khi tạo đơn: role="alert" + nút "Thử lại" gửi lại CÙNG key và cùng body; chưa có 201 thì không báo đã tạo đơn.
//   - Không lưu quoteToken vào localStorage/sessionStorage hay URL.
//   - Vai trò khác MEMBER mở /member/checkout: "Không có quyền truy cập", không gọi API đặt đơn.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Socket thông báo không liên quan US-41: thay bằng socket giả không làm gì.
vi.mock('socket.io-client', () => {
  const socket = { on: () => socket, off: () => socket, emit: () => socket, connect: () => socket, disconnect: () => socket, io: { on: () => undefined, off: () => undefined } };
  return { io: () => socket, default: () => socket };
});

const url = 'http://localhost:3000/api';
const WATER_ID = '670000000000000000000001';
const WHEY_ID = '670000000000000000000002';
const ORDER_ID = '680000000000000000000001';
const ASOF = '2026-11-19T03:00:00.000Z';
const PICKUP = 'Quầy lễ tân tầng 1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (code: string, message: string, status: number) => json({ error: { code, message }, requestId: 'req-1' }, status);
const pageOf = <T,>(items: T[]) => ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0 });
const failNetwork = () => Promise.reject(new TypeError('Failed to fetch'));

const cartOf = (version: number, empty = false) => ({
  memberLinked: true, version, subtotal: empty ? '0' : '60000', totalsState: 'OK', readyForOrder: !empty, canCheckout: !empty, asOf: ASOF,
  items: empty ? [] : [
    { productId: WATER_ID, sku: 'WATER_01', name: 'Nước suối', imageUrl: null, quantity: 2, unitPrice: '25000', lineTotal: '50000',
      availableQuantity: 50, productVersion: 0, lineState: 'OK', reasons: [] },
    { productId: WHEY_ID, sku: 'WHEY_01', name: 'Whey 1kg', imageUrl: null, quantity: 1, unitPrice: '10000', lineTotal: '10000',
      availableQuantity: 50, productVersion: 0, lineState: 'OK', reasons: [] },
  ],
});
const previewOf = (quoteToken: string, total = '60000') => ({
  items: total === '0'
    ? [{ productId: WATER_ID, sku: 'WATER_01', name: 'Nước suối', quantity: 2, productVersion: 0, unitPrice: '0', lineTotal: '0' }]
    : [{ productId: WATER_ID, sku: 'WATER_01', name: 'Nước suối', quantity: 2, productVersion: 0, unitPrice: '25000', lineTotal: '50000' },
      { productId: WHEY_ID, sku: 'WHEY_01', name: 'Whey 1kg', quantity: 1, productVersion: 0, unitPrice: '10000', lineTotal: '10000' }],
  total, quoteToken, quoteExpiresAt: '2026-11-19T03:10:00.000Z', pickupLocation: PICKUP, asOf: ASOF,
});
const createdOf = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_ID, code: `ORD-${ORDER_ID}`, status: 'PENDING', transactionId: '690000000000000000000001', transactionStatus: 'PENDING', total: '60000',
  reservationExpiresAt: '2026-11-20T03:00:00.000Z', reservationState: 'HELD', cartVersion: 4, notificationState: 'PENDING', ...overrides,
});

type Call = { path: string; method: string; body?: Record<string, unknown>; headers: Headers };
type Reply = unknown | Response | (() => Response | Promise<Response>);

// Máy chủ giả: Member đăng nhập sẵn. GET /me/cart, POST preview, POST /me/orders trả lần lượt theo danh sách (hết thì giữ phần tử cuối).
function fakeServer(options: { carts?: Reply[]; previews?: Reply[]; creates?: Reply[]; role?: 'MEMBER' | 'STAFF' } = {}) {
  const calls: Call[] = [];
  const counters = { cart: 0, preview: 0, create: 0 };
  const pick = async (list: Reply[], key: keyof typeof counters) => {
    const next = list[Math.min(counters[key], list.length - 1)];
    counters[key] += 1;
    if (next instanceof Response) return next.clone();
    if (typeof next === 'function') return (next as () => Response | Promise<Response>)();
    return json(next, key === 'create' ? 201 : 200);
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const target = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: Call = { path: target.pathname.replace('/api', ''), method, headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const role = options.role ?? 'MEMBER';
    const user = { id: '650000000000000000000001', fullName: 'Hội viên A', phone: '0901234567', roleCode: role };
    if (call.path === '/auth/refresh') return json({ accessToken: 'token-a', tokenType: 'Bearer', expiresIn: 900, user });
    if (call.path === '/auth/me') return json(user);
    if (call.path === '/me/cart' && method === 'GET') return pick(options.carts ?? [cartOf(3)], 'cart');
    if (call.path === '/me/orders/preview' && method === 'POST') return pick(options.previews ?? [previewOf('quote-1')], 'preview');
    if (call.path === '/me/orders' && method === 'POST') return pick(options.creates ?? [createdOf()], 'create');
    return json(pageOf([]));
  });
  return { fetcher, calls };
}
type Server = ReturnType<typeof fakeServer>;

const previews = (server: Server) => server.calls.filter(c => c.path === '/me/orders/preview');
const creates = (server: Server) => server.calls.filter(c => c.path === '/me/orders' && c.method === 'POST');

async function renderApp(server: Server, path = '/member/checkout') {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', url);
  vi.stubGlobal('fetch', server.fetcher);
  window.history.pushState({}, '', path);
  const { default: App } = await import('../../App');
  render(<App />);
}
const confirmButton = () => screen.findByRole('button', { name: 'Xác nhận đặt hàng' }) as Promise<HTMLButtonElement>;
async function fillRecipient(name = 'Nguyễn Văn Nhận', phone = '0912345678') {
  const nameBox = await screen.findByLabelText('Tên người nhận');
  await userEvent.clear(nameBox);
  await userEvent.type(nameBox, name);
  const phoneBox = screen.getByLabelText('Số điện thoại người nhận');
  await userEvent.clear(phoneBox);
  await userEvent.type(phoneBox, phone);
}
const text = () => document.body.textContent ?? '';
const noPaidClaimButton = () => expect(screen.queryByRole('button', { name: /tôi đã|đã trả|đã thanh toán|đã chuyển/i })).toBeNull();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* bỏ qua */ }
  window.history.pushState({}, '', '/');
});

describe('US-41 bước 4: trang đặt hàng /member/checkout', () => {
  it('US-41-TC18: đang tải preview hiện "Đang tải", chưa có nút xác nhận', async () => {
    const server = fakeServer({ previews: [() => new Promise<Response>(() => undefined)] });
    await renderApp(server);
    expect(await screen.findByText(/Đang tải/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Xác nhận đặt hàng' })).toBeNull();
  });

  it('US-41-TC18: mở trang gửi preview {cartVersion} của giỏ hiện tại, hiện dòng, tổng, quầy nhận; KHÔNG tự gửi lệnh tạo đơn', async () => {
    const server = fakeServer();
    await renderApp(server);
    expect(await screen.findByRole('heading', { level: 1, name: 'Đặt hàng' })).toBeTruthy();
    await confirmButton();

    expect(previews(server)).toHaveLength(1);
    expect(previews(server)[0].body).toEqual({ cartVersion: 3 });
    for (const value of ['Nước suối', 'Whey 1kg', PICKUP, 'Tổng cộng']) expect(text()).toContain(value);
    expect(text()).toMatch(/60\.000\s?₫/);
    expect(creates(server)).toHaveLength(0);
  });

  it.each([
    ['giỏ trống (canCheckout false)', { carts: [cartOf(5, true)], previews: [apiError('CART_EMPTY', 'Giỏ hàng đang trống', 409)] }],
    ['preview trả 409 CART_EMPTY', { previews: [apiError('CART_EMPTY', 'Giỏ hàng đang trống', 409)] }],
  ])('US-41-TC18: %s → "Giỏ hàng trống", liên kết quay lại giỏ, không có nút xác nhận', async (_case, options) => {
    const server = fakeServer(options);
    await renderApp(server);
    expect(await screen.findByText(/Giỏ hàng trống/)).toBeTruthy();
    expect((await screen.findByRole('link', { name: 'Quay lại giỏ hàng' })).getAttribute('href')).toBe('/member/cart');
    expect(screen.queryByRole('button', { name: 'Xác nhận đặt hàng' })).toBeNull();
    expect(creates(server)).toHaveLength(0);
  });

  it('US-41-TC18: preview lỗi mạng → role="alert" + "Thử lại"; bấm thì tải lại được', async () => {
    const server = fakeServer({ previews: [failNetwork, previewOf('quote-1')] });
    await renderApp(server);
    expect(await screen.findByRole('alert')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Thử lại' }));
    await confirmButton();
    expect(previews(server)).toHaveLength(2);
  });

  it('US-41-TC18: chọn "Chuyển khoản" hiện cảnh báo chờ nhân viên xác minh; không có nút "tôi đã trả"', async () => {
    const server = fakeServer();
    await renderApp(server);
    await confirmButton();
    expect((screen.getByRole('radio', { name: 'Tiền mặt' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: 'Chuyển khoản' }));
    expect(text()).toMatch(/chờ nhân viên xác minh/i);
    noPaidClaimButton();
  });

  it.each([['1 ký tự sau trim', '  A  '], ['121 ký tự', 'B'.repeat(121)]])('US-41-TC18: tên người nhận %s → báo lỗi, không gửi', async (_case, name) => {
    const server = fakeServer();
    await renderApp(server);
    await confirmButton();
    await fillRecipient(name);
    await userEvent.click(await confirmButton());
    expect(await screen.findByText('Tên người nhận từ 2 đến 120 ký tự')).toBeTruthy();
    expect(creates(server)).toHaveLength(0);
  });

  it('US-41-TC18: xác nhận gửi POST /me/orders đúng body và Idempotency-Key UUID v4; xong hiện mã đơn, trạng thái đơn và tiền tách riêng', async () => {
    const server = fakeServer();
    await renderApp(server);
    await confirmButton();
    await fillRecipient('  Nguyễn Văn Nhận  ');
    await userEvent.click(screen.getByRole('radio', { name: 'Chuyển khoản' }));
    await userEvent.click(await confirmButton());

    expect(await screen.findByText(/Đã tạo đơn/)).toBeTruthy();
    expect(creates(server)).toHaveLength(1);
    const call = creates(server)[0];
    expect(call.body).toEqual({ cartVersion: 3, quoteToken: 'quote-1', recipientName: 'Nguyễn Văn Nhận', recipientPhone: '0912345678', preferredPaymentMethod: 'TRANSFER' });
    expect(call.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    for (const value of [`ORD-${ORDER_ID}`, 'Chờ xác nhận', 'Chưa thanh toán', '20/11/2026', '10:00']) expect(text()).toContain(value);
    expect(text()).not.toMatch(/đã nhận hàng|đã bàn giao/i);
    expect((await screen.findByRole('link', { name: 'Xem đơn hàng của tôi' })).getAttribute('href')).toBe('/member/orders');
  });

  it('US-41-TC18: bấm đúp "Xác nhận đặt hàng" khi đang gửi → chỉ một POST (nút khóa khi pending)', async () => {
    let release: (value: Response) => void = () => undefined;
    const server = fakeServer({ creates: [() => new Promise<Response>(resolve => { release = resolve; })] });
    await renderApp(server);
    await confirmButton();
    await fillRecipient();
    const submit = await confirmButton();
    await userEvent.click(submit);
    await userEvent.click(submit);
    await waitFor(() => expect(submit.disabled).toBe(true));
    expect(text()).not.toMatch(/Đã tạo đơn/);
    release(json(createdOf(), 201));
    expect(await screen.findByText(/Đã tạo đơn/)).toBeTruthy();
    expect(creates(server)).toHaveLength(1);
  });

  it.each(['QUOTE_STALE', 'QUOTE_EXPIRED', 'CART_VERSION_CONFLICT'])(
    'US-41-TC18: tạo đơn bị 409 %s → báo "đã thay đổi", tải lại giỏ + giá, giữ người nhận, không tự gửi lại; xác nhận lại dùng quote mới và key mới', async code => {
      const server = fakeServer({
        carts: [cartOf(3), cartOf(4)], previews: [previewOf('quote-1'), previewOf('quote-2')],
        creates: [apiError(code, 'Giá hoặc giỏ đã thay đổi', 409), createdOf()],
      });
      await renderApp(server);
      await confirmButton();
      await fillRecipient('Trần Thị Giữ', '0987654321');
      await userEvent.click(await confirmButton());

      expect((await screen.findByRole('alert')).textContent).toMatch(/đã thay đổi/i);
      await waitFor(() => expect(previews(server)).toHaveLength(2));
      expect(previews(server)[1].body).toEqual({ cartVersion: 4 });
      expect((screen.getByLabelText('Tên người nhận') as HTMLInputElement).value).toBe('Trần Thị Giữ');
      expect((screen.getByLabelText('Số điện thoại người nhận') as HTMLInputElement).value).toBe('0987654321');
      expect(creates(server)).toHaveLength(1);

      await userEvent.click(await confirmButton());
      await screen.findByText(/Đã tạo đơn/);
      const [first, second] = creates(server);
      expect(second.body).toMatchObject({ cartVersion: 4, quoteToken: 'quote-2' });
      expect(second.headers.get('Idempotency-Key')).not.toBe(first.headers.get('Idempotency-Key'));
    });

  it.each([['lỗi mạng', failNetwork], ['503', () => apiError('SERVICE_UNAVAILABLE', 'Hệ thống bận', 503)]])(
    'US-41-TC18: tạo đơn bị %s → alert + "Thử lại", chưa báo đã tạo đơn; thử lại gửi CÙNG key và cùng body', async (_case, error) => {
      const server = fakeServer({ creates: [error, createdOf()] });
      await renderApp(server);
      await confirmButton();
      await fillRecipient();
      await userEvent.click(await confirmButton());

      expect(await screen.findByRole('alert')).toBeTruthy();
      expect(text()).not.toMatch(/Đã tạo đơn/);
      await userEvent.click(await screen.findByRole('button', { name: 'Thử lại' }));
      await screen.findByText(/Đã tạo đơn/);
      const [first, second] = creates(server);
      expect(second.headers.get('Idempotency-Key')).toBe(first.headers.get('Idempotency-Key'));
      expect(second.body).toEqual(first.body);
    });

  it('US-41-TC18: đơn giá 0 → tổng "0 ₫" (không "Liên hệ"); tạo xong hiện "Đã thanh toán" nhưng đơn vẫn "Chờ xác nhận", không báo đã nhận hàng', async () => {
    const server = fakeServer({ previews: [previewOf('quote-0', '0')], creates: [createdOf({ total: '0', transactionStatus: 'SETTLED', invoiceId: '6a0000000000000000000001' })] });
    await renderApp(server);
    await confirmButton();
    expect(text()).toMatch(/Tổng cộng[\s\S]*0\s?₫/);
    expect(text()).not.toMatch(/Liên hệ/);
    await fillRecipient();
    await userEvent.click(await confirmButton());

    await screen.findByText(/Đã tạo đơn/);
    expect(text()).toContain('Đã thanh toán');
    expect(text()).toContain('Chờ xác nhận');
    expect(text()).not.toMatch(/đã nhận hàng|đã bàn giao/i);
  });

  it('US-41-TC18: quoteToken không nằm trên URL, localStorage hay sessionStorage', async () => {
    const server = fakeServer({ previews: [previewOf('quote-secret-token-123')] });
    await renderApp(server);
    await confirmButton();
    await fillRecipient();
    await userEvent.click(await confirmButton());
    await screen.findByText(/Đã tạo đơn/);
    const stored = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage }) + window.location.href;
    expect(stored).not.toContain('quote-secret-token-123');
  });

  it('US-41-TC18: Staff mở /member/checkout → "Không có quyền truy cập", không gọi API đặt đơn', async () => {
    const server = fakeServer({ role: 'STAFF' });
    await renderApp(server);
    expect(await screen.findByText(/Không có quyền truy cập/)).toBeTruthy();
    expect(server.calls.some(c => c.path.startsWith('/me/orders'))).toBe(false);
  });
});
