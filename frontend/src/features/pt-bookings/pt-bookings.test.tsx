// Tầng kiểm thử frontend (Vitest, jsdom): US-27 bước 3 – trang /member/pt-bookings (lịch PT riêng + chọn PT/ngày/gói xem slot).
// Kiểm tra lịch riêng và bộ lọc, slot theo gói, quota/asOf theo số server, nhãn chưa link/chưa có gói, lỗi mạng, giờ VN (TC08, TC11, TC12).
// Hợp đồng test đặt ra cho Builder (US-27 bước 3, theo mục "Giao diện" và mục 2 của spec):
//   src/features/pt-bookings/PtBookingsPage.tsx: export function PtBookingsPage(); tiêu đề h1 "Lịch PT của tôi".
//   Gọi backend qua apiClient.request (file pt-bookings.api.ts cùng thư mục), bước 3 CHỈ GET, không gửi memberId/accountId:
//     /me/pt-bookings?fromDate&toDate&status?&page&limit, /me/pt-trainers?..., /me/pt-trainers/:id/availability?fromDate&toDate&membershipId?,
//     /me/memberships?... (lấy gói PT và số buổi do server tính).
//   - Vùng <section aria-labelledby> "Lịch của tôi": mỗi buổi là <article> có tên PT, ngày dd/mm/yyyy, giờ HH:mm–HH:mm (giờ VN),
//     địa điểm và nhãn trạng thái "Đã đặt" (BOOKED) / "Đã hoàn thành" (COMPLETED) / "Đã hủy" (CANCELLED).
//     Bộ lọc: ô "Từ ngày", "Đến ngày" (input date YYYY-MM-DD) và select "Trạng thái" (Tất cả/Đã đặt/Đã hoàn thành/Đã hủy).
//   - Vùng "Đặt lịch PT": select "Chọn PT" (option = displayName), input date "Ngày", select "Gói PT" (option = planName;
//     chỉ gói kind PT, storedStatus ACTIVE, timeState CURRENT hoặc SCHEDULED). Chọn PT + ngày thì gọi availability với
//     fromDate = toDate = ngày; chọn gói thì gửi thêm membershipId.
//     Mỗi slot là <button> tên "HH:mm–HH:mm" (giờ VN). bookable=false → nút disabled và có chữ giải thích theo reason:
//       MEMBERSHIP_REQUIRED "Chọn gói PT để đặt", QUOTA_EXHAUSTED "Gói đã hết số buổi", MEMBERSHIP_NOT_ELIGIBLE "Gói không dùng được cho buổi này".
//     Khi đã chọn gói: hiện "Đã dùng: u/q buổi", "Đang giữ chỗ: r buổi", "Còn đặt được: a buổi" lấy NGUYÊN số server
//     (sessionsUsed/Quota/Reserved/Available), không đếm từ lịch đang thấy; và "Cập nhật lúc HH:mm dd/mm/yyyy" theo asOf (giờ VN).
//   - memberLinked=false: chữ "chưa được liên kết hồ sơ hội viên" + hướng dẫn "quầy"; không phải lỗi.
//   - Đã link, không có gói PT dùng được: chữ "Bạn chưa có gói PT nào".
//   - Lỗi mạng/server: role="alert" + nút "Thử lại"; không hiện như chưa link/chưa có gói.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import type { AuthSnapshot, AuthUser } from '../auth/auth.types';
import { PtBookingsPage } from './PtBookingsPage';

const member: AuthUser = { id: 'a'.repeat(24), fullName: 'Hội viên A', phone: '+84901234567', roleCode: 'MEMBER' };
const asOf = '2026-11-20T03:05:00.000Z'; // 10:05 ngày 20/11/2026 giờ VN
const DAY = '2026-11-25';
const trainerA = { id: '1'.repeat(24), displayName: 'PT Trần Văn Bình', specialty: 'Thể hình' };
const trainerB = { id: '2'.repeat(24), displayName: 'PT Lê Thị Cúc', specialty: 'Yoga' };

type Booking = Record<string, unknown> & { id: string; status: string; startAt: string; endAt: string };
type Membership = Record<string, unknown> & { id: string; planName: string; kind: string; storedStatus: string; timeState: string };
type Slot = { shiftId: string; startAt: string; endAt: string; location: string; bookable: boolean; reason?: string };

