// Tầng kiểm thử frontend (Vitest, jsdom): US-64 bước 4 – trang /trainer/bookings cho PT xác nhận buổi đã dạy.
// Kiểm tra nút "Xác nhận đã dạy" theo permittedActions của server, bảng xác nhận nêu tác động số buổi, gửi đúng body + Idempotency-Key,
// giữ key khi mất phản hồi, 409 tải lại danh sách, buổi hoàn tất hiện giờ buổi và giờ xác nhận riêng (giờ VN), route chỉ TRAINER (TC15, F05, UI mục 3).
// Hợp đồng test đặt ra cho Builder (US-64 bước 4, theo đoạn UI mục 3 và GET /api/me/trainer-bookings bản 1.1 của spec):
//   File frontend/src/features/pt-bookings/TrainerBookingsPage.tsx, export TrainerBookingsPage; gọi API qua apiClient (pt-bookings.api.ts).
//   Trang có tiêu đề "Buổi dạy của tôi", hai ô <input type="date"> nhãn "Từ ngày", "Đến ngày" (mặc định hôm nay theo giờ VN).
//   Tải GET /me/trainer-bookings?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD; đổi ngày thì tải lại với ngày mới.
//   Vùng <section aria-labelledby> tên "Danh sách buổi dạy": mỗi buổi một <article> có tên hội viên, giờ buổi "HH:mm–HH:mm dd/mm/yyyy" (giờ VN)
//     và nhãn trạng thái (BOOKED "Đã đặt", COMPLETED "Đã hoàn tất", CANCELLED "Đã hủy"). Không có buổi → chữ "Chưa có buổi dạy".
//   Buổi COMPLETED có thêm dòng "Xác nhận lúc: HH:mm dd/mm/yyyy" (giờ VN) – tách riêng với giờ buổi.
//   Nút "Xác nhận đã dạy" CHỈ khi permittedActions có "COMPLETE" (không tự tính bằng đồng hồ máy người dùng).
//   Bấm nút mở <section aria-labelledby> tên "Xác nhận buổi đã dạy": tên hội viên, giờ buổi, câu có "trừ 1 buổi" (tác động số buổi của gói),
//     nút "Xác nhận" và "Đóng".
//   "Xác nhận" gọi POST /me/pt-bookings/:id/complete, body CHỈ {version}, header Idempotency-Key UUID; đang gửi thì nút khóa.
//   Thành công: role="status" có "Đã xác nhận", đóng bảng xác nhận, tải lại danh sách từ server.
//   Mất phản hồi/503: role="alert", bảng xác nhận giữ nguyên, không tự gửi lại; bấm "Xác nhận" lần nữa dùng LẠI key cũ.
//   409 (BOOKING_NOT_ENDED, BOOKING_ALREADY_COMPLETED, VERSION_CONFLICT, INVALID_BOOKING_STATE): role="alert" có "tải lại",
//     tự tải lại danh sách; lần xác nhận sau là ý định mới → key mới.
//   App.tsx: /trainer/bookings trong ProtectedRoute role TRAINER; trang chính PT có link "Buổi dạy của tôi"; role khác → "Không có quyền truy cập".
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import App from '../../App';
import type { AuthSnapshot, AuthUser } from '../auth/auth.types';
import { TrainerBookingsPage } from './TrainerBookingsPage';

// Không mở socket thật khi render cả App.
vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })), default: vi.fn() }));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const trainerUser: AuthUser = { id: 'a'.repeat(24), fullName: 'PT Lê Văn Cường', phone: '+84901234567', roleCode: 'TRAINER' };
const BOOKING_ID = 'd'.repeat(24);
// 09:00–10:00 ngày 25/11/2026 giờ VN.
const START = '2026-11-25T02:00:00.000Z';
const END = '2026-11-25T03:00:00.000Z';
// Xác nhận muộn: 08:30 ngày 26/11/2026 giờ VN.
const COMPLETED_AT = '2026-11-26T01:30:00.000Z';

type Item = Record<string, unknown> & { id: string; status: string; version: number; permittedActions: string[] };
type PostCall = { path: string; body: Record<string, unknown>; key: string | null };

