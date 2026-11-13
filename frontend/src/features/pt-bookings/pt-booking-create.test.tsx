// Tầng kiểm thử frontend (Vitest, jsdom): US-28 bước 4 – Member đặt slot PT ngay trên trang /member/pt-bookings.
// Kiểm tra bảng xác nhận PT/giờ/địa điểm/gói/số buổi còn, gửi đúng body + Idempotency-Key, giữ key khi pending/mất phản hồi,
// conflict thì tải lại giờ và quota rồi yêu cầu chọn lại, không giảm quota trước khi server commit (spec mục 3 "UI", TC01, TC05–TC07, TC10).
// Hợp đồng test đặt ra cho Builder (US-28 bước 4, dựa trên trang US-27 bước 3 đã có):
//   Trong vùng "Đặt lịch PT", khi đã chọn PT + ngày + gói, bấm một nút slot bookable (tên "HH:mm–HH:mm") mở vùng
//   <section aria-labelledby> tiêu đề "Xác nhận đặt lịch" hiện: tên PT, ngày dd/mm/yyyy, giờ HH:mm–HH:mm (giờ VN), địa điểm của slot,
//   tên gói và "Còn đặt được: a buổi" (số server). Nút "Xác nhận đặt" và "Đóng" (đóng không gửi gì).
//   "Xác nhận đặt" gọi POST /me/pt-bookings qua apiClient (file pt-bookings.api.ts), body JSON CHỈ {membershipId, trainerId, shiftId, startAt}
//     (startAt lấy nguyên từ slot, không gửi endAt/memberId/location), header Idempotency-Key UUID. Đang gửi thì nút bị khóa (không gửi kép).
//   Thành công: role="status" có "Đã đặt lịch", đóng bảng xác nhận, tải lại lịch của tôi, gói (quota) và giờ trống từ server.
//   Mất phản hồi (lỗi mạng) hoặc 503: role="alert", bảng xác nhận giữ nguyên, KHÔNG tự gửi lại; bấm "Xác nhận đặt" lần nữa dùng LẠI key cũ.
//   409 (SLOT_UNAVAILABLE, MEMBER_TIME_CONFLICT, QUOTA_EXHAUSTED, SHIFT_UNAVAILABLE, TRAINER_UNAVAILABLE, MEMBERSHIP_NOT_ELIGIBLE):
//     role="alert" có chữ "chọn lại", đóng bảng xác nhận, tự tải lại giờ trống và gói; không tự gửi slot khác, không đổi PT đang chọn.
//     Lần đặt sau đó là ý định mới → key mới.
//   Không giảm "Còn đặt được" trước khi server trả thành công.
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
const DAY = '2026-11-25';
const MEMBERSHIP_ID = 'b'.repeat(24);
const SHIFT_ID = 'c'.repeat(24);
const trainerA = { id: '1'.repeat(24), displayName: 'PT Trần Văn Bình', specialty: 'Thể hình' };
const trainerB = { id: '2'.repeat(24), displayName: 'PT Lê Thị Cúc', specialty: 'Yoga' };
// 08:00–09:00 và 09:00–10:00 ngày 25/11/2026 giờ VN.
const SLOT_8 = '2026-11-25T01:00:00.000Z';
const SLOT_9 = '2026-11-25T02:00:00.000Z';

type Membership = Record<string, unknown> & { id: string; sessionsAvailable: number };
type Slot = { shiftId: string; startAt: string; endAt: string; location: string; bookable: boolean; reason?: string };
type PostCall = { body: Record<string, unknown>; key: string | null };

const plus1h = (startAt: string) => new Date(Date.parse(startAt) + 3600000).toISOString();
const slot = (startAt: string): Slot => ({ shiftId: SHIFT_ID, startAt, endAt: plus1h(startAt), location: 'Phòng PT 2', bookable: true });
const ptMembership = (available: number): Membership => ({
  id: MEMBERSHIP_ID, planName: 'PT 10 buổi', kind: 'PT', storedStatus: 'ACTIVE', timeState: 'CURRENT', startDate: '2026-11-01', endDate: '2026-12-31',
  sessionsQuota: 10, sessionsUsed: 2, sessionsReserved: 8 - available, sessionsAvailable: available,
});

