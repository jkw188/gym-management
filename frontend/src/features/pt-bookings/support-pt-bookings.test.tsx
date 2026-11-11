// Tầng kiểm thử frontend (Vitest, jsdom): US-29 bước 3 – trang hỗ trợ /staff/pt-bookings cho Staff/Admin.
// Kiểm tra tra cứu theo ngày/trạng thái, xem chi tiết, hủy hỗ trợ có lý do kể cả sát giờ/đã qua giờ, không có nút hoàn tất,
// giữ key khi mất phản hồi, 409 tải lại chi tiết, route chỉ cho STAFF (TC05, TC06, TC09, TC12).
// Hợp đồng test đặt ra cho Builder (US-29 bước 3, theo đoạn "UI hỗ trợ /staff/pt-bookings" mục 2 của spec):
//   src/features/pt-bookings/SupportPtBookingsPage.tsx: export function SupportPtBookingsPage(); h1 "Tra cứu lịch PT".
//   App.tsx khai báo /staff/pt-bookings trong ProtectedRoute role STAFF.
//   Form tra cứu: input date "Từ ngày", "Đến ngày", select "Trạng thái" (Tất cả/Đã đặt/Đã hoàn thành/Đã hủy), nút "Tìm"
//     → GET /pt-bookings?fromDate&toDate&status?&page&limit (qua apiClient, file pt-bookings.api.ts).
//   Vùng <section aria-labelledby> "Kết quả": mỗi buổi là <article> có mã + tên Member, tên PT, ngày dd/mm/yyyy, giờ HH:mm–HH:mm (VN),
//     nhãn trạng thái và nút "Chi tiết" → GET /pt-bookings/:id.
//   Vùng "Chi tiết lịch PT": mã + tên Member, tên PT, ngày giờ VN, địa điểm, trạng thái. Buổi BOOKED (kể cả sát giờ/đã qua giờ)
//     có nút "Hủy hỗ trợ" mở ô <textarea> "Lý do hủy" + nút "Xác nhận hủy" (khóa khi lý do sau trim < 10 hoặc > 500 ký tự).
//     "Xác nhận hủy" gọi POST /pt-bookings/:id/cancel body CHỈ {version, reason} (version của chi tiết đang xem), header Idempotency-Key UUID.
//   Thành công: role="status" "Đã hủy lịch", tải lại kết quả và chi tiết. Mất phản hồi/503: role="alert", giữ ô lý do, bấm lại dùng LẠI key cũ.
//   409: role="alert" có "tải lại", tự tải lại chi tiết. Không có nút "Hoàn tất" ở đâu trên trang (S04).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import App from '../../App';
import type { AuthUser } from '../auth/auth.types';
import { SupportPtBookingsPage } from './SupportPtBookingsPage';

// Không mở socket thật (chuông thông báo dùng socket).
vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })), default: vi.fn() }));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const staff: AuthUser = { id: '5'.repeat(24), fullName: 'Nhân viên Quầy', phone: '+84901234500', roleCode: 'STAFF' };
const BOOKING_ID = 'd'.repeat(24);
const REASON = 'Học viên báo ốm, nhân viên hủy hộ';
// 09:00–10:00 ngày 25/11/2026 giờ VN.
const START = '2026-11-25T02:00:00.000Z';

type Item = Record<string, unknown> & { id: string; status: string; version: number };
type PostCall = { path: string; body: Record<string, unknown>; key: string | null };

const plus1h = (startAt: string) => new Date(Date.parse(startAt) + 3600000).toISOString();
const item = (extra: Partial<Item> = {}): Item => ({
  id: BOOKING_ID, memberId: 'e'.repeat(24), memberCode: 'HV-000123', memberName: 'Nguyễn Văn An', trainerId: '1'.repeat(24),
  trainerName: 'PT Trần Văn Bình', startAt: START, endAt: plus1h(START), location: 'Phòng PT 1', status: 'BOOKED', version: 0, ...extra,
});

// ---------- Server giả ở tầng apiClient ----------
let current: Item;
let posts: PostCall[];
let onPost: (call: PostCall) => Promise<unknown>;
let requestSpy: ReturnType<typeof vi.fn>;
const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

