// Tầng kiểm thử frontend (Vitest, jsdom): US-29 bước 3 – Member tự hủy buổi PT trên trang /member/pt-bookings.
// Kiểm tra hạn hủy giờ VN, cancelAllowed từ server chỉ là gợi ý, nhập lý do + xác nhận, gửi đúng body + Idempotency-Key,
// giữ key khi mất phản hồi, 409 tải lại lịch, thành công tải lại lịch/quota/giờ trống, lỗi không xóa thẻ lịch (TC01, TC02, TC04, TC06, TC12, TC13).
// Hợp đồng test đặt ra cho Builder (US-29 bước 3, theo đoạn "UI Member" mục 2 của spec, dựa trên trang US-27/28 đã có):
//   Trong vùng "Lịch của tôi", mỗi <article> buổi BOOKED:
//     cancelAllowed = true  → có chữ "Hạn hủy: HH:mm dd/mm/yyyy" (startAt − 2 giờ, giờ VN) và nút "Hủy lịch".
//     cancelAllowed = false → KHÔNG có nút "Hủy lịch", có chữ hướng dẫn "liên hệ quầy". Không tự tính lại bằng đồng hồ máy người dùng.
//   Buổi COMPLETED/CANCELLED không có nút "Hủy lịch".
//   Bấm "Hủy lịch" mở <section aria-labelledby> tiêu đề "Xác nhận hủy lịch": tên PT, ngày, giờ VN, "Hạn hủy: …",
//     ô <textarea> nhãn "Lý do hủy", nút "Xác nhận hủy" (bị khóa khi lý do sau trim < 10 hoặc > 500 ký tự) và "Đóng".
//   "Xác nhận hủy" gọi POST /me/pt-bookings/:id/cancel qua apiClient (pt-bookings.api.ts), body CHỈ {version, reason},
//     version lấy từ buổi đang hiện, header Idempotency-Key UUID. Đang gửi thì nút khóa (không gửi kép).
//   Thành công: role="status" có "Đã hủy lịch", đóng bảng xác nhận, tải lại lịch của tôi, gói (quota) và giờ trống đang xem.
//   Mất phản hồi/503: role="alert", bảng xác nhận và thẻ lịch giữ nguyên, không tự gửi lại; bấm "Xác nhận hủy" lần nữa dùng LẠI key cũ.
//   409 CANCELLATION_WINDOW_CLOSED: role="alert" có "liên hệ quầy"; 409 VERSION_CONFLICT/INVALID_BOOKING_STATE: role="alert" có "tải lại";
//     cả hai: tự tải lại lịch, thẻ lịch không bị xóa khỏi màn hình; lần hủy sau là ý định mới → key mới.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import type { AuthSnapshot, AuthUser } from '../auth/auth.types';
import { PtBookingsPage } from './PtBookingsPage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const member: AuthUser = { id: 'a'.repeat(24), fullName: 'Hội viên A', phone: '+84901234567', roleCode: 'MEMBER' };
const asOf = '2026-11-20T03:05:00.000Z';
const BOOKING_ID = 'd'.repeat(24);
const MEMBERSHIP_ID = 'b'.repeat(24);
const trainerA = { id: '1'.repeat(24), displayName: 'PT Trần Văn Bình', specialty: 'Thể hình' };
// 09:00–10:00 ngày 25/11/2026 giờ VN → hạn hủy 07:00 25/11/2026.
const START = '2026-11-25T02:00:00.000Z';
const REASON = 'Bận việc gia đình đột xuất';

type Booking = Record<string, unknown> & { id: string; status: string; version: number; cancelAllowed: boolean };
type PostCall = { path: string; body: Record<string, unknown>; key: string | null };

const plus1h = (startAt: string) => new Date(Date.parse(startAt) + 3600000).toISOString();
const booking = (extra: Partial<Booking> = {}): Booking => ({
  id: BOOKING_ID, membershipId: MEMBERSHIP_ID, trainerId: trainerA.id, trainerName: trainerA.displayName, shiftId: 'c'.repeat(24),
  startAt: START, endAt: plus1h(START), location: 'Phòng PT 1', status: 'BOOKED', version: 0, cancelAllowed: true, ...extra,
});
const ptMembership = (reserved: number) => ({
  id: MEMBERSHIP_ID, planName: 'PT 10 buổi', kind: 'PT', storedStatus: 'ACTIVE', timeState: 'CURRENT', startDate: '2026-11-01', endDate: '2026-12-31',
  sessionsQuota: 10, sessionsUsed: 2, sessionsReserved: reserved, sessionsAvailable: 8 - reserved,
});

// ---------- Server giả ở tầng apiClient ----------
let snapshot: AuthSnapshot;
let bookings: Booking[];
let reserved: number;
let posts: PostCall[];
let onPost: (call: PostCall) => Promise<unknown>;
let requestSpy: ReturnType<typeof vi.fn>;

