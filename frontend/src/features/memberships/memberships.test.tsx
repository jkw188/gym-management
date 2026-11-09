// Tầng kiểm thử frontend (Vitest, jsdom): US-17 bước 3 – trang /member/memberships chỉ đọc.
// Kiểm tra tách gói hiện hành/chờ hiệu lực/lịch sử/giao dịch chờ, nhãn ngày cuối, GYM/PT, chứng từ, lỗi mạng, đổi account (TC09, TC11, TC12).
// Hợp đồng test đặt ra cho Builder (US-17 bước 3, theo mục "Giao diện" và F02–F05 của spec):
//   src/features/memberships/MyMembershipsPage.tsx: export function MyMembershipsPage()
//   Gọi backend qua apiClient.request (file *.api.ts trong cùng thư mục), CHỈ GET, đường dẫn /me/memberships,
//   /me/service-sales, /me/transactions/:id, /me/invoices/:id; không gửi memberId/accountId.
//   - Đang tải hiện chữ "Đang tải".
//   - Bốn vùng <section aria-labelledby> (role region) có tiêu đề: "Gói hiện hành", "Gói chờ hiệu lực", "Lịch sử gói",
//     "Giao dịch chờ xác nhận"; và vùng "Lịch sử mua" liệt kê các lần mua.
//     Gói hiện hành = storedStatus ACTIVE + timeState CURRENT; chờ hiệu lực = ACTIVE + SCHEDULED; còn lại vào "Lịch sử gói".
//     Giao dịch chờ xác nhận = lần mua có status PENDING, ghi "Chờ xác nhận thu".
//   - Mỗi gói và mỗi lần mua là <article aria-label={planName}>.
//   - Gói hiện "Từ dd/mm/yyyy đến hết ngày dd/mm/yyyy" (ngày cuối vẫn được dùng; đổi chuỗi YYYY-MM-DD, không lệch múi giờ).
//   - Gói PT: "Đã dùng: <used>/<quota> buổi", "Đang giữ chỗ: <reserved> buổi", "Còn đặt được: <available> buổi".
//     Gói GYM: "Không áp dụng số buổi PT", không hiện số buổi còn lại/hết buổi.
//   - Gói trong lịch sử có nhãn "Đã được thay thế" (SUPERSEDED), "Đã hủy" (CANCELLED), "Đã hết hạn" (ACTIVE + EXPIRED),
//     và không hiện "Còn đặt được".
//   - memberLinked=false: chữ "chưa được liên kết hồ sơ hội viên" và hướng dẫn liên hệ "quầy"; không phải lỗi.
//   - Đã link, chưa có gói: "Bạn chưa có gói tập nào."
//   - Lỗi mạng/server: role="alert" + nút "Thử lại"; KHÔNG hiện như trạng thái chưa có gói/chưa liên kết.
//   - Mỗi lần mua có nút "Xem giao dịch" → hiện mã giao dịch, số tiền dạng 1.500.000; có chứng từ thì nút "Xem chứng từ"
//     → hiện số chứng từ và người mua theo snapshot của chứng từ. Chỉ hiện field cho phép (không reference/ghi chú nội bộ).
//   - apiClient.subscribe báo đổi account → xóa ngay dữ liệu account cũ rồi tải lại.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import type { AuthSnapshot, AuthUser } from '../auth/auth.types';
import { MyMembershipsPage } from './MyMembershipsPage';

const userA: AuthUser = { id: 'a'.repeat(24), fullName: 'Tên Hiện Tại Của A', phone: '+84901234567', roleCode: 'MEMBER' };
const userB: AuthUser = { id: 'b'.repeat(24), fullName: 'Hội viên B', phone: '+84907654321', roleCode: 'MEMBER' };
const asOf = '2026-11-09T03:00:00.000Z';

type Membership = Record<string, unknown> & { id: string; planName: string; storedStatus: string; timeState: string; kind?: string };
type Sale = Record<string, unknown> & { id: string; planName: string; transactionId: string; status?: string };
type Data = {
  memberLinked: boolean;
  memberships: Membership[];
  sales: Sale[];
  transactions: Record<string, Record<string, unknown>>;
  invoices: Record<string, Record<string, unknown>>;
};