const booking = (id: string, startAt: string, extra: Partial<Booking> = {}): Booking => ({
  id, membershipId: 'm1', trainerId: trainerA.id, trainerName: trainerA.displayName, shiftId: `shift-${id}`, startAt,
  endAt: new Date(Date.parse(startAt) + 3600000).toISOString(), location: 'Phòng PT 1', status: 'BOOKED', version: 0,
  cancelAllowed: true, ...extra,
});
const ptMembership = (id: string, planName: string, extra: Partial<Membership> = {}): Membership => ({
  id, planName, kind: 'PT', storedStatus: 'ACTIVE', timeState: 'CURRENT', startDate: '2026-11-01', endDate: '2026-12-31',
  sessionsQuota: 10, sessionsUsed: 2, sessionsReserved: 1, sessionsAvailable: 7, ...extra,
});
const slot = (startAt: string, extra: Partial<Slot> = {}): Slot => ({
  shiftId: 'shift-1', startAt, endAt: new Date(Date.parse(startAt) + 3600000).toISOString(), location: 'Phòng PT 2',
  bookable: false, reason: 'MEMBERSHIP_REQUIRED', ...extra,
});

// ---------- Server giả ở tầng apiClient ----------
let snapshot: AuthSnapshot;
let memberLinked: boolean;
let bookings: Booking[];
let bookingsTotal: number | null;
let memberships: Membership[];
let availability: (trainerId: string, params: URLSearchParams) => Slot[];
let failNext: Error | null;
let requestSpy: ReturnType<typeof vi.fn>;

const page = <T,>(items: T[], params: URLSearchParams, total = items.length) => {
  const pageNo = Number(params.get('page') ?? 1);
  const limit = Number(params.get('limit') ?? 20);
  return { items, page: pageNo, limit, total, totalPages: Math.ceil(total / limit), asOf };
};

async function fakeServer(path: string, init: RequestInit = {}): Promise<unknown> {
  if (failNext) { const error = failNext; failNext = null; throw error; }
  if (init.method && init.method !== 'GET') throw new Error(`Bước 3 chỉ đọc, không được gọi ${init.method} ${path}`);
  const [route, queryString] = path.split('?');
  const params = new URLSearchParams(queryString ?? '');
  if (route === '/me/pt-bookings') {
    const items = memberLinked ? bookings.filter(item => !params.get('status') || item.status === params.get('status')) : [];
    return { memberLinked, ...page(items, params, memberLinked ? bookingsTotal ?? items.length : 0) };
  }
  if (route === '/me/pt-trainers') return page([trainerA, trainerB], params);
  const slots = /^\/me\/pt-trainers\/([^/]+)\/availability$/.exec(route);
  if (slots) return { trainerId: slots[1], memberLinked, asOf, slots: availability(slots[1], params) };
  if (route === '/me/memberships') {
    const items = memberLinked ? memberships.filter(item =>
      (!params.get('kind') || item.kind === params.get('kind'))
      && (!params.get('storedStatus') || item.storedStatus === params.get('storedStatus'))
      && (!params.get('timeState') || item.timeState === params.get('timeState'))) : [];
    return { memberLinked, ...page(items, params) };
  }
  if (route.startsWith('/me/notifications')) return { items: [], unreadCount: 0, asOf };
  throw new Error(`Đường dẫn không có trong spec US-27: ${path}`);
}

