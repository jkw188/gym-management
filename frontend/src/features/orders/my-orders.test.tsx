// Tầng kiểm thử frontend (Vitest, jsdom): US-42 bước 3 – trang /member/orders của Member: lọc lịch sử → xem chi tiết → hướng dẫn thanh toán hoặc hủy có lý do → tải lại.
// Dựng nguyên App với fetch giả (khuôn giống cart/checkout test). Test chỉ dựa vào route, hợp đồng API spec US-42 1.0.1 và chữ trên màn hình.
// Hợp đồng giao diện do tester đặt (spec không ghi chữ cụ thể; dùng lại nhãn đã có của US-45 cho thống nhất, cần sinh viên xác nhận):
//   - Route /member/orders chỉ cho MEMBER; vai trò khác thấy "Không có quyền truy cập", không gọi /me/orders.
//   - h1 "Đơn hàng của tôi". Mở trang: GET /me/orders (không gửi q rỗng). Đang tải: "Đang tải". Rỗng: "Chưa có đơn hàng".
//     memberLinked=false: chữ "chưa được liên kết". Lỗi mạng/503: role="alert" + nút "Thử lại".
//   - Bộ lọc: select "Trạng thái đơn" (giá trị PENDING/CONFIRMED/COMPLETED/CANCELLED), ô "Tìm mã đơn", nút "Lọc" → GET /me/orders?status=&q=; q trống thì bỏ hẳn.
//   - Ba lớp trạng thái hiển thị RIÊNG:
//       đơn PENDING "Chờ xác nhận", CONFIRMED "Đã chuẩn bị", COMPLETED "Đã nhận hàng", CANCELLED "Đã hủy";
//       tiền PENDING "Chưa thanh toán", SETTLED "Đã thanh toán", CANCELLED "Không thu";
//       hoàn NONE (không nhãn), PENDING "Chờ hoàn", FAILED "Hoàn thất bại", SUCCEEDED "Đã hoàn". Tiền dạng "50.000 ₫"; giờ theo Việt Nam dd/mm/yyyy HH:mm.
//   - Nút "Xem <mã đơn>" → GET /me/orders/:id. paymentAllowed=true mới gọi GET /me/orders/:id/payment-instructions và hiện mã giao dịch, số tiền,
//     quầy, hướng dẫn tiền mặt, số tài khoản (nếu có transferOptions). expired=true: chữ "Đã hết hạn giữ hàng". Không bao giờ có nút "Tôi đã trả/chuyển khoản".
//   - cancelAllowed=true mới có form hủy: ô "Lý do hủy", ô chọn "Tôi xác nhận hủy toàn bộ đơn chưa bàn giao", nút "Xác nhận hủy đơn"
//     (khóa tới khi đủ lý do + đã tick). Đơn đã thu (transactionStatus SETTLED): form có câu nhắc "chờ hoàn" và "chưa phải tiền đã về".
//     POST /me/orders/:id/cancel Idempotency-Key UUID v4, body {version lấy từ GET, reason đã trim}; thành công → "Đã hủy đơn" và GET chi tiết lại.
//     409 VERSION_CONFLICT → role="alert" có "đã thay đổi", tự GET chi tiết lại, KHÔNG tự gửi lại; gửi lần sau dùng version mới và key MỚI.
//     Lỗi mạng → role="alert", không báo "Đã hủy đơn"; nút "Gửi lại…" dùng CÙNG key và cùng body. 401 → không báo thành công.
//   - Đăng xuất rồi tài khoản khác đăng nhập: không còn thấy đơn của tài khoản cũ; storage không còn id đơn của tài khoản cũ.
// Thủ công (không tự động): socket báo đơn đổi/kết nối lại → trang tải lại REST và không hiện trùng (xem báo cáo).
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Socket thông báo không thuộc phạm vi tự động của bước này: thay bằng socket giả không làm gì.
vi.mock('socket.io-client', () => {
  const socket = { on: () => socket, off: () => socket, emit: () => socket, connect: () => socket, disconnect: () => socket, io: { on: () => undefined, off: () => undefined } };
  return { io: () => socket, default: () => socket };
});