const membership = (id: string, planName: string, extra: Partial<Membership> = {}): Membership => ({
  id, planName, serviceSaleId: `sale-${id}`, transactionId: `tx-${id}`, operation: 'REGISTER', storedStatus: 'ACTIVE',
  timeState: 'CURRENT', kind: 'GYM', benefits: `Quyền lợi ${planName}`, startDate: '2026-11-01', endDate: '2026-11-30',
  sessionsQuota: 0, sessionsUsed: 0, sessionsReserved: 0, sessionsAvailable: 0, ...extra,
});
const sale = (id: string, planName: string, extra: Partial<Sale> = {}): Sale => ({
  id, planName, transactionId: `tx-${id}`, operation: 'REGISTER', status: 'SETTLED', benefits: `Quyền lợi ${planName}`,
  policy: 'Giá niêm yết', startDate: '2026-11-01', endDate: '2026-11-30', listPrice: '1500000', creditAmount: '0',
  amountDue: '1500000', sessionsQuota: 0, ...extra,
});
const empty = (memberLinked = true): Data => ({ memberLinked, memberships: [], sales: [], transactions: {}, invoices: {} });

// ---------- Server giả ở tầng apiClient: dữ liệu theo account đang đăng nhập ----------
let snapshot: AuthSnapshot;
let authListeners: Array<() => void>;
let dataByAccount: Record<string, Data>;
let failNext: Error | null;
let hold: Promise<void> | null;
let requestSpy: ReturnType<typeof vi.fn>;

function pageOf<T>(items: T[], params: URLSearchParams, memberLinked: boolean) {
  const page = Number(params.get('page') ?? 1);
  const limit = Number(params.get('limit') ?? 20);
  return {
    memberLinked, items: items.slice((page - 1) * limit, page * limit), page, limit, total: items.length,
    totalPages: Math.ceil(items.length / limit), asOf,
  };
}

async function fakeServer(path: string, init: RequestInit = {}): Promise<unknown> {
  if (hold) await hold;
  if (failNext) { const error = failNext; failNext = null; throw error; }
  if (init.method && init.method !== 'GET') throw new Error(`Trang chỉ đọc không được gọi ${init.method} ${path}`);
  const data = dataByAccount[snapshot.user!.id] ?? empty();
  const [route, queryString] = path.split('?');
  const params = new URLSearchParams(queryString ?? '');
  const notFound = () => new ApiError('Không tìm thấy', 404, 'req-404', undefined, undefined, 'NOT_FOUND');
  if (route === '/me/memberships') {
    // Nếu trang dùng bộ lọc của spec thì server giả lọc giống server thật.
    const items = data.memberships.filter(item =>
      (!params.get('kind') || item.kind === params.get('kind'))
      && (!params.get('storedStatus') || item.storedStatus === params.get('storedStatus'))
      && (!params.get('timeState') || item.timeState === params.get('timeState')));
    return pageOf(data.memberLinked ? items : [], params, data.memberLinked);
  }
  if (route === '/me/service-sales') return pageOf(data.memberLinked ? data.sales : [], params, data.memberLinked);
  const detail = /^\/me\/(memberships|service-sales|transactions|invoices)\/([^/]+)$/.exec(route);
  if (detail) {
    const [, kind, id] = detail;
    const found = kind === 'memberships' ? data.memberships.find(item => item.id === id)
      : kind === 'service-sales' ? data.sales.find(item => item.id === id)
        : kind === 'transactions' ? data.transactions[id] : data.invoices[id];
    if (!found) throw notFound();
    return found;
  }
  throw new Error(`Đường dẫn không có trong spec US-17: ${path}`);
}

