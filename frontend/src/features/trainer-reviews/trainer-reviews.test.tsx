// Tầng kiểm thử frontend (Vitest, jsdom): US-31 bước 3 – trang /trainer/reviews cho PT xem đánh giá của học viên.
// Kiểm tra lọc kỳ/điểm, số lượt và điểm trung bình, danh sách, rỗng/đang tải/lỗi/thử lại, hiện nhận xét như chữ thường,
// chỉ đọc, mở chi tiết buổi qua API kiểm owner, đổi account/đăng xuất xóa cache, route chỉ TRAINER (TC09, TC11, TC12; giao diện của TC07, TC10).
// Hợp đồng test đặt ra cho Builder (US-31 bước 3, theo đoạn "UI /trainer/reviews" mục 2 của spec, API bước 1–2 đã có):
//   File frontend/src/features/trainer-reviews/TrainerReviewsPage.tsx, export TrainerReviewsPage; gọi API qua apiClient.request
//   (trainer-reviews.api.ts cùng thư mục). CHỈ GET tới /me/trainer-reviews..., không gửi trainerId/accountId. Tiêu đề h1 "Đánh giá của học viên".
//   Bộ lọc: ô ngày nhãn "Từ ngày", "Đến ngày" (YYYY-MM-DD), ô chọn nhãn "Điểm" (giá trị '' = tất cả, '1'…'5'), nút "Lọc"
//     → GET /me/trainer-reviews?fromDate&toDate&rating&page=1 (field để trống thì không gửi). Lần đầu không gửi fromDate/toDate/rating.
//   Vùng <section aria-labelledby> tên "Tổng quan đánh giá": "Số lượt: <reviewCount>", "Điểm trung bình: <averageRating làm tròn 2 số lẻ>"
//     (4.5 → "4.50"); lấy NGUYÊN summary của server, không tự tính từ trang đang xem. averageRating=null → không hiện số 0.
//   Vùng <section aria-labelledby> tên "Danh sách đánh giá": mỗi review một <article> theo thứ tự server trả, có tên học viên
//     (memberDisplayName), "Điểm: <rating>/5", nhận xét, "Gửi lúc HH:mm dd/mm/yyyy" (createdAt, giờ VN),
//     "Buổi tập: HH:mm–HH:mm dd/mm/yyyy" (booking.startAt–endAt, giờ VN) và nút "Xem chi tiết".
//     totalPages > page → nút "Trang sau" → GET page tiếp theo.
//   Không có review → chữ "Chưa có đánh giá". profileLinked=false → chữ có "chưa được liên kết hồ sơ PT" (không phải lỗi).
//   Đang tải → chữ "Đang tải". Lỗi mạng/503 → role="alert" + nút "Thử lại"; KHÔNG hiện "Chưa có đánh giá".
//   "Xem chi tiết" → GET /me/trainer-reviews/:id (server kiểm owner lại) → vùng <section aria-labelledby> tên "Chi tiết đánh giá"
//     có "Mã buổi: <booking.id>" và giờ buổi. 404 → role="alert" có "Không tìm thấy đánh giá", không giữ chi tiết cũ.
//   Chỉ đọc (F04): không có nút sửa/xóa/ẩn/trả lời; không gửi request khác GET.
//   Tên/nhận xét chứa HTML hiện như chữ thường, không chèn thẻ (F04, TC09).
//   apiClient.subscribe báo đổi account hoặc đăng xuất → xóa ngay dữ liệu account cũ rồi tải lại theo account mới (TC11).
//   App.tsx: /trainer/reviews trong ProtectedRoute role TRAINER; trang chính PT có link "Đánh giá của học viên"; role khác → "Không có quyền truy cập".
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import App from '../../App';
import type { AuthSnapshot, AuthUser } from '../auth/auth.types';
import { TrainerReviewsPage } from './TrainerReviewsPage';

// Không mở socket thật khi render cả App.
vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })), default: vi.fn() }));

