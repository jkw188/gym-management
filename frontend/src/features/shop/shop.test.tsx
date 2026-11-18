// Tầng kiểm thử frontend (Vitest, jsdom): US-35 bước 3 – trang công khai /shop, chi tiết /shop/:id và chuyển sang đăng nhập.
// Dựng nguyên App với fetch giả, nên test chỉ dựa vào route, hợp đồng API US-35 mục 2 và chữ trên màn hình.
// Hợp đồng giao diện do tester đặt (spec không ghi chữ cụ thể; cần sinh viên xác nhận):
//   - File frontend/src/features/shop/ShopPage.tsx, ProductDetailPage.tsx, shop.api.ts (gọi qua apiClient). /shop và /shop/:id KHÔNG cần đăng nhập.
//   - /shop: tiêu đề h1 "Cửa hàng". Gọi GET /api/products và GET /api/categories; KHÔNG gửi tham số rỗng (q=, categoryId=…).
//     Ô "Tìm sản phẩm" → q (debounce được); ô chọn "Danh mục" (lựa chọn "Tất cả" + tên danh mục) → categoryId;
//     ô chọn "Tình trạng" (lựa chọn "Tất cả", "Còn hàng", "Hết hàng") → availability IN_STOCK/OUT_OF_STOCK.
//   - Danh sách <ul aria-label="Danh sách sản phẩm">, mỗi sản phẩm một listitem theo đúng thứ tự server trả: tên, giá dạng "9.000 ₫",
//     nhãn "Còn hàng" / "Hết hàng" / "Không khả dụng", liên kết "Xem chi tiết" tới /shop/:id. Giá "0" hiện "0 ₫", không hiện "Liên hệ".
//   - Đang tải: "Đang tải". Rỗng: "Không tìm thấy sản phẩm phù hợp". Lỗi mạng/503: role="alert" + nút "Thử lại";
//     không hiện danh sách giả; thử lại gửi đúng query cũ và ô tìm kiếm giữ nguyên chữ đã gõ.
//   - /shop/:id: gọi GET /api/products/:id; h1 là tên sản phẩm; hiện SKU, tên danh mục, giá, nhãn tình trạng, "Cập nhật lúc …" (asOf);
//     mô tả hiện nguyên văn dạng chữ (không chèn HTML); ảnh <img alt="<tên sản phẩm>">, ảnh lỗi hoặc không có ảnh thì hiện "Không có ảnh".
//     Ô số lượng nhãn "Số lượng" và nút "Thêm vào giỏ"; hàng "Hết hàng"/"Không khả dụng" thì nút bị khóa (disabled).
//     404 PRODUCT_NOT_AVAILABLE: role="alert" chứa "không còn được bán" và liên kết "Quay lại cửa hàng".
//   - Guest bấm "Thêm vào giỏ" → sang /login?returnTo=/shop/:id, không gọi API ghi, không lưu giỏ ở trình duyệt.
//   - Member đăng nhập với returnTo=/shop/:id → quay lại đúng trang chi tiết, KHÔNG tự gửi yêu cầu thêm giỏ.
//   - PT/Staff/Admin: không hiện nút "Thêm vào giỏ" (họ có màn nghiệp vụ riêng), không gọi API /me/.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Socket thông báo của Member không liên quan US-35: thay bằng socket giả không làm gì.
vi.mock('socket.io-client', () => {
  const socket = { on: () => socket, off: () => socket, emit: () => socket, connect: () => socket, disconnect: () => socket, io: { on: () => undefined, off: () => undefined } };
  return { io: () => socket, default: () => socket };
});

const url = 'http://localhost:3000/api';
type Availability = 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNAVAILABLE';
type PublicProduct = {
  id: string; sku: string; name: string; category: { id: string; name: string };
  description?: string; imageUrl?: string; price: string; version: number; availability: Availability; asOf: string;
};

// Dữ liệu giống ProductPublicDto của US-35-F03.
const DRINKS = { id: '660000000000000000000001', name: 'Đồ uống' };
const CLOTHES = { id: '660000000000000000000002', name: 'Áo tập' };
const ASOF = '2026-11-18T03:00:00.000Z';
const water: PublicProduct = { id: '670000000000000000000001', sku: 'WATER_01', name: 'Nước suối', category: DRINKS,
  description: '<b>Mát lạnh</b> & sạch', imageUrl: 'https://example.test/water.png', price: '9000', version: 0, availability: 'IN_STOCK', asOf: ASOF };
