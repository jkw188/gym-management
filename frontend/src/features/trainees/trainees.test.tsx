// Tầng kiểm thử frontend (Vitest, jsdom): US-30 bước 3 – trang /trainer/trainees cho PT tra cứu học viên của mình.
// Kiểm tra tìm kiếm, danh sách, chi tiết lịch/gói liên quan, nhãn trạng thái gói, rỗng/đang tải/lỗi, đổi account/logout xóa cache, route chỉ TRAINER
// (TC12; phần giao diện của TC08, TC09, TC10).
// Hợp đồng test đặt ra cho Builder (US-30 bước 3, theo đoạn "UI /trainer/trainees" mục 2 của spec, API bước 1–2 đã có):
//   File frontend/src/features/trainees/TraineesPage.tsx, export TraineesPage; gọi API qua apiClient.request (trainees.api.ts cùng thư mục).
//   CHỈ GET tới /me/trainees..., không gửi trainerId/accountId. Tiêu đề h1 "Học viên của tôi".
//   Tìm kiếm: ô <input> nhãn "Tìm học viên" + nút "Tìm" → GET /me/trainees?q=<chuỗi>&page=1.
//   Vùng <section aria-labelledby> tên "Danh sách học viên": mỗi học viên một <article> có tên truy cập = fullName,
//     hiện fullName, memberCode và nút "Xem chi tiết". totalPages > page → nút "Trang sau" → GET page tiếp theo.
//   Không có học viên → chữ "Danh sách học viên trống". profileLinked=false → chữ có "chưa được liên kết hồ sơ PT" (không phải lỗi).
//   Đang tải → chữ "Đang tải". Lỗi mạng/503 → role="alert" + nút "Thử lại"; KHÔNG hiện như danh sách trống.
//   Bấm "Xem chi tiết" → GET /me/trainees/:id, /me/trainees/:id/bookings, /me/trainees/:id/memberships;
//     vùng <section aria-labelledby> tên "Chi tiết học viên" có fullName, memberCode và hai vùng con:
//     "Lịch với tôi": mỗi buổi một <article>, giờ "HH:mm–HH:mm dd/mm/yyyy" (giờ VN), nhãn "Đã đặt" / "Đã hoàn thành" / "Đã hủy".
//     "Gói liên quan": mỗi gói một <article> theo thứ tự server trả, nhãn storedStatus "Đang hiệu lực" (ACTIVE) /
//       "Đã được thay thế" (SUPERSEDED) / "Đã hủy" (CANCELLED); số liệu lấy NGUYÊN từ server: "Tổng: <quota>", "Đã dùng: <sessionsUsed>",
//       "Đang giữ chỗ: <reserved>", "Còn lại: <available>"; quotaInvalid=true → chữ có "bất thường". Có "Cập nhật lúc HH:mm dd/mm/yyyy" theo asOf.
//   Detail trả 404 → role="alert" có "Không tìm thấy học viên", không giữ dữ liệu chi tiết cũ.
//   Không có nút hoàn tất buổi hay nhận xét/đánh giá (thuộc S07).
//   Tên/HTML hiện như chữ thường, không chèn HTML.
//   apiClient.subscribe báo đổi account hoặc đăng xuất → xóa ngay danh sách và chi tiết của account cũ rồi tải lại theo account mới.
//   App.tsx: /trainer/trainees trong ProtectedRoute role TRAINER; trang chính PT có link "Học viên của tôi"; role khác → "Không có quyền truy cập".
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import App from '../../App';
import type { AuthSnapshot, AuthUser } from '../auth/auth.types';
import { TraineesPage } from './TraineesPage';

// Không mở socket thật khi render cả App.
vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })), default: vi.fn() }));

const ptA: AuthUser = { id: 'a'.repeat(24), fullName: 'PT Lê Văn Cường', phone: '+84901234567', roleCode: 'TRAINER' };
const ptB: AuthUser = { id: 'b'.repeat(24), fullName: 'PT Trần Thị Dung', phone: '+84901234568', roleCode: 'TRAINER' };
const HOA = '1'.repeat(24);
const MINH = '2'.repeat(24);
// 09:00–10:00 ngày 25/11/2026 giờ VN.
const START = '2026-11-25T02:00:00.000Z';
const END = '2026-11-25T03:00:00.000Z';
// 10:05 ngày 20/11/2026 giờ VN.
const AS_OF = '2026-11-20T03:05:00.000Z';