const url = 'http://localhost:3000/api';
const ORDER_ID = '680000000000000000000001';
const CODE = `ORD-${ORDER_ID}`;
const TX_CODE = 'TX-690000000000000000000001';
const ASOF = '2035-11-14T03:00:00.000Z';
const PICKUP = 'Quầy lễ tân tầng 1';
const ACCOUNT_NUMBER = '9990001112';
const REASON = 'Tôi đổi ý, không cần mua nữa';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (code: string, message: string, status: number) => json({ error: { code, message }, requestId: 'req-1' }, status);
const failNetwork = () => Promise.reject(new TypeError('Failed to fetch'));

// Dữ liệu theo bảng tên field spec 1.0.1.
const itemOf = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_ID, code: CODE, channel: 'WEBSITE', status: 'PENDING', transactionStatus: 'PENDING', total: '50000',
  reservationExpiresAt: '2035-11-15T03:00:00.000Z', refundState: 'NONE', createdAt: ASOF, ...overrides,
});
const listOf = (items: unknown[], memberLinked = true) => ({ memberLinked, items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0, asOf: ASOF });
const detailOf = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_ID, code: CODE, channel: 'WEBSITE', status: 'PENDING', version: 2, createdAt: ASOF, confirmedAt: null, fulfilledAt: null, cancelledAt: null,
  cancellationReason: null, reservationState: 'HELD', reservationExpiresAt: '2035-11-15T03:00:00.000Z', expired: false, cancelAllowed: true, paymentAllowed: true,
  preferredPaymentMethod: 'TRANSFER', recipientName: 'Người nhận A', recipientPhone: '+84901234567', pickupLocation: PICKUP,
  items: [{ id: '6a0000000000000000000001', sku: 'WATER_01', name: 'Nước suối', unitPrice: '25000', quantity: 2, lineTotal: '50000' }],
  total: '50000', transactionStatus: 'PENDING', refundState: 'NONE', refundAmount: '0', invoiceId: null, asOf: ASOF, ...overrides,
});
const instructionsOf = (overrides: Record<string, unknown> = {}) => ({
  transactionCode: TX_CODE, amountDue: '50000', preferredPaymentMethod: 'TRANSFER', pickupLocation: PICKUP,
  cashInstructions: 'Thanh toán tiền mặt tại quầy nhận hàng trước hạn giữ hàng.',
  transferOptions: [{ receivingAccountCode: 'GYM_MAIN', bankName: 'TEST ONLY Bank', accountNumber: ACCOUNT_NUMBER, accountName: 'TEST ONLY GYM', transferContent: TX_CODE }],
  ...overrides,
});
const cancelResultOf = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_ID, code: CODE, status: 'CANCELLED', version: 3, reservationState: 'RELEASED', cancelledAt: ASOF, transactionStatus: 'CANCELLED',
  refundState: 'NONE', refundAmount: '0', notificationState: 'STORED', ...overrides,
});
const cancelledDetail = (overrides: Record<string, unknown> = {}) => detailOf({ status: 'CANCELLED', version: 3, reservationState: 'RELEASED', cancelledAt: ASOF,
  cancellationReason: REASON, cancelAllowed: false, paymentAllowed: false, transactionStatus: 'CANCELLED', ...overrides });

type Call = { path: string; method: string; query: URLSearchParams; body?: Record<string, unknown>; headers: Headers };
type Reply = unknown | Response | (() => Response | Promise<Response>);
const userOf = (id: string, fullName: string, roleCode = 'MEMBER') => ({ id, fullName, phone: '0901234567', roleCode });