beforeEach(() => {
  snapshot = { status: 'authenticated', user: member };
  memberLinked = true;
  bookings = [];
  bookingsTotal = null;
  memberships = [ptMembership('m1', 'PT 10 buổi')];
  availability = () => [];
  failNext = null;
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
  requestSpy = vi.fn(fakeServer);
  vi.spyOn(apiClient, 'request').mockImplementation(requestSpy as never);
  vi.spyOn(apiClient, 'requestOnce').mockImplementation(requestSpy as never);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderPage = () => render(<MemoryRouter initialEntries={['/member/pt-bookings']}><PtBookingsPage /></MemoryRouter>);
const region = (name: string) => screen.getByRole('region', { name });
const calls = (prefix: string) => requestSpy.mock.calls.map(call => String(call[0])).filter(path => path.startsWith(prefix));
const lastCall = (prefix: string) => {
  const list = calls(prefix);
  return new URLSearchParams(list[list.length - 1]?.split('?')[1] ?? '');
};
const slotButton = (from: string, to: string) => screen.findByRole('button', { name: new RegExp(`${from}\\s*[–-]\\s*${to}`) });

// Chọn PT (theo tên hiển thị), ngày và (tùy chọn) gói trong vùng "Đặt lịch PT".
async function choose(trainerName: string, day: string, planName?: string) {
  const panel = await screen.findByRole('region', { name: 'Đặt lịch PT' });
  const trainerSelect = await within(panel).findByLabelText('Chọn PT');
  await within(trainerSelect).findByRole('option', { name: trainerName });
  await userEvent.selectOptions(trainerSelect, trainerName);
  fireEvent.change(within(panel).getByLabelText('Ngày'), { target: { value: day } });
  if (planName) {
    const planSelect = within(panel).getByLabelText('Gói PT');
    await within(planSelect).findByRole('option', { name: planName });
    await userEvent.selectOptions(planSelect, planName);
  }
}

describe('US-27 bước 3: trang /member/pt-bookings', () => {
  // ---------- TC12: lịch riêng, bộ lọc, quota/asOf, nhãn rõ, lỗi mạng ----------

  it('US-27-TC12: lịch của tôi hiện tên PT, ngày, giờ VN, địa điểm và nhãn trạng thái của từng buổi', async () => {
    bookings = [
      booking('b1', '2026-11-25T01:00:00.000Z'),
      booking('b2', '2026-11-26T03:00:00.000Z', { status: 'COMPLETED', location: 'Phòng PT 3', cancelAllowed: false }),
      booking('b3', '2026-11-27T10:00:00.000Z', { status: 'CANCELLED', trainerName: trainerB.displayName, cancelAllowed: false }),
    ];
    renderPage();

    const mine = await screen.findByRole('region', { name: 'Lịch của tôi' });
    await waitFor(() => expect(within(mine).getAllByRole('article')).toHaveLength(3));
    const [first, second, third] = within(mine).getAllByRole('article');
    expect(first.textContent).toMatch(/PT Trần Văn Bình/);
    expect(first.textContent).toMatch(/25\/11\/2026/);
    expect(first.textContent).toMatch(/08:00\s*[–-]\s*09:00/);
    expect(first.textContent).toMatch(/Phòng PT 1/);
    expect(within(first).getByText('Đã đặt')).toBeDefined();
    expect(within(second).getByText('Đã hoàn thành')).toBeDefined();
    expect(second.textContent).toMatch(/Phòng PT 3/);
    expect(within(third).getByText('Đã hủy')).toBeDefined();
    expect(third.textContent).toMatch(/PT Lê Thị Cúc/);
  });

  it('US-27-TC12: lọc trạng thái "Đã hủy" gửi status=CANCELLED và chỉ còn buổi đã hủy', async () => {
    bookings = [booking('b1', '2026-11-25T01:00:00.000Z'), booking('b2', '2026-11-25T03:00:00.000Z', { status: 'CANCELLED' })];
    renderPage();
    const mine = await screen.findByRole('region', { name: 'Lịch của tôi' });
    await waitFor(() => expect(within(mine).getAllByRole('article')).toHaveLength(2));

    await userEvent.selectOptions(within(mine).getByLabelText('Trạng thái'), 'Đã hủy');

    await waitFor(() => expect(lastCall('/me/pt-bookings').get('status')).toBe('CANCELLED'));
    await waitFor(() => expect(within(mine).getAllByRole('article')).toHaveLength(1));
    expect(within(within(mine).getByRole('article')).getByText('Đã hủy')).toBeDefined();
  });

  it('US-27-TC12: đổi "Từ ngày"/"Đến ngày" thì tải lại lịch với đúng fromDate/toDate', async () => {
    renderPage();
    const mine = await screen.findByRole('region', { name: 'Lịch của tôi' });
    await waitFor(() => expect(calls('/me/pt-bookings').length).toBeGreaterThan(0));

    fireEvent.change(within(mine).getByLabelText('Từ ngày'), { target: { value: '2026-12-01' } });
    fireEvent.change(within(mine).getByLabelText('Đến ngày'), { target: { value: '2026-12-07' } });

    await waitFor(() => {
      const params = lastCall('/me/pt-bookings');
      expect(params.get('fromDate')).toBe('2026-12-01');
      expect(params.get('toDate')).toBe('2026-12-07');
    });
  });

  it('US-27-TC12: chọn PT và ngày, chưa chọn gói → gọi availability đúng ngày, slot bị khóa kèm "Chọn gói PT để đặt"', async () => {
    availability = () => [slot('2026-11-25T01:10:00.000Z'), slot('2026-11-25T02:10:00.000Z')];
    renderPage();
    await choose(trainerA.displayName, DAY);

    const first = await slotButton('08:10', '09:10');
    expect((first as HTMLButtonElement).disabled).toBe(true);
    expect(((await slotButton('09:10', '10:10')) as HTMLButtonElement).disabled).toBe(true);
    expect(within(region('Đặt lịch PT')).getAllByText(/Chọn gói PT để đặt/).length).toBeGreaterThan(0);
    const params = lastCall(`/me/pt-trainers/${trainerA.id}/availability`);
    expect(params.get('fromDate')).toBe(DAY);
    expect(params.get('toDate')).toBe(DAY);
    expect(params.get('membershipId')).toBeNull();
  });

  it('US-27-TC12: chọn gói → gửi membershipId; slot bookable mở, slot bookable=false khóa và giải thích lý do', async () => {
    availability = (_trainerId, params) => params.get('membershipId') === 'm1'
      ? [
        slot('2026-11-25T01:00:00.000Z', { bookable: true, reason: undefined }),
        slot('2026-11-25T02:00:00.000Z', { bookable: false, reason: 'MEMBERSHIP_NOT_ELIGIBLE' }),
      ]
      : [slot('2026-11-25T01:00:00.000Z'), slot('2026-11-25T02:00:00.000Z')];
    renderPage();
    await choose(trainerA.displayName, DAY, 'PT 10 buổi');

    await waitFor(() => expect(lastCall(`/me/pt-trainers/${trainerA.id}/availability`).get('membershipId')).toBe('m1'));
    await waitFor(async () => expect(((await slotButton('08:00', '09:00')) as HTMLButtonElement).disabled).toBe(false));
    expect(((await slotButton('09:00', '10:00')) as HTMLButtonElement).disabled).toBe(true);
    expect(within(region('Đặt lịch PT')).getByText(/Gói không dùng được cho buổi này/)).toBeDefined();
  });

  it('US-27-TC12: gói hết số buổi → mọi slot khóa và hiện "Gói đã hết số buổi"', async () => {
    memberships = [ptMembership('m1', 'PT 10 buổi', { sessionsUsed: 9, sessionsReserved: 1, sessionsAvailable: 0 })];
    availability = (_trainerId, params) => [slot('2026-11-25T01:00:00.000Z', params.get('membershipId')
      ? { bookable: false, reason: 'QUOTA_EXHAUSTED' } : {})];
    renderPage();
    await choose(trainerA.displayName, DAY, 'PT 10 buổi');

    await waitFor(() => expect(within(region('Đặt lịch PT')).getAllByText(/Gói đã hết số buổi/).length).toBeGreaterThan(0));
    expect(((await slotButton('08:00', '09:00')) as HTMLButtonElement).disabled).toBe(true);
  });

  it('US-27-TC12: quota lấy nguyên số server, không đếm từ lịch đang thấy (lịch phân trang chỉ thấy 1 buổi, server giữ 3)', async () => {
    bookings = [booking('b1', '2026-11-25T01:00:00.000Z')];
    bookingsTotal = 25; // còn nhiều buổi ở trang sau
    memberships = [ptMembership('m1', 'PT 20 buổi', { sessionsQuota: 20, sessionsUsed: 4, sessionsReserved: 3, sessionsAvailable: 13 })];
    renderPage();
    await choose(trainerA.displayName, DAY, 'PT 20 buổi');

    const panel = region('Đặt lịch PT');
    expect(await within(panel).findByText(/Đã dùng: 4\/20 buổi/)).toBeDefined();
    expect(within(panel).getByText(/Đang giữ chỗ: 3 buổi/)).toBeDefined();
    expect(within(panel).getByText(/Còn đặt được: 13 buổi/)).toBeDefined();
  });

  it('US-27-TC12: hiện thời điểm dữ liệu "Cập nhật lúc 10:05 20/11/2026" theo asOf của server (giờ VN)', async () => {
    availability = () => [slot('2026-11-25T01:00:00.000Z')];
    renderPage();
    await choose(trainerA.displayName, DAY, 'PT 10 buổi');

    expect((await within(region('Đặt lịch PT')).findAllByText(/Cập nhật lúc 10:05 20\/11\/2026/)).length).toBeGreaterThan(0);
  });

  it('US-27-TC12: account chưa liên kết hồ sơ → hướng dẫn ra quầy, không báo lỗi, không có buổi nào', async () => {
    memberLinked = false;
    renderPage();

    expect((await screen.findAllByText(/chưa được liên kết hồ sơ hội viên/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/quầy/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('US-27-TC12: đã liên kết nhưng chỉ có gói GYM → "Bạn chưa có gói PT nào", không báo lỗi', async () => {
    memberships = [ptMembership('g1', 'GYM 3 tháng', { kind: 'GYM', sessionsQuota: 0, sessionsUsed: 0, sessionsReserved: 0, sessionsAvailable: 0 })];
    renderPage();

    expect(await screen.findByText(/Bạn chưa có gói PT nào/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/chưa được liên kết/)).toBeNull();
  });

  it('US-27-TC12: mất mạng → báo lỗi + "Thử lại", không hiện như chưa liên kết/chưa có gói; thử lại thì tải được', async () => {
    bookings = [booking('b1', '2026-11-25T01:00:00.000Z')];
    failNext = new TypeError('Failed to fetch');
    renderPage();

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText(/chưa được liên kết/)).toBeNull();
    expect(screen.queryByText(/Bạn chưa có gói PT nào/)).toBeNull();

    failNext = null;
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    const mine = await screen.findByRole('region', { name: 'Lịch của tôi' });
    await waitFor(() => expect(within(mine).getAllByRole('article')).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('US-27-TC12: server lỗi 503 → báo lỗi, không hiện "Bạn chưa có gói PT nào"', async () => {
    failNext = new ApiError('Hệ thống tạm thời không sẵn sàng', 503, 'req-503', undefined, undefined, 'SERVICE_UNAVAILABLE');
    renderPage();

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText(/Bạn chưa có gói PT nào/)).toBeNull();
  });

  it('US-27-TC12: bước 3 chỉ gọi GET tới /me/*, không gửi memberId/accountId', async () => {
    availability = () => [slot('2026-11-25T01:00:00.000Z')];
    renderPage();
    await choose(trainerA.displayName, DAY, 'PT 10 buổi');
    await slotButton('08:00', '09:00');

    expect(calls('/me/pt-bookings').length).toBeGreaterThan(0);
    expect(calls(`/me/pt-trainers/${trainerA.id}/availability`).length).toBeGreaterThan(0);
    for (const [path, init] of requestSpy.mock.calls as Array<[string, RequestInit | undefined]>) {
      expect(path.startsWith('/me/')).toBe(true);
      expect(path).not.toMatch(/memberId|accountId/);
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });

  // ---------- TC08: không mở slot từ gói cũ (phần giao diện) ----------

  it('US-27-TC08: ô "Gói PT" chỉ có gói PT ACTIVE hiện hành/chờ hiệu lực; không có gói SUPERSEDED, hết hạn hay GYM', async () => {
    memberships = [
      ptMembership('m1', 'PT hiện hành'),
      ptMembership('m2', 'PT tháng sau', { timeState: 'SCHEDULED', startDate: '2026-12-01', endDate: '2027-01-31' }),
      ptMembership('m3', 'PT cũ đã nâng cấp', { storedStatus: 'SUPERSEDED' }),
      ptMembership('m4', 'PT đã hết hạn', { timeState: 'EXPIRED', startDate: '2026-09-01', endDate: '2026-10-31' }),
      ptMembership('g1', 'GYM 3 tháng', { kind: 'GYM', sessionsQuota: 0, sessionsAvailable: 0 }),
    ];
    renderPage();
    const planSelect = await within(await screen.findByRole('region', { name: 'Đặt lịch PT' })).findByLabelText('Gói PT');
    await within(planSelect).findByRole('option', { name: 'PT hiện hành' });

    const names = within(planSelect).getAllByRole('option').map(option => option.textContent);
    expect(names).toEqual(expect.arrayContaining(['PT hiện hành', 'PT tháng sau']));
    for (const hidden of ['PT cũ đã nâng cấp', 'PT đã hết hạn', 'GYM 3 tháng']) expect(names).not.toContain(hidden);
  });

  // ---------- TC11: thời gian hiển thị đúng giờ Việt Nam ----------

  it('US-27-TC11: buổi 17:00 UTC hiện là 00:00 ngày hôm sau theo giờ VN', async () => {
    bookings = [booking('b1', '2026-11-25T17:00:00.000Z')];
    renderPage();

    const mine = await screen.findByRole('region', { name: 'Lịch của tôi' });
    const card = await within(mine).findByRole('article');
    expect(card.textContent).toMatch(/26\/11\/2026/);
    expect(card.textContent).toMatch(/00:00\s*[–-]\s*01:00/);
  });

  it('US-27-TC11: slot 01:10 UTC hiện nút 08:10–09:10 giờ VN', async () => {
    availability = () => [slot('2026-11-25T01:10:00.000Z')];
    renderPage();
    await choose(trainerA.displayName, DAY);

    expect(await slotButton('08:10', '09:10')).toBeDefined();
  });
});
