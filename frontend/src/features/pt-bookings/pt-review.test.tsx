// Tầng kiểm thử frontend (Vitest, jsdom): US-65 bước 3 – Member gửi và xem đánh giá buổi PT trên trang /member/pt-bookings.
// Kiểm tra nút theo reviewState, chọn sao + nhận xét, xem trước + cảnh báo không sửa, gửi đúng body + Idempotency-Key, hiện review gốc,
// trùng thì tải bản đã gửi, mất phản hồi giữ key, nhận xét hiển thị dạng chữ thường, đang tải/mất mạng (TC01, TC04–TC07, TC11, TC12).
// Hợp đồng test đặt ra cho Builder (US-65 bước 3, theo đoạn "UI lịch cá nhân" mục 2 của spec, dựa trên trang US-27/29 đã có):
//   Trong vùng "Lịch của tôi", mỗi <article> buổi dùng reviewState từ server (trang KHÔNG gọi GET review lúc tải):
//     ELIGIBLE → nút "Đánh giá". SUBMITTED → nút "Xem đánh giá", không có "Đánh giá". NOT_ELIGIBLE/không có → không nút nào.
//   Bấm "Đánh giá" mở <section aria-labelledby> tiêu đề "Đánh giá buổi PT": tên PT, ngày buổi; 5 ô radio tên bắt đầu "1 sao"…"5 sao"
//     (mỗi mức có nhãn chữ), ô <textarea> nhãn chứa "Nhận xét" (không bắt buộc), nút "Xem trước" (khóa khi chưa chọn sao
//     hoặc nhận xét sau trim > 1000 ký tự) và "Đóng".
//   "Xem trước" hiện số sao đã chọn, nội dung nhận xét và cảnh báo "không thể sửa" sau khi gửi; nút "Xác nhận gửi" và "Quay lại".
//   "Xác nhận gửi" gọi POST /me/pt-bookings/:id/review qua apiClient, body CHỈ {rating, comment} (rating là số), header Idempotency-Key UUID.
//     Đang gửi thì nút khóa (không gửi kép).
//   Thành công: role="status" có "Đã gửi đánh giá"; vùng "Đánh giá của bạn" hiện review gốc server trả (số sao, nhận xét, ngày gửi giờ VN);
//     tải lại lịch của tôi.
//   409 REVIEW_ALREADY_EXISTS: gọi GET /me/pt-bookings/:id/review và hiện bản đã gửi trong "Đánh giá của bạn"; không gửi POST khác.
//   409 BOOKING_NOT_COMPLETED: role="alert", tải lại lịch.
//   Mất phản hồi/503: role="alert", giữ bảng xem trước, không tự gửi lại; bấm "Xác nhận gửi" lần nữa dùng LẠI key và body cũ.
//   "Xem đánh giá": GET /me/pt-bookings/:id/review; đang tải hiện "Đang tải"; hiện "Đánh giá của bạn"; không có nút Sửa/Xóa, không ô nhập.
//   Lỗi mạng khi tải review: role="alert", không hiện "Đã gửi đánh giá".
//   Nhận xét hiển thị dạng chữ thường (React escape), HTML không thành thẻ.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import type { AuthSnapshot, AuthUser } from '../auth/auth.types';
import { PtBookingsPage } from './PtBookingsPage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const member: AuthUser = { id: 'a'.repeat(24), fullName: 'Hội viên A', phone: '+84901234567', roleCode: 'MEMBER' };
const asOf = '2026-11-14T03:05:00.000Z';
const BOOKING_ID = 'd'.repeat(24);
const REVIEW_ID = 'e'.repeat(24);
const MEMBERSHIP_ID = 'b'.repeat(24);
const trainerA = { id: '1'.repeat(24), displayName: 'PT Trần Văn Bình', specialty: 'Thể hình' };
// Buổi 09:00–10:00 ngày 12/11/2026 giờ VN, đã hoàn tất.
const START = '2026-11-12T02:00:00.000Z';
// Gửi lúc 10:30 14/11/2026 giờ VN.
const CREATED_AT = '2026-11-14T03:30:00.000Z';