type Item = { memberId: string; memberCode: string; fullName: string; relatedBookingCount: number; hasUpcoming: boolean; nextBookingAt?: string };
type Membership = {
  id: string; kind: 'PT' | 'GYM'; storedStatus: string; startDate: string; endDate: string;
  quota: number; sessionsUsed: number; reserved: number; available: number; quotaInvalid: boolean;
};
type Booking = { id: string; membershipId: string; startAt: string; endAt: string; status: string; location: string };
type Detail = { memberId: string; memberCode: string; fullName: string; hasUpcoming: boolean };
type AccountData = {
  profileLinked: boolean;
  items: Item[];
  totalPages?: number;
  details: Record<string, { detail: Detail; bookings: Booking[]; memberships: Membership[] }>;
};

const trainee = (memberId: string, fullName: string, memberCode: string): Item => ({
  memberId, memberCode, fullName, relatedBookingCount: 2, hasUpcoming: true, nextBookingAt: START,
});
const pack = (id: string, extra: Partial<Membership> = {}): Membership => ({
  id, kind: 'PT', storedStatus: 'ACTIVE', startDate: '2026-10-01', endDate: '2026-12-31',
  quota: 10, sessionsUsed: 3, reserved: 4, available: 3, quotaInvalid: false, ...extra,
});
const session = (id: string, status: string): Booking => ({ id, membershipId: 'm'.repeat(24), startAt: START, endAt: END, status, location: 'Phòng PT 1' });
const detailOf = (item: Item, bookings: Booking[] = [session('k'.repeat(24), 'BOOKED')], memberships: Membership[] = [pack('p'.repeat(24))]) => ({
  detail: { memberId: item.memberId, memberCode: item.memberCode, fullName: item.fullName, hasUpcoming: item.hasUpcoming }, bookings, memberships,
});
const notFound = () => new ApiError('Không tìm thấy', 404, 'req-404', undefined, undefined, 'NOT_FOUND');

// ---------- Server giả ở tầng apiClient ----------
let snapshot: AuthSnapshot;
let authListeners: Array<() => void>;
let dataByAccount: Record<string, AccountData>;
let failNext: Error | null;
let hold: Promise<void> | null;
let requestSpy: ReturnType<typeof vi.fn>;

const page = <T,>(items: T[], totalPages = items.length ? 1 : 0, current = 1) => ({ items, page: current, limit: 20, total: items.length, totalPages });

async function fakeServer(path: string, init: RequestInit = {}): Promise<unknown> {
  if (hold) await hold;
  if (failNext) throw failNext;
  if (init.method && init.method !== 'GET') throw new Error(`Không có trong spec US-30: ${init.method} ${path}`);
  const [route, search = ''] = path.split('?');
  const params = new URLSearchParams(search);
  if (route.startsWith('/me/notifications') || route.startsWith('/notifications')) return { items: [], unreadCount: 0 };
  if (route.startsWith('/me/work-shifts') || route.startsWith('/me/trainer-bookings')) return { items: [] };
  const user = snapshot.status === 'authenticated' ? snapshot.user : null;
  const data = user ? dataByAccount[user.id] : undefined;
  if (!data) throw new ApiError('Phiên không hợp lệ', 401, 'req-401');
  if (route === '/me/trainees') {
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const found = q ? data.items.filter(item => item.fullName.toLowerCase().includes(q) || item.memberCode.toLowerCase().includes(q)) : data.items;
    const current = Number(params.get('page') ?? '1');
    return { profileLinked: data.profileLinked, ...page(found, data.totalPages ?? (found.length ? 1 : 0), current) };
  }
  const match = /^\/me\/trainees\/([^/]+)(\/bookings|\/memberships)?$/.exec(route);
  if (match) {
    const found = data.details[match[1]];
    if (!found) throw notFound();
    if (match[2] === '/bookings') return page(found.bookings);
    if (match[2] === '/memberships') return { ...page(found.memberships), asOf: AS_OF };
    return found.detail;
  }
  throw new Error(`Đường dẫn không có trong spec US-30: ${path}`);
}

