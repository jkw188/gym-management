// Tầng kiểm thử frontend (Vitest, jsdom): US-40 bước 3 – trang giỏ /member/cart và nút "Thêm vào giỏ" của Member ở /shop/:id.
// Dựng nguyên App với fetch giả (khuôn giống shop.test.tsx), test chỉ dựa vào route, hợp đồng API US-40 mục 3 và chữ trên màn hình.
// Hợp đồng giao diện do tester đặt (spec không ghi chữ cụ thể; cần sinh viên xác nhận):
//   - File frontend/src/features/cart/CartPage.tsx, cart.api.ts (gọi qua apiClient). Route /member/cart chỉ cho MEMBER.
//   - h1 "Giỏ hàng". Đang tải: "Đang tải". GET lỗi mạng/503: role="alert" + nút "Thử lại".
//   - Chưa liên kết (memberLinked=false): chữ có "chưa được liên kết", không có danh sách hay nút sửa.
//   - Giỏ trống: "Giỏ hàng trống", "Tạm tính" 0 ₫.
//   - Danh sách <ul aria-label="Dòng giỏ hàng">, mỗi dòng một listitem: tên (name null → "Sản phẩm không còn tồn tại"),
//     đơn giá và thành tiền dạng "9.000 ₫"; ô số lượng aria-label "Số lượng <tên>"; nút "Tăng <tên>", "Giảm <tên>", "Xóa <tên>".
//     Lý do bị chặn: PRODUCT_UNAVAILABLE → "Sản phẩm ngừng bán"; INVENTORY_UNAVAILABLE → "Chưa có thông tin tồn kho";
//     INSUFFICIENT_STOCK → "Chỉ còn <availableQuantity>". Dòng BLOCKED: nút Tăng khóa, Giảm/Xóa vẫn bấm được.
//     Giảm khóa khi quantity = 1 (xóa dùng nút Xóa); Tăng khóa khi quantity = 999.
//   - Tạm tính: "Tạm tính" + subtotal; subtotal null → "Chưa tính được tạm tính" (UNAVAILABLE) hoặc "vượt mức cho phép" (OVER_LIMIT).
//   - Tăng/Giảm/nhập số + Enter → PUT /me/cart/items/:id {version, quantity}; Xóa → DELETE /me/cart/items/:id?version=;
//     mọi lệnh có header Idempotency-Key, khóa nút khi đang gửi; thành công thì GET lại giỏ.
//     Nhập 0, 1000 hoặc chữ → báo "Số lượng từ 1 đến 999", không gửi.
//     409 CART_VERSION_CONFLICT → role="alert" có "Giỏ hàng đã thay đổi" và tự GET lại (không tự gửi lại lệnh).
//     Lỗi mạng/503 → role="alert" + nút "Thử lại" gửi lại CÙNG Idempotency-Key và cùng body.
//   - Không bao giờ có nút "Thanh toán"/"Đặt hàng" (canCheckout false ở S05); có chữ "đặt hàng sẽ có" để hướng dẫn.
//   - Đăng xuất rồi đăng nhập tài khoản khác: không còn thấy dòng của tài khoản cũ; không lưu giỏ/version/key vào localStorage/sessionStorage.
//   - /shop/:id (Member): bấm "Thêm vào giỏ" → GET /me/cart lấy version → POST /me/cart/items {version, productId, quantity} có key;
//     thành công: chữ "Đã thêm vào giỏ" + liên kết "Xem giỏ hàng" tới /member/cart. 409 nghiệp vụ → role="alert"; không tự gửi lại.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Socket thông báo của Member không liên quan US-40: thay bằng socket giả không làm gì.
vi.mock('socket.io-client', () => {
  const socket = { on: () => socket, off: () => socket, emit: () => socket, connect: () => socket, disconnect: () => socket, io: { on: () => undefined, off: () => undefined } };
  return { io: () => socket, default: () => socket };
});

const url = 'http://localhost:3000/api';
const WATER_ID = '670000000000000000000001';
const WHEY_ID = '670000000000000000000002';
const ASOF = '2026-11-19T03:00:00.000Z';