// Máy chủ giả: Member A đăng nhập sẵn. Mỗi loại request trả lần lượt theo danh sách (hết thì giữ phần tử cuối).
function fakeServer(options: { lists?: Reply[]; details?: Reply[]; instructions?: Reply[]; cancels?: Reply[]; role?: 'MEMBER' | 'STAFF' | 'TRAINER' | 'ADMIN' } = {}) {
  const calls: Call[] = [];
  const counters = { list: 0, detail: 0, instructions: 0, cancel: 0 };
  const pick = async (list: Reply[], key: keyof typeof counters) => {
    const next = list[Math.min(counters[key], list.length - 1)];
    counters[key] += 1;
    if (next instanceof Response) return next.clone();
    if (typeof next === 'function') return (next as () => Response | Promise<Response>)();
    return json(next);
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const target = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: Call = { path: target.pathname.replace('/api', ''), method, query: target.searchParams, headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const user = userOf('650000000000000000000001', 'Hội viên A', options.role ?? 'MEMBER');
    if (call.path === '/auth/refresh') return json({ accessToken: 'token-a', tokenType: 'Bearer', expiresIn: 900, user });
    if (call.path === '/auth/me') return json(user);
    if (call.path === '/me/orders' && method === 'GET') return pick(options.lists ?? [listOf([itemOf()])], 'list');
    if (call.path === `/me/orders/${ORDER_ID}` && method === 'GET') return pick(options.details ?? [detailOf()], 'detail');
    if (call.path === `/me/orders/${ORDER_ID}/payment-instructions` && method === 'GET') return pick(options.instructions ?? [instructionsOf()], 'instructions');
    if (call.path === `/me/orders/${ORDER_ID}/cancel` && method === 'POST') return pick(options.cancels ?? [cancelResultOf()], 'cancel');
    return json({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
  });
  return { fetcher, calls };
}
type Server = ReturnType<typeof fakeServer>;

const lists = (server: Server) => server.calls.filter(c => c.path === '/me/orders' && c.method === 'GET');
const details = (server: Server) => server.calls.filter(c => c.path === `/me/orders/${ORDER_ID}` && c.method === 'GET');
const instructionCalls = (server: Server) => server.calls.filter(c => c.path.endsWith('/payment-instructions'));
const cancels = (server: Server) => server.calls.filter(c => c.path.endsWith('/cancel') && c.method === 'POST');

async function renderApp(fetcher: typeof fetch, path = '/member/orders') {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', url);
  vi.stubGlobal('fetch', fetcher);
  window.history.pushState({}, '', path);
  const { default: App } = await import('../../App');
  render(<App />);
}
const text = () => document.body.textContent ?? '';
const noPaidClaimButton = () => expect(screen.queryByRole('button', { name: /tôi đã|đã trả|đã chuyển/i })).toBeNull();
async function openDetail(server: Server) {
  await renderApp(server.fetcher);
  await userEvent.click(await screen.findByRole('button', { name: `Xem ${CODE}` }));
  await waitFor(() => expect(details(server).length).toBeGreaterThan(0));
}
async function fillCancel(reason = `  ${REASON}  `) {
  await userEvent.type(await screen.findByLabelText('Lý do hủy'), reason);
  await userEvent.click(screen.getByLabelText('Tôi xác nhận hủy toàn bộ đơn chưa bàn giao'));
}
const confirmCancel = () => screen.findByRole('button', { name: 'Xác nhận hủy đơn' }) as Promise<HTMLButtonElement>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  sessionStorage.clear();
  localStorage.clear();
});