const item = (extra: Partial<Item> = {}): Item => ({
  id: BOOKING_ID, memberName: 'Nguyễn Thị Hoa', startAt: START, endAt: END, status: 'BOOKED', version: 0, permittedActions: ['COMPLETE'], ...extra,
});
const completedResult = () => ({
  id: BOOKING_ID, status: 'COMPLETED', version: 1, completedAt: COMPLETED_AT, completionRevision: 1,
  membershipId: 'b'.repeat(24), sessionsUsed: 3, notificationState: 'STORED',
});
const apiError = (status: number, code: string) => new ApiError('Lỗi', status, 'req-1', undefined, undefined, code);

// ---------- Server giả ở tầng apiClient ----------
let snapshot: AuthSnapshot;
let items: Item[];
let posts: PostCall[];
let onPost: (call: PostCall) => Promise<unknown>;
let requestSpy: ReturnType<typeof vi.fn>;
const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

async function fakeServer(path: string, init: RequestInit = {}): Promise<unknown> {
  const [route] = path.split('?');
  if (init.method === 'POST' && /^\/me\/pt-bookings\/[^/]+\/complete$/.test(route)) {
    const call = { path: route, body: JSON.parse(String(init.body)) as Record<string, unknown>, key: headerOf(init, 'Idempotency-Key') };
    posts.push(call);
    return onPost(call);
  }
  if (init.method && init.method !== 'GET') throw new Error(`Không có trong spec: ${init.method} ${path}`);
  if (route === '/me/trainer-bookings') return { items };
  if (route.startsWith('/me/notifications') || route.startsWith('/notifications')) return { items: [], unreadCount: 0 };
  if (route.startsWith('/me/work-shifts')) return { items: [] };
  throw new Error(`Đường dẫn không có trong spec: ${path}`);
}