type Line = {
  productId: string; sku: string | null; name: string | null; imageUrl: string | null; quantity: number; unitPrice: string | null;
  lineTotal: string | null; availableQuantity: number | null; productVersion: number | null; lineState: 'OK' | 'BLOCKED'; reasons: string[];
};
type Cart = {
  memberLinked: boolean; reason?: string; version: number; items: Line[]; subtotal: string | null;
  totalsState: 'OK' | 'UNAVAILABLE' | 'OVER_LIMIT'; readyForOrder: boolean; canCheckout: false; asOf: string;
};

const line = (overrides: Partial<Line> = {}): Line => ({
  productId: WATER_ID, sku: 'WATER_01', name: 'Nước suối', imageUrl: null, quantity: 2, unitPrice: '9000', lineTotal: '18000',
  availableQuantity: 50, productVersion: 0, lineState: 'OK', reasons: [], ...overrides,
});
const cartOf = (items: Line[], overrides: Partial<Cart> = {}): Cart => ({
  memberLinked: true, version: 3, items, subtotal: items.length ? '18000' : '0', totalsState: 'OK',
  readyForOrder: items.length > 0, canCheckout: false, asOf: ASOF, ...overrides,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (code: string, message: string, status: number) => json({ error: { code, message }, requestId: 'req-1' }, status);
const pageOf = <T,>(items: T[]) => ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0 });
const userOf = (id: string, fullName: string) => ({ id, fullName, phone: '0901234567', roleCode: 'MEMBER' });

type Call = { path: string; method: string; body?: Record<string, unknown>; headers: Headers; query: URLSearchParams };
type Handler = (call: Call, callNo: number) => Response | Promise<Response>;

// Máy chủ giả: Member đăng nhập sẵn (refresh trả token-a). GET /me/cart trả lần lượt các giỏ trong `carts`
// (hết danh sách thì giữ giỏ cuối). PUT/POST/DELETE mặc định thành công; muốn lỗi thì truyền handler.
function fakeServer(options: {
  carts?: Array<Cart | Response | (() => Response | Promise<Response>)>; put?: Handler; post?: Handler; del?: Handler;
  role?: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
} = {}) {
  const calls: Call[] = [];
  let getNo = 0, putNo = 0, postNo = 0, delNo = 0;
  const carts = options.carts ?? [cartOf([line()])];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const target = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: Call = { path: target.pathname.replace('/api', ''), method, headers: new Headers(init?.headers), query: target.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const path = call.path;
    if (path === '/auth/refresh') {
      const role = options.role ?? 'MEMBER';
      return json({ accessToken: 'token-a', tokenType: 'Bearer', expiresIn: 900, user: { ...userOf('650000000000000000000001', 'Hội viên A'), roleCode: role } });
    }
    if (path === '/auth/me') return json({ ...userOf('650000000000000000000001', 'Hội viên A'), roleCode: options.role ?? 'MEMBER' });
    if (path === '/me/cart' && method === 'GET') {
      const next = carts[Math.min(getNo, carts.length - 1)];
      getNo += 1;
      if (next instanceof Response) return next.clone();
      if (typeof next === 'function') return next();
      return json(next);
    }
    if (path === '/me/cart/items' && method === 'POST') {
      postNo += 1;
      if (options.post) return options.post(call, postNo);
      return json({ version: Number(call.body?.version) + 1, productId: call.body?.productId, quantity: call.body?.quantity }, 201);
    }
    const item = path.match(/^\/me\/cart\/items\/([^/]+)$/);
    if (item && method === 'PUT') {
      putNo += 1;
      if (options.put) return options.put(call, putNo);
      return json({ version: Number(call.body?.version) + 1, productId: item[1], quantity: call.body?.quantity });
    }
    if (item && method === 'DELETE') {
      delNo += 1;
      if (options.del) return options.del(call, delNo);
      return json({ version: Number(call.query.get('version')) + 1, removedProductId: item[1] });
    }
    if (path === '/categories') return json(pageOf([{ id: '660000000000000000000001', name: 'Đồ uống' }]));
    if (path === `/products/${WATER_ID}`) {
      return json({ id: WATER_ID, sku: 'WATER_01', name: 'Nước suối', category: { id: '660000000000000000000001', name: 'Đồ uống' },
        price: '9000', version: 0, availability: 'IN_STOCK', asOf: ASOF });
    }
    return json(pageOf([]));
  });
  return { fetcher, calls };
}
type Server = ReturnType<typeof fakeServer>;