const ptA: AuthUser = { id: 'a'.repeat(24), fullName: 'PT Lê Văn Cường', phone: '+84901234567', roleCode: 'TRAINER' };
const ptB: AuthUser = { id: 'b'.repeat(24), fullName: 'PT Trần Thị Dung', phone: '+84901234568', roleCode: 'TRAINER' };
// Buổi 09:00–10:00 ngày 18/11/2026 giờ VN; review gửi 10:05 ngày 20/11/2026 giờ VN.
const START = '2026-11-18T02:00:00.000Z';
const END = '2026-11-18T03:00:00.000Z';
const SENT = '2026-11-20T03:05:00.000Z';
const AS_OF = '2026-11-20T04:00:00.000Z';

type Review = {
  id: string; rating: number; comment: string; createdAt: string;
  booking: { id: string; startAt: string; endAt: string }; memberDisplayName: string;
};
type Summary = { reviewCount: number; averageRating: number | null };
type AccountData = { profileLinked: boolean; reviews: Review[]; summary?: Summary; totalPages?: number };

const reviewOf = (id: string, rating: number, comment: string, memberDisplayName: string, bookingId = id.replace(/./g, 'k')): Review => ({
  id, rating, comment, createdAt: SENT, booking: { id: bookingId, startAt: START, endAt: END }, memberDisplayName,
});
const notFound = () => new ApiError('Không tìm thấy', 404, 'req-404', undefined, undefined, 'NOT_FOUND');

// ---------- Server giả ở tầng apiClient ----------
let snapshot: AuthSnapshot;
let authListeners: Array<() => void>;
let dataByAccount: Record<string, AccountData>;
let failNext: Error | null;
let hold: Promise<void> | null;
let requestSpy: ReturnType<typeof vi.fn>;

async function fakeServer(path: string, init: RequestInit = {}): Promise<unknown> {
  if (hold) await hold;
  if (failNext) throw failNext;
  if (init.method && init.method !== 'GET') throw new Error(`Không có trong spec US-31: ${init.method} ${path}`);
  const [route, search = ''] = path.split('?');
  const params = new URLSearchParams(search);
  if (route.startsWith('/me/notifications') || route.startsWith('/notifications')) return { items: [], unreadCount: 0 };
  if (route.startsWith('/me/work-shifts') || route.startsWith('/me/trainer-bookings') || route.startsWith('/me/trainees')) return { items: [] };
  const user = snapshot.status === 'authenticated' ? snapshot.user : null;
  const data = user ? dataByAccount[user.id] : undefined;
  if (!data) throw new ApiError('Phiên không hợp lệ', 401, 'req-401');
  if (route === '/me/trainer-reviews') {
    const rating = params.get('rating');
    const items = rating ? data.reviews.filter(review => String(review.rating) === rating) : data.reviews;
    const sum = items.reduce((total, review) => total + review.rating, 0);
    return {
      profileLinked: data.profileLinked, items, page: Number(params.get('page') ?? '1'), limit: 20,
      total: items.length, totalPages: data.totalPages ?? (items.length ? 1 : 0), asOf: AS_OF,
      summary: data.summary ?? { reviewCount: items.length, averageRating: items.length ? sum / items.length : null },
    };
  }
  const match = /^\/me\/trainer-reviews\/([^/]+)$/.exec(route);
  if (match) {
    const found = data.reviews.find(review => review.id === match[1]);
    if (!found) throw notFound();
    return found;
  }
  throw new Error(`Đường dẫn không có trong spec US-31: ${path}`);
}