// ---------- Server giả ở tầng apiClient ----------
let snapshot: AuthSnapshot;
let membership: Membership;
let slots: Slot[];
let posts: PostCall[];
let onPost: (call: PostCall) => Promise<unknown>;
let requestSpy: ReturnType<typeof vi.fn>;

const page = <T,>(items: T[]) => ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0, asOf });

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

async function fakeServer(path: string, init: RequestInit = {}): Promise<unknown> {
  const [route, queryString] = path.split('?');
  const params = new URLSearchParams(queryString ?? '');
  if (init.method === 'POST' && route === '/me/pt-bookings') {
    const call = { body: JSON.parse(String(init.body)) as Record<string, unknown>, key: headerOf(init, 'Idempotency-Key') };
    posts.push(call);
    return onPost(call);
  }
  if (init.method && init.method !== 'GET') throw new Error(`Không có trong spec: ${init.method} ${path}`);
  if (route === '/me/pt-bookings') return { memberLinked: true, ...page([]) };
  if (route === '/me/pt-trainers') return page([trainerA, trainerB]);
  const match = /^\/me\/pt-trainers\/([^/]+)\/availability$/.exec(route);
  if (match) return { trainerId: match[1], memberLinked: true, asOf, slots };
  if (route === '/me/memberships') {
    // Lọc theo query như server thật (US-17): kind, storedStatus, timeState.
    const matches = (!params.get('kind') || membership.kind === params.get('kind'))
      && (!params.get('storedStatus') || membership.storedStatus === params.get('storedStatus'))
      && (!params.get('timeState') || membership.timeState === params.get('timeState'));
    return { memberLinked: true, ...page(matches ? [membership] : []) };
  }
  if (route.startsWith('/me/notifications')) return { items: [], unreadCount: 0, asOf };
  throw new Error(`Đường dẫn không có trong spec: ${path}`);
}

const created = (call: PostCall) => ({
  id: 'd'.repeat(24), memberId: 'e'.repeat(24), membershipId: call.body.membershipId, trainerId: call.body.trainerId, shiftId: call.body.shiftId,
  startAt: call.body.startAt, endAt: plus1h(String(call.body.startAt)), location: 'Phòng PT 2', status: 'BOOKED', version: 0, notificationState: 'STORED',
});
const conflict = (code: string) => new ApiError('Xung đột', 409, 'req-1', undefined, undefined, code);