beforeEach(() => {
  snapshot = { status: 'authenticated', user: ptA };
  authListeners = [];
  const hoa = trainee(HOA, 'Nguyễn Thị Hoa', 'HV-0001');
  const minh = trainee(MINH, 'Trần Văn Minh', 'HV-0002');
  dataByAccount = {
    [ptA.id]: { profileLinked: true, items: [hoa, minh], details: { [HOA]: detailOf(hoa), [MINH]: detailOf(minh) } },
  };
  failNext = null;
  hold = null;
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(listener => {
    authListeners.push(listener);
    return () => { authListeners = authListeners.filter(entry => entry !== listener); };
  });
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
  requestSpy = vi.fn(fakeServer);
  vi.spyOn(apiClient, 'request').mockImplementation(requestSpy as never);
  vi.spyOn(apiClient, 'requestOnce').mockImplementation(requestSpy as never);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

const renderPage = () => render(<MemoryRouter initialEntries={['/trainer/trainees']}><TraineesPage /></MemoryRouter>);
const traineeCalls = () => requestSpy.mock.calls.map(call => String(call[0])).filter(path => path.startsWith('/me/trainees'));
const listRegion = () => screen.findByRole('region', { name: 'Danh sách học viên' });
const card = async (name: string) => within(await listRegion()).findByRole('article', { name });
const detailRegion = () => screen.findByRole('region', { name: 'Chi tiết học viên' });
const switchAccount = (next: AuthSnapshot) => act(() => {
  snapshot = next;
  for (const listener of [...authListeners]) listener();
});

async function openDetail(name = 'Nguyễn Thị Hoa') {
  renderPage();
  await userEvent.click(within(await card(name)).getByRole('button', { name: 'Xem chi tiết' }));
  return detailRegion();
}

// =====================================================================
// TC12 – danh sách, tìm kiếm, rỗng/đang tải/lỗi
// =====================================================================
describe('US-30 bước 3: danh sách và tìm kiếm học viên', () => {
  it('US-30-TC12: trang tải GET /me/trainees, hiện mỗi học viên một thẻ có tên và mã hội viên', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Học viên của tôi' })).toBeDefined();
    const hoa = await card('Nguyễn Thị Hoa');
    expect(within(hoa).getByText('HV-0001')).toBeDefined();
    expect(await card('Trần Văn Minh')).toBeDefined();
    expect(traineeCalls()[0].split('?')[0]).toBe('/me/trainees');
  });

  it('US-30-TC12: trang chỉ gọi GET tới /me/trainees..., không gửi trainerId/accountId', async () => {
    await openDetail();
    await within(await detailRegion()).findByRole('region', { name: 'Gói liên quan' });

    for (const [path, init] of requestSpy.mock.calls as Array<[string, RequestInit | undefined]>) {
      expect(init?.method ?? 'GET').toBe('GET');
      expect(path).not.toMatch(/trainerId|accountId/);
    }
    expect(traineeCalls().length).toBeGreaterThan(1);
  });

  it('US-30-TC12: nhập "Hoa" vào "Tìm học viên" rồi bấm "Tìm" → gọi lại với q=Hoa, page=1 và chỉ còn học viên khớp', async () => {
    renderPage();
    await card('Trần Văn Minh');

    await userEvent.type(screen.getByLabelText('Tìm học viên'), 'Hoa');
    await userEvent.click(screen.getByRole('button', { name: 'Tìm' }));

    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Danh sách học viên' })).queryByRole('article', { name: 'Trần Văn Minh' })).toBeNull());
    expect(await card('Nguyễn Thị Hoa')).toBeDefined();
    const last = new URLSearchParams(traineeCalls().at(-1)!.split('?')[1]);
    expect(last.get('q')?.trim()).toBe('Hoa');
    expect(last.get('page')).toBe('1');
  });

  it('US-30-TC12: tìm bằng chuỗi regex/HTML ".*<b>" → gửi nguyên văn trong q, trang không lỗi', async () => {
    renderPage();
    await card('Nguyễn Thị Hoa');

    await userEvent.type(screen.getByLabelText('Tìm học viên'), '.*<b>');
    await userEvent.click(screen.getByRole('button', { name: 'Tìm' }));

    await waitFor(() => expect(new URLSearchParams(traineeCalls().at(-1)!.split('?')[1]).get('q')).toBe('.*<b>'));
    expect(await screen.findByText(/Danh sách học viên trống|Không tìm thấy/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('US-30-TC12: totalPages=2 → nút "Trang sau" gọi page=2', async () => {
    dataByAccount[ptA.id].totalPages = 2;
    renderPage();
    await card('Nguyễn Thị Hoa');

    await userEvent.click(screen.getByRole('button', { name: 'Trang sau' }));

    await waitFor(() => expect(new URLSearchParams(traineeCalls().at(-1)!.split('?')[1]).get('page')).toBe('2'));
  });

  it('US-30-TC12: không có học viên → "Danh sách học viên trống", không dùng dữ liệu giả', async () => {
    dataByAccount[ptA.id] = { profileLinked: true, items: [], details: {} };
    renderPage();

    expect(await screen.findByText('Danh sách học viên trống')).toBeDefined();
    expect(within(await listRegion()).queryAllByRole('article')).toHaveLength(0);
  });

  it('US-30-TC12: profileLinked=false → báo chưa được liên kết hồ sơ PT, không phải lỗi', async () => {
    dataByAccount[ptA.id] = { profileLinked: false, items: [], details: {} };
    renderPage();

    expect(await screen.findByText(/chưa được liên kết hồ sơ PT/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('US-30-TC12: đang tải hiện "Đang tải"', async () => {
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    renderPage();

    expect(await screen.findByText(/Đang tải/)).toBeDefined();
    release();
    hold = null;
    expect(await card('Nguyễn Thị Hoa')).toBeDefined();
  });

  it('US-30-TC12: mất mạng → role="alert" + "Thử lại", không hiện "Danh sách học viên trống"; thử lại thì tải được', async () => {
    failNext = new TypeError('Failed to fetch');
    renderPage();

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText('Danh sách học viên trống')).toBeNull();

    failNext = null;
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await card('Nguyễn Thị Hoa')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('US-30-TC12: server 503 → role="alert", không hiện "Danh sách học viên trống"', async () => {
    failNext = new ApiError('Hệ thống tạm thời không sẵn sàng', 503, 'req-503', undefined, undefined, 'DATABASE_UNAVAILABLE');
    renderPage();

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText('Danh sách học viên trống')).toBeNull();
  });
});

// =====================================================================
// Chi tiết học viên: lịch, gói liên quan (TC12; giao diện của TC08, TC09, TC10)
// =====================================================================
describe('US-30 bước 3: chi tiết học viên', () => {
  it('US-30-TC12: "Xem chi tiết" gọi detail, bookings, memberships của đúng học viên và hiện tên, mã', async () => {
    const detail = await openDetail();

    expect(within(detail).getByText('Nguyễn Thị Hoa')).toBeDefined();
    expect(within(detail).getByText('HV-0001')).toBeDefined();
    await waitFor(() => {
      const routes = traineeCalls().map(path => path.split('?')[0]);
      expect(routes).toEqual(expect.arrayContaining([`/me/trainees/${HOA}`, `/me/trainees/${HOA}/bookings`, `/me/trainees/${HOA}/memberships`]));
    });
  });

  it('US-30-TC12: "Lịch với tôi" hiện giờ buổi theo giờ VN "09:00–10:00 25/11/2026" và nhãn trạng thái', async () => {
    const hoa = dataByAccount[ptA.id].items[0];
    dataByAccount[ptA.id].details[HOA] = detailOf(hoa, [session('k'.repeat(24), 'BOOKED'), session('j'.repeat(24), 'COMPLETED'), session('h'.repeat(24), 'CANCELLED')]);
    const detail = await openDetail();

    const schedule = await within(detail).findByRole('region', { name: 'Lịch với tôi' });
    const sessions = await within(schedule).findAllByRole('article');
    expect(sessions).toHaveLength(3);
    expect(sessions[0].textContent).toContain('09:00–10:00 25/11/2026');
    expect(within(sessions[0]).getByText('Đã đặt')).toBeDefined();
    expect(within(sessions[1]).getByText('Đã hoàn thành')).toBeDefined();
    expect(within(sessions[2]).getByText('Đã hủy')).toBeDefined();
  });

  it('US-30-TC12: "Gói liên quan" hiện số liệu nguyên từ server và "Cập nhật lúc 10:05 20/11/2026"', async () => {
    const detail = await openDetail();

    const packs = await within(detail).findByRole('region', { name: 'Gói liên quan' });
    const [first] = await within(packs).findAllByRole('article');
    const text = first.textContent ?? '';
    expect(text).toMatch(/Tổng:\s*10/);
    expect(text).toMatch(/Đã dùng:\s*3/);
    expect(text).toMatch(/Đang giữ chỗ:\s*4/);
    expect(text).toMatch(/Còn lại:\s*3/);
    expect(within(first).getByText('Đang hiệu lực')).toBeDefined();
    expect(within(detail).getByText(/Cập nhật lúc 10:05 20\/11\/2026/)).toBeDefined();
  });

  it('US-30-TC10: gói cũ "Đã được thay thế" và gói mới "Đang hiệu lực" hiện riêng, không cộng "Đã dùng" của gói cũ vào gói mới', async () => {
    const hoa = dataByAccount[ptA.id].items[0];
    dataByAccount[ptA.id].details[HOA] = detailOf(hoa, [session('k'.repeat(24), 'BOOKED')], [
      pack('n'.repeat(24), { storedStatus: 'ACTIVE', quota: 20, sessionsUsed: 0, reserved: 2, available: 18 }),
      pack('o'.repeat(24), { storedStatus: 'SUPERSEDED', quota: 10, sessionsUsed: 4, reserved: 0, available: 6 }),
    ]);
    const detail = await openDetail();

    const packs = await within(detail).findByRole('region', { name: 'Gói liên quan' });
    const [current, old] = await within(packs).findAllByRole('article');
    expect(within(current).getByText('Đang hiệu lực')).toBeDefined();
    expect(current.textContent).toMatch(/Đã dùng:\s*0/);
    expect(current.textContent).toMatch(/Còn lại:\s*18/);
    expect(current.textContent).not.toMatch(/Đã dùng:\s*4/);
    expect(within(old).getByText('Đã được thay thế')).toBeDefined();
    expect(old.textContent).toMatch(/Đã dùng:\s*4/);
  });

  it('US-30-TC12: gói có quotaInvalid=true → hiện cảnh báo "bất thường"; quotaInvalid=false thì không', async () => {
    const hoa = dataByAccount[ptA.id].items[0];
    dataByAccount[ptA.id].details[HOA] = detailOf(hoa, [], [
      pack('n'.repeat(24), { quota: 10, sessionsUsed: 9, reserved: 3, available: 0, quotaInvalid: true }),
      pack('o'.repeat(24), { quota: 10, sessionsUsed: 7, reserved: 3, available: 0, quotaInvalid: false }),
    ]);
    const detail = await openDetail();

    const packs = await within(detail).findByRole('region', { name: 'Gói liên quan' });
    const [broken, full] = await within(packs).findAllByRole('article');
    expect(broken.textContent).toMatch(/bất thường/);
    expect(full.textContent).not.toMatch(/bất thường/);
  });

  it('US-30-TC12: chi tiết không có nút hoàn tất buổi hay nhận xét/đánh giá (thuộc S07)', async () => {
    const detail = await openDetail();
    await within(detail).findByRole('region', { name: 'Gói liên quan' });

    const buttons = within(detail).queryAllByRole('button').map(button => button.textContent ?? '');
    for (const label of buttons) expect(label).not.toMatch(/hoàn tất|đã dạy|nhận xét|đánh giá/i);
  });

  it('US-30-TC08: tên chứa HTML hiện như chữ thường trong danh sách và chi tiết, không chèn thẻ <img>', async () => {
    const html = trainee('3'.repeat(24), '<img src=x onerror=alert(1)>', 'HV-0003');
    dataByAccount[ptA.id] = { profileLinked: true, items: [html], details: { [html.memberId]: detailOf(html) } };
    renderPage();

    const row = await card('<img src=x onerror=alert(1)>');
    expect(within(row).getByText('<img src=x onerror=alert(1)>')).toBeDefined();
    await userEvent.click(within(row).getByRole('button', { name: 'Xem chi tiết' }));
    const detail = await detailRegion();
    expect(within(detail).getByText('<img src=x onerror=alert(1)>')).toBeDefined();
    expect(document.querySelector('img')).toBeNull();
  });

  it('US-30-TC09: chi tiết trả 404 (quan hệ vừa hết) → role="alert" "Không tìm thấy học viên", không giữ dữ liệu chi tiết cũ', async () => {
    const detail = await openDetail();
    await within(detail).findByRole('region', { name: 'Gói liên quan' });
    expect(within(detail).getByText('HV-0001')).toBeDefined();

    // Học viên Hoa hủy buổi cuối: server không còn quan hệ, lần GET tiếp theo 404.
    delete dataByAccount[ptA.id].details[HOA];
    await userEvent.click(within(await card('Nguyễn Thị Hoa')).getByRole('button', { name: 'Xem chi tiết' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Không tìm thấy học viên');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Gói liên quan' })).toBeNull());
  });

  it('US-30-TC12: mở chi tiết học viên khác → không còn lịch/gói của học viên trước', async () => {
    const minh = dataByAccount[ptA.id].items[1];
    dataByAccount[ptA.id].details[MINH] = detailOf(minh, [], [pack('q'.repeat(24), { quota: 30, sessionsUsed: 1, reserved: 0, available: 29 })]);
    await openDetail('Nguyễn Thị Hoa');

    await userEvent.click(within(await card('Trần Văn Minh')).getByRole('button', { name: 'Xem chi tiết' }));

    const detail = await detailRegion();
    await waitFor(() => expect(within(detail).getByText('HV-0002')).toBeDefined());
    expect(within(detail).queryByText('HV-0001')).toBeNull();
    const packs = await within(detail).findByRole('region', { name: 'Gói liên quan' });
    await waitFor(() => expect(packs.textContent).toMatch(/Còn lại:\s*29/));
    expect(packs.textContent).not.toMatch(/Còn lại:\s*3\b/);
  });
});

// =====================================================================
// TC12 – đổi account / đăng xuất không lộ cache học viên của PT trước
// =====================================================================
describe('US-30 bước 3: cache theo account', () => {
  it('US-30-TC12: đổi sang PT khác → học viên và chi tiết của PT cũ biến mất ngay, rồi hiện học viên của PT mới', async () => {
    const lan = trainee('4'.repeat(24), 'Phạm Thị Lan', 'HV-0004');
    dataByAccount[ptB.id] = { profileLinked: true, items: [lan], details: { [lan.memberId]: detailOf(lan) } };
    await openDetail();

    // Request của PT mới bị giữ lại: trong lúc chờ, dữ liệu của PT cũ không được hiện nữa.
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    await switchAccount({ status: 'authenticated', user: ptB });
    await waitFor(() => expect(screen.queryByText('Nguyễn Thị Hoa')).toBeNull());
    expect(screen.queryByText('Trần Văn Minh')).toBeNull();
    expect(screen.queryByText('HV-0001')).toBeNull();

    release();
    hold = null;
    expect(await card('Phạm Thị Lan')).toBeDefined();
    expect(screen.queryByText('Nguyễn Thị Hoa')).toBeNull();
  });

  it('US-30-TC12: đăng xuất → xóa ngay danh sách và chi tiết học viên khỏi màn hình', async () => {
    await openDetail();

    await switchAccount({ status: 'anonymous', user: null });

    await waitFor(() => expect(screen.queryByText('Nguyễn Thị Hoa')).toBeNull());
    expect(screen.queryByText('Trần Văn Minh')).toBeNull();
    expect(screen.queryByText('HV-0001')).toBeNull();
  });
});

// =====================================================================
// Route /trainer/trainees
// =====================================================================
describe('US-30 bước 3: route /trainer/trainees', () => {
  it('US-30-TC12: TRAINER mở /trainer/trainees trong App → trang "Học viên của tôi" và tải danh sách', async () => {
    window.history.pushState({}, '', '/trainer/trainees');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Học viên của tôi' })).toBeDefined();
    await waitFor(() => expect(traineeCalls().length).toBeGreaterThan(0));
  });

  it('US-30-TC12: trang chính của PT có link "Học viên của tôi" tới /trainer/trainees', async () => {
    window.history.pushState({}, '', '/trainer');
    render(<App />);

    const link = await screen.findByRole('link', { name: 'Học viên của tôi' });
    expect(link.getAttribute('href')).toBe('/trainer/trainees');
  });

  it.each(['MEMBER', 'STAFF', 'ADMIN'] as const)('US-30-TC12: %s gõ thẳng /trainer/trainees → "Không có quyền truy cập", không gọi /me/trainees', async role => {
    snapshot = { status: 'authenticated', user: { ...ptA, roleCode: role } };
    window.history.pushState({}, '', '/trainer/trainees');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Không có quyền truy cập' })).toBeDefined();
    expect(traineeCalls()).toEqual([]);
  });
});