async function fakeServer(path: string, init: RequestInit = {}): Promise<unknown> {
  const [route, queryString] = path.split('?');
  const params = new URLSearchParams(queryString ?? '');
  if (init.method === 'POST' && /^\/pt-bookings\/[^/]+\/cancel$/.test(route)) {
    const call = { path: route, body: JSON.parse(String(init.body)) as Record<string, unknown>, key: headerOf(init, 'Idempotency-Key') };
    posts.push(call);
    return onPost(call);
  }
  if (init.method && init.method !== 'GET') throw new Error(`Không có trong spec: ${init.method} ${path}`);
  if (route === '/pt-bookings') {
    const items = [current].filter(row => !params.get('status') || row.status === params.get('status'));
    return { items, page: 1, limit: Number(params.get('limit') ?? 20), total: items.length, totalPages: items.length ? 1 : 0 };
  }
  if (route === `/pt-bookings/${BOOKING_ID}`) return current;
  if (route.startsWith('/me/notifications') || route.startsWith('/notifications')) return { items: [], unreadCount: 0 };
  throw new Error(`Đường dẫn không có trong spec: ${path}`);
}

const cancelled = () => ({ id: BOOKING_ID, status: 'CANCELLED', version: current.version + 1, cancelledAt: '2026-11-25T02:30:00.000Z', notificationState: 'STORED' });
const apiError = (status: number, code: string) => new ApiError('Lỗi', status, 'req-1', undefined, undefined, code);

beforeEach(() => {
  current = item();
  posts = [];
  onPost = async () => {
    const result = cancelled();
    current = { ...current, status: 'CANCELLED', version: result.version };
    return result;
  };
  vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: staff });
  vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {});
  vi.spyOn(apiClient, 'restore').mockResolvedValue();
  requestSpy = vi.fn(fakeServer);
  vi.spyOn(apiClient, 'request').mockImplementation(requestSpy as never);
  vi.spyOn(apiClient, 'requestOnce').mockImplementation(requestSpy as never);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

const renderPage = () => render(<MemoryRouter initialEntries={['/staff/pt-bookings']}><SupportPtBookingsPage /></MemoryRouter>);
const getCalls = (prefix: string) => requestSpy.mock.calls
  .filter(call => !(call[1] as RequestInit | undefined)?.method || (call[1] as RequestInit).method === 'GET')
  .map(call => String(call[0])).filter(path => path.startsWith(prefix));
const lastQuery = (route: string) => {
  const list = getCalls(route).filter(path => path.split('?')[0] === route);
  return new URLSearchParams(list[list.length - 1]?.split('?')[1] ?? '');
};

// Tra cứu ngày 25/11/2026 rồi mở chi tiết buổi đầu tiên.
async function search(status?: string) {
  renderPage();
  fireEvent.change(await screen.findByLabelText('Từ ngày'), { target: { value: '2026-11-25' } });
  fireEvent.change(screen.getByLabelText('Đến ngày'), { target: { value: '2026-11-25' } });
  if (status) await userEvent.selectOptions(screen.getByLabelText('Trạng thái'), status);
  await userEvent.click(screen.getByRole('button', { name: 'Tìm' }));
  return screen.findByRole('region', { name: 'Kết quả' });
}
async function openDetail() {
  const results = await search();
  await userEvent.click(within(await within(results).findByRole('article')).getByRole('button', { name: 'Chi tiết' }));
  return screen.findByRole('region', { name: 'Chi tiết lịch PT' });
}
async function openCancel(reason = REASON) {
  const detail = await openDetail();
  await userEvent.click(within(detail).getByRole('button', { name: 'Hủy hỗ trợ' }));
  fireEvent.change(await within(detail).findByLabelText('Lý do hủy'), { target: { value: reason } });
  return detail;
}
const confirmButton = (scope: HTMLElement) => within(scope).getByRole('button', { name: 'Xác nhận hủy' }) as HTMLButtonElement;