describe('US-42 bước 3: trang /member/orders – danh sách và bộ lọc', () => {
  it('US-42-TC12: đang tải hiện "Đang tải", chưa báo rỗng', async () => {
    let release!: (value: Response) => void;
    const server = fakeServer({ lists: [() => new Promise<Response>(resolve => { release = resolve; })] });
    await renderApp(server.fetcher);
    expect(await screen.findByText(/Đang tải/)).toBeTruthy();
    expect(screen.queryByText('Chưa có đơn hàng')).toBeNull();
    release(json(listOf([itemOf()])));
    expect(await screen.findByRole('button', { name: `Xem ${CODE}` })).toBeTruthy();
  });

  it('US-42-TC12: không có đơn → "Chưa có đơn hàng", không có nút xem', async () => {
    const server = fakeServer({ lists: [listOf([])] });
    await renderApp(server.fetcher);
    expect(await screen.findByRole('heading', { level: 1, name: 'Đơn hàng của tôi' })).toBeTruthy();
    expect(await screen.findByText('Chưa có đơn hàng')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Xem ORD-/ })).toBeNull();
  });

  it('US-42-TC03: tài khoản chưa liên kết hồ sơ (memberLinked=false) → báo "chưa được liên kết", không có danh sách', async () => {
    const server = fakeServer({ lists: [listOf([], false)] });
    await renderApp(server.fetcher);
    expect(await screen.findByText(/chưa được liên kết/i)).toBeTruthy();
    expect(screen.queryByText('Chưa có đơn hàng')).toBeNull();
  });

  it.each(['TRAINER', 'STAFF', 'ADMIN'] as const)('US-42-TC03: vai trò %s mở /member/orders thấy "Không có quyền truy cập", không gọi /me/orders', async role => {
    const server = fakeServer({ role });
    await renderApp(server.fetcher);
    expect(await screen.findByText('Không có quyền truy cập')).toBeTruthy();
    expect(server.calls.some(c => c.path.startsWith('/me/orders'))).toBe(false);
  });

  it.each([['lỗi mạng', failNetwork], ['503', () => apiError('SERVICE_UNAVAILABLE', 'Hệ thống bận', 503)]])(
    'US-42-TC12: GET danh sách bị %s → role="alert" + "Thử lại", không hiện đơn cũ; bấm thì tải lại được', async (_label, error) => {
      const server = fakeServer({ lists: [error, listOf([itemOf()])] });
      await renderApp(server.fetcher);
      expect(await screen.findByRole('alert')).toBeTruthy();
      expect(screen.queryByRole('button', { name: `Xem ${CODE}` })).toBeNull();
      await userEvent.click(await screen.findByRole('button', { name: 'Thử lại' }));
      expect(await screen.findByRole('button', { name: `Xem ${CODE}` })).toBeTruthy();
      expect(lists(server)).toHaveLength(2);
    });

  it('US-42-TC05: danh sách hiện riêng trạng thái đơn, tiền và hoàn – đơn hủy đã thu có khoản hoàn PENDING là "Chờ hoàn", không "Đã hoàn"/"Đã nhận hàng"', async () => {
    const server = fakeServer({ lists: [listOf([itemOf({ status: 'CANCELLED', transactionStatus: 'SETTLED', refundState: 'PENDING' })])] });
    await renderApp(server.fetcher);
    await screen.findByRole('button', { name: `Xem ${CODE}` });
    expect(text()).toContain(CODE);
    expect(text()).toContain('Đã hủy');
    expect(text()).toContain('Đã thanh toán');
    expect(text()).toContain('Chờ hoàn');
    expect(text()).toMatch(/50\.000\s?₫/);
    expect(text()).not.toMatch(/Đã hoàn|Đã nhận hàng/);
  });

  it('US-42-TC06: lọc theo trạng thái và mã đơn gửi đúng query; ô mã đơn trống thì không gửi q', async () => {
    const server = fakeServer();
    await renderApp(server.fetcher);
    await screen.findByRole('button', { name: `Xem ${CODE}` });
    expect(lists(server)[0].query.has('q')).toBe(false);
    await userEvent.selectOptions(screen.getByLabelText('Trạng thái đơn'), 'CANCELLED');
    await userEvent.type(screen.getByLabelText('Tìm mã đơn'), '  abc01  ');
    await userEvent.click(screen.getByRole('button', { name: 'Lọc' }));
    await waitFor(() => expect(lists(server).length).toBeGreaterThan(1));
    const filtered = lists(server).at(-1)!;
    expect(filtered.query.get('status')).toBe('CANCELLED');
    expect(filtered.query.get('q')).toBe('abc01');
    await userEvent.clear(screen.getByLabelText('Tìm mã đơn'));
    await userEvent.click(screen.getByRole('button', { name: 'Lọc' }));
    await waitFor(() => expect(lists(server).length).toBeGreaterThan(2));
    expect(lists(server).at(-1)!.query.has('q')).toBe(false);
  });
});