beforeEach(() => {
  snapshot = { status: 'authenticated', user: ptA };
  authListeners = [];
  dataByAccount = {
    [ptA.id]: {
      profileLinked: true,
      reviews: [
        reviewOf('1'.repeat(24), 5, 'PT nhiệt tình, chỉ kỹ thuật rõ', 'Nguyễn Thị Hoa'),
        reviewOf('2'.repeat(24), 4, 'Buổi tập ổn', 'Trần Văn Minh'),
      ],
    },
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

const renderPage = () => render(<MemoryRouter initialEntries={['/trainer/reviews']}><TrainerReviewsPage /></MemoryRouter>);
const reviewCalls = () => requestSpy.mock.calls.map(call => String(call[0])).filter(path => path.startsWith('/me/trainer-reviews'));
const lastListParams = () => new URLSearchParams(reviewCalls().filter(path => path.split('?')[0] === '/me/trainer-reviews').at(-1)!.split('?')[1] ?? '');
const listRegion = () => screen.findByRole('region', { name: 'Danh sách đánh giá' });
const summaryRegion = () => screen.findByRole('region', { name: 'Tổng quan đánh giá' });
const cards = async () => within(await listRegion()).findAllByRole('article');
const detailRegion = () => screen.findByRole('region', { name: 'Chi tiết đánh giá' });
const switchAccount = (next: AuthSnapshot) => act(() => {
  snapshot = next;
  for (const listener of [...authListeners]) listener();
});

async function openDetail(index = 0) {
  renderPage();
  const list = await cards();
  await userEvent.click(within(list[index]).getByRole('button', { name: 'Xem chi tiết' }));
  return detailRegion();
}

// =====================================================================
// Danh sách, tổng quan và bộ lọc (giao diện của TC05–TC07)
// =====================================================================
describe('US-31 bước 3: danh sách và tổng quan đánh giá', () => {
  it('US-31-TC07: trang tải GET /me/trainer-reviews, hiện mỗi review một thẻ: tên, điểm, nhận xét, giờ gửi, giờ buổi (giờ VN)', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Đánh giá của học viên' })).toBeDefined();
    const [first, second] = await cards();
    const text = first.textContent ?? '';
    expect(text).toContain('Nguyễn Thị Hoa');
    expect(text).toMatch(/Điểm:\s*5\/5/);
    expect(text).toContain('PT nhiệt tình, chỉ kỹ thuật rõ');
    expect(text).toContain('Gửi lúc 10:05 20/11/2026');
    expect(text).toContain('Buổi tập: 09:00–10:00 18/11/2026');
    expect(second.textContent).toContain('Trần Văn Minh');
    expect(reviewCalls()[0].split('?')[0]).toBe('/me/trainer-reviews');
  });

  it('US-31-TC07: điểm 4 và 5 → "Số lượt: 2", "Điểm trung bình: 4.50"', async () => {
    renderPage();

    const summary = await summaryRegion();
    await waitFor(() => expect(summary.textContent).toMatch(/Số lượt:\s*2/));
    expect(summary.textContent).toMatch(/Điểm trung bình:\s*4\.50/);
  });

  it('US-31-TC07: trung bình 4.3333… từ server → hiện "4.33"', async () => {
    dataByAccount[ptA.id].summary = { reviewCount: 3, averageRating: 13 / 3 };
    renderPage();

    const summary = await summaryRegion();
    await waitFor(() => expect(summary.textContent).toMatch(/Điểm trung bình:\s*4\.33/));
  });

  it('US-31-TC06: tổng quan lấy nguyên summary của server (25 lượt) dù trang chỉ có 2 dòng', async () => {
    dataByAccount[ptA.id].summary = { reviewCount: 25, averageRating: 4.2 };
    dataByAccount[ptA.id].totalPages = 2;
    renderPage();

    const summary = await summaryRegion();
    await waitFor(() => expect(summary.textContent).toMatch(/Số lượt:\s*25/));
    expect(summary.textContent).toMatch(/Điểm trung bình:\s*4\.20/);
  });

  it('US-31-TC07: không có review → "Chưa có đánh giá", số lượt 0 và KHÔNG hiện điểm trung bình 0', async () => {
    dataByAccount[ptA.id] = { profileLinked: true, reviews: [] };
    renderPage();

    expect(await screen.findByText('Chưa có đánh giá')).toBeDefined();
    expect(within(await listRegion()).queryAllByRole('article')).toHaveLength(0);
    const summary = await summaryRegion();
    expect(summary.textContent).toMatch(/Số lượt:\s*0/);
    expect(summary.textContent).not.toMatch(/Điểm trung bình:\s*0/);
  });

  it('US-31-TC05: chọn "Từ ngày", "Đến ngày", "Điểm" rồi bấm "Lọc" → gọi lại với fromDate, toDate, rating, page=1', async () => {
    renderPage();
    await cards();
    const first = lastListParams();
    expect(first.get('fromDate')).toBeNull();
    expect(first.get('toDate')).toBeNull();
    expect(first.get('rating')).toBeNull();

    fireEvent.change(screen.getByLabelText('Từ ngày'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('Đến ngày'), { target: { value: '2026-11-30' } });
    await userEvent.selectOptions(screen.getByLabelText('Điểm'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Lọc' }));

    await waitFor(() => expect(lastListParams().get('rating')).toBe('5'));
    const last = lastListParams();
    expect(last.get('fromDate')).toBe('2026-11-01');
    expect(last.get('toDate')).toBe('2026-11-30');
    expect(last.get('page')).toBe('1');
    await waitFor(async () => expect(await cards()).toHaveLength(1));
  });

  it('US-31-TC06: totalPages=2 → nút "Trang sau" gọi page=2', async () => {
    dataByAccount[ptA.id].totalPages = 2;
    renderPage();
    await cards();

    await userEvent.click(screen.getByRole('button', { name: 'Trang sau' }));

    await waitFor(() => expect(lastListParams().get('page')).toBe('2'));
  });

  it('US-31-TC04: profileLinked=false → báo chưa được liên kết hồ sơ PT, không phải lỗi, không hiện điểm 0', async () => {
    dataByAccount[ptA.id] = { profileLinked: false, reviews: [] };
    renderPage();

    expect(await screen.findByText(/chưa được liên kết hồ sơ PT/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Điểm trung bình:\s*0/);
  });

  it('US-31-TC11: đang tải hiện "Đang tải"', async () => {
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    renderPage();

    expect(await screen.findByText(/Đang tải/)).toBeDefined();
    release();
    hold = null;
    expect(await cards()).toHaveLength(2);
  });

  it('US-31-TC11: server 503 → role="alert" + "Thử lại", không hiện "Chưa có đánh giá"; thử lại thì tải được', async () => {
    failNext = new ApiError('Hệ thống tạm thời không sẵn sàng', 503, 'req-503', undefined, undefined, 'DATABASE_UNAVAILABLE');
    renderPage();

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText('Chưa có đánh giá')).toBeNull();

    failNext = null;
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await cards()).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('US-31-TC11: mất mạng → role="alert", không hiện "Chưa có đánh giá" hay số lượt 0', async () => {
    failNext = new TypeError('Failed to fetch');
    renderPage();

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText('Chưa có đánh giá')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Số lượt:\s*0/);
  });
});

// =====================================================================
// TC09, TC10: hiển thị an toàn và chỉ đọc
// =====================================================================
describe('US-31 bước 3: an toàn và chỉ đọc', () => {
  it('US-31-TC09: nhận xét và tên chứa script/HTML hiện như chữ thường, không chèn thẻ', async () => {
    const html = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    dataByAccount[ptA.id] = { profileLinked: true, reviews: [reviewOf('3'.repeat(24), 1, html, '<b>Hoa</b>')] };
    renderPage();

    const [card] = await cards();
    expect(within(card).getByText(html)).toBeDefined();
    expect(within(card).getByText('<b>Hoa</b>')).toBeDefined();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(card.querySelector('b')).toBeNull();
  });

  it('US-31-TC09: nhận xét chứa URL hiện như chữ, không thành link', async () => {
    const withUrl = 'Xem thêm tại https://evil.example/phishing';
    dataByAccount[ptA.id] = { profileLinked: true, reviews: [reviewOf('3'.repeat(24), 2, withUrl, 'Nguyễn Thị Hoa')] };
    renderPage();

    const [card] = await cards();
    expect(within(card).getByText(withUrl)).toBeDefined();
    expect(within(card).queryByRole('link')).toBeNull();
  });

  it('US-31-TC10: danh sách và chi tiết không có nút sửa/xóa/ẩn/trả lời; mọi request đều là GET, không gửi trainerId/accountId', async () => {
    const detail = await openDetail();
    await within(detail).findByText(/Mã buổi:/);

    const buttons = screen.queryAllByRole('button').map(button => button.textContent ?? '');
    for (const label of buttons) expect(label).not.toMatch(/sửa|xóa|ẩn|trả lời|phản hồi/i);
    for (const [path, init] of requestSpy.mock.calls as Array<[string, RequestInit | undefined]>) {
      expect(init?.method ?? 'GET').toBe('GET');
      expect(path).not.toMatch(/trainerId|accountId/);
    }
  });
});

// =====================================================================
// TC12: mở buổi từ review – API đích kiểm owner lại
// =====================================================================
describe('US-31 bước 3: mở chi tiết buổi từ review', () => {
  it('US-31-TC12: "Xem chi tiết" gọi GET /me/trainer-reviews/:id rồi hiện mã buổi và giờ buổi', async () => {
    const detail = await openDetail();

    expect(await within(detail).findByText(`Mã buổi: ${'k'.repeat(24)}`)).toBeDefined();
    expect(detail.textContent).toContain('09:00–10:00 18/11/2026');
    expect(reviewCalls().map(path => path.split('?')[0])).toContain(`/me/trainer-reviews/${'1'.repeat(24)}`);
  });

  it('US-31-TC12: server từ chối 404 (không còn thuộc PT này) → role="alert" "Không tìm thấy đánh giá", không giữ chi tiết cũ', async () => {
    const detail = await openDetail(0);
    await within(detail).findByText(`Mã buổi: ${'k'.repeat(24)}`);

    // Review thứ hai bị server từ chối (owner check ở API đích).
    dataByAccount[ptA.id].reviews = dataByAccount[ptA.id].reviews.slice(0, 1);
    const list = await cards();
    await userEvent.click(within(list[1]).getByRole('button', { name: 'Xem chi tiết' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Không tìm thấy đánh giá');
    await waitFor(() => expect(screen.queryByText(`Mã buổi: ${'k'.repeat(24)}`)).toBeNull());
  });
});

// =====================================================================
// TC11: đổi account / đăng xuất không lộ cache review của PT trước
// =====================================================================
describe('US-31 bước 3: cache theo account', () => {
  it('US-31-TC11: đổi sang PT khác → review của PT cũ biến mất ngay, rồi hiện review của PT mới', async () => {
    dataByAccount[ptB.id] = { profileLinked: true, reviews: [reviewOf('4'.repeat(24), 3, 'Nhận xét cho PT Dung', 'Phạm Thị Lan')] };
    await openDetail();

    // Request của PT mới bị giữ lại: trong lúc chờ, dữ liệu của PT cũ không được hiện nữa.
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    await switchAccount({ status: 'authenticated', user: ptB });
    await waitFor(() => expect(screen.queryByText(/PT nhiệt tình/)).toBeNull());
    expect(screen.queryByText(/Nguyễn Thị Hoa/)).toBeNull();
    expect(screen.queryByText(/Mã buổi:/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Số lượt:\s*2/);

    release();
    hold = null;
    expect(await screen.findByText('Nhận xét cho PT Dung')).toBeDefined();
  });

  it('US-31-TC11: đăng xuất → xóa ngay danh sách, tổng quan và chi tiết khỏi màn hình', async () => {
    await openDetail();

    await switchAccount({ status: 'anonymous', user: null });

    await waitFor(() => expect(screen.queryByText(/PT nhiệt tình/)).toBeNull());
    expect(screen.queryByText(/Trần Văn Minh/)).toBeNull();
    expect(screen.queryByText(/Mã buổi:/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Điểm trung bình:\s*4\.50/);
  });
});

// =====================================================================
// Route /trainer/reviews
// =====================================================================
describe('US-31 bước 3: route /trainer/reviews', () => {
  it('US-31-TC11: TRAINER mở /trainer/reviews trong App → trang "Đánh giá của học viên" và tải danh sách', async () => {
    window.history.pushState({}, '', '/trainer/reviews');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Đánh giá của học viên' })).toBeDefined();
    await waitFor(() => expect(reviewCalls().length).toBeGreaterThan(0));
  });

  it('US-31-TC11: trang chính của PT có link "Đánh giá của học viên" tới /trainer/reviews', async () => {
    window.history.pushState({}, '', '/trainer');
    render(<App />);

    const link = await screen.findByRole('link', { name: 'Đánh giá của học viên' });
    expect(link.getAttribute('href')).toBe('/trainer/reviews');
  });

  it.each(['MEMBER', 'STAFF', 'ADMIN'] as const)('US-31-TC03: %s gõ thẳng /trainer/reviews → "Không có quyền truy cập", không gọi /me/trainer-reviews', async role => {
    snapshot = { status: 'authenticated', user: { ...ptA, roleCode: role } };
    window.history.pushState({}, '', '/trainer/reviews');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Không có quyền truy cập' })).toBeDefined();
    expect(reviewCalls()).toEqual([]);
  });
});