describe('US-29 bước 3: trang hỗ trợ /staff/pt-bookings', () => {
  // ---------- TC05: tra cứu và chi tiết ----------

  it('US-29-TC05: tra cứu theo ngày + trạng thái gửi GET /pt-bookings đúng fromDate/toDate/status; kết quả có mã/tên Member, PT, giờ VN', async () => {
    const results = await search('Đã đặt');

    const query = lastQuery('/pt-bookings');
    expect(query.get('fromDate')).toBe('2026-11-25');
    expect(query.get('toDate')).toBe('2026-11-25');
    expect(query.get('status')).toBe('BOOKED');
    const card = await within(results).findByRole('article');
    expect(within(card).getByText(/HV-000123/)).toBeDefined();
    expect(within(card).getByText(/Nguyễn Văn An/)).toBeDefined();
    expect(within(card).getByText(/PT Trần Văn Bình/)).toBeDefined();
    expect(within(card).getByText(/25\/11\/2026/)).toBeDefined();
    expect(within(card).getByText(/09:00\s*[–-]\s*10:00/)).toBeDefined();
    expect(within(card).getByText('Đã đặt')).toBeDefined();
  });

  it('US-29-TC05: "Chi tiết" gọi GET /pt-bookings/:id và hiện Member, PT, giờ VN, địa điểm, trạng thái; không có nút "Hoàn tất"', async () => {
    const detail = await openDetail();

    expect(getCalls(`/pt-bookings/${BOOKING_ID}`).length).toBeGreaterThan(0);
    expect(within(detail).getByText(/HV-000123/)).toBeDefined();
    expect(within(detail).getByText(/Nguyễn Văn An/)).toBeDefined();
    expect(within(detail).getByText(/PT Trần Văn Bình/)).toBeDefined();
    expect(within(detail).getByText(/09:00\s*[–-]\s*10:00/)).toBeDefined();
    expect(within(detail).getByText(/Phòng PT 1/)).toBeDefined();
    expect(within(detail).getByRole('button', { name: 'Hủy hỗ trợ' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Hoàn tất/i })).toBeNull();
  });

  it('US-29-TC05: buổi đã qua giờ (no show) vẫn có nút "Hủy hỗ trợ"; buổi CANCELLED/COMPLETED thì không', async () => {
    current = item({ startAt: '2020-01-01T02:00:00.000Z', endAt: '2020-01-01T03:00:00.000Z' });
    let detail = await openDetail();
    expect(within(detail).getByRole('button', { name: 'Hủy hỗ trợ' })).toBeDefined();
    cleanup();

    for (const status of ['CANCELLED', 'COMPLETED']) {
      current = item({ status });
      detail = await openDetail();
      expect(within(detail).queryByRole('button', { name: 'Hủy hỗ trợ' })).toBeNull();
      cleanup();
    }
  });

  it('US-29-TC05: "Xác nhận hủy" gửi POST /pt-bookings/:id/cancel chỉ {version, reason} với version của chi tiết và Idempotency-Key UUID', async () => {
    current = item({ version: 4 });
    const detail = await openCancel();

    await userEvent.click(confirmButton(detail));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].path).toBe(`/pt-bookings/${BOOKING_ID}/cancel`);
    expect(Object.keys(posts[0].body).sort()).toEqual(['reason', 'version']);
    expect(posts[0].body.version).toBe(4);
    expect(String(posts[0].body.reason).trim()).toBe(REASON);
    expect(posts[0].key).toMatch(UUID);
  });

  it('US-29-TC05: thành công → "Đã hủy lịch", tải lại kết quả và chi tiết; chi tiết hiện "Đã hủy"', async () => {
    const detail = await openCancel();
    const listBefore = getCalls('/pt-bookings?').length;
    const detailBefore = getCalls(`/pt-bookings/${BOOKING_ID}`).length;

    await userEvent.click(confirmButton(detail));

    expect((await screen.findByRole('status')).textContent).toMatch(/Đã hủy lịch/);
    await waitFor(() => expect(getCalls('/pt-bookings?').length).toBeGreaterThan(listBefore));
    await waitFor(() => expect(getCalls(`/pt-bookings/${BOOKING_ID}`).length).toBeGreaterThan(detailBefore));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Chi tiết lịch PT' })).getByText('Đã hủy')).toBeDefined());
  });

  // ---------- TC06: lý do bắt buộc ----------

  it.each([
    ['trống', ''],
    ['9 ký tự sau trim', '   123456789   '],
    ['501 ký tự', 'a'.repeat(501)],
  ])('US-29-TC06: lý do %s → nút "Xác nhận hủy" bị khóa, không gửi', async (_name, reason) => {
    const detail = await openCancel(reason);

    expect(confirmButton(detail).disabled).toBe(true);
    fireEvent.click(confirmButton(detail));
    expect(posts).toHaveLength(0);
  });

  it('US-29-TC06: server trả 403 (mất quyền) → báo lỗi, không hiện đã hủy', async () => {
    onPost = async () => { throw apiError(403, 'FORBIDDEN'); };
    const detail = await openCancel();

    await userEvent.click(confirmButton(detail));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText(/Đã hủy lịch/)).toBeNull();
  });

  // ---------- TC09, TC12: khóa gửi kép, mất phản hồi giữ key, 409 tải lại ----------

  it('US-29-TC09: đang gửi thì "Xác nhận hủy" bị khóa, bấm nhiều lần chỉ một yêu cầu', async () => {
    let release!: (value: unknown) => void;
    onPost = () => new Promise(resolve => { release = resolve; });
    const detail = await openCancel();

    await userEvent.click(confirmButton(detail));
    await waitFor(() => expect(confirmButton(detail).disabled).toBe(true));
    fireEvent.click(confirmButton(detail));
    expect(posts).toHaveLength(1);
    release(cancelled());
  });

  it('US-29-TC12: mất kết nối → báo lỗi, giữ ô lý do, không tự gửi lại; bấm lại dùng đúng key và body cũ', async () => {
    let first = true;
    onPost = async () => {
      if (first) { first = false; throw new ApiError('Không kết nối được máy chủ'); }
      current = { ...current, status: 'CANCELLED', version: 1 };
      return cancelled();
    };
    const detail = await openCancel();

    await userEvent.click(confirmButton(detail));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(within(detail).getByLabelText('Lý do hủy')).toBeDefined();
    expect(posts).toHaveLength(1);
    await userEvent.click(confirmButton(detail));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].key).toBe(posts[0].key);
    expect(posts[1].body).toEqual(posts[0].body);
  });

  it('US-29-TC12: 409 VERSION_CONFLICT → báo "tải lại", tự tải lại chi tiết để lấy version mới', async () => {
    onPost = async () => {
      current = { ...current, version: 1 };
      throw apiError(409, 'VERSION_CONFLICT');
    };
    const detail = await openCancel();
    const detailBefore = getCalls(`/pt-bookings/${BOOKING_ID}`).length;

    await userEvent.click(confirmButton(detail));

    expect((await screen.findByRole('alert')).textContent).toMatch(/tải lại/i);
    await waitFor(() => expect(getCalls(`/pt-bookings/${BOOKING_ID}`).length).toBeGreaterThan(detailBefore));
  });
});

describe('US-29 bước 3: route /staff/pt-bookings', () => {
  it('US-29-TC05: STAFF mở /staff/pt-bookings → thấy trang "Tra cứu lịch PT"', async () => {
    window.history.pushState({}, '', '/staff/pt-bookings');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Tra cứu lịch PT' })).toBeDefined();
  });

  it.each(['MEMBER', 'TRAINER'] as const)('US-29-TC06: %s gõ thẳng /staff/pt-bookings → "Không có quyền truy cập", không gọi API /pt-bookings', async role => {
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: { ...staff, roleCode: role } });
    window.history.pushState({}, '', '/staff/pt-bookings');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Không có quyền truy cập' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Tra cứu lịch PT' })).toBeNull();
    expect(requestSpy.mock.calls.map(call => String(call[0])).filter(path => path.startsWith('/pt-bookings'))).toHaveLength(0);
  });
});