const page = <T,>(items: T[]) => ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0, asOf });
const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

async function fakeServer(path: string, init: RequestInit = {}): Promise<unknown> {
  const [route] = path.split('?');
  if (init.method === 'POST' && /^\/me\/pt-bookings\/[^/]+\/cancel$/.test(route)) {
    const call = { path: route, body: JSON.parse(String(init.body)) as Record<string, unknown>, key: headerOf(init, 'Idempotency-Key') };
    posts.push(call);
    return onPost(call);
  }
  if (init.method && init.method !== 'GET') throw new Error(`Không có trong spec: ${init.method} ${path}`);
  if (route === '/me/pt-bookings') return { memberLinked: true, ...page(bookings) };
  if (route === '/me/pt-trainers') return page([trainerA]);
  const match = /^\/me\/pt-trainers\/([^/]+)\/availability$/.exec(route);
  if (match) return { trainerId: match[1], memberLinked: true, asOf, slots: [] };
  if (route === '/me/memberships') return { memberLinked: true, ...page([ptMembership(reserved)]) };
  if (route.startsWith('/me/notifications')) return { items: [], unreadCount: 0, asOf };
  throw new Error(`Đường dẫn không có trong spec: ${path}`);
}

const cancelled = () => ({ id: BOOKING_ID, status: 'CANCELLED', version: 1, cancelledAt: '2026-11-20T03:10:00.000Z', notificationState: 'STORED' });
const apiError = (status: number, code: string) => new ApiError('Lỗi', status, 'req-1', undefined, undefined, code);

