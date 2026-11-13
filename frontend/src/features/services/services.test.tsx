// Tầng kiểm thử frontend (Vitest, jsdom): US-13 bước 2 – trang công khai /services (danh mục gói GYM/PT) và chi tiết gói.
// Dựng nguyên App ở /services với fetch giả, nên test chỉ dựa vào route, hợp đồng API US-13 mục 2 và chữ trên màn hình.
// Hợp đồng giao diện test đặt ra cho Builder (spec không ghi chữ cụ thể, tester đặt; cần sinh viên xác nhận):
//   - File frontend/src/features/services/ServicesPage.tsx + services.api.ts (gọi qua apiClient). Route /services KHÔNG cần đăng nhập.
//   - Tiêu đề h1 "Gói dịch vụ". Mở trang gọi GET /api/catalog/plans (page=1 hoặc không gửi page);
//     KHÔNG gửi tham số rỗng (kind=, q=, minPrice=, maxPrice=) vì backend trả 400 cho giá trị rỗng.
//   - Bộ lọc: ô chọn nhãn "Loại gói" (lựa chọn "Tất cả", "Gym", "PT" → kind=GYM/PT, áp dụng ngay);
//     ô "Giá từ (VND)" → minPrice, ô "Giá đến (VND)" → maxPrice, ô "Tìm dịch vụ" → q.
//     Ô chữ/giá debounce khoảng 300ms (gõ nhanh chỉ gửi 1 request). Đổi bộ lọc thì về trang 1.
//   - Danh sách <ul aria-label="Danh sách dịch vụ">, mỗi gói một listitem theo ĐÚNG thứ tự server trả: tên, giá VND dạng "500.000 ₫",
//     thời hạn "<durationDays> ngày", gói PT có "<sessionsQuota> buổi tập", gói GYM KHÔNG hiện chữ "buổi"; nút "Xem chi tiết".
//   - page < totalPages → nút "Trang sau" gửi page tiếp theo, giữ bộ lọc.
//   - "Xem chi tiết" gọi GET /api/catalog/plans/:id (mỗi lần mở đều gọi mới, không dùng cache) rồi hiện
//     <section aria-label="Chi tiết dịch vụ"> có tên, mã, giá, thời hạn, số buổi (PT), quyền lợi (benefits hiện dạng chữ, không chèn HTML),
//     nút "Hướng dẫn đăng ký" (chỉ hiện hướng dẫn có chữ "tại quầy", không gọi API ghi) và nút "Quay lại danh mục".
//     Mở chi tiết thì focus chuyển vào vùng chi tiết; "Quay lại danh mục" thì focus về nút "Xem chi tiết" của gói vừa xem.
//   - Detail 404 PLAN_NOT_FOUND: role="alert" chứa "không còn khả dụng", đóng chi tiết, tải lại danh sách.
//   - Đang tải: "Đang tải". Rỗng: "Không tìm thấy dịch vụ phù hợp". Lỗi mạng/503: role="alert" + nút "Thử lại",
//     không hiện danh sách giả hay giá 0; thử lại gửi đúng query cũ.
//   - Response cũ về muộn (sau khi đã đổi bộ lọc) KHÔNG được ghi đè kết quả mới.
//   - Trang chỉ gửi GET; không gọi API bán hàng/thanh toán (US-13-F04, TC10).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Socket thông báo của Member không liên quan US-13: thay bằng socket giả không làm gì.
vi.mock('socket.io-client', () => {
  const socket = { on: () => socket, off: () => socket, emit: () => socket, connect: () => socket, disconnect: () => socket, io: { on: () => undefined, off: () => undefined } };
  return { io: () => socket, default: () => socket };
});

const url = 'http://localhost:3000/api';

type PublicPlan = {
  id: string; code: string; name: string; kind: 'GYM' | 'PT'; durationDays: number;
  sessionsQuota: number; price: string; benefits: string; version: number;
};