beforeEach(() => {
  snapshot = { status: 'authenticated', user: member };
  membership = ptMembership(7);
  slots = [slot(SLOT_8), slot(SLOT_9)];
  posts = [];
  onPost = async call => {
    // Server commit: quota giảm và slot không còn trống trong lần tải lại sau.
    membership = ptMembership(6);
    slots = slots.filter(item => item.startAt !== call.body.startAt);
    return created(call);
  };
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
  requestSpy = vi.fn(fakeServer);
  vi.spyOn(apiClient, 'request').mockImplementation(requestSpy as never);
  vi.spyOn(apiClient, 'requestOnce').mockImplementation(requestSpy as never);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderPage = () => render(<MemoryRouter initialEntries={['/member/pt-bookings']}><PtBookingsPage /></MemoryRouter>);
const getCalls = (prefix: string) => requestSpy.mock.calls
  .filter(call => !(call[1] as RequestInit | undefined)?.method || (call[1] as RequestInit).method === 'GET')
  .map(call => String(call[0])).filter(path => path.startsWith(prefix));
const slotButton = (from: string, to: string) => screen.findByRole('button', { name: new RegExp(`${from}\\s*[–-]\\s*${to}`) });
const confirmRegion = () => screen.findByRole('region', { name: 'Xác nhận đặt lịch' });

// Chọn PT, ngày, gói trong vùng "Đặt lịch PT" (giống test US-27 bước 3).
async function choose(trainerName = trainerA.displayName) {
  const panel = await screen.findByRole('region', { name: 'Đặt lịch PT' });
  const trainerSelect = await within(panel).findByLabelText('Chọn PT');
  await within(trainerSelect).findByRole('option', { name: trainerName });
  await userEvent.selectOptions(trainerSelect, trainerName);
  fireEvent.change(within(panel).getByLabelText('Ngày'), { target: { value: DAY } });
  const planSelect = within(panel).getByLabelText('Gói PT');
  await within(planSelect).findByRole('option', { name: 'PT 10 buổi' });
  await userEvent.selectOptions(planSelect, 'PT 10 buổi');
  return panel;
}

// Mở bảng xác nhận cho slot 08:00–09:00.
async function openConfirm(from = '08:00', to = '09:00') {
  renderPage();
  await choose();
  await userEvent.click(await slotButton(from, to));
  return confirmRegion();
}

describe('US-28 bước 4: Member đặt slot PT trên trang /member/pt-bookings', () => {
  // ---------- Xác nhận trước khi đặt ----------

  it('US-28-TC01: bấm slot mở bảng xác nhận có PT, ngày, giờ VN, địa điểm, gói và số buổi còn đặt được (số server)', async () => {
    const dialog = await openConfirm();
    expect(within(dialog).getByText(new RegExp(trainerA.displayName))).toBeDefined();
    expect(within(dialog).getByText(/25\/11\/2026/)).toBeDefined();
    expect(within(dialog).getByText(/08:00\s*[–-]\s*09:00/)).toBeDefined();
    expect(within(dialog).getByText(/Phòng PT 2/)).toBeDefined();
    expect(within(dialog).getByText(/PT 10 buổi/)).toBeDefined();
    expect(within(dialog).getByText(/Còn đặt được: 7 buổi/)).toBeDefined();
    expect(posts).toHaveLength(0);
  });

  it('US-28-TC01: "Đóng" bảng xác nhận thì không gửi yêu cầu đặt nào', async () => {
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Đóng' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Xác nhận đặt lịch' })).toBeNull());
    expect(posts).toHaveLength(0);
  });

  // ---------- Gửi đúng hợp đồng ----------

  it('US-28-TC01: "Xác nhận đặt" gửi POST /me/pt-bookings chỉ với membershipId, trainerId, shiftId, startAt và Idempotency-Key UUID', async () => {
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận đặt' }));
    await waitFor(() => expect(posts).toHaveLength(1));

    expect(posts[0].body).toEqual({ membershipId: MEMBERSHIP_ID, trainerId: trainerA.id, shiftId: SHIFT_ID, startAt: SLOT_8 });
    expect(posts[0].key).toMatch(UUID);
  });

  it('US-28-TC01: thành công thì báo "Đã đặt lịch", đóng bảng xác nhận và tải lại lịch, gói, giờ trống; quota hiện theo số server mới', async () => {
    const dialog = await openConfirm();
    const before = { bookings: getCalls('/me/pt-bookings').length, memberships: getCalls('/me/memberships').length, slots: getCalls(`/me/pt-trainers/${trainerA.id}/availability`).length };
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận đặt' }));

    expect((await screen.findByRole('status')).textContent).toMatch(/Đã đặt lịch/);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Xác nhận đặt lịch' })).toBeNull());
    await waitFor(() => {
      expect(getCalls('/me/pt-bookings').length).toBeGreaterThan(before.bookings);
      expect(getCalls('/me/memberships').length).toBeGreaterThan(before.memberships);
      expect(getCalls(`/me/pt-trainers/${trainerA.id}/availability`).length).toBeGreaterThan(before.slots);
    });
    const panel = screen.getByRole('region', { name: 'Đặt lịch PT' });
    expect(await within(panel).findByText(/Còn đặt được: 6 buổi/)).toBeDefined();
  });

  // ---------- TC10: giữ key khi pending / mất phản hồi ----------

  it('US-28-TC10: đang gửi thì bấm "Xác nhận đặt" nhiều lần chỉ gửi một yêu cầu; chưa có kết quả thì quota vẫn là số cũ', async () => {
    let finish!: (value: unknown) => void;
    onPost = call => new Promise(resolve => { finish = () => resolve(created(call)); });
    const dialog = await openConfirm();
    const button = within(dialog).getByRole('button', { name: 'Xác nhận đặt' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(posts).toHaveLength(1));
    // Không giảm quota hiển thị trước khi server commit.
    expect(screen.queryByText(/Còn đặt được: 6 buổi/)).toBeNull();
    expect(screen.getAllByText(/Còn đặt được: 7 buổi/).length).toBeGreaterThan(0);
    finish(undefined);
    expect((await screen.findByRole('status')).textContent).toMatch(/Đã đặt lịch/);
    expect(posts).toHaveLength(1);
  });

  it.each([
    ['mất kết nối', () => new ApiError('Không kết nối được máy chủ')],
    ['503 OPERATION_OUTCOME_UNKNOWN', () => new ApiError('Chưa xác định được kết quả', 503, 'req-9', undefined, undefined, 'OPERATION_OUTCOME_UNKNOWN')],
    ['503 DB lỗi', () => new ApiError('Dịch vụ tạm thời không khả dụng', 503, 'req-8', undefined, undefined, 'SERVICE_UNAVAILABLE')],
  ])('US-28-TC10: %s → báo lỗi, giữ bảng xác nhận, không tự gửi lại; bấm lại dùng đúng key cũ', async (_label, makeError) => {
    const error = makeError();
    let failed = false;
    onPost = async call => {
      if (!failed) { failed = true; throw error; }
      membership = ptMembership(6);
      return created(call);
    };
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận đặt' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('region', { name: 'Xác nhận đặt lịch' })).toBeDefined();
    expect(screen.queryByText(/Còn đặt được: 6 buổi/)).toBeNull();
    // Không tự gửi lại.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(posts).toHaveLength(1);

    await userEvent.click(within(await confirmRegion()).getByRole('button', { name: 'Xác nhận đặt' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].key).toBe(posts[0].key);
    expect(posts[1].body).toEqual(posts[0].body);
    expect((await screen.findByRole('status')).textContent).toMatch(/Đã đặt lịch/);
  });

  // ---------- TC05–TC07: conflict tải lại và yêu cầu chọn lại ----------

  it.each(['SLOT_UNAVAILABLE', 'MEMBER_TIME_CONFLICT', 'QUOTA_EXHAUSTED', 'SHIFT_UNAVAILABLE', 'TRAINER_UNAVAILABLE', 'MEMBERSHIP_NOT_ELIGIBLE'])(
    'US-28-TC05: 409 %s → báo "chọn lại", đóng bảng xác nhận, tải lại giờ trống và gói; không tự gửi slot khác, giữ PT đang chọn',
    async code => {
      onPost = async () => {
        // Server: người khác vừa chiếm 08:00, quota cập nhật lại.
        slots = [slot(SLOT_9)];
        membership = ptMembership(5);
        throw conflict(code);
      };
      const dialog = await openConfirm();
      const before = { memberships: getCalls('/me/memberships').length, slots: getCalls(`/me/pt-trainers/${trainerA.id}/availability`).length };
      await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận đặt' }));

      expect((await screen.findByRole('alert')).textContent).toMatch(/chọn lại/i);
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Xác nhận đặt lịch' })).toBeNull());
      await waitFor(() => {
        expect(getCalls('/me/memberships').length).toBeGreaterThan(before.memberships);
        expect(getCalls(`/me/pt-trainers/${trainerA.id}/availability`).length).toBeGreaterThan(before.slots);
      });
      const panel = screen.getByRole('region', { name: 'Đặt lịch PT' });
      expect(await within(panel).findByText(/Còn đặt được: 5 buổi/)).toBeDefined();
      expect(within(panel).queryByRole('button', { name: /08:00\s*[–-]\s*09:00/ })).toBeNull();
      expect((within(panel).getByLabelText('Chọn PT') as HTMLSelectElement).value).toBe(trainerA.id);
      expect(posts).toHaveLength(1);
    },
  );

  it('US-28-TC05: sau conflict, chọn slot khác và đặt là ý định mới → dùng key mới', async () => {
    let first = true;
    onPost = async call => {
      if (first) { first = false; slots = [slot(SLOT_9)]; throw conflict('SLOT_UNAVAILABLE'); }
      return created(call);
    };
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận đặt' }));
    await screen.findByRole('alert');

    await userEvent.click(await slotButton('09:00', '10:00'));
    await userEvent.click(within(await confirmRegion()).getByRole('button', { name: 'Xác nhận đặt' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].body.startAt).toBe(SLOT_9);
    expect(posts[1].key).toMatch(UUID);
    expect(posts[1].key).not.toBe(posts[0].key);
  });

  it('US-28-TC01: đặt thành công rồi đặt slot khác là ý định mới → dùng key mới', async () => {
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận đặt' }));
    await screen.findByRole('status');

    await userEvent.click(await slotButton('09:00', '10:00'));
    await userEvent.click(within(await confirmRegion()).getByRole('button', { name: 'Xác nhận đặt' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].key).not.toBe(posts[0].key);
  });
});