type Booking = Record<string, unknown> & { id: string; status: string; reviewState?: string; reviewId?: string };
type PostCall = { path: string; body: Record<string, unknown>; key: string | null };
type Review = { id: string; bookingId: string; trainerId: string; rating: number; comment: string; createdAt: string };

const booking = (extra: Partial<Booking> = {}): Booking => ({
  id: BOOKING_ID, membershipId: MEMBERSHIP_ID, trainerId: trainerA.id, trainerName: trainerA.displayName, shiftId: 'c'.repeat(24),
  startAt: START, endAt: new Date(Date.parse(START) + 3600000).toISOString(), location: 'Phòng PT 1', status: 'COMPLETED', version: 1,
  cancelAllowed: false, reviewState: 'ELIGIBLE', ...extra,
});
const review = (extra: Partial<Review> = {}): Review => ({
  id: REVIEW_ID, bookingId: BOOKING_ID, trainerId: trainerA.id, rating: 4, comment: 'PT hướng dẫn kỹ', createdAt: CREATED_AT, ...extra,
});
const ptMembership = () => ({
  id: MEMBERSHIP_ID, planName: 'PT 10 buổi', kind: 'PT', storedStatus: 'ACTIVE', timeState: 'CURRENT', startDate: '2026-11-01', endDate: '2026-12-31',
  sessionsQuota: 10, sessionsUsed: 3, sessionsReserved: 0, sessionsAvailable: 7,
});

// ---------- Server giả ở tầng apiClient ----------
let snapshot: AuthSnapshot;
let bookings: Booking[];
let posts: PostCall[];
let onPost: (call: PostCall) => Promise<unknown>;
let onGetReview: () => Promise<unknown>;
let requestSpy: ReturnType<typeof vi.fn>;

const page = <T,>(items: T[]) => ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0, asOf });
const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

async function fakeServer(path: string, init: RequestInit = {}): Promise<unknown> {
  const [route] = path.split('?');
  if (init.method === 'POST' && /^\/me\/pt-bookings\/[^/]+\/review$/.test(route)) {
    const call = { path: route, body: JSON.parse(String(init.body)) as Record<string, unknown>, key: headerOf(init, 'Idempotency-Key') };
    posts.push(call);
    return onPost(call);
  }
  if (init.method && init.method !== 'GET') throw new Error(`Không có trong spec: ${init.method} ${path}`);
  if (/^\/me\/pt-bookings\/[^/]+\/review$/.test(route)) return onGetReview();
  if (route === '/me/pt-bookings') return { memberLinked: true, ...page(bookings) };
  if (route === '/me/pt-trainers') return page([trainerA]);
  const match = /^\/me\/pt-trainers\/([^/]+)\/availability$/.exec(route);
  if (match) return { trainerId: match[1], memberLinked: true, asOf, slots: [] };
  if (route === '/me/memberships') return { memberLinked: true, ...page([ptMembership()]) };
  if (route.startsWith('/me/notifications')) return { items: [], unreadCount: 0, asOf };
  throw new Error(`Đường dẫn không có trong spec: ${path}`);
}

const apiError = (status: number, code: string) => new ApiError('Lỗi', status, 'req-1', undefined, undefined, code);