describe('US-42 bước 3: chi tiết đơn và hướng dẫn thanh toán', () => {
  it('US-42-TC05: chi tiết đơn CANCELLED + SETTLED + hoàn PENDING → "Đã hủy", "Đã thanh toán", "Chờ hoàn" 50.000 ₫; không form hủy, không gọi hướng dẫn thanh toán', async () => {
    const server = fakeServer({ details: [cancelledDetail({ transactionStatus: 'SETTLED', refundState: 'PENDING', refundAmount: '50000', invoiceId: '6b0000000000000000000001' })] });
    await openDetail(server);
    await screen.findByText(/Chờ hoàn/);
    expect(text()).toContain('Đã hủy');
    expect(text()).toContain('Đã thanh toán');
    expect(text()).toMatch(/50\.000\s?₫/);
    expect(text()).not.toMatch(/Đã hoàn|Đã nhận hàng/);
    expect(screen.queryByLabelText('Lý do hủy')).toBeNull();
    expect(instructionCalls(server)).toEqual([]);
  });

  it('US-42-TC07: đơn chờ thu (paymentAllowed) → hiện mã giao dịch, số tiền, quầy, hướng dẫn tiền mặt và số tài khoản cấu hình; không có nút "Tôi đã chuyển khoản"', async () => {
    const server = fakeServer();
    await openDetail(server);
    await screen.findByText(new RegExp(TX_CODE));
    expect(instructionCalls(server)).toHaveLength(1);
    expect(text()).toMatch(/50\.000\s?₫/);
    expect(text()).toContain(PICKUP);
    expect(text()).toContain('Thanh toán tiền mặt tại quầy');
    expect(text()).toContain(ACCOUNT_NUMBER);
    // Hạn giữ hàng theo giờ Việt Nam: 03:00 UTC ngày 15/11 = 10:00 ngày 15/11.
    expect(text()).toMatch(/15\/11\/2035[\s\S]*10:00|10:00[\s\S]*15\/11\/2035/);
    noPaidClaimButton();
  });

  it('US-42-TC07: thiếu cấu hình ngân hàng (không có transferOptions) → vẫn hiện hướng dẫn tiền mặt, không có số tài khoản', async () => {
    const server = fakeServer({ instructions: [instructionsOf({ transferOptions: undefined })] });
    await openDetail(server);
    await screen.findByText(/Thanh toán tiền mặt tại quầy/);
    expect(text()).not.toContain(ACCOUNT_NUMBER);
    noPaidClaimButton();
  });

  it('US-42-TC07: đơn đã thanh toán (paymentAllowed=false) → không gọi hướng dẫn thanh toán, chỉ nhắc đến quầy nhận hàng', async () => {
    const server = fakeServer({ details: [detailOf({ status: 'CONFIRMED', transactionStatus: 'SETTLED', paymentAllowed: false, invoiceId: '6b0000000000000000000001' })] });
    await openDetail(server);
    await screen.findByText(/Đã thanh toán/);
    expect(text()).toContain(PICKUP);
    expect(text()).toContain('Đã chuẩn bị');
    expect(text()).not.toContain(TX_CODE);
    expect(instructionCalls(server)).toEqual([]);
    noPaidClaimButton();
  });

  it('US-42-TC08: đơn hết hạn (expired=true) mà worker chưa chạy → "Đã hết hạn giữ hàng", không gọi hướng dẫn thanh toán', async () => {
    const server = fakeServer({ details: [detailOf({ expired: true, paymentAllowed: false })] });
    await openDetail(server);
    expect(await screen.findByText(/Đã hết hạn giữ hàng/)).toBeTruthy();
    expect(instructionCalls(server)).toEqual([]);
    expect(text()).not.toContain(ACCOUNT_NUMBER);
    noPaidClaimButton();
  });
});