beforeEach(() => {
  snapshot = { status: 'authenticated', user: member };
  bookings = [booking()];
  reserved = 1;
  posts = [];
  onPost = async () => {
    // Server commit: buổi chuyển CANCELLED, quota giữ chỗ giảm 1 trong lần tải lại sau.
    bookings = [booking({ status: 'CANCELLED', version: 1, cancelAllowed: false })];
    reserved = 0;
    return cancelled();
  };
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
  requestSpy = vi.fn(fakeServer);
  vi.spyOn(apiClient, 'request').mockImplementation(requestSpy as never);
  vi.spyOn(apiClient, 'requestOnce').mockImplementation(requestSpy as never);
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const renderPage = () => render(<MemoryRouter initialEntries={['/member/pt-bookings']}><PtBookingsPage /></MemoryRouter>);
const getCalls = (prefix: string) => requestSpy.mock.calls
  .filter(call => !(call[1] as RequestInit | undefined)?.method || (call[1] as RequestInit).method === 'GET')
  .map(call => String(call[0])).filter(path => path.startsWith(prefix));
const myBookings = () => screen.findByRole('region', { name: 'Lịch của tôi' });
const bookingCard = async () => {
  const region = await myBookings();
  return within(region).findByRole('article');
};
const confirmRegion = () => screen.findByRole('region', { name: 'Xác nhận hủy lịch' });

// Mở bảng xác nhận hủy và nhập lý do.
async function openCancel(reason = REASON) {
  renderPage();
  const card = await bookingCard();
  await userEvent.click(within(card).getByRole('button', { name: 'Hủy lịch' }));
  const dialog = await confirmRegion();
  fireEvent.change(within(dialog).getByLabelText('Lý do hủy'), { target: { value: reason } });
  return dialog;
}
const confirmButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Xác nhận hủy' }) as HTMLButtonElement;

describe('US-29 bước 3: Member hủy buổi PT trên trang /member/pt-bookings', () => {
  // ---------- TC01, TC02: hạn hủy và nút theo gợi ý của server ----------

  it('US-29-TC01: buổi BOOKED còn hạn hiện "Hạn hủy: 07:00 25/11/2026" (giờ VN) và nút "Hủy lịch"', async () => {
    renderPage();
    const card = await bookingCard();

    expect(within(card).getByText(/Hạn hủy:\s*07:00 25\/11\/2026/)).toBeDefined();
    expect(within(card).getByRole('button', { name: 'Hủy lịch' })).toBeDefined();
  });

  it('US-29-TC02: buổi BOOKED server báo cancelAllowed false → không có nút "Hủy lịch", hướng dẫn liên hệ quầy', async () => {
    bookings = [booking({ cancelAllowed: false })];
    renderPage();
    const card = await bookingCard();

    expect(within(card).queryByRole('button', { name: 'Hủy lịch' })).toBeNull();
    expect(within(card).getByText(/liên hệ quầy/i)).toBeDefined();
  });

  it('US-29-TC02: đổi đồng hồ máy về 1 ngày trước vẫn không mở nút khi server báo cancelAllowed false', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T00:00:00.000Z'));
    bookings = [booking({ cancelAllowed: false })];
    renderPage();
    const card = await bookingCard();

    expect(within(card).queryByRole('button', { name: 'Hủy lịch' })).toBeNull();
  });

  it.each([
    ['COMPLETED', 'Đã hoàn thành'],
    ['CANCELLED', 'Đã hủy'],
  ])('US-29-TC02: buổi %s không có nút "Hủy lịch"', async (status, label) => {
    bookings = [booking({ status, cancelAllowed: false })];
    renderPage();
    const card = await bookingCard();

    expect(within(card).getByText(label)).toBeDefined();
    expect(within(card).queryByRole('button', { name: 'Hủy lịch' })).toBeNull();
  });

  // ---------- TC01, TC06: bảng xác nhận, lý do, gửi đúng hợp đồng ----------

  it('US-29-TC01: bấm "Hủy lịch" mở bảng "Xác nhận hủy lịch" có PT, ngày, giờ VN, hạn hủy; "Đóng" không gửi gì', async () => {
    renderPage();
    await userEvent.click(within(await bookingCard()).getByRole('button', { name: 'Hủy lịch' }));
    const dialog = await confirmRegion();

    expect(within(dialog).getByText(new RegExp(trainerA.displayName))).toBeDefined();
    expect(within(dialog).getByText(/25\/11\/2026/)).toBeDefined();
    expect(within(dialog).getByText(/09:00\s*[–-]\s*10:00/)).toBeDefined();
    expect(within(dialog).getByText(/Hạn hủy:\s*07:00 25\/11\/2026/)).toBeDefined();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Đóng' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Xác nhận hủy lịch' })).toBeNull());
    expect(posts).toHaveLength(0);
  });

  it.each([
    ['trống', ''],
    ['9 ký tự sau trim', '   123456789   '],
    ['501 ký tự', 'a'.repeat(501)],
  ])('US-29-TC06: lý do %s → nút "Xác nhận hủy" bị khóa, không gửi', async (_name, reason) => {
    const dialog = await openCancel(reason);

    expect(confirmButton(dialog).disabled).toBe(true);
    fireEvent.click(confirmButton(dialog));
    expect(posts).toHaveLength(0);
  });

  it('US-29-TC01: "Xác nhận hủy" gửi POST /me/pt-bookings/:id/cancel chỉ với {version, reason} và Idempotency-Key UUID', async () => {
    bookings = [booking({ version: 3 })];
    const dialog = await openCancel();

    await userEvent.click(confirmButton(dialog));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].path).toBe(`/me/pt-bookings/${BOOKING_ID}/cancel`);
    expect(Object.keys(posts[0].body).sort()).toEqual(['reason', 'version']);
    expect(posts[0].body.version).toBe(3);
    expect(String(posts[0].body.reason).trim()).toBe(REASON);
    expect(posts[0].key).toMatch(UUID);
  });

  it('US-29-TC01: đang gửi thì nút "Xác nhận hủy" bị khóa, bấm nhiều lần chỉ gửi một yêu cầu', async () => {
    let release!: (value: unknown) => void;
    onPost = () => new Promise(resolve => { release = resolve; });
    const dialog = await openCancel();

    await userEvent.click(confirmButton(dialog));
    await waitFor(() => expect(confirmButton(dialog).disabled).toBe(true));
    fireEvent.click(confirmButton(dialog));
    expect(posts).toHaveLength(1);
    release(cancelled());
  });

  // ---------- TC01, TC13: thành công tải lại lịch/quota/giờ trống ----------

  it('US-29-TC01: thành công → "Đã hủy lịch", đóng bảng xác nhận, tải lại lịch của tôi và gói; thẻ hiện "Đã hủy" theo server', async () => {
    const dialog = await openCancel();
    const bookingsBefore = getCalls('/me/pt-bookings').length;
    const membershipsBefore = getCalls('/me/memberships').length;

    await userEvent.click(confirmButton(dialog));

    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringMatching(/Đã hủy lịch/));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Xác nhận hủy lịch' })).toBeNull());
    await waitFor(() => expect(getCalls('/me/pt-bookings').length).toBeGreaterThan(bookingsBefore));
    await waitFor(() => expect(getCalls('/me/memberships').length).toBeGreaterThan(membershipsBefore));
    expect(within(await bookingCard()).getByText('Đã hủy')).toBeDefined();
  });

  it('US-29-TC13: đang xem giờ trống của một PT/ngày → hủy thành công thì tải lại giờ trống đó', async () => {
    renderPage();
    const panel = await screen.findByRole('region', { name: 'Đặt lịch PT' });
    const trainerSelect = await within(panel).findByLabelText('Chọn PT');
    await within(trainerSelect).findByRole('option', { name: trainerA.displayName });
    await userEvent.selectOptions(trainerSelect, trainerA.displayName);
    fireEvent.change(within(panel).getByLabelText('Ngày'), { target: { value: '2026-11-25' } });
    await waitFor(() => expect(getCalls(`/me/pt-trainers/${trainerA.id}/availability`).length).toBeGreaterThan(0));
    const availabilityBefore = getCalls(`/me/pt-trainers/${trainerA.id}/availability`).length;

    await userEvent.click(within(await bookingCard()).getByRole('button', { name: 'Hủy lịch' }));
    const dialog = await confirmRegion();
    fireEvent.change(within(dialog).getByLabelText('Lý do hủy'), { target: { value: REASON } });
    await userEvent.click(confirmButton(dialog));

    await waitFor(() => expect(getCalls(`/me/pt-trainers/${trainerA.id}/availability`).length).toBeGreaterThan(availabilityBefore));
  });

  // ---------- TC12, TC13: mất phản hồi giữ key, lỗi không xóa thẻ ----------

  it.each([
    ['mất kết nối', () => new ApiError('Không kết nối được máy chủ')],
    ['503 OPERATION_OUTCOME_UNKNOWN', () => apiError(503, 'OPERATION_OUTCOME_UNKNOWN')],
  ])('US-29-TC12: %s → báo lỗi, giữ bảng xác nhận và thẻ lịch, không tự gửi lại; bấm lại dùng đúng key cũ', async (_name, makeError) => {
    let first = true;
    onPost = async () => {
      if (first) { first = false; throw makeError(); }
      bookings = [booking({ status: 'CANCELLED', version: 1, cancelAllowed: false })];
      return cancelled();
    };
    const dialog = await openCancel();

    await userEvent.click(confirmButton(dialog));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('region', { name: 'Xác nhận hủy lịch' })).toBeDefined();
    expect(within(await myBookings()).getAllByRole('article')).toHaveLength(1);
    expect(posts).toHaveLength(1);
    await userEvent.click(confirmButton(dialog));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].key).toBe(posts[0].key);
    expect(posts[1].body).toEqual(posts[0].body);
  });

  // ---------- TC02, TC04: 409 từ server tải lại lịch, không xóa thẻ ----------

  it('US-29-TC02: server trả 409 CANCELLATION_WINDOW_CLOSED (đồng hồ server quyết định) → báo liên hệ quầy, tải lại lịch, thẻ vẫn còn', async () => {
    onPost = async () => {
      bookings = [booking({ cancelAllowed: false })];
      throw apiError(409, 'CANCELLATION_WINDOW_CLOSED');
    };
    const dialog = await openCancel();
    const bookingsBefore = getCalls('/me/pt-bookings').length;

    await userEvent.click(confirmButton(dialog));

    expect((await screen.findByRole('alert')).textContent).toMatch(/liên hệ quầy/i);
    await waitFor(() => expect(getCalls('/me/pt-bookings').length).toBeGreaterThan(bookingsBefore));
    const card = await bookingCard();
    expect(within(card).getByText('Đã đặt')).toBeDefined();
    await waitFor(() => expect(within(card).queryByRole('button', { name: 'Hủy lịch' })).toBeNull());
  });

  it('US-29-TC04: server trả 409 VERSION_CONFLICT → báo tải lại, lịch được tải lại; lần hủy sau gửi version mới và key mới', async () => {
    let first = true;
    onPost = async () => {
      if (first) {
        first = false;
        // Booking vừa đổi gói sau nâng cấp: version tăng.
        bookings = [booking({ version: 1, membershipId: 'f'.repeat(24) })];
        throw apiError(409, 'VERSION_CONFLICT');
      }
      bookings = [booking({ status: 'CANCELLED', version: 2, cancelAllowed: false })];
      return { ...cancelled(), version: 2 };
    };
    const dialog = await openCancel();
    const bookingsBefore = getCalls('/me/pt-bookings').length;

    await userEvent.click(confirmButton(dialog));

    expect((await screen.findByRole('alert')).textContent).toMatch(/tải lại/i);
    await waitFor(() => expect(getCalls('/me/pt-bookings').length).toBeGreaterThan(bookingsBefore));
    expect(within(await myBookings()).getAllByRole('article')).toHaveLength(1);

    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Lịch của tôi' })).getByRole('button', { name: 'Hủy lịch' })).toBeDefined());
    await userEvent.click(within(await bookingCard()).getByRole('button', { name: 'Hủy lịch' }));
    const again = await confirmRegion();
    fireEvent.change(within(again).getByLabelText('Lý do hủy'), { target: { value: REASON } });
    await userEvent.click(confirmButton(again));

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].body.version).toBe(1);
    expect(posts[1].key).not.toBe(posts[0].key);
  });
});