const whey: PublicProduct = { id: '670000000000000000000002', sku: 'WHEY_01', name: 'Whey Protein', category: DRINKS,
  price: '900000', version: 1, availability: 'OUT_OF_STOCK', asOf: ASOF };
const shirt: PublicProduct = { id: '670000000000000000000003', sku: 'SHIRT_01', name: 'Áo thun', category: CLOTHES,
  price: '150000', version: 0, availability: 'UNAVAILABLE', asOf: ASOF };
const gift: PublicProduct = { id: '670000000000000000000004', sku: 'GIFT_01', name: 'Quà tặng', category: CLOTHES,
  price: '0', version: 0, availability: 'IN_STOCK', asOf: ASOF };
const ALL = [water, whey, shirt, gift];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (code: string, message: string, status: number) => json({ error: { code, message }, requestId: 'req-1' }, status);
const pageOf = <T,>(items: T[]) => ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0 });
const userOf = (roleCode: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN') =>
  ({ id: '650000000000000000000099', fullName: `Người dùng ${roleCode}`, phone: '0901234567', roleCode });

type ListHandler = (query: URLSearchParams, callNo: number) => Response | Promise<Response>;
type DetailHandler = (id: string) => Response | Promise<Response>;

// Máy chủ giả: mặc định Guest (refresh 401), list trả 4 sản phẩm, detail trả đúng sản phẩm theo id.
function fakeServer(options: { list?: ListHandler; detail?: DetailHandler; role?: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN' } = {}) {
  let listCalls = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const target = new URL(String(input));
    const path = target.pathname;
    if (path.endsWith('/auth/refresh')) {
      return options.role
        ? json({ accessToken: 'token-x', tokenType: 'Bearer', expiresIn: 900, user: userOf(options.role) })
        : apiError('UNAUTHORIZED', 'Cần xác thực', 401);
    }
    // Sau refresh, apiClient gọi /auth/me để lấy thông tin người dùng.
    if (path.endsWith('/auth/me')) {
      return options.role ? json(userOf(options.role)) : apiError('UNAUTHORIZED', 'Cần xác thực', 401);
    }
    if (path.endsWith('/categories')) return json(pageOf([CLOTHES, DRINKS]));
    const detail = path.match(/\/products\/([^/]+)$/);
    if (detail) {
      if (options.detail) return options.detail(detail[1]);
      const found = ALL.find(product => product.id === detail[1]);
      return found ? json(found) : apiError('PRODUCT_NOT_AVAILABLE', 'Sản phẩm không còn được bán', 404);
    }
    if (path.endsWith('/products')) {
      listCalls += 1;
      return options.list ? options.list(target.searchParams, listCalls) : json(pageOf(ALL));
    }
    // Các API khác (thông báo, badge…) của layout: trả rỗng cho yên.
    return json(pageOf([]));
  });
}
type Fetcher = ReturnType<typeof fakeServer>;

const requestsOf = (fetcher: Fetcher) => fetcher.mock.calls.map(([input, init]) => ({ url: new URL(String(input)), method: (init?.method ?? 'GET').toUpperCase() }));
const productQueries = (fetcher: Fetcher) => requestsOf(fetcher).filter(r => r.url.pathname.endsWith('/products')).map(r => r.url.searchParams);
const lastProductQuery = (fetcher: Fetcher) => productQueries(fetcher).at(-1)!;
const writeRequests = (fetcher: Fetcher) => requestsOf(fetcher).filter(r => r.method !== 'GET' && !r.url.pathname.includes('/auth/'));
const memberApiCalls = (fetcher: Fetcher) => requestsOf(fetcher).filter(r => r.url.pathname.includes('/me/cart'));

// Nạp lại App với fetch giả (apiClient được tạo một lần lúc import) rồi mở đường dẫn.
async function renderApp(fetcher: Fetcher, path = '/shop') {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', url);
  vi.stubGlobal('fetch', fetcher);
  window.history.pushState({}, '', path);
  const { default: App } = await import('../../App');
  render(<App />);
}