// Dữ liệu giống PublicPlanDto (9 field) của US-13-F02.
const GYM = '650000000000000000000001';
const PT = '650000000000000000000002';
const gymPlan: PublicPlan = {
  id: GYM, code: 'GYM1M', name: 'Gym 1 tháng', kind: 'GYM', durationDays: 30,
  sessionsQuota: 0, price: '500000', benefits: 'Tập không giới hạn trong giờ mở cửa', version: 0,
};
const ptPlan: PublicPlan = {
  id: PT, code: 'PT10', name: 'PT 10 buổi', kind: 'PT', durationDays: 60,
  sessionsQuota: 10, price: '3000000', benefits: 'Huấn luyện viên kèm 1-1', version: 2,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (code: string, message: string, status: number) => json({ error: { code, message }, requestId: 'req-1' }, status);
const pageOf = (items: PublicPlan[], page = 1, totalPages = items.length ? 1 : 0) => ({ items, page, limit: 20, total: items.length, totalPages });
const member = { id: '650000000000000000000099', fullName: 'Hội Viên A', phone: '0901234567', roleCode: 'MEMBER' };

type ListHandler = (query: URLSearchParams, callNo: number) => Response | Promise<Response>;
type DetailHandler = (id: string, callNo: number) => Response | Promise<Response>;

// Máy chủ giả: ghi lại mọi lần gọi. Mặc định Guest (refresh 401), list trả 2 gói, detail trả đúng gói theo id.
function fakeServer(options: { list?: ListHandler; detail?: DetailHandler; loggedIn?: boolean } = {}) {
  let listCalls = 0;
  let detailCalls = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const target = new URL(String(input));
    const path = target.pathname;
    if (path.endsWith('/auth/refresh')) {
      return options.loggedIn
        ? json({ accessToken: 'token-member', tokenType: 'Bearer', expiresIn: 900, user: member })
        : apiError('UNAUTHORIZED', 'Cần xác thực', 401);
    }
    const detail = path.match(/\/catalog\/plans\/([^/]+)$/);
    if (detail) {
      detailCalls += 1;
      if (options.detail) return options.detail(detail[1], detailCalls);
      const found = [gymPlan, ptPlan].find(plan => plan.id === detail[1]);
      return found ? json(found) : apiError('PLAN_NOT_FOUND', 'Dịch vụ không còn khả dụng', 404);
    }
    if (path.endsWith('/catalog/plans')) {
      listCalls += 1;
      return options.list ? options.list(target.searchParams, listCalls) : json(pageOf([gymPlan, ptPlan]));
    }
    return apiError('NOT_FOUND', 'Không có', 404);
  });
}
type Fetcher = ReturnType<typeof fakeServer>;

const requestsOf = (fetcher: Fetcher) => fetcher.mock.calls.map(([input, init]) => ({ url: new URL(String(input)), method: (init?.method ?? 'GET').toUpperCase() }));
const listQueries = (fetcher: Fetcher) => requestsOf(fetcher).filter(r => r.url.pathname.endsWith('/catalog/plans')).map(r => r.url.searchParams);
const lastListQuery = (fetcher: Fetcher) => listQueries(fetcher).at(-1)!;
const detailCalls = (fetcher: Fetcher) => requestsOf(fetcher).filter(r => /\/catalog\/plans\/[^/]+$/.test(r.url.pathname));
const writeRequests = (fetcher: Fetcher) => requestsOf(fetcher).filter(r => r.method !== 'GET' && !r.url.pathname.includes('/auth/'));

// Nạp lại App với fetch giả (apiClient được tạo một lần lúc import) rồi mở /services.
async function renderApp(fetcher: Fetcher, path = '/services') {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', url);
  vi.stubGlobal('fetch', fetcher);
  window.history.pushState({}, '', path);
  const { default: App } = await import('../../App');
  render(<App />);
}

const planList = () => screen.findByRole('list', { name: 'Danh sách dịch vụ' });
async function planItem(name: string) {
  const list = await planList();
  return within(list).findByText(name).then(node => node.closest('li') as HTMLElement);
}
const itemNames = async () => within(await planList()).getAllByRole('listitem').map(item => item.textContent ?? '');
const detailRegion = () => screen.findByRole('region', { name: 'Chi tiết dịch vụ' });
async function openDetail(name: string) {
  await userEvent.click(within(await planItem(name)).getByRole('button', { name: 'Xem chi tiết' }));
  return detailRegion();
}

// Promise mở/đóng bằng tay để giả server trả chậm.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/');
});