beforeEach(() => {
  snapshot = { status: 'authenticated', user: trainerUser };
  items = [item()];
  posts = [];
  onPost = async () => {
    // Server commit: buổi thành COMPLETED trong lần tải lại sau.
    items = [item({ status: 'COMPLETED', version: 1, permittedActions: [], completedAt: COMPLETED_AT })];
    return completedResult();
  };
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
  requestSpy = vi.fn(fakeServer);
  vi.spyOn(apiClient, 'request').mockImplementation(requestSpy as never);
  vi.spyOn(apiClient, 'requestOnce').mockImplementation(requestSpy as never);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

const renderPage = () => render(<MemoryRouter initialEntries={['/trainer/bookings']}><TrainerBookingsPage /></MemoryRouter>);
const listCalls = () => requestSpy.mock.calls
  .filter(call => !(call[1] as RequestInit | undefined)?.method || (call[1] as RequestInit).method === 'GET')
  .map(call => String(call[0])).filter(path => path.startsWith('/me/trainer-bookings'));
const listRegion = () => screen.findByRole('region', { name: 'Danh sách buổi dạy' });
const bookingCard = async () => within(await listRegion()).findByRole('article');
const confirmRegion = () => screen.findByRole('region', { name: 'Xác nhận buổi đã dạy' });

async function openConfirm() {
  renderPage();
  const card = await bookingCard();
  await userEvent.click(within(card).getByRole('button', { name: 'Xác nhận đã dạy' }));
  return confirmRegion();
}
const confirmButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Xác nhận' }) as HTMLButtonElement;

// =====================================================================
// Danh sách buổi dạy
// =====================================================================
describe('US-64 bước 4: danh sách buổi dạy của PT', () => {
  it('US-64-TC15: trang tải GET /me/trainer-bookings với fromDate/toDate dạng YYYY-MM-DD; có ô "Từ ngày", "Đến ngày"', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Buổi dạy của tôi' })).toBeDefined();
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    const params = new URLSearchParams(listCalls()[0].split('?')[1]);
    expect(params.get('fromDate')).toMatch(DATE);
    expect(params.get('toDate')).toMatch(DATE);
    expect(screen.getByLabelText('Từ ngày')).toBeDefined();
    expect(screen.getByLabelText('Đến ngày')).toBeDefined();
  });

  it('US-64-TC15: đổi "Từ ngày"/"Đến ngày" → tải lại với ngày mới', async () => {
    renderPage();
    await bookingCard();

    fireEvent.change(screen.getByLabelText('Từ ngày'), { target: { value: '2026-11-20' } });
    fireEvent.change(screen.getByLabelText('Đến ngày'), { target: { value: '2026-11-27' } });

    await waitFor(() => expect(listCalls().some(path => path.includes('fromDate=2026-11-20') && path.includes('toDate=2026-11-27'))).toBe(true));
  });

  it('US-64-TC15: thẻ buổi hiện tên hội viên, giờ buổi theo giờ VN "09:00–10:00 25/11/2026" và nhãn "Đã đặt"', async () => {
    renderPage();
    const card = await bookingCard();

    expect(within(card).getByText(/Nguyễn Thị Hoa/)).toBeDefined();
    expect(card.textContent).toContain('09:00–10:00 25/11/2026');
    expect(card.textContent).toContain('Đã đặt');
  });

  it('US-64-TC15: buổi hoàn tất muộn hiện giờ buổi và dòng "Xác nhận lúc: 08:30 26/11/2026" riêng; nhãn "Đã hoàn tất"; không có nút xác nhận', async () => {
    items = [item({ status: 'COMPLETED', version: 1, permittedActions: [], completedAt: COMPLETED_AT })];
    renderPage();
    const card = await bookingCard();

    expect(card.textContent).toContain('09:00–10:00 25/11/2026');
    expect(card.textContent).toContain('Xác nhận lúc: 08:30 26/11/2026');
    expect(card.textContent).toContain('Đã hoàn tất');
    expect(within(card).queryByRole('button', { name: 'Xác nhận đã dạy' })).toBeNull();
  });

  it('US-64-TC15: nút "Xác nhận đã dạy" theo permittedActions của server: có COMPLETE thì hiện, rỗng thì ẩn (buổi BOOKED chưa tới giờ)', async () => {
    items = [item(), item({ id: 'e'.repeat(24), memberName: 'Trần Văn Nam', permittedActions: [] })];
    renderPage();
    const region = await listRegion();
    const cards = await within(region).findAllByRole('article');

    expect(within(cards[0]).getByRole('button', { name: 'Xác nhận đã dạy' })).toBeDefined();
    expect(within(cards[1]).queryByRole('button', { name: 'Xác nhận đã dạy' })).toBeNull();
    expect(cards[1].textContent).toContain('Đã đặt');
  });

  it('US-64-TC15: buổi CANCELLED nhãn "Đã hủy", không có nút xác nhận', async () => {
    items = [item({ status: 'CANCELLED', permittedActions: [] })];
    renderPage();
    const card = await bookingCard();

    expect(card.textContent).toContain('Đã hủy');
    expect(within(card).queryByRole('button', { name: 'Xác nhận đã dạy' })).toBeNull();
  });

  it('US-64-TC15: không có buổi nào → "Chưa có buổi dạy"', async () => {
    items = [];
    renderPage();

    expect(await screen.findByText(/Chưa có buổi dạy/)).toBeDefined();
  });
});

// =====================================================================
// Xác nhận đã dạy
// =====================================================================
describe('US-64 bước 4: xác nhận buổi đã dạy', () => {
  it('US-64-TC15: bảng xác nhận có tên hội viên, giờ buổi và nêu rõ "trừ 1 buổi" của gói; "Đóng" thì không gửi gì', async () => {
    const dialog = await openConfirm();

    expect(dialog.textContent).toContain('Nguyễn Thị Hoa');
    expect(dialog.textContent).toContain('09:00–10:00 25/11/2026');
    expect(dialog.textContent).toMatch(/trừ 1 buổi/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Đóng' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Xác nhận buổi đã dạy' })).toBeNull());
    expect(posts).toEqual([]);
  });

  it('US-64-TC15: "Xác nhận" gửi POST /me/pt-bookings/:id/complete body CHỈ {version} và Idempotency-Key UUID', async () => {
    const dialog = await openConfirm();

    await userEvent.click(confirmButton(dialog));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].path).toBe(`/me/pt-bookings/${BOOKING_ID}/complete`);
    expect(posts[0].body).toEqual({ version: 0 });
    expect(posts[0].key).toMatch(UUID);
  });

  it('US-64-TC15: đang gửi thì nút "Xác nhận" bị khóa, bấm nhiều lần chỉ gửi một request', async () => {
    let release: (value: unknown) => void = () => {};
    onPost = () => new Promise(resolve => { release = resolve; });
    const dialog = await openConfirm();

    await userEvent.click(confirmButton(dialog));
    await waitFor(() => expect(confirmButton(dialog).disabled).toBe(true));
    fireEvent.click(confirmButton(dialog));
    release(completedResult());

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Xác nhận buổi đã dạy' })).toBeNull());
    expect(posts).toHaveLength(1);
  });

  it('US-64-TC15: thành công → role="status" "Đã xác nhận", đóng bảng xác nhận, tải lại danh sách và thẻ chuyển "Đã hoàn tất"', async () => {
    const dialog = await openConfirm();
    const before = listCalls().length;

    await userEvent.click(confirmButton(dialog));

    expect((await screen.findByRole('status')).textContent).toContain('Đã xác nhận');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Xác nhận buổi đã dạy' })).toBeNull());
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(before));
    await waitFor(async () => expect((await bookingCard()).textContent).toContain('Đã hoàn tất'));
  });

  it.each([
    ['mất kết nối', () => new ApiError('Không kết nối được máy chủ')],
    ['503 chưa rõ kết quả', () => apiError(503, 'OPERATION_OUTCOME_UNKNOWN')],
  ])('US-64-TC15 (mất response giữ key): %s → role="alert", bảng xác nhận giữ nguyên, không tự gửi lại; bấm lại dùng LẠI key cũ', async (_label, makeError) => {
    onPost = async () => { throw makeError(); };
    const dialog = await openConfirm();

    await userEvent.click(confirmButton(dialog));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(await confirmRegion()).toBeDefined();
    expect(posts).toHaveLength(1);
    onPost = async () => completedResult();
    await userEvent.click(confirmButton(await confirmRegion()));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].key).toBe(posts[0].key);
  });

  it.each(['BOOKING_NOT_ENDED', 'BOOKING_ALREADY_COMPLETED', 'VERSION_CONFLICT', 'INVALID_BOOKING_STATE'])(
    'US-64-TC15: 409 %s → role="alert" có "tải lại", tự tải lại danh sách, thẻ buổi vẫn còn; lần xác nhận sau dùng key mới', async code => {
      onPost = async () => { throw apiError(409, code); };
      const dialog = await openConfirm();
      const before = listCalls().length;

      await userEvent.click(confirmButton(dialog));

      expect((await screen.findByRole('alert')).textContent).toMatch(/tải lại/i);
      await waitFor(() => expect(listCalls().length).toBeGreaterThan(before));
      const card = await bookingCard();
      expect(card).toBeDefined();
      await userEvent.click(within(card).getByRole('button', { name: 'Xác nhận đã dạy' }));
      await userEvent.click(confirmButton(await confirmRegion()));
      await waitFor(() => expect(posts).toHaveLength(2));
      expect(posts[1].key).not.toBe(posts[0].key);
    });
});

// =====================================================================
// Route /trainer/bookings
// =====================================================================
describe('US-64 bước 4: route /trainer/bookings', () => {
  it('US-64-TC15: TRAINER mở /trainer/bookings trong App → trang "Buổi dạy của tôi" và tải danh sách', async () => {
    window.history.pushState({}, '', '/trainer/bookings');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Buổi dạy của tôi' })).toBeDefined();
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
  });

  it('US-64-TC15: trang chính của PT có link "Buổi dạy của tôi" tới /trainer/bookings', async () => {
    window.history.pushState({}, '', '/trainer');
    render(<App />);

    const link = await screen.findByRole('link', { name: 'Buổi dạy của tôi' });
    expect(link.getAttribute('href')).toBe('/trainer/bookings');
  });

  it.each(['MEMBER', 'STAFF', 'ADMIN'] as const)('US-64-TC15: %s gõ thẳng /trainer/bookings → "Không có quyền truy cập", không gọi /me/trainer-bookings', async role => {
    snapshot = { status: 'authenticated', user: { ...trainerUser, roleCode: role } };
    window.history.pushState({}, '', '/trainer/bookings');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Không có quyền truy cập' })).toBeDefined();
    expect(listCalls()).toEqual([]);
  });
});