const productList = () => screen.findByRole('list', { name: 'Danh sách sản phẩm' });
async function productItem(name: string) {
  const list = await productList();
  return within(list).findByText(name).then(node => node.closest('li') as HTMLElement);
}
const itemNames = async () => within(await productList()).getAllByRole('listitem').map(item => item.textContent ?? '');
const addButton = () => screen.findByRole('button', { name: 'Thêm vào giỏ' });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* bỏ qua */ }
  window.history.pushState({}, '', '/');
});

// =====================================================================
describe('US-35 bước 3: trang /shop', () => {
  it('US-35-TC12: Guest mở /shop không cần đăng nhập, thấy tên, giá VND và nhãn tình trạng theo đúng thứ tự server', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);

    expect(await screen.findByRole('heading', { level: 1, name: 'Cửa hàng' })).toBeTruthy();
    const names = await itemNames();
    expect(names).toHaveLength(4);
    expect(names[0]).toContain('Nước suối'); expect(names[1]).toContain('Whey Protein');
    expect(names[2]).toContain('Áo thun'); expect(names[3]).toContain('Quà tặng');
    expect((await productItem('Nước suối')).textContent).toMatch(/9\.000\s?₫/);
    expect((await productItem('Nước suối')).textContent).toContain('Còn hàng');
    expect((await productItem('Whey Protein')).textContent).toContain('Hết hàng');
    expect((await productItem('Áo thun')).textContent).toContain('Không khả dụng');
    // Không bị đẩy sang trang đăng nhập
    expect(window.location.pathname).toBe('/shop');
  });

  it('US-35-TC12: giá 0 hiện "0 ₫", không biến thành "Liên hệ"', async () => {
    await renderApp(fakeServer());

    const item = await productItem('Quà tặng');
    expect(item.textContent).toMatch(/0\s?₫/);
    expect(item.textContent).not.toMatch(/Liên hệ/i);
  });

  it('US-35-TC12: mở trang lần đầu không gửi tham số rỗng', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    await productList();

    for (const [, value] of lastProductQuery(fetcher)) expect(value).not.toBe('');
  });

  it('US-35-TC12: mỗi sản phẩm có liên kết "Xem chi tiết" tới /shop/:id', async () => {
    await renderApp(fakeServer());

    const link = within(await productItem('Nước suối')).getByRole('link', { name: 'Xem chi tiết' });
    expect(link.getAttribute('href')).toBe(`/shop/${water.id}`);
  });

  it('US-35-TC12: gõ từ khóa và chọn danh mục/tình trạng gửi đúng q, categoryId, availability', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    await productList();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Tìm sản phẩm' }), 'nước');
    await waitFor(() => expect(lastProductQuery(fetcher).get('q')).toBe('nước'));

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Danh mục' }), 'Đồ uống');
    await waitFor(() => expect(lastProductQuery(fetcher).get('categoryId')).toBe(DRINKS.id));

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Tình trạng' }), 'Còn hàng');
    await waitFor(() => expect(lastProductQuery(fetcher).get('availability')).toBe('IN_STOCK'));
    // Các điều kiện cũ vẫn giữ (AND), không tự bỏ filter
    expect(lastProductQuery(fetcher).get('q')).toBe('nước');
    expect(lastProductQuery(fetcher).get('categoryId')).toBe(DRINKS.id);
  });

  it('US-35-TC12: không có kết quả hiện "Không tìm thấy sản phẩm phù hợp"', async () => {
    await renderApp(fakeServer({ list: () => json(pageOf([])) }));

    expect(await screen.findByText('Không tìm thấy sản phẩm phù hợp')).toBeTruthy();
  });

  it('US-35-TC12: lỗi 503 hiện thông báo + "Thử lại", không hiện danh sách giả', async () => {
    await renderApp(fakeServer({ list: () => apiError('DATABASE_UNAVAILABLE', 'Cơ sở dữ liệu chưa sẵn sàng', 503) }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Danh sách sản phẩm' })).toBeNull();
    expect(screen.queryByText(/0\s?₫/)).toBeNull();
  });

  it('US-35-TC12: mất mạng giữ từ khóa đã gõ; "Thử lại" gửi đúng query cũ và hiện kết quả', async () => {
    let failing = false;
    const fetcher = fakeServer({ list: (query) => {
      if (failing) return Promise.reject(new TypeError('Failed to fetch'));
      return json(pageOf(query.get('q') ? [water] : ALL));
    } });
    await renderApp(fetcher);
    await productList();

    failing = true;
    const box = screen.getByRole('searchbox', { name: 'Tìm sản phẩm' });
    await userEvent.type(box, 'nước');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((box as HTMLInputElement).value).toBe('nước');

    failing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    await waitFor(() => expect(lastProductQuery(fetcher).get('q')).toBe('nước'));
    const names = await itemNames();
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('Nước suối');
  });

  it('US-35-TC09: xem /shop chỉ gửi GET, không gọi API ghi hay API giỏ', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    await productList();

    expect(writeRequests(fetcher)).toEqual([]);
    expect(memberApiCalls(fetcher)).toEqual([]);
  });
});