// =====================================================================
// TC01 – Guest/Member xem danh sách và chi tiết không cần đăng nhập
// =====================================================================
describe('US-13 bước 2: trang /services công khai', () => {
  it('US-13-TC01: Guest mở /services không bị chuyển sang đăng nhập, gọi GET /api/catalog/plans', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);

    expect(await screen.findByRole('heading', { level: 1, name: 'Gói dịch vụ' })).toBeDefined();
    expect(await planItem('Gym 1 tháng')).toBeDefined();
    expect(window.location.pathname).toBe('/services');
    expect(listQueries(fetcher).length).toBeGreaterThanOrEqual(1);
  });

  it('US-13-TC01: lần tải đầu không gửi tham số rỗng (kind=, q=, minPrice=, maxPrice=), page là 1 nếu có', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');

    const first = listQueries(fetcher)[0];
    for (const key of ['kind', 'q', 'minPrice', 'maxPrice']) expect(first.has(key)).toBe(false);
    expect(first.get('page') ?? '1').toBe('1');
  });

  it('US-13-TC01: mỗi gói hiện tên, giá VND có định dạng, thời hạn; PT hiện số buổi, GYM không hiện "buổi"', async () => {
    await renderApp(fakeServer());

    const gym = await planItem('Gym 1 tháng');
    expect(within(gym).getByText(/500\.000\s*₫/)).toBeDefined();
    expect(within(gym).getByText(/30 ngày/)).toBeDefined();
    expect(gym.textContent).not.toMatch(/buổi/);

    const pt = await planItem('PT 10 buổi');
    expect(within(pt).getByText(/3\.000\.000\s*₫/)).toBeDefined();
    expect(within(pt).getByText(/60 ngày/)).toBeDefined();
    expect(within(pt).getByText(/10 buổi tập/)).toBeDefined();
  });

  it('US-13-TC01: "Xem chi tiết" gọi GET /api/catalog/plans/:id và hiện đủ tên, mã, giá, thời hạn, số buổi, quyền lợi', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);

    const detail = await openDetail('PT 10 buổi');

    expect(detailCalls(fetcher).at(-1)!.url.pathname).toBe(`/api/catalog/plans/${PT}`);
    expect(within(detail).getByText('PT 10 buổi')).toBeDefined();
    expect(within(detail).getByText('PT10')).toBeDefined();
    expect(within(detail).getByText(/3\.000\.000\s*₫/)).toBeDefined();
    expect(within(detail).getByText(/60 ngày/)).toBeDefined();
    expect(within(detail).getByText(/10 buổi tập/)).toBeDefined();
    expect(within(detail).getByText('Huấn luyện viên kèm 1-1')).toBeDefined();
  });

  it('US-13-TC01: chi tiết gói GYM không hiện "0 buổi"', async () => {
    await renderApp(fakeServer());

    const detail = await openDetail('Gym 1 tháng');

    expect(within(detail).getByText(/500\.000\s*₫/)).toBeDefined();
    expect(detail.textContent).not.toMatch(/buổi/);
  });

  it('US-13-TC01: Member đã đăng nhập mở /services thấy cùng danh sách, vẫn ở /services', async () => {
    const fetcher = fakeServer({ loggedIn: true });
    await renderApp(fetcher);

    expect(await planItem('Gym 1 tháng')).toBeDefined();
    expect(await planItem('PT 10 buổi')).toBeDefined();
    expect(window.location.pathname).toBe('/services');
  });
});