const cartGets = (server: Server) => server.calls.filter(c => c.path === '/me/cart' && c.method === 'GET');
const cartWrites = (server: Server) => server.calls.filter(c => c.path.startsWith('/me/cart/items'));

async function renderApp(server: Server, path = '/member/cart') {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', url);
  vi.stubGlobal('fetch', server.fetcher);
  window.history.pushState({}, '', path);
  const { default: App } = await import('../../App');
  render(<App />);
}

const cartList = () => screen.findByRole('list', { name: 'Dòng giỏ hàng' });
async function lineOf(name: string) {
  const list = await cartList();
  return within(list).findByText(name).then(node => node.closest('li') as HTMLElement);
}
const button = (name: string) => screen.findByRole('button', { name }) as Promise<HTMLButtonElement>;
const noCheckoutButton = () => expect(screen.queryByRole('button', { name: /thanh toán|đặt hàng/i })).toBeNull();
const failNetwork = () => Promise.reject(new TypeError('Failed to fetch'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* bỏ qua */ }
  window.history.pushState({}, '', '/');
});

// =====================================================================
describe('US-40 bước 3: trang giỏ /member/cart – hiển thị', () => {
  it('US-40-TC01: hiện dòng giỏ với tên, số lượng, đơn giá, thành tiền và tạm tính dạng VND', async () => {
    const server = fakeServer({ carts: [cartOf([line(), line({ productId: WHEY_ID, sku: 'WHEY_01', name: 'Whey Protein', quantity: 1, unitPrice: '900000', lineTotal: '900000' })], { subtotal: '918000' })] });
    await renderApp(server);

    expect(await screen.findByRole('heading', { level: 1, name: 'Giỏ hàng' })).toBeTruthy();
    const water = await lineOf('Nước suối');
    expect(water.textContent).toMatch(/9\.000\s?₫/);
    expect(water.textContent).toMatch(/18\.000\s?₫/);
    expect((within(water).getByLabelText('Số lượng Nước suối') as HTMLInputElement).value).toBe('2');
    expect(document.body.textContent).toMatch(/Tạm tính[\s\S]*918\.000\s?₫/);
    // Thứ tự dòng đúng như server trả.
    const names = within(await cartList()).getAllByRole('listitem').map(item => item.textContent ?? '');
    expect(names[0]).toContain('Nước suối');
    expect(names[1]).toContain('Whey Protein');
  });

  it('US-40-TC16: đang tải hiện "Đang tải"', async () => {
    let release!: (value: Response) => void;
    const server = fakeServer({ carts: [() => new Promise<Response>(resolve => { release = resolve; })] });
    await renderApp(server);
    expect(await screen.findByText(/Đang tải/)).toBeTruthy();
    release(json(cartOf([line()])));
    expect(await lineOf('Nước suối')).toBeTruthy();
  });

  it('US-40-TC16: giỏ trống hiện "Giỏ hàng trống", tạm tính 0 ₫, không có nút thanh toán, có hướng dẫn đặt hàng sẽ có sau', async () => {
    const server = fakeServer({ carts: [cartOf([], { version: 0 })] });
    await renderApp(server);
    expect(await screen.findByText('Giỏ hàng trống')).toBeTruthy();
    expect(document.body.textContent).toMatch(/Tạm tính[\s\S]*0\s?₫/);
    expect(document.body.textContent).toMatch(/đặt hàng sẽ có/i);
    noCheckoutButton();
  });

  it('US-40-TC16: giỏ hợp lệ (readyForOrder true) vẫn KHÔNG có nút thanh toán/đặt hàng', async () => {
    const server = fakeServer({ carts: [cartOf([line()], { readyForOrder: true })] });
    await renderApp(server);
    await lineOf('Nước suối');
    noCheckoutButton();
  });

  it.each([['lỗi mạng', failNetwork], ['503', () => apiError('SERVICE_UNAVAILABLE', 'Hệ thống bận', 503)]])(
    'US-40-TC16: GET giỏ bị %s → role="alert" + "Thử lại", bấm thì tải lại được', async (_label, error) => {
      const server = fakeServer({ carts: [error, cartOf([line()])] });
      await renderApp(server);
      expect(await screen.findByRole('alert')).toBeTruthy();
      expect(screen.queryByRole('list', { name: 'Dòng giỏ hàng' })).toBeNull();
      await userEvent.click(await button('Thử lại'));
      expect(await lineOf('Nước suối')).toBeTruthy();
      expect(cartGets(server)).toHaveLength(2);
    });

  it('US-40-TC03: tài khoản chưa liên kết hồ sơ → báo "chưa được liên kết", không có danh sách hay nút sửa', async () => {
    const server = fakeServer({ carts: [cartOf([], { memberLinked: false, reason: 'MEMBER_PROFILE_REQUIRED', version: 0, readyForOrder: false })] });
    await renderApp(server);
    expect(await screen.findByText(/chưa được liên kết/i)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Dòng giỏ hàng' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Tăng|Giảm|Xóa) / })).toBeNull();
    noCheckoutButton();
  });

  it.each(['TRAINER', 'STAFF', 'ADMIN'] as const)('US-40-TC02: vai trò %s mở /member/cart không gọi API giỏ', async role => {
    const server = fakeServer({ role });
    await renderApp(server);
    await waitFor(() => expect(window.location.pathname).not.toBe('/member/cart'));
    expect(cartGets(server)).toEqual([]);
  });
});

// =====================================================================
describe('US-40 bước 3: dòng bị chặn và tổng không tính được', () => {
  it('US-40-TC05: dòng ngừng bán hiện "Sản phẩm ngừng bán", nút Tăng khóa, Giảm và Xóa vẫn bấm được', async () => {
    const server = fakeServer({ carts: [cartOf([line({ quantity: 3, lineState: 'BLOCKED', reasons: ['PRODUCT_UNAVAILABLE'] })], { readyForOrder: false })] });
    await renderApp(server);
    const water = await lineOf('Nước suối');
    expect(water.textContent).toContain('Sản phẩm ngừng bán');
    expect((await button('Tăng Nước suối')).disabled).toBe(true);
    expect((await button('Giảm Nước suối')).disabled).toBe(false);
    expect((await button('Xóa Nước suối')).disabled).toBe(false);
  });

  it('US-40-TC05: dòng vượt tồn hiện "Chỉ còn 2"; dòng thiếu tồn kho hiện "Chưa có thông tin tồn kho"', async () => {
    const server = fakeServer({ carts: [cartOf([
      line({ quantity: 4, availableQuantity: 2, lineState: 'BLOCKED', reasons: ['INSUFFICIENT_STOCK'] }),
      line({ productId: WHEY_ID, sku: 'WHEY_01', name: 'Whey Protein', quantity: 1, availableQuantity: null, lineState: 'BLOCKED', reasons: ['INVENTORY_UNAVAILABLE'] }),
    ], { readyForOrder: false })] });
    await renderApp(server);
    expect((await lineOf('Nước suối')).textContent).toMatch(/Chỉ còn 2/);
    expect((await lineOf('Whey Protein')).textContent).toContain('Chưa có thông tin tồn kho');
  });

  it('US-40-TC06: giảm dòng bị chặn gửi PUT quantity nhỏ hơn, rồi tải lại vẫn hiện lý do', async () => {
    const blocked = line({ quantity: 3, lineState: 'BLOCKED', reasons: ['PRODUCT_UNAVAILABLE'] });
    const server = fakeServer({ carts: [cartOf([blocked], { version: 3 }), cartOf([{ ...blocked, quantity: 2 }], { version: 4 })] });
    await renderApp(server);
    await userEvent.click(await button('Giảm Nước suối'));
    await waitFor(() => expect(cartGets(server)).toHaveLength(2));
    const put = cartWrites(server)[0];
    expect(put).toMatchObject({ method: 'PUT', path: `/me/cart/items/${WATER_ID}`, body: { version: 3, quantity: 2 } });
    expect((await lineOf('Nước suối')).textContent).toContain('Sản phẩm ngừng bán');
  });

  it('US-40-TC08: sản phẩm không còn tồn tại (name/giá null) → hiện "Sản phẩm không còn tồn tại", vẫn có nút Xóa', async () => {
    const server = fakeServer({ carts: [cartOf([line({ name: null, sku: null, unitPrice: null, lineTotal: null, lineState: 'BLOCKED', reasons: ['PRODUCT_UNAVAILABLE'] })],
      { subtotal: null, totalsState: 'UNAVAILABLE', readyForOrder: false })] });
    await renderApp(server);
    const item = await lineOf('Sản phẩm không còn tồn tại');
    expect(within(item).getByRole('button', { name: /^Xóa / })).toBeTruthy();
    expect(document.body.textContent).toContain('Chưa tính được tạm tính');
  });

  it('US-40-TC08: tổng vượt trần (OVER_LIMIT) → hiện "vượt mức cho phép", không hiện số tạm tính giả', async () => {
    const server = fakeServer({ carts: [cartOf([line({ unitPrice: '600000000000', lineTotal: null })], { subtotal: null, totalsState: 'OVER_LIMIT', readyForOrder: false })] });
    await renderApp(server);
    await lineOf('Nước suối');
    expect(document.body.textContent).toMatch(/vượt mức cho phép/i);
  });
});

// =====================================================================
describe('US-40 bước 3: sửa, xóa, version và key', () => {
  it('US-40-TC01: bấm Tăng gửi PUT {version, quantity+1} có Idempotency-Key, xong thì tải lại giỏ', async () => {
    const server = fakeServer({ carts: [cartOf([line({ quantity: 2 })], { version: 3 }), cartOf([line({ quantity: 3, lineTotal: '27000' })], { version: 4, subtotal: '27000' })] });
    await renderApp(server);
    await userEvent.click(await button('Tăng Nước suối'));
    await waitFor(() => expect(cartGets(server)).toHaveLength(2));
    const put = cartWrites(server)[0];
    expect(put).toMatchObject({ method: 'PUT', path: `/me/cart/items/${WATER_ID}`, body: { version: 3, quantity: 3 } });
    expect(put.headers.get('Idempotency-Key')).toBeTruthy();
    // Body chỉ có version và quantity: không gửi memberId, giá hay tổng.
    expect(Object.keys(put.body ?? {}).sort()).toEqual(['quantity', 'version']);
    expect(document.body.textContent).toMatch(/27\.000\s?₫/);
  });

  it('US-40-TC01: nhập số 5 rồi Enter gửi PUT quantity 5 (số tuyệt đối)', async () => {
    const server = fakeServer({ carts: [cartOf([line({ quantity: 2 })], { version: 3 }), cartOf([line({ quantity: 5 })], { version: 4 })] });
    await renderApp(server);
    const input = (await screen.findByLabelText('Số lượng Nước suối')) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, '5{Enter}');
    await waitFor(() => expect(cartWrites(server)).toHaveLength(1));
    expect(cartWrites(server)[0]).toMatchObject({ method: 'PUT', body: { version: 3, quantity: 5 } });
  });

  it.each(['0', '1000', 'abc'])('US-40-TC04: nhập "%s" rồi Enter → báo "Số lượng từ 1 đến 999", không gửi', async value => {
    const server = fakeServer();
    await renderApp(server);
    const input = (await screen.findByLabelText('Số lượng Nước suối')) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, `${value}{Enter}`);
    expect(await screen.findByText(/Số lượng từ 1 đến 999/)).toBeTruthy();
    expect(cartWrites(server)).toEqual([]);
  });

  it('US-40-TC04: quantity 1 thì nút Giảm khóa (muốn bỏ phải bấm Xóa); quantity 999 thì nút Tăng khóa', async () => {
    const server = fakeServer({ carts: [cartOf([line({ quantity: 1 }), line({ productId: WHEY_ID, sku: 'WHEY_01', name: 'Whey Protein', quantity: 999 })])] });
    await renderApp(server);
    expect((await button('Giảm Nước suối')).disabled).toBe(true);
    expect((await button('Tăng Whey Protein')).disabled).toBe(true);
  });

  it('US-40-TC06: bấm Xóa gửi DELETE ?version= có key, không body; xong tải lại thấy giỏ trống', async () => {
    const server = fakeServer({ carts: [cartOf([line()], { version: 3 }), cartOf([], { version: 4 })] });
    await renderApp(server);
    await userEvent.click(await button('Xóa Nước suối'));
    expect(await screen.findByText('Giỏ hàng trống')).toBeTruthy();
    const del = cartWrites(server)[0];
    expect(del).toMatchObject({ method: 'DELETE', path: `/me/cart/items/${WATER_ID}` });
    expect(del.query.get('version')).toBe('3');
    expect(del.body).toBeUndefined();
    expect(del.headers.get('Idempotency-Key')).toBeTruthy();
  });

  it('US-40-TC10: bấm đúp Tăng khi đang gửi → chỉ một PUT (nút khóa khi pending)', async () => {
    let release!: (value: Response) => void;
    const server = fakeServer({
      carts: [cartOf([line({ quantity: 2 })], { version: 3 }), cartOf([line({ quantity: 3 })], { version: 4 })],
      put: () => new Promise<Response>(resolve => { release = resolve; }),
    });
    await renderApp(server);
    const increase = await button('Tăng Nước suối');
    fireEvent.click(increase);
    fireEvent.click(increase);
    await waitFor(() => expect(cartWrites(server)).toHaveLength(1));
    expect(increase.disabled).toBe(true);
    release(json({ version: 4, productId: WATER_ID, quantity: 3 }));
    await waitFor(() => expect(cartGets(server)).toHaveLength(2));
    expect(cartWrites(server)).toHaveLength(1);
  });

  it('US-40-TC09: PUT bị 409 CART_VERSION_CONFLICT → báo "Giỏ hàng đã thay đổi", tự tải lại, không tự gửi lại', async () => {
    const server = fakeServer({
      carts: [cartOf([line({ quantity: 2 })], { version: 3 }), cartOf([line({ quantity: 6 })], { version: 5 })],
      put: () => apiError('CART_VERSION_CONFLICT', 'Giỏ hàng đã thay đổi, vui lòng tải lại', 409),
    });
    await renderApp(server);
    await userEvent.click(await button('Tăng Nước suối'));
    expect((await screen.findByRole('alert')).textContent).toContain('Giỏ hàng đã thay đổi');
    await waitFor(() => expect(cartGets(server)).toHaveLength(2));
    expect(((await screen.findByLabelText('Số lượng Nước suối')) as HTMLInputElement).value).toBe('6');
    expect(cartWrites(server)).toHaveLength(1);
  });

  it.each([['lỗi mạng', failNetwork], ['503', () => apiError('OPERATION_OUTCOME_UNKNOWN', 'Chưa rõ kết quả', 503)]])(
    'US-40-TC10: PUT bị %s → role="alert" + "Thử lại" gửi lại CÙNG Idempotency-Key và cùng body', async (_label, error) => {
      const server = fakeServer({
        carts: [cartOf([line({ quantity: 2 })], { version: 3 }), cartOf([line({ quantity: 3 })], { version: 4 })],
        put: (_call, callNo) => (callNo === 1 ? error() : json({ version: 4, productId: WATER_ID, quantity: 3 })),
      });
      await renderApp(server);
      await userEvent.click(await button('Tăng Nước suối'));
      expect(await screen.findByRole('alert')).toBeTruthy();
      await userEvent.click(await button('Thử lại'));
      await waitFor(() => expect(cartWrites(server)).toHaveLength(2));
      const [first, second] = cartWrites(server);
      expect(second.headers.get('Idempotency-Key')).toBe(first.headers.get('Idempotency-Key'));
      expect(second.body).toEqual(first.body);
    });

  it('US-40-TC10: hai lệnh thành công liên tiếp dùng hai Idempotency-Key khác nhau', async () => {
    const server = fakeServer({ carts: [cartOf([line({ quantity: 2 })], { version: 3 }), cartOf([line({ quantity: 3 })], { version: 4 }), cartOf([line({ quantity: 4 })], { version: 5 })] });
    await renderApp(server);
    await userEvent.click(await button('Tăng Nước suối'));
    await waitFor(() => expect(cartGets(server)).toHaveLength(2));
    await waitFor(async () => expect((await button('Tăng Nước suối')).disabled).toBe(false));
    await userEvent.click(await button('Tăng Nước suối'));
    await waitFor(() => expect(cartWrites(server)).toHaveLength(2));
    const [first, second] = cartWrites(server);
    expect(second.headers.get('Idempotency-Key')).not.toBe(first.headers.get('Idempotency-Key'));
    expect(second.body).toMatchObject({ version: 4 });
  });

  it('US-40-TC16: giá đổi khi tải lại sau thao tác → hiện giá mới, không giữ giá cũ', async () => {
    const server = fakeServer({ carts: [
      cartOf([line({ quantity: 2, unitPrice: '9000', lineTotal: '18000' })], { version: 3, subtotal: '18000' }),
      cartOf([line({ quantity: 3, unitPrice: '12000', lineTotal: '36000' })], { version: 4, subtotal: '36000' }),
    ] });
    await renderApp(server);
    await userEvent.click(await button('Tăng Nước suối'));
    await waitFor(() => expect(document.body.textContent).toMatch(/12\.000\s?₫/));
    expect(document.body.textContent).not.toMatch(/(^|[^\d.])9\.000\s?₫/);
    expect(document.body.textContent).toMatch(/36\.000\s?₫/);
  });
});