// =====================================================================
describe('US-35 bước 3: trang chi tiết /shop/:id', () => {
  it('US-35-TC12: Guest xem chi tiết: tên, SKU, danh mục, giá, nhãn, thời điểm cập nhật', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher, `/shop/${water.id}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Nước suối' })).toBeTruthy();
    expect(screen.getByText('WATER_01', { exact: false })).toBeTruthy();
    expect(screen.getByText('Đồ uống', { exact: false })).toBeTruthy();
    expect(document.body.textContent).toMatch(/9\.000\s?₫/);
    expect(document.body.textContent).toContain('Còn hàng');
    expect(document.body.textContent).toContain('Cập nhật lúc');
    expect(requestsOf(fetcher).some(r => r.url.pathname.endsWith(`/products/${water.id}`))).toBe(true);
  });

  it('US-35-TC04: mô tả hiện nguyên văn dạng chữ, không chèn HTML', async () => {
    await renderApp(fakeServer(), `/shop/${water.id}`);

    expect(await screen.findByText('<b>Mát lạnh</b> & sạch')).toBeTruthy();
    expect(document.querySelector('b')?.textContent ?? '').not.toBe('Mát lạnh');
  });

  it('US-35-TC12: ảnh lỗi thì hiện "Không có ảnh" thay cho ảnh vỡ', async () => {
    await renderApp(fakeServer(), `/shop/${water.id}`);

    const image = await screen.findByRole('img', { name: 'Nước suối' });
    expect(image.getAttribute('src')).toBe('https://example.test/water.png');
    fireEvent.error(image);
    expect(await screen.findByText('Không có ảnh')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Nước suối' })).toBeNull();
  });

  it('US-35-TC12: sản phẩm không có ảnh hiện "Không có ảnh"', async () => {
    await renderApp(fakeServer(), `/shop/${whey.id}`);

    await screen.findByRole('heading', { level: 1, name: 'Whey Protein' });
    expect(screen.getByText('Không có ảnh')).toBeTruthy();
  });

  it('US-35-TC12: giá 0 ở chi tiết hiện "0 ₫", không hiện "Liên hệ"', async () => {
    await renderApp(fakeServer(), `/shop/${gift.id}`);

    await screen.findByRole('heading', { level: 1, name: 'Quà tặng' });
    expect(document.body.textContent).toMatch(/0\s?₫/);
    expect(document.body.textContent).not.toMatch(/Liên hệ/i);
  });

  it('US-35-TC03: hàng còn có ô "Số lượng" và nút "Thêm vào giỏ" bấm được', async () => {
    await renderApp(fakeServer(), `/shop/${water.id}`);

    expect(await screen.findByLabelText('Số lượng')).toBeTruthy();
    expect((await addButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('US-35-TC03: hàng hết (OUT_OF_STOCK) vẫn xem được nhưng nút "Thêm vào giỏ" bị khóa', async () => {
    await renderApp(fakeServer(), `/shop/${whey.id}`);

    await screen.findByRole('heading', { level: 1, name: 'Whey Protein' });
    expect(document.body.textContent).toContain('Hết hàng');
    expect((await addButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('US-35-TC03: hàng thiếu tồn (UNAVAILABLE) hiện "Không khả dụng" và nút "Thêm vào giỏ" bị khóa', async () => {
    await renderApp(fakeServer(), `/shop/${shirt.id}`);

    await screen.findByRole('heading', { level: 1, name: 'Áo thun' });
    expect(document.body.textContent).toContain('Không khả dụng');
    expect((await addButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('US-35-TC02: sản phẩm ngừng bán (404 PRODUCT_NOT_AVAILABLE) hiện thông báo và liên kết "Quay lại cửa hàng"', async () => {
    await renderApp(fakeServer(), `/shop/${'6'.repeat(24)}`);

    expect((await screen.findByRole('alert')).textContent).toMatch(/không còn được bán/i);
    expect(screen.getByRole('link', { name: 'Quay lại cửa hàng' }).getAttribute('href')).toBe('/shop');
    expect(screen.queryByRole('button', { name: 'Thêm vào giỏ' })).toBeNull();
  });

  it('US-35-TC12: lỗi 503 ở chi tiết hiện thông báo + "Thử lại", không hiện giá giả', async () => {
    let failing = true;
    await renderApp(fakeServer({ detail: () => failing
      ? apiError('DATABASE_UNAVAILABLE', 'Cơ sở dữ liệu chưa sẵn sàng', 503) : json(water) }), `/shop/${water.id}`);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/₫/);
    failing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Nước suối' })).toBeTruthy();
  });
});

// =====================================================================
describe('US-35-TC11: Guest, Member và vai trò khác', () => {
  it('US-35-TC11: Guest bấm "Thêm vào giỏ" được chuyển sang /login?returnTo=/shop/:id, không gọi API ghi', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher, `/shop/${water.id}`);

    await userEvent.click(await addButton());

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(new URLSearchParams(window.location.search).get('returnTo')).toBe(`/shop/${water.id}`);
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeTruthy();
    expect(writeRequests(fetcher)).toEqual([]);
    expect(memberApiCalls(fetcher)).toEqual([]);
  });

  it('US-35-TC11: Guest bấm thêm không tạo giỏ Guest trong trình duyệt', async () => {
    await renderApp(fakeServer(), `/shop/${water.id}`);
    await userEvent.click(await addButton());
    await waitFor(() => expect(window.location.pathname).toBe('/login'));

    const stored = [window.localStorage, window.sessionStorage]
      .flatMap(storage => Object.keys(storage).map(key => `${key}=${storage.getItem(key)}`)).join('\n');
    expect(stored).not.toMatch(/cart|giỏ|WATER_01|670000000000000000000001/i);
  });

  it('US-35-TC11: Member đăng nhập với returnTo=/shop/:id quay lại đúng trang chi tiết, KHÔNG tự gửi thêm giỏ', async () => {
    const fetcher = fakeServer({ role: 'MEMBER' });
    await renderApp(fetcher, `/login?returnTo=${encodeURIComponent(`/shop/${water.id}`)}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Nước suối' })).toBeTruthy();
    expect(window.location.pathname).toBe(`/shop/${water.id}`);
    // Member phải tự bấm lại; trang không tự gửi số lượng cũ
    expect(writeRequests(fetcher)).toEqual([]);
    expect(memberApiCalls(fetcher)).toEqual([]);
    expect((await addButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['https://evil.example/shop', '//evil.example/shop', '/shop/../admin'])('US-35-TC11: returnTo không an toàn (%s) không được dùng', async (target) => {
    await renderApp(fakeServer({ role: 'MEMBER' }), `/login?returnTo=${encodeURIComponent(target)}`);

    await waitFor(() => expect(window.location.pathname).not.toBe('/login'));
    expect(window.location.pathname.startsWith('/member')).toBe(true);
  });

  it.each(['TRAINER', 'STAFF', 'ADMIN'] as const)('US-35-TC11: %s xem chi tiết không có nút "Thêm vào giỏ" và không gọi API giỏ Member', async (role) => {
    const fetcher = fakeServer({ role });
    await renderApp(fetcher, `/shop/${water.id}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Nước suối' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Thêm vào giỏ' })).toBeNull();
    expect(window.location.pathname).toBe(`/shop/${water.id}`);
    expect(memberApiCalls(fetcher)).toEqual([]);
    expect(writeRequests(fetcher)).toEqual([]);
  });
});