// =====================================================================
// TC05 – lọc loại, giá, từ khóa gửi đúng query
// =====================================================================
describe('US-13 bước 2: bộ lọc gửi đúng query', () => {
  it('US-13-TC05: chọn "PT" ở "Loại gói" gửi kind=PT và hiện kết quả server trả', async () => {
    const fetcher = fakeServer({ list: query => json(pageOf(query.get('kind') === 'PT' ? [ptPlan] : [gymPlan, ptPlan])) });
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');

    await userEvent.selectOptions(screen.getByLabelText('Loại gói'), 'PT');

    await waitFor(() => expect(lastListQuery(fetcher).get('kind')).toBe('PT'));
    await waitFor(async () => expect(await itemNames()).toHaveLength(1));
    expect(await planItem('PT 10 buổi')).toBeDefined();
  });

  it('US-13-TC05: chọn "Gym" gửi kind=GYM; chọn lại "Tất cả" thì bỏ kind khỏi query', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');

    await userEvent.selectOptions(screen.getByLabelText('Loại gói'), 'Gym');
    await waitFor(() => expect(lastListQuery(fetcher).get('kind')).toBe('GYM'));

    await userEvent.selectOptions(screen.getByLabelText('Loại gói'), 'Tất cả');
    await waitFor(() => expect(lastListQuery(fetcher).has('kind')).toBe(false));
  });

  it('US-13-TC05: nhập "Giá từ (VND)" và "Giá đến (VND)" gửi minPrice/maxPrice dạng chuỗi số nguyên', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');

    await userEvent.type(screen.getByLabelText('Giá từ (VND)'), '500000');
    await userEvent.type(screen.getByLabelText('Giá đến (VND)'), '3000000');

    await waitFor(() => {
      const last = lastListQuery(fetcher);
      expect(last.get('minPrice')).toBe('500000');
      expect(last.get('maxPrice')).toBe('3000000');
    });
  });

  it('US-13-TC05: gõ từ khóa vào "Tìm dịch vụ" gửi q và hiện kết quả server trả', async () => {
    const fetcher = fakeServer({ list: query => json(pageOf(query.get('q') === 'PT10' ? [ptPlan] : [gymPlan, ptPlan])) });
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');

    await userEvent.type(screen.getByLabelText('Tìm dịch vụ'), 'PT10');

    await waitFor(() => expect(lastListQuery(fetcher).get('q')).toBe('PT10'));
    await waitFor(async () => expect(await itemNames()).toHaveLength(1));
  });

  it('US-13-TC05: kết hợp loại, giá và từ khóa trong cùng một request (AND)', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');

    await userEvent.selectOptions(screen.getByLabelText('Loại gói'), 'PT');
    await userEvent.type(screen.getByLabelText('Giá đến (VND)'), '5000000');
    await userEvent.type(screen.getByLabelText('Tìm dịch vụ'), 'PT');

    await waitFor(() => {
      const last = lastListQuery(fetcher);
      expect(last.get('kind')).toBe('PT');
      expect(last.get('maxPrice')).toBe('5000000');
      expect(last.get('q')).toBe('PT');
    });
  });

  it('US-13-TC05: xóa hết chữ trong "Tìm dịch vụ" thì bỏ q khỏi query, không gửi q rỗng', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');
    const search = screen.getByLabelText('Tìm dịch vụ');

    await userEvent.type(search, 'Gym');
    await waitFor(() => expect(lastListQuery(fetcher).get('q')).toBe('Gym'));
    await userEvent.clear(search);

    await waitFor(() => expect(lastListQuery(fetcher).has('q')).toBe(false));
  });
});

// =====================================================================
// TC07 – rỗng, thứ tự server, phân trang
// =====================================================================
describe('US-13 bước 2: rỗng, thứ tự và phân trang', () => {
  it('US-13-TC07: không có kết quả hiện "Không tìm thấy dịch vụ phù hợp", không có danh sách, không báo lỗi', async () => {
    await renderApp(fakeServer({ list: () => json(pageOf([])) }));

    expect(await screen.findByText('Không tìm thấy dịch vụ phù hợp')).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Danh sách dịch vụ' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('US-13-TC07: hiện gói đúng thứ tự server trả (name rồi _id), không tự sắp lại', async () => {
    // Hai gói trùng tên: server đã sắp theo _id, trang phải giữ nguyên thứ tự này.
    const a = { ...ptPlan, id: '650000000000000000000010', code: 'PTA', name: 'Gói chung' };
    const b = { ...gymPlan, id: '650000000000000000000011', code: 'GYMB', name: 'Gói chung' };
    const z = { ...gymPlan, id: '650000000000000000000005', code: 'ZZZ', name: 'Zumba 1 tháng' };
    await renderApp(fakeServer({ list: () => json(pageOf([a, b, z])) }));

    await waitFor(async () => expect(await itemNames()).toHaveLength(3));
    const names = await itemNames();
    expect(names[0]).toContain('3.000.000');
    expect(names[1]).toContain('500.000');
    expect(names[2]).toContain('Zumba 1 tháng');
  });

  it('US-13-TC07: có trang sau thì "Trang sau" gửi page=2 và giữ bộ lọc đang chọn', async () => {
    const fetcher = fakeServer({
      list: query => query.get('page') === '2' ? json(pageOf([ptPlan], 2, 2)) : json(pageOf([gymPlan], 1, 2)),
    });
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');
    await userEvent.selectOptions(screen.getByLabelText('Loại gói'), 'Gym');
    await waitFor(() => expect(lastListQuery(fetcher).get('kind')).toBe('GYM'));
    await planItem('Gym 1 tháng');

    await userEvent.click(await screen.findByRole('button', { name: 'Trang sau' }));

    await waitFor(() => expect(lastListQuery(fetcher).get('page')).toBe('2'));
    expect(lastListQuery(fetcher).get('kind')).toBe('GYM');
    expect(await planItem('PT 10 buổi')).toBeDefined();
  });

  it('US-13-TC07: đang ở trang 2 mà đổi bộ lọc thì quay về trang 1', async () => {
    const fetcher = fakeServer({
      list: query => query.get('page') === '2' ? json(pageOf([ptPlan], 2, 2)) : json(pageOf([gymPlan], 1, 2)),
    });
    await renderApp(fetcher);
    await userEvent.click(await screen.findByRole('button', { name: 'Trang sau' }));
    await waitFor(() => expect(lastListQuery(fetcher).get('page')).toBe('2'));
    await planItem('PT 10 buổi');

    await userEvent.selectOptions(screen.getByLabelText('Loại gói'), 'PT');

    await waitFor(() => expect(lastListQuery(fetcher).get('kind')).toBe('PT'));
    expect(lastListQuery(fetcher).get('page') ?? '1').toBe('1');
  });

  it('US-13-TC07: trang cuối (page = totalPages) không có nút "Trang sau"', async () => {
    await renderApp(fakeServer());
    await planItem('Gym 1 tháng');

    expect(screen.queryByRole('button', { name: 'Trang sau' })).toBeNull();
  });
});