beforeEach(() => {
  snapshot = { status: 'authenticated', user: userA };
  authListeners = [];
  dataByAccount = {};
  failNext = null;
  hold = null;
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(listener => {
    authListeners.push(listener);
    return () => { authListeners = authListeners.filter(entry => entry !== listener); };
  });
  requestSpy = vi.fn(fakeServer);
  vi.spyOn(apiClient, 'request').mockImplementation(requestSpy as never);
  vi.spyOn(apiClient, 'requestOnce').mockImplementation(requestSpy as never);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderPage = () => render(<MemoryRouter initialEntries={['/member/memberships']}><MyMembershipsPage /></MemoryRouter>);
const region = (name: string) => screen.getByRole('region', { name });
const switchAccount = (user: AuthUser) => act(() => {
  snapshot = { status: 'authenticated', user };
  for (const listener of [...authListeners]) listener();
});

describe('US-17 bước 3: trang /member/memberships', () => {
  // ---------- TC12: nhãn rõ cho ngày cuối, GYM/PT, chưa link, chưa có gói ----------

  it('US-17-TC12: tách gói hiện hành, chờ hiệu lực, lịch sử và giao dịch chờ xác nhận', async () => {
    dataByAccount[userA.id] = {
      ...empty(),
      memberships: [
        membership('m1', 'GYM 1 tháng đang dùng'),
        membership('m2', 'GYM tháng sau', { timeState: 'SCHEDULED', startDate: '2026-12-01', endDate: '2026-12-30' }),
        membership('m3', 'GYM tháng trước', { timeState: 'EXPIRED', startDate: '2026-10-01', endDate: '2026-10-31' }),
      ],
      sales: [sale('s4', 'PT 10 buổi chờ thu', { status: 'PENDING' })],
    };
    renderPage();
    await screen.findByRole('region', { name: 'Gói hiện hành' });

    expect(await within(region('Gói hiện hành')).findByRole('article', { name: 'GYM 1 tháng đang dùng' })).toBeDefined();
    expect(within(region('Gói chờ hiệu lực')).getByRole('article', { name: 'GYM tháng sau' })).toBeDefined();
    expect(within(region('Lịch sử gói')).getByRole('article', { name: 'GYM tháng trước' })).toBeDefined();
    const pending = within(region('Giao dịch chờ xác nhận')).getByRole('article', { name: 'PT 10 buổi chờ thu' });
    expect(within(pending).getByText(/Chờ xác nhận thu/)).toBeDefined();
    // Gói chờ thu không được hiện như gói đang có (F02).
    expect(within(region('Gói hiện hành')).queryByText('PT 10 buổi chờ thu')).toBeNull();
    expect(within(region('Gói hiện hành')).queryByText('GYM tháng sau')).toBeNull();
  });

  it('US-17-TC12: hiện ngày cuối là "đến hết ngày" và đổi đúng ngày, không lệch múi giờ', async () => {
    dataByAccount[userA.id] = {
      ...empty(), memberships: [membership('m1', 'GYM đến 01/12', { startDate: '2026-11-02', endDate: '2026-12-01' })],
    };
    renderPage();

    const card = await screen.findByRole('article', { name: 'GYM đến 01/12' });
    expect(within(card).getByText(/Từ 02\/11\/2026 đến hết ngày 01\/12\/2026/)).toBeDefined();
  });

  it('US-17-TC12: gói PT hiện đã dùng/quota, đang giữ chỗ và còn đặt được theo số của server', async () => {
    dataByAccount[userA.id] = {
      ...empty(), memberships: [membership('m1', 'PT 20 buổi', {
        kind: 'PT', sessionsQuota: 20, sessionsUsed: 4, sessionsReserved: 2, sessionsAvailable: 14,
      })],
    };
    renderPage();

    const card = await screen.findByRole('article', { name: 'PT 20 buổi' });
    expect(within(card).getByText(/Đã dùng: 4\/20 buổi/)).toBeDefined();
    expect(within(card).getByText(/Đang giữ chỗ: 2 buổi/)).toBeDefined();
    expect(within(card).getByText(/Còn đặt được: 14 buổi/)).toBeDefined();
  });

  it('US-17-TC12: gói GYM quota 0 hiện "Không áp dụng số buổi PT", không coi là hết buổi/không thể tập', async () => {
    dataByAccount[userA.id] = { ...empty(), memberships: [membership('m1', 'GYM 3 tháng')] };
    renderPage();

    const card = await screen.findByRole('article', { name: 'GYM 3 tháng' });
    expect(within(card).getByText(/Không áp dụng số buổi PT/)).toBeDefined();
    expect(within(card).queryByText(/Còn đặt được/)).toBeNull();
    expect(within(card).queryByText(/hết buổi/i)).toBeNull();
    expect(within(card).queryByText(/0\/0/)).toBeNull();
  });

  it('US-17-TC12: gói lịch sử có nhãn Đã được thay thế / Đã hủy / Đã hết hạn và không hiện số buổi còn đặt được', async () => {
    dataByAccount[userA.id] = {
      ...empty(), memberships: [
        membership('m1', 'PT cũ đã nâng cấp', { kind: 'PT', storedStatus: 'SUPERSEDED', sessionsQuota: 10, sessionsUsed: 3, sessionsAvailable: 7 }),
        membership('m2', 'PT đã hủy', { kind: 'PT', storedStatus: 'CANCELLED', sessionsQuota: 10, sessionsAvailable: 10 }),
        membership('m3', 'PT hết hạn', { kind: 'PT', timeState: 'EXPIRED', sessionsQuota: 10, sessionsUsed: 6, sessionsAvailable: 4 }),
      ],
    };
    renderPage();
    await screen.findByRole('article', { name: 'PT cũ đã nâng cấp' });

    const history = region('Lịch sử gói');
    const cases: Array<[string, RegExp]> = [['PT cũ đã nâng cấp', /Đã được thay thế/], ['PT đã hủy', /Đã hủy/], ['PT hết hạn', /Đã hết hạn/]];
    for (const [name, label] of cases) {
      const card = within(history).getByRole('article', { name });
      expect(within(card).getByText(label)).toBeDefined();
      expect(within(card).queryByText(/Còn đặt được/)).toBeNull();
    }
    expect(within(region('Gói hiện hành')).queryByRole('article')).toBeNull();
  });

  it('US-17-TC12: account chưa liên kết hồ sơ → hướng dẫn ra quầy, không báo lỗi, không hiện gói', async () => {
    dataByAccount[userA.id] = empty(false);
    renderPage();

    expect(await screen.findByText(/chưa được liên kết hồ sơ hội viên/)).toBeDefined();
    expect(screen.getByText(/quầy/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('US-17-TC12: đã liên kết nhưng chưa có gói → "Bạn chưa có gói tập nào.", không báo lỗi', async () => {
    dataByAccount[userA.id] = empty(true);
    renderPage();

    expect(await screen.findByText('Bạn chưa có gói tập nào.')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/chưa được liên kết/)).toBeNull();
  });

  // ---------- TC09: chứng từ theo snapshot, không lộ thông tin nội bộ ----------

  it('US-17-TC09: xem giao dịch rồi chứng từ → người mua theo snapshot chứng từ, không theo tên hiện tại; không hiện field nội bộ', async () => {
    dataByAccount[userA.id] = {
      ...empty(),
      memberships: [membership('m1', 'GYM 1 tháng')],
      sales: [sale('s1', 'GYM 1 tháng', { transactionId: 'tx1' })],
      transactions: {
        tx1: {
          id: 'tx1', code: 'GD-2026-0001', kind: 'GYM', status: 'SETTLED', amountDue: '1500000', createdAt: asOf,
          payment: { method: 'TRANSFER', amount: '1500000', paidAt: '2026-11-01T03:15:00.000Z' }, invoiceId: 'inv1', membershipId: 'm1',
          // Field lẽ ra server không trả; nếu lỡ có thì trang cũng không được hiện.
          reference: 'VCB-NOI-BO-998877', evidenceNote: 'Ảnh sao kê nội bộ', verifiedBy: 'nhan-vien-01',
        },
      },
      invoices: {
        inv1: {
          id: 'inv1', invoiceNo: 'HD-2026-0001', transactionId: 'tx1', issuedAt: '2026-11-01T03:16:00.000Z',
          totalAmount: '1500000', buyer: 'Nguyễn Văn Lúc Mua - 0901234567',
        },
      },
    };
    renderPage();
    const purchase = await within(await screen.findByRole('region', { name: 'Lịch sử mua' })).findByRole('article', { name: 'GYM 1 tháng' });

    await userEvent.click(within(purchase).getByRole('button', { name: 'Xem giao dịch' }));
    expect(await screen.findByText(/GD-2026-0001/)).toBeDefined();
    expect(screen.getAllByText(/1\.500\.000/).length).toBeGreaterThan(0);

    await userEvent.click(await screen.findByRole('button', { name: 'Xem chứng từ' }));
    expect(await screen.findByText(/HD-2026-0001/)).toBeDefined();
    expect(screen.getByText(/Nguyễn Văn Lúc Mua - 0901234567/)).toBeDefined();
    expect(screen.queryByText(/Tên Hiện Tại Của A/)).toBeNull();
    expect(document.body.textContent).not.toContain('VCB-NOI-BO-998877');
    expect(document.body.textContent).not.toContain('sao kê nội bộ');
    expect(document.body.textContent).not.toContain('nhan-vien-01');
    expect(requestSpy.mock.calls.map(call => String(call[0]))).toEqual(expect.arrayContaining(['/me/transactions/tx1', '/me/invoices/inv1']));
  });

  // ---------- TC11: chỉ GET, lỗi riêng, cache tách theo account ----------

  it('US-17-TC11: trang chỉ gọi GET tới /me/* và không gửi memberId/accountId', async () => {
    dataByAccount[userA.id] = {
      ...empty(), memberships: [membership('m1', 'GYM 1 tháng')], sales: [sale('s1', 'GYM 1 tháng')],
    };
    renderPage();
    await screen.findByRole('article', { name: 'GYM 1 tháng' });

    expect(requestSpy).toHaveBeenCalled();
    for (const [path, init] of requestSpy.mock.calls as Array<[string, RequestInit | undefined]>) {
      expect(path.startsWith('/me/')).toBe(true);
      expect(path).not.toMatch(/memberId|accountId/);
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });

  it('US-17-TC11: mất mạng → báo lỗi + "Thử lại", không hiện như chưa có gói; bấm thử lại thì tải được', async () => {
    dataByAccount[userA.id] = { ...empty(), memberships: [membership('m1', 'GYM 1 tháng')] };
    failNext = new TypeError('Failed to fetch');
    renderPage();

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText('Bạn chưa có gói tập nào.')).toBeNull();
    expect(screen.queryByText(/chưa được liên kết/)).toBeNull();

    // Một lần tải có thể gọi nhiều request; cho mọi request lần sau thành công.
    failNext = null;
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByRole('article', { name: 'GYM 1 tháng' })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('US-17-TC11: server lỗi 503 → báo lỗi, không hiện "Bạn chưa có gói tập nào."', async () => {
    dataByAccount[userA.id] = empty(true);
    failNext = new ApiError('Hệ thống tạm thời không sẵn sàng', 503, 'req-503', undefined, undefined, 'SERVICE_UNAVAILABLE');
    renderPage();

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText('Bạn chưa có gói tập nào.')).toBeNull();
  });

  it('US-17-TC11: đang tải hiện "Đang tải"', async () => {
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    dataByAccount[userA.id] = { ...empty(), memberships: [membership('m1', 'GYM 1 tháng')] };
    renderPage();

    expect(await screen.findByText(/Đang tải/)).toBeDefined();
    release();
    hold = null;
    expect(await screen.findByRole('article', { name: 'GYM 1 tháng' })).toBeDefined();
  });

  it('US-17-TC11: đổi sang account khác → dữ liệu account cũ biến mất ngay, rồi hiện đúng dữ liệu account mới', async () => {
    dataByAccount[userA.id] = { ...empty(), memberships: [membership('m1', 'Gói riêng của A')], sales: [sale('s1', 'Gói riêng của A')] };
    dataByAccount[userB.id] = { ...empty(), memberships: [membership('m9', 'Gói riêng của B')], sales: [sale('s9', 'Gói riêng của B')] };
    renderPage();
    expect((await screen.findAllByText('Gói riêng của A')).length).toBeGreaterThan(0);

    // Request của account mới bị giữ lại: trong lúc chờ, dữ liệu của A không được hiện nữa.
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    await switchAccount(userB);
    await waitFor(() => expect(screen.queryByText('Gói riêng của A')).toBeNull());

    release();
    hold = null;
    expect((await screen.findAllByText('Gói riêng của B')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Gói riêng của A')).toBeNull();
  });
});