describe('US-42 bước 3: hủy đơn của mình', () => {
  it('US-42-TC09: hủy đơn chưa thu → nút khóa tới khi đủ lý do + tick; POST đúng key/body (version từ GET, lý do đã trim); bấm đúp chỉ một POST; xong thì tải lại chi tiết', async () => {
    let finish!: (value: Response) => void;
    const server = fakeServer({ details: [detailOf(), cancelledDetail()], cancels: [() => new Promise<Response>(resolve => { finish = resolve; })] });
    await openDetail(server);
    expect((await confirmCancel()).disabled).toBe(true);
    await fillCancel();
    const button = await confirmCancel();
    expect(button.disabled).toBe(false);
    await userEvent.dblClick(button);
    await waitFor(() => expect(cancels(server)).toHaveLength(1));
    const sent = cancels(server)[0];
    expect(sent.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(sent.body).toEqual({ version: 2, reason: REASON });
    expect(text()).not.toContain('Đã hủy đơn');
    finish(json(cancelResultOf()));
    expect(await screen.findByText(/Đã hủy đơn/)).toBeTruthy();
    await waitFor(() => expect(details(server).length).toBeGreaterThanOrEqual(2));
    expect(cancels(server)).toHaveLength(1);
  });

  it('US-42-TC09: đơn đã thu → form hủy nhắc rõ sẽ ghi khoản chờ hoàn, chưa phải tiền đã về; kết quả hiện "Chờ hoàn", không "Đã hoàn"', async () => {
    const server = fakeServer({
      details: [detailOf({ status: 'CONFIRMED', transactionStatus: 'SETTLED', paymentAllowed: false }),
        cancelledDetail({ transactionStatus: 'SETTLED', refundState: 'PENDING', refundAmount: '50000' })],
      cancels: [cancelResultOf({ transactionStatus: 'SETTLED', refundState: 'PENDING', refundAmount: '50000', refundId: '6c0000000000000000000001' })],
    });
    await openDetail(server);
    await screen.findByLabelText('Lý do hủy');
    expect(text()).toMatch(/chờ hoàn/i);
    expect(text()).toMatch(/chưa phải tiền đã về/i);
    await fillCancel();
    await userEvent.click(await confirmCancel());
    expect(await screen.findByText(/Đã hủy đơn/)).toBeTruthy();
    expect(text()).toContain('Chờ hoàn');
    expect(text()).not.toMatch(/Đã hoàn/);
  });

  it.each([
    ['COMPLETED', detailOf({ status: 'COMPLETED', reservationState: 'CONSUMED', transactionStatus: 'SETTLED', cancelAllowed: false, paymentAllowed: false, fulfilledAt: ASOF })],
    ['CANCELLED', cancelledDetail()],
  ])('US-42-TC09: đơn %s (cancelAllowed=false) → không có form hủy', async (_label, body) => {
    const server = fakeServer({ details: [body] });
    await openDetail(server);
    await waitFor(() => expect(text()).toMatch(/Đã nhận hàng|Đã hủy/));
    expect(screen.queryByLabelText('Lý do hủy')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Xác nhận hủy đơn' })).toBeNull();
  });

  it('US-42-TC10: 409 VERSION_CONFLICT (nhân viên vừa thu/chuẩn bị) → báo "đã thay đổi", tự tải lại chi tiết, không tự gửi lại; gửi lần sau dùng version mới và key mới', async () => {
    const server = fakeServer({
      details: [detailOf(), detailOf({ status: 'CONFIRMED', version: 3, transactionStatus: 'SETTLED', paymentAllowed: false }), cancelledDetail({ version: 4 })],
      cancels: [apiError('VERSION_CONFLICT', 'Đơn đã thay đổi', 409), cancelResultOf({ version: 4, transactionStatus: 'SETTLED', refundState: 'PENDING', refundAmount: '50000' })],
    });
    await openDetail(server);
    await fillCancel();
    await userEvent.click(await confirmCancel());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/đã thay đổi/i);
    await waitFor(() => expect(details(server)).toHaveLength(2));
    expect(cancels(server)).toHaveLength(1);
    expect(text()).not.toContain('Đã hủy đơn');
    await screen.findByText(/Đã thanh toán/);
    const reason = await screen.findByLabelText('Lý do hủy') as HTMLTextAreaElement;
    if (!reason.value) await fillCancel();
    else if (!(screen.getByLabelText('Tôi xác nhận hủy toàn bộ đơn chưa bàn giao') as HTMLInputElement).checked) {
      await userEvent.click(screen.getByLabelText('Tôi xác nhận hủy toàn bộ đơn chưa bàn giao'));
    }
    await userEvent.click(await confirmCancel());
    await waitFor(() => expect(cancels(server)).toHaveLength(2));
    const [first, second] = cancels(server);
    expect(second.body).toMatchObject({ version: 3, reason: REASON });
    expect(second.headers.get('Idempotency-Key')).not.toBe(first.headers.get('Idempotency-Key'));
  });

  it('US-42-TC11: mất mạng khi gửi hủy → role="alert", không báo "Đã hủy đơn"; bấm gửi lại dùng CÙNG key và cùng body', async () => {
    const server = fakeServer({ details: [detailOf(), cancelledDetail()], cancels: [failNetwork, cancelResultOf()] });
    await openDetail(server);
    await fillCancel();
    await userEvent.click(await confirmCancel());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(text()).not.toContain('Đã hủy đơn');
    await userEvent.click(await screen.findByRole('button', { name: /Gửi lại/ }));
    expect(await screen.findByText(/Đã hủy đơn/)).toBeTruthy();
    const [first, second] = cancels(server);
    expect(second.headers.get('Idempotency-Key')).toBe(first.headers.get('Idempotency-Key'));
    expect(second.body).toEqual(first.body);
  });

  it('US-42-TC11: phiên bị thu hồi (401) khi gửi hủy → không báo thành công, có thông báo lỗi', async () => {
    const server = fakeServer({ cancels: [apiError('UNAUTHORIZED', 'Phiên đăng nhập đã hết hiệu lực', 401)] });
    await openDetail(server);
    await fillCancel();
    await userEvent.click(await confirmCancel());
    await waitFor(() => expect(cancels(server).length).toBeGreaterThan(0));
    await waitFor(() => expect(text()).toMatch(/Phiên đăng nhập|đăng nhập lại|Cần xác thực/i));
    expect(text()).not.toContain('Đã hủy đơn');
  });
});

describe('US-42 bước 3: đổi tài khoản', () => {
  it('US-42-TC12: Member A đăng xuất, Member B đăng nhập → /member/orders chỉ thấy đơn của B, không lộ đơn hay cache của A', async () => {
    const A_ID = '680000000000000000000aaa', B_ID = '680000000000000000000bbb';
    let loggedIn: 'a' | 'b' | null = 'a';
    const calls: Array<{ path: string; auth: string | null }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname.replace('/api', '');
      const auth = new Headers(init?.headers).get('Authorization');
      calls.push({ path, auth });
      const userA = userOf('650000000000000000000001', 'Hội viên A'), userB = userOf('650000000000000000000002', 'Hội viên B');
      if (path === '/auth/refresh') {
        return loggedIn ? json({ accessToken: `token-${loggedIn}`, tokenType: 'Bearer', expiresIn: 900, user: loggedIn === 'a' ? userA : userB })
          : apiError('UNAUTHORIZED', 'Cần xác thực', 401);
      }
      if (path === '/auth/me') return loggedIn ? json(loggedIn === 'a' ? userA : userB) : apiError('UNAUTHORIZED', 'Cần xác thực', 401);
      if (path === '/auth/logout') { loggedIn = null; return new Response(null, { status: 204 }); }
      if (path === '/auth/login') { loggedIn = 'b'; return json({ accessToken: 'token-b', tokenType: 'Bearer', expiresIn: 900, user: userB }); }
      if (path === '/me/orders') {
        if (auth === 'Bearer token-a') return json(listOf([itemOf({ id: A_ID, code: `ORD-${A_ID}` })]));
        if (auth === 'Bearer token-b') return json(listOf([itemOf({ id: B_ID, code: `ORD-${B_ID}` })]));
        return apiError('UNAUTHORIZED', 'Cần xác thực', 401);
      }
      return json({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
    });
    await renderApp(fetcher);
    expect(await screen.findByRole('button', { name: `Xem ORD-${A_ID}` })).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }));
    await waitFor(() => expect(screen.queryByText(`ORD-${A_ID}`)).toBeNull());
    // Đăng xuất xong: storage trình duyệt không còn dữ liệu đơn của A.
    const stored = JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage });
    expect(stored).not.toContain(A_ID);

    window.history.pushState({}, '', `/login?returnTo=${encodeURIComponent('/member/orders')}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await userEvent.type(await screen.findByLabelText('Số điện thoại'), '0907654321');
    await userEvent.type(screen.getByLabelText('Mật khẩu'), 'Mật khẩu của B 123');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));

    expect(await screen.findByRole('button', { name: `Xem ORD-${B_ID}` })).toBeTruthy();
    expect(screen.queryByText(`ORD-${A_ID}`)).toBeNull();
    const afterLogin = calls.slice(calls.findIndex(c => c.path === '/auth/login'));
    expect(afterLogin.filter(c => c.path.startsWith('/me/orders')).every(c => c.auth === 'Bearer token-b')).toBe(true);
  });
});