// =====================================================================
describe('US-40 bước 3: đổi tài khoản và lưu trữ trình duyệt', () => {
  it('US-40-TC16: không lưu giỏ, version hay Idempotency-Key vào localStorage/sessionStorage', async () => {
    const server = fakeServer({ carts: [cartOf([line()], { version: 3 }), cartOf([line({ quantity: 3 })], { version: 4 })] });
    await renderApp(server);
    await userEvent.click(await button('Tăng Nước suối'));
    await waitFor(() => expect(cartGets(server)).toHaveLength(2));
    const stored = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage });
    const key = cartWrites(server)[0].headers.get('Idempotency-Key')!;
    expect(stored).not.toMatch(/cart|giỏ|WATER_01|Nước suối|670000000000000000000001/i);
    expect(stored).not.toContain(key);
  });

  it('US-40-TC16: Member A đăng xuất, Member B đăng nhập → /member/cart chỉ thấy giỏ của B, không lộ dòng của A', async () => {
    // Máy chủ giả phân biệt giỏ theo token: token-a là A, token-b là B.
    let loggedIn: 'a' | 'b' | null = 'a';
    const calls: Array<{ path: string; auth: string | null }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname.replace('/api', '');
      const auth = new Headers(init?.headers).get('Authorization');
      calls.push({ path, auth });
      const userA = userOf('650000000000000000000001', 'Hội viên A');
      const userB = userOf('650000000000000000000002', 'Hội viên B');
      if (path === '/auth/refresh') {
        return loggedIn ? json({ accessToken: `token-${loggedIn}`, tokenType: 'Bearer', expiresIn: 900, user: loggedIn === 'a' ? userA : userB })
          : apiError('UNAUTHORIZED', 'Cần xác thực', 401);
      }
      if (path === '/auth/me') return loggedIn ? json(loggedIn === 'a' ? userA : userB) : apiError('UNAUTHORIZED', 'Cần xác thực', 401);
      if (path === '/auth/logout') { loggedIn = null; return new Response(null, { status: 204 }); }
      if (path === '/auth/login') { loggedIn = 'b'; return json({ accessToken: 'token-b', tokenType: 'Bearer', expiresIn: 900, user: userB }); }
      if (path === '/me/cart') {
        if (auth === 'Bearer token-a') return json(cartOf([line({ name: 'Hàng riêng của A' })]));
        if (auth === 'Bearer token-b') return json(cartOf([line({ productId: WHEY_ID, sku: 'WHEY_01', name: 'Hàng của B' })], { version: 7 }));
        return apiError('UNAUTHORIZED', 'Cần xác thực', 401);
      }
      return json(pageOf([]));
    });
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE_URL', url);
    vi.stubGlobal('fetch', fetcher);
    window.history.pushState({}, '', '/member/cart');
    const { default: App } = await import('../../App');
    render(<App />);

    expect(await screen.findByText('Hàng riêng của A')).toBeTruthy();
    await userEvent.click(await button('Đăng xuất'));
    await waitFor(() => expect(screen.queryByText('Hàng riêng của A')).toBeNull());

    // Mở trang đăng nhập trong cùng ứng dụng (không tải lại trang), đăng nhập B và quay lại giỏ.
    window.history.pushState({}, '', `/login?returnTo=${encodeURIComponent('/member/cart')}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await userEvent.type(await screen.findByLabelText('Số điện thoại'), '0907654321');
    await userEvent.type(screen.getByLabelText('Mật khẩu'), 'Mật khẩu của B 123');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));

    expect(await screen.findByText('Hàng của B')).toBeTruthy();
    expect(screen.queryByText('Hàng riêng của A')).toBeNull();
    // Sau khi B đăng nhập, mọi request giỏ đều mang token của B.
    const afterLogin = calls.slice(calls.findIndex(c => c.path === '/auth/login'));
    expect(afterLogin.filter(c => c.path.startsWith('/me/cart')).every(c => c.auth === 'Bearer token-b')).toBe(true);
  });
});

// =====================================================================
describe('US-40 bước 3: Member thêm vào giỏ từ /shop/:id', () => {
  const openDetail = async (server: Server) => {
    await renderApp(server, `/shop/${WATER_ID}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Nước suối' })).toBeTruthy();
  };

  it('US-40-TC01: bấm "Thêm vào giỏ" với số lượng 2 → GET lấy version rồi POST {version, productId, quantity} có key; báo "Đã thêm vào giỏ"', async () => {
    const server = fakeServer({ carts: [cartOf([], { version: 4 })] });
    await openDetail(server);
    const quantity = screen.getByLabelText('Số lượng') as HTMLInputElement;
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '2');
    await userEvent.click(await button('Thêm vào giỏ'));

    expect(await screen.findByText(/Đã thêm vào giỏ/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Xem giỏ hàng' }) as HTMLAnchorElement;
    expect(new URL(link.href).pathname).toBe('/member/cart');
    expect(cartGets(server).length).toBeGreaterThanOrEqual(1);
    const post = cartWrites(server)[0];
    expect(post).toMatchObject({ method: 'POST', path: '/me/cart/items', body: { version: 4, productId: WATER_ID, quantity: 2 } });
    expect(Object.keys(post.body ?? {}).sort()).toEqual(['productId', 'quantity', 'version']);
    expect(post.headers.get('Idempotency-Key')).toBeTruthy();
  });

  it.each([
    ['PRODUCT_UNAVAILABLE', 'Sản phẩm đang ngừng bán'],
    ['INSUFFICIENT_STOCK', 'Số lượng vượt quá tồn kho hiện có'],
    ['CART_VERSION_CONFLICT', 'Giỏ hàng đã thay đổi, vui lòng tải lại'],
  ])('US-40-TC05: POST thêm bị 409 %s → role="alert" có thông báo, không tự gửi lại', async (code, message) => {
    const server = fakeServer({ carts: [cartOf([], { version: 0 })], post: () => apiError(code, message, 409) });
    await openDetail(server);
    await userEvent.click(await button('Thêm vào giỏ'));
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(screen.queryByText(/Đã thêm vào giỏ/)).toBeNull();
    expect(cartWrites(server)).toHaveLength(1);
  });

  it('US-40-TC03: Member chưa liên kết bấm "Thêm vào giỏ" → báo "chưa được liên kết", không gửi POST', async () => {
    const server = fakeServer({ carts: [cartOf([], { memberLinked: false, reason: 'MEMBER_PROFILE_REQUIRED', version: 0, readyForOrder: false })] });
    await openDetail(server);
    await userEvent.click(await button('Thêm vào giỏ'));
    expect(await screen.findByText(/chưa được liên kết/i)).toBeTruthy();
    expect(cartWrites(server)).toEqual([]);
  });
});