beforeEach(() => {
  snapshot = { status: 'authenticated', user: member };
  bookings = [booking()];
  posts = [];
  onPost = async call => {
    // Server commit: lần tải lại sau buổi này là SUBMITTED.
    bookings = [booking({ reviewState: 'SUBMITTED', reviewId: REVIEW_ID })];
    return review({ rating: Number(call.body.rating), comment: String(call.body.comment ?? '').trim() });
  };
  onGetReview = async () => ({ review: review(), canReview: false });
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
  .map(call => String(call[0])).filter(path => path.split('?')[0] === prefix);
const bookingCard = async () => within(await screen.findByRole('region', { name: 'Lịch của tôi' })).findByRole('article');
const formRegion = () => screen.findByRole('region', { name: 'Đánh giá buổi PT' });
const reviewRegion = () => screen.findByRole('region', { name: 'Đánh giá của bạn' });
const button = (scope: HTMLElement, name: string) => within(scope).getByRole('button', { name }) as HTMLButtonElement;

// Mở form đánh giá, chọn sao và nhập nhận xét.
async function openForm(rating: number | null = 4, comment = '') {
  renderPage();
  await userEvent.click(within(await bookingCard()).getByRole('button', { name: 'Đánh giá' }));
  const form = await formRegion();
  if (rating !== null) await userEvent.click(within(form).getByRole('radio', { name: new RegExp(`^${rating} sao`) }));
  if (comment) fireEvent.change(within(form).getByLabelText(/Nhận xét/), { target: { value: comment } });
  return form;
}
// Mở form rồi bấm "Xem trước".
async function openPreview(rating = 4, comment = '') {
  const form = await openForm(rating, comment);
  await userEvent.click(button(form, 'Xem trước'));
  await within(form).findByRole('button', { name: 'Xác nhận gửi' });
  return form;
}

describe('US-65 bước 3: Member gửi và xem đánh giá buổi PT trên trang /member/pt-bookings', () => {
  // ---------- TC04: nút theo reviewState từ server ----------

  it('US-65-TC04: buổi COMPLETED reviewState ELIGIBLE → có nút "Đánh giá"; trang không gọi GET review lúc tải', async () => {
    renderPage();
    const card = await bookingCard();

    expect(within(card).getByRole('button', { name: 'Đánh giá' })).toBeDefined();
    expect(within(card).queryByRole('button', { name: 'Xem đánh giá' })).toBeNull();
    expect(getCalls(`/me/pt-bookings/${BOOKING_ID}/review`)).toHaveLength(0);
  });

  it.each([
    ['BOOKED', 'NOT_ELIGIBLE'],
    ['CANCELLED', 'NOT_ELIGIBLE'],
    ['COMPLETED', undefined],
  ])('US-65-TC04: buổi %s reviewState %s → không có nút "Đánh giá" hay "Xem đánh giá"', async (status, reviewState) => {
    bookings = [booking({ status, reviewState })];
    renderPage();
    const card = await bookingCard();

    expect(within(card).queryByRole('button', { name: 'Đánh giá' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Xem đánh giá' })).toBeNull();
  });

  it('US-65-TC04: gói đã hết hạn sau buổi nhưng server báo ELIGIBLE → vẫn có nút "Đánh giá" (không tự chặn theo gói)', async () => {
    vi.spyOn(apiClient, 'request').mockImplementation(((path: string, init?: RequestInit) => {
      if (path.split('?')[0] === '/me/memberships') {
        return Promise.resolve({ memberLinked: true, ...page([{ ...ptMembership(), storedStatus: 'EXPIRED', timeState: 'PAST', endDate: '2026-11-13' }]) });
      }
      return fakeServer(path, init);
    }) as never);
    renderPage();

    expect(within(await bookingCard()).getByRole('button', { name: 'Đánh giá' })).toBeDefined();
  });

  it('US-65-TC07: buổi SUBMITTED → có nút "Xem đánh giá", không có nút "Đánh giá"', async () => {
    bookings = [booking({ reviewState: 'SUBMITTED', reviewId: REVIEW_ID })];
    renderPage();
    const card = await bookingCard();

    expect(within(card).getByRole('button', { name: 'Xem đánh giá' })).toBeDefined();
    expect(within(card).queryByRole('button', { name: 'Đánh giá' })).toBeNull();
  });

  // ---------- TC01, TC05: form chọn sao, nhận xét, xem trước ----------

  it('US-65-TC01: bấm "Đánh giá" mở form có tên PT, ngày buổi, 5 mức sao kèm nhãn và ô nhận xét; "Đóng" không gửi gì', async () => {
    const form = await openForm(null);

    expect(within(form).getByText(new RegExp(trainerA.displayName))).toBeDefined();
    expect(within(form).getByText(/12\/11\/2026/)).toBeDefined();
    const radios = within(form).getAllByRole('radio');
    expect(radios).toHaveLength(5);
    for (let star = 1; star <= 5; star += 1) {
      // Mỗi mức có nhãn chữ sau con số (ví dụ "4 sao – Tốt"), không chỉ "4 sao".
      expect(within(form).getByRole('radio', { name: new RegExp(`^${star} sao\s*\S.*\p{L}`, 'u') })).toBeDefined();
    }
    expect(within(form).getByLabelText(/Nhận xét/)).toBeDefined();
    await userEvent.click(button(form, 'Đóng'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Đánh giá buổi PT' })).toBeNull());
    expect(posts).toHaveLength(0);
  });

  it('US-65-TC05: chưa chọn sao → nút "Xem trước" bị khóa, không gửi', async () => {
    const form = await openForm(null, 'Nhận xét');

    expect(button(form, 'Xem trước').disabled).toBe(true);
    expect(posts).toHaveLength(0);
  });

  it('US-65-TC05: nhận xét 1001 ký tự sau trim → nút "Xem trước" bị khóa; đúng 1000 ký tự (có khoảng trắng hai đầu) thì mở', async () => {
    const form = await openForm(4, 'a'.repeat(1001));
    expect(button(form, 'Xem trước').disabled).toBe(true);

    fireEvent.change(within(form).getByLabelText(/Nhận xét/), { target: { value: `  ${'a'.repeat(1000)}  ` } });
    await waitFor(() => expect(button(form, 'Xem trước').disabled).toBe(false));
    expect(posts).toHaveLength(0);
  });

  it('US-65-TC01: "Xem trước" hiện số sao, nhận xét và cảnh báo không thể sửa sau khi gửi; "Quay lại" không gửi', async () => {
    const form = await openPreview(4, 'PT hướng dẫn kỹ');

    expect(within(form).getByText(/4 sao/)).toBeDefined();
    expect(within(form).getByText(/PT hướng dẫn kỹ/)).toBeDefined();
    expect(within(form).getByText(/không thể sửa/i)).toBeDefined();
    await userEvent.click(button(form, 'Quay lại'));
    expect(within(form).getByRole('radio', { name: /^4 sao/ })).toBeDefined();
    expect(posts).toHaveLength(0);
  });

  // ---------- TC01, TC02, TC06: gửi đúng hợp đồng, hiện review gốc ----------

  it('US-65-TC01: "Xác nhận gửi" gọi POST /me/pt-bookings/:id/review chỉ với {rating, comment}, rating là số, Idempotency-Key UUID', async () => {
    const form = await openPreview(4, 'PT hướng dẫn kỹ');

    await userEvent.click(button(form, 'Xác nhận gửi'));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].path).toBe(`/me/pt-bookings/${BOOKING_ID}/review`);
    expect(Object.keys(posts[0].body).every(key => key === 'rating' || key === 'comment')).toBe(true);
    expect(posts[0].body.rating).toBe(4);
    expect(String(posts[0].body.comment).trim()).toBe('PT hướng dẫn kỹ');
    expect(posts[0].key).toMatch(UUID);
  });

  it('US-65-TC02: body gửi lên không có memberId/trainerId/status/createdAt (không viết thay)', async () => {
    const form = await openPreview(5);

    await userEvent.click(button(form, 'Xác nhận gửi'));

    await waitFor(() => expect(posts).toHaveLength(1));
    for (const key of ['memberId', 'trainerId', 'status', 'createdAt', 'bookingId']) expect(posts[0].body).not.toHaveProperty(key);
  });

  it('US-65-TC01: đang gửi thì nút "Xác nhận gửi" bị khóa, bấm nhiều lần chỉ gửi một yêu cầu', async () => {
    let release!: (value: unknown) => void;
    onPost = () => new Promise(resolve => { release = resolve; });
    const form = await openPreview();

    await userEvent.click(button(form, 'Xác nhận gửi'));
    await waitFor(() => expect(button(form, 'Xác nhận gửi').disabled).toBe(true));
    fireEvent.click(button(form, 'Xác nhận gửi'));
    expect(posts).toHaveLength(1);
    release(review());
  });

  it('US-65-TC01: thành công → "Đã gửi đánh giá", hiện review gốc server trả (sao, nhận xét, ngày gửi giờ VN), tải lại lịch', async () => {
    onPost = async () => {
      bookings = [booking({ reviewState: 'SUBMITTED', reviewId: REVIEW_ID })];
      // Server trả bản đã chuẩn hóa: dùng đúng bản này, không dùng chữ đang gõ trên form.
      return review({ rating: 4, comment: 'Bản gốc từ server' });
    };
    const form = await openPreview(4, 'Chữ đang gõ');
    const before = getCalls('/me/pt-bookings').length;

    await userEvent.click(button(form, 'Xác nhận gửi'));

    expect((await screen.findByRole('status')).textContent).toMatch(/Đã gửi đánh giá/);
    const shown = await reviewRegion();
    expect(within(shown).getByText(/4 sao/)).toBeDefined();
    expect(within(shown).getByText('Bản gốc từ server')).toBeDefined();
    expect(within(shown).getByText(/14\/11\/2026/)).toBeDefined();
    await waitFor(() => expect(getCalls('/me/pt-bookings').length).toBeGreaterThan(before));
    await waitFor(async () => expect(within(await bookingCard()).getByRole('button', { name: 'Xem đánh giá' })).toBeDefined());
  });

  it('US-65-TC06: không nhập nhận xét → vẫn gửi được, comment rỗng', async () => {
    const form = await openPreview(3);

    await userEvent.click(button(form, 'Xác nhận gửi'));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.comment ?? '').toBe('');
    expect(await screen.findByRole('status')).toBeDefined();
  });

  it('US-65-TC06: nhận xét có HTML hiển thị đúng dạng chữ, không thành thẻ (xem trước và review gốc)', async () => {
    const html = '<b>đậm</b><img src=x onerror="alert(1)">';
    onPost = async () => review({ comment: html });
    const form = await openPreview(4, html);

    expect(within(form).getByText(html)).toBeDefined();
    expect(form.querySelector('b, img')).toBeNull();
    await userEvent.click(button(form, 'Xác nhận gửi'));
    const shown = await reviewRegion();
    expect(within(shown).getByText(html)).toBeDefined();
    expect(shown.querySelector('b, img')).toBeNull();
  });

  // ---------- TC07: không sửa, trùng thì tải bản đã gửi ----------

  it('US-65-TC07: "Xem đánh giá" gọi GET review, hiện bản gốc; không có nút Sửa/Xóa, không có ô nhập', async () => {
    bookings = [booking({ reviewState: 'SUBMITTED', reviewId: REVIEW_ID })];
    onGetReview = async () => ({ review: review({ rating: 2, comment: 'Đến muộn' }), canReview: false });
    renderPage();

    await userEvent.click(within(await bookingCard()).getByRole('button', { name: 'Xem đánh giá' }));

    const shown = await reviewRegion();
    expect(getCalls(`/me/pt-bookings/${BOOKING_ID}/review`)).toHaveLength(1);
    expect(within(shown).getByText(/2 sao/)).toBeDefined();
    expect(within(shown).getByText('Đến muộn')).toBeDefined();
    expect(within(shown).queryByRole('button', { name: /Sửa|Xóa/ })).toBeNull();
    expect(within(shown).queryByRole('textbox')).toBeNull();
    expect(within(shown).queryByRole('radio')).toBeNull();
  });

  it('US-65-TC07: server trả 409 REVIEW_ALREADY_EXISTS → tải và hiện bản đã gửi, không gửi POST khác', async () => {
    onPost = async () => {
      bookings = [booking({ reviewState: 'SUBMITTED', reviewId: REVIEW_ID })];
      throw apiError(409, 'REVIEW_ALREADY_EXISTS');
    };
    onGetReview = async () => ({ review: review({ rating: 5, comment: 'Gửi từ máy khác' }), canReview: false });
    const form = await openPreview(3, 'Lần hai');

    await userEvent.click(button(form, 'Xác nhận gửi'));

    const shown = await reviewRegion();
    expect(within(shown).getByText('Gửi từ máy khác')).toBeDefined();
    expect(within(shown).getByText(/5 sao/)).toBeDefined();
    expect(getCalls(`/me/pt-bookings/${BOOKING_ID}/review`).length).toBeGreaterThan(0);
    expect(posts).toHaveLength(1);
  });

  it('US-65-TC04: server trả 409 BOOKING_NOT_COMPLETED (vừa bị mở lại) → báo lỗi và tải lại lịch, không hiện thành công', async () => {
    onPost = async () => {
      bookings = [booking({ status: 'BOOKED', reviewState: 'NOT_ELIGIBLE' })];
      throw apiError(409, 'BOOKING_NOT_COMPLETED');
    };
    const form = await openPreview();
    const before = getCalls('/me/pt-bookings').length;

    await userEvent.click(button(form, 'Xác nhận gửi'));

    expect(await screen.findByRole('alert')).toBeDefined();
    await waitFor(() => expect(getCalls('/me/pt-bookings').length).toBeGreaterThan(before));
    expect(screen.queryByText(/Đã gửi đánh giá/)).toBeNull();
    await waitFor(async () => expect(within(await bookingCard()).queryByRole('button', { name: 'Đánh giá' })).toBeNull());
  });

  // ---------- TC11, TC12: mất phản hồi giữ key, đang tải/mất mạng ----------

  it.each([
    ['mất kết nối', () => new ApiError('Không kết nối được máy chủ')],
    ['503 OPERATION_OUTCOME_UNKNOWN', () => apiError(503, 'OPERATION_OUTCOME_UNKNOWN')],
  ])('US-65-TC11: %s → báo lỗi, giữ bảng xem trước, không tự gửi lại; bấm lại dùng đúng key và body cũ', async (_name, makeError) => {
    let first = true;
    onPost = async () => {
      if (first) { first = false; throw makeError(); }
      return review();
    };
    const form = await openPreview(4, 'PT hướng dẫn kỹ');

    await userEvent.click(button(form, 'Xác nhận gửi'));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText(/Đã gửi đánh giá/)).toBeNull();
    expect(button(form, 'Xác nhận gửi')).toBeDefined();
    expect(posts).toHaveLength(1);
    await userEvent.click(button(form, 'Xác nhận gửi'));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].key).toBe(posts[0].key);
    expect(posts[1].body).toEqual(posts[0].body);
  });

  it('US-65-TC12: đang tải đánh giá đã gửi → hiện "Đang tải"', async () => {
    bookings = [booking({ reviewState: 'SUBMITTED', reviewId: REVIEW_ID })];
    let release!: (value: unknown) => void;
    onGetReview = () => new Promise(resolve => { release = resolve; });
    renderPage();

    await userEvent.click(within(await bookingCard()).getByRole('button', { name: 'Xem đánh giá' }));

    expect(await screen.findByText(/Đang tải/)).toBeDefined();
    release({ review: review(), canReview: false });
    expect(await reviewRegion()).toBeDefined();
  });

  it('US-65-TC12: mất mạng khi tải đánh giá đã gửi → role="alert", không hiện thông báo thành công giả', async () => {
    bookings = [booking({ reviewState: 'SUBMITTED', reviewId: REVIEW_ID })];
    onGetReview = async () => { throw new ApiError('Không kết nối được máy chủ'); };
    renderPage();

    await userEvent.click(within(await bookingCard()).getByRole('button', { name: 'Xem đánh giá' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText(/Đã gửi đánh giá/)).toBeNull();
  });
});