// =====================================================================
// TC08 – từ khóa regex gửi nguyên văn, benefits có HTML hiện dạng chữ
// =====================================================================
describe('US-13 bước 2: an toàn với ký tự đặc biệt', () => {
  it('US-13-TC08: từ khóa ".*(" được gửi nguyên văn trong q, trang không lỗi', async () => {
    const fetcher = fakeServer({ list: query => json(pageOf(query.has('q') ? [] : [gymPlan, ptPlan])) });
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');

    await userEvent.type(screen.getByLabelText('Tìm dịch vụ'), '.*(');

    await waitFor(() => expect(lastListQuery(fetcher).get('q')).toBe('.*('));
    expect(await screen.findByText('Không tìm thấy dịch vụ phù hợp')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('US-13-TC08: benefits và tên có HTML được hiện nguyên văn dạng chữ, không tạo thẻ HTML', async () => {
    const html = {
      ...gymPlan, name: '<b>Gym đậm</b>',
      benefits: '<img src=x onerror="alert(1)"><script>window.hacked=1</script>Tập tự do',
    };
    await renderApp(fakeServer({ list: () => json(pageOf([html])), detail: () => json(html) }));

    const detail = await openDetail('<b>Gym đậm</b>');

    expect(within(detail).getByText(html.benefits)).toBeDefined();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('main script, section script, li script')).toBeNull();
    expect(document.querySelector('li b, section b')).toBeNull();
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
  });
});

// =====================================================================
// TC09 – dữ liệu thay đổi sau khi đã xem
// =====================================================================
describe('US-13 bước 2: dữ liệu thay đổi sau khi xem', () => {
  it('US-13-TC09: đổi giá sau khi đã xem thì mở lại chi tiết gọi API mới và hiện giá mới (không dùng cache)', async () => {
    const fetcher = fakeServer({
      detail: (_id, callNo) => json(callNo === 1 ? ptPlan : { ...ptPlan, price: '3500000', version: 3 }),
    });
    await renderApp(fetcher);

    let detail = await openDetail('PT 10 buổi');
    expect(within(detail).getByText(/3\.000\.000\s*₫/)).toBeDefined();
    await userEvent.click(within(detail).getByRole('button', { name: 'Quay lại danh mục' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Chi tiết dịch vụ' })).toBeNull());

    detail = await openDetail('PT 10 buổi');

    expect(detailCalls(fetcher)).toHaveLength(2);
    expect(await within(detail).findByText(/3\.500\.000\s*₫/)).toBeDefined();
    expect(within(detail).queryByText(/3\.000\.000\s*₫/)).toBeNull();
  });

  it('US-13-TC09: chi tiết trả 404 PLAN_NOT_FOUND thì báo "không còn khả dụng", đóng chi tiết và tải lại danh sách', async () => {
    let stopped = false;
    const fetcher = fakeServer({
      list: () => json(pageOf(stopped ? [gymPlan] : [gymPlan, ptPlan])),
      detail: id => {
        if (id === PT) { stopped = true; return apiError('PLAN_NOT_FOUND', 'Dịch vụ không còn khả dụng', 404); }
        return json(gymPlan);
      },
    });
    await renderApp(fetcher);
    const item = await planItem('PT 10 buổi');
    const before = listQueries(fetcher).length;

    await userEvent.click(within(item).getByRole('button', { name: 'Xem chi tiết' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/không còn khả dụng/i);
    expect(screen.queryByRole('region', { name: 'Chi tiết dịch vụ' })).toBeNull();
    await waitFor(() => expect(listQueries(fetcher).length).toBeGreaterThan(before));
    await waitFor(async () => expect(within(await planList()).queryByText('PT 10 buổi')).toBeNull());
  });

  it('US-13-TC09: đang xem chi tiết gói A, mở gói B bị 404 thì không còn hiện dữ liệu cũ của gói A như vẫn mua được', async () => {
    const fetcher = fakeServer({
      detail: id => id === PT ? apiError('PLAN_NOT_FOUND', 'Dịch vụ không còn khả dụng', 404) : json(gymPlan),
    });
    await renderApp(fetcher);
    await openDetail('Gym 1 tháng');

    await userEvent.click(within(await planItem('PT 10 buổi')).getByRole('button', { name: 'Xem chi tiết' }));

    await screen.findByRole('alert');
    expect(screen.queryByRole('region', { name: 'Chi tiết dịch vụ' })).toBeNull();
  });
});

// =====================================================================
// TC10 – hướng dẫn đăng ký tại quầy, không tạo sale/payment
// =====================================================================
describe('US-13 bước 2: hướng dẫn đăng ký, không tự mua', () => {
  it('US-13-TC10: Guest bấm "Hướng dẫn đăng ký" chỉ thấy hướng dẫn đăng ký tại quầy, không gửi request ghi nào', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    const detail = await openDetail('PT 10 buổi');

    await userEvent.click(within(detail).getByRole('button', { name: 'Hướng dẫn đăng ký' }));

    expect(await screen.findByText(/tại quầy/i)).toBeDefined();
    expect(writeRequests(fetcher)).toHaveLength(0);
    expect(requestsOf(fetcher).some(r => /sale|payment|checkout|invoice/i.test(r.url.pathname))).toBe(false);
  });

  it('US-13-TC10: trang không có nút mua/thanh toán/giỏ hàng', async () => {
    await renderApp(fakeServer());
    const detail = await openDetail('PT 10 buổi');

    expect(within(detail).queryByRole('button', { name: /mua|thanh toán|giỏ hàng|đặt mua/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /mua ngay|thanh toán|thêm vào giỏ/i })).toBeNull();
  });

  it('US-13-TC10: xem danh sách, lọc, mở chi tiết nhiều lần chỉ gửi GET', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);

    const detail = await openDetail('Gym 1 tháng');
    await userEvent.click(within(detail).getByRole('button', { name: 'Quay lại danh mục' }));
    await userEvent.selectOptions(screen.getByLabelText('Loại gói'), 'PT');
    await openDetail('PT 10 buổi');

    expect(writeRequests(fetcher)).toHaveLength(0);
  });
});

// =====================================================================
// TC11 – mất DB/mạng rồi thử lại
// =====================================================================
describe('US-13 bước 2: lỗi hạ tầng và thử lại', () => {
  it('US-13-TC11: 503 SERVICE_UNAVAILABLE thì báo lỗi + "Thử lại", không hiện danh sách giả hay giá 0', async () => {
    await renderApp(fakeServer({ list: () => apiError('SERVICE_UNAVAILABLE', 'Dịch vụ tạm thời không khả dụng', 503) }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Danh sách dịch vụ' })).toBeNull();
    expect(screen.queryByText('Không tìm thấy dịch vụ phù hợp')).toBeNull();
    expect(screen.queryByText(/(^|\s)0\s*₫/)).toBeNull();
  });

  it('US-13-TC11: bấm "Thử lại" sau 503 gọi lại đúng query và hiện danh sách', async () => {
    const fetcher = fakeServer({
      list: (_query, callNo) => callNo === 1 ? apiError('SERVICE_UNAVAILABLE', 'Dịch vụ tạm thời không khả dụng', 503) : json(pageOf([gymPlan, ptPlan])),
    });
    await renderApp(fetcher);

    await userEvent.click(await screen.findByRole('button', { name: 'Thử lại' }));

    expect(await planItem('Gym 1 tháng')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    const [first, second] = listQueries(fetcher);
    expect(second.toString()).toBe(first.toString());
  });

  it('US-13-TC11: mất mạng cũng báo lỗi + "Thử lại", không coi là danh mục rỗng', async () => {
    const fetcher = fakeServer({ list: () => Promise.reject(new TypeError('Failed to fetch')) });
    await renderApp(fetcher);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeDefined();
    expect(screen.queryByText('Không tìm thấy dịch vụ phù hợp')).toBeNull();
  });

  it('US-13-TC11: lỗi sau khi đã lọc thì giữ bộ lọc; "Thử lại" vẫn gửi kind đang chọn và không hiện danh sách cũ', async () => {
    const fetcher = fakeServer({
      list: (query, callNo) => callNo === 2 ? apiError('SERVICE_UNAVAILABLE', 'Lỗi', 503) : json(pageOf(query.get('kind') === 'PT' ? [ptPlan] : [gymPlan, ptPlan])),
    });
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');

    await userEvent.selectOptions(screen.getByLabelText('Loại gói'), 'PT');

    await screen.findByRole('alert');
    expect(screen.queryByText('Gym 1 tháng')).toBeNull();
    expect((screen.getByLabelText('Loại gói') as HTMLSelectElement).selectedOptions[0].textContent).toBe('PT');
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    await waitFor(() => expect(lastListQuery(fetcher).get('kind')).toBe('PT'));
    expect(await planItem('PT 10 buổi')).toBeDefined();
  });
});

// =====================================================================
// TC12 – lọc nhanh, đang tải, bàn phím/focus
// =====================================================================
describe('US-13 bước 2: lọc nhanh, đang tải và bàn phím', () => {
  it('US-13-TC12: đang chờ server thì hiện "Đang tải"', async () => {
    const slow = deferred<Response>();
    await renderApp(fakeServer({ list: () => slow.promise }));

    expect(await screen.findByText(/Đang tải/)).toBeDefined();
    slow.resolve(json(pageOf([gymPlan])));
    expect(await planItem('Gym 1 tháng')).toBeDefined();
    expect(screen.queryByText(/Đang tải/)).toBeNull();
  });

  it('US-13-TC12: gõ nhanh "Gym" chỉ gửi một request q=Gym (debounce), không gửi q=G hay q=Gy', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');

    await userEvent.type(screen.getByLabelText('Tìm dịch vụ'), 'Gym');
    await waitFor(() => expect(lastListQuery(fetcher).get('q')).toBe('Gym'));
    await new Promise(done => setTimeout(done, 500));

    const sentQ = listQueries(fetcher).filter(query => query.has('q')).map(query => query.get('q'));
    expect(sentQ).toEqual(['Gym']);
  });

  it('US-13-TC12: response cũ về muộn sau khi đã đổi bộ lọc không ghi đè kết quả mới', async () => {
    const slowPt = deferred<Response>();
    const fetcher = fakeServer({
      list: query => {
        if (query.get('kind') === 'PT') return slowPt.promise;
        if (query.get('kind') === 'GYM') return json(pageOf([gymPlan]));
        return json(pageOf([gymPlan, ptPlan]));
      },
    });
    await renderApp(fetcher);
    await planItem('PT 10 buổi');
    const select = screen.getByLabelText('Loại gói');

    await userEvent.selectOptions(select, 'PT');
    await waitFor(() => expect(lastListQuery(fetcher).get('kind')).toBe('PT'));
    await userEvent.selectOptions(select, 'Gym');
    await waitFor(async () => expect(await itemNames()).toHaveLength(1));
    slowPt.resolve(json(pageOf([ptPlan])));
    await new Promise(done => setTimeout(done, 50));

    expect(await planItem('Gym 1 tháng')).toBeDefined();
    expect(within(await planList()).queryByText('PT 10 buổi')).toBeNull();
  });

  it('US-13-TC12: chỉ dùng bàn phím: focus "Xem chi tiết" rồi Enter mở chi tiết và focus chuyển vào vùng chi tiết', async () => {
    await renderApp(fakeServer());
    const button = within(await planItem('PT 10 buổi')).getByRole('button', { name: 'Xem chi tiết' });

    button.focus();
    await userEvent.keyboard('{Enter}');

    const detail = await detailRegion();
    await waitFor(() => expect(detail.contains(document.activeElement)).toBe(true));
  });

  it('US-13-TC12: "Quay lại danh mục" đóng chi tiết và đưa focus về nút "Xem chi tiết" của gói vừa xem', async () => {
    await renderApp(fakeServer());
    const detail = await openDetail('PT 10 buổi');

    await userEvent.click(within(detail).getByRole('button', { name: 'Quay lại danh mục' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Chi tiết dịch vụ' })).toBeNull());
    const back = within(await planItem('PT 10 buổi')).getByRole('button', { name: 'Xem chi tiết' });
    await waitFor(() => expect(document.activeElement).toBe(back));
  });

  it('US-13-TC12: các ô lọc đều có nhãn để dùng được bằng bàn phím và trình đọc màn hình', async () => {
    await renderApp(fakeServer());
    await planItem('Gym 1 tháng');

    for (const label of ['Loại gói', 'Giá từ (VND)', 'Giá đến (VND)', 'Tìm dịch vụ']) {
      expect(screen.getByLabelText(label)).toBeDefined();
    }
  });

  it('US-13-TC12: đang chờ GET chi tiết thì có role="status" báo "Đang tải", xong thì hiện chi tiết', async () => {
    const slow = deferred<Response>();
    await renderApp(fakeServer({ detail: () => slow.promise }));

    await userEvent.click(within(await planItem('PT 10 buổi')).getByRole('button', { name: 'Xem chi tiết' }));

    expect((await screen.findByRole('status')).textContent).toMatch(/Đang tải/);
    slow.resolve(json(ptPlan));
    expect(await detailRegion()).toBeDefined();
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});

// =====================================================================
// US-13 bước 3 – TC06 phía giao diện: lỗi 400 do dữ liệu lọc sai
// Hợp đồng (tester đặt, cần sinh viên xác nhận): 400 VALIDATION_ERROR hiện lý do trong error.details,
// KHÔNG có nút "Thử lại" (gửi lại y nguyên vẫn sai); nút "Thử lại" chỉ dành cho lỗi mạng/5xx (TC11).
// =====================================================================
describe('US-13 bước 3: lỗi 400 khi lọc sai', () => {
  const minOverMax = () => json({
    error: { code: 'VALIDATION_ERROR', message: 'Dữ liệu không hợp lệ', details: [{ field: 'minPrice', message: 'minPrice không được lớn hơn maxPrice' }] },
    requestId: 'req-400',
  }, 400);

  it('US-13-TC06: nhập "Giá từ" lớn hơn "Giá đến" mà backend trả 400 thì hiện lý do cụ thể trong details', async () => {
    const fetcher = fakeServer({ list: query => query.has('minPrice') && query.has('maxPrice') ? minOverMax() : json(pageOf([gymPlan, ptPlan])) });
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');

    await userEvent.type(screen.getByLabelText('Giá từ (VND)'), '3000000');
    await userEvent.type(screen.getByLabelText('Giá đến (VND)'), '500000');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('minPrice không được lớn hơn maxPrice');
  });

  it('US-13-TC06: lỗi 400 KHÔNG có nút "Thử lại" và không hiện danh sách cũ hay "Không tìm thấy dịch vụ phù hợp"', async () => {
    const fetcher = fakeServer({ list: query => query.has('minPrice') && query.has('maxPrice') ? minOverMax() : json(pageOf([gymPlan, ptPlan])) });
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');

    await userEvent.type(screen.getByLabelText('Giá từ (VND)'), '3000000');
    await userEvent.type(screen.getByLabelText('Giá đến (VND)'), '500000');

    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Danh sách dịch vụ' })).toBeNull();
    expect(screen.queryByText('Không tìm thấy dịch vụ phù hợp')).toBeNull();
  });

  it('US-13-TC06: sửa lại giá cho đúng thì lỗi biến mất và danh sách hiện lại', async () => {
    const fetcher = fakeServer({
      list: query => query.has('minPrice') && query.has('maxPrice') && BigInt(query.get('minPrice')!) > BigInt(query.get('maxPrice')!)
        ? minOverMax() : json(pageOf([gymPlan])),
    });
    await renderApp(fetcher);
    await planItem('Gym 1 tháng');
    await userEvent.type(screen.getByLabelText('Giá từ (VND)'), '3000000');
    await userEvent.type(screen.getByLabelText('Giá đến (VND)'), '500000');
    await screen.findByRole('alert');

    await userEvent.clear(screen.getByLabelText('Giá từ (VND)'));

    expect(await planItem('Gym 1 tháng')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
