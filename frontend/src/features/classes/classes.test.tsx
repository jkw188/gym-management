// Tầng kiểm thử frontend (Vitest, jsdom): US-26 bước 3 – trang công khai /classes (lịch lớp miễn phí) và chi tiết lớp.
// Dựng nguyên App ở /classes với fetch giả, nên test chỉ dựa vào route, hợp đồng API trong spec và chữ trên màn hình.
// Hợp đồng giao diện test đặt ra cho Builder (spec không ghi chữ cụ thể, tester đặt; cần sinh viên xác nhận):
//   - Route /classes KHÔNG cần đăng nhập; Guest và Member thấy cùng nội dung. Tiêu đề "Lịch lớp miễn phí".
//   - Gọi GET /api/public-session-subjects lấy bộ môn; GET /api/public-sessions?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
//     (mặc định tuần hiện tại thứ Hai → Chủ nhật theo ngày Việt Nam), thêm subjectCode khi chọn bộ môn, page khi sang trang.
//   - Ô chọn nhãn "Bộ môn", lựa chọn đầu "Tất cả bộ môn", sau đó là label từ taxonomy. Nút "Tuần trước" / "Tuần sau".
//   - Danh sách <ul aria-label="Danh sách lớp">, mỗi lớp một listitem có: title, subjectLabel, trainerName,
//     ngày "dd/MM" và giờ "HH:mm–HH:mm" theo Asia/Ho_Chi_Minh, location; ended=true có nhãn "Đã kết thúc"; nút "Xem chi tiết".
//   - Hiển thị lớp theo đúng thứ tự server trả (server đã sắp startAt rồi id).
//   - Có trang sau (page < totalPages) thì có nút "Trang sau".
//   - "Xem chi tiết" gọi GET /api/public-sessions/:id rồi mở role="dialog" có nút "Đóng".
//   - Detail 404 SESSION_NOT_FOUND: role="alert" chứa "không còn được công bố" và tự tải lại danh sách.
//   - Đang tải: "Đang tải". Rỗng: "Không có lớp". Lỗi mạng/503: role="alert" + nút "Thử lại", giữ bộ lọc.
//   - Không có nút đăng ký/đặt chỗ/giữ chỗ; trang không gửi request ghi nào (POST/PUT/PATCH/DELETE) ngoài /auth.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Socket thông báo của Member không liên quan US-26: thay bằng socket giả không làm gì.
vi.mock('socket.io-client', () => {
  const socket = { on: () => socket, off: () => socket, emit: () => socket, connect: () => socket, disconnect: () => socket, io: { on: () => undefined, off: () => undefined } };
  return { io: () => socket, default: () => socket };
});

const url = 'http://localhost:3000/api';
// "Bây giờ": thứ Tư 04/11/2026 10:00 giờ Việt Nam → tuần hiện tại 02/11 – 08/11.
const NOW = new Date('2026-11-04T03:00:00.000Z');

const SUBJECTS = [
  { code: 'YOGA', label: 'Yoga' }, { code: 'AEROBICS', label: 'Aerobics' }, { code: 'ZUMBA', label: 'Zumba' },
  { code: 'FUNCTIONAL', label: 'Tập chức năng' }, { code: 'OTHER', label: 'Khác' },
];

interface PublicSession {
  id: string; title: string; subjectCode: string; subjectLabel: string; trainerId: string; trainerName: string;
  startAt: string; endAt: string; location: string; status: 'PUBLISHED'; ended: boolean;
}
const session = (id: string, title: string, subjectCode: string, startAt: string, endAt: string, extra: Partial<PublicSession> = {}): PublicSession => ({
  id, title, subjectCode, subjectLabel: SUBJECTS.find(s => s.code === subjectCode)!.label,
  trainerId: '650000000000000000000001', trainerName: 'Trần Thị Huấn Luyện', startAt, endAt,
  location: 'Phòng tập tầng 2', status: 'PUBLISHED', ended: false, ...extra,
});

// Giờ trong comment là giờ Việt Nam.
const pastZumba = session('660000000000000000000001', 'Zumba buổi sớm', 'ZUMBA', '2026-11-02T23:00:00.000Z', '2026-11-03T00:00:00.000Z', { ended: true }); // T3 03/11 06:00–07:00
const nightAerobics = session('660000000000000000000002', 'Aerobics nửa đêm', 'AEROBICS', '2026-11-04T17:30:00.000Z', '2026-11-04T18:30:00.000Z'); // T5 05/11 00:30–01:30 (UTC vẫn 04/11)
const morningYoga = session('660000000000000000000003', 'Yoga buổi sáng', 'YOGA', '2026-11-05T01:00:00.000Z', '2026-11-05T02:00:00.000Z', { location: 'Phòng Yoga 1' }); // T5 05/11 08:00–09:00
const weekItems = [pastZumba, nightAerobics, morningYoga];

const pageOf = (items: PublicSession[], extra: Record<string, number> = {}) =>
  ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0, ...extra });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (code: string, message: string, status: number) => json({ error: { code, message }, requestId: 'req-1' }, status);
const member = { id: '650000000000000000000099', fullName: 'Hội Viên Chưa Gói', phone: '0901234567', roleCode: 'MEMBER' };

type ListHandler = (query: URLSearchParams, callNo: number) => Response | Promise<Response>;
type DetailHandler = (id: string) => Response | Promise<Response>;

// Máy chủ giả: ghi lại mọi lần gọi. Mặc định Guest (refresh 401), list trả 3 lớp của tuần, detail trả đúng lớp theo id.
function fakeServer(options: { list?: ListHandler; detail?: DetailHandler; loggedIn?: boolean } = {}) {
  let listCalls = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const target = new URL(String(input));
    const path = target.pathname;
    if (path.endsWith('/auth/refresh')) {
      return options.loggedIn
        ? json({ accessToken: 'token-member', tokenType: 'Bearer', expiresIn: 900, user: member })
        : apiError('UNAUTHORIZED', 'Cần xác thực', 401);
    }
    if (path.endsWith('/public-session-subjects')) return json(SUBJECTS);
    const detail = path.match(/\/public-sessions\/([^/]+)$/);
    if (detail) {
      if (options.detail) return options.detail(detail[1]);
      const found = weekItems.find(item => item.id === detail[1]);
      return found ? json(found) : apiError('SESSION_NOT_FOUND', 'Không tìm thấy lớp', 404);
    }
    if (path.endsWith('/public-sessions')) {
      listCalls += 1;
      return options.list ? options.list(target.searchParams, listCalls) : json(pageOf(weekItems));
    }
    return apiError('NOT_FOUND', 'Không có', 404);
  });
}
type Fetcher = ReturnType<typeof fakeServer>;

const requestsOf = (fetcher: Fetcher) => fetcher.mock.calls.map(([input, init]) => ({ url: new URL(String(input)), method: (init?.method ?? 'GET').toUpperCase() }));
const listQueries = (fetcher: Fetcher) => requestsOf(fetcher).filter(r => r.url.pathname.endsWith('/public-sessions')).map(r => r.url.searchParams);
const lastListQuery = (fetcher: Fetcher) => listQueries(fetcher).at(-1)!;
const writeRequests = (fetcher: Fetcher) => requestsOf(fetcher).filter(r => r.method !== 'GET' && !r.url.pathname.includes('/auth/'));

// Nạp lại App với fetch giả (apiClient được tạo một lần lúc import) rồi mở /classes.
async function renderApp(fetcher: Fetcher, path = '/classes') {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', url);
  vi.stubGlobal('fetch', fetcher);
  window.history.pushState({}, '', path);
  const { default: App } = await import('../../App');
  render(<App />);
}

const classList = () => screen.findByRole('list', { name: 'Danh sách lớp' });
const timeRange = (from: string, to: string) => new RegExp(`${from}\\s*[–-]\\s*${to}`);
async function classItem(title: string) {
  const list = await classList();
  const item = within(list).getAllByRole('listitem').find(li => li.textContent?.includes(title));
  expect(item, `không thấy lớp "${title}"`).toBeDefined();
  return item!;
}
const bookingButton = () => screen.queryByRole('button', { name: /đăng ký|đặt chỗ|giữ chỗ|tham gia/i });

beforeEach(() => {
  // Chỉ giả lập đồng hồ Date; timer thật để userEvent và waitFor chạy bình thường.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('US-26 bước 3: trang /classes', () => {
  // ---------- TC01: lớp từ DB thật hiện đúng PT/giờ/địa điểm ----------
  it('US-26-TC01: Guest mở /classes không bị chuyển sang đăng nhập, gọi API tuần hiện tại 02/11–08/11', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    expect(await screen.findByRole('heading', { name: 'Lịch lớp miễn phí' })).toBeTruthy();
    await classList();
    expect(window.location.pathname).toBe('/classes');
    const query = lastListQuery(fetcher);
    expect(query.get('fromDate')).toBe('2026-11-02');
    expect(query.get('toDate')).toBe('2026-11-08');
    expect(query.has('status')).toBe(false);
  });

  it('US-26-TC01: mỗi lớp hiện tên lớp, bộ môn, tên PT, ngày giờ Việt Nam và địa điểm lấy từ API', async () => {
    await renderApp(fakeServer());
    const item = await classItem('Yoga buổi sáng');
    const text = item.textContent ?? '';
    expect(text).toContain('Yoga');
    expect(text).toContain('Trần Thị Huấn Luyện');
    expect(text).toContain('05/11');
    expect(text).toMatch(timeRange('08:00', '09:00'));
    expect(text).toContain('Phòng Yoga 1');
  });

  it('US-26-TC01: "Xem chi tiết" gọi GET /api/public-sessions/:id và mở hộp chi tiết đúng PT/giờ/địa điểm', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    const user = userEvent.setup();
    await user.click(within(await classItem('Yoga buổi sáng')).getByRole('button', { name: 'Xem chi tiết' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toContain('Trần Thị Huấn Luyện'));
    expect(dialog.textContent).toContain('Yoga buổi sáng');
    expect(dialog.textContent).toMatch(timeRange('08:00', '09:00'));
    expect(dialog.textContent).toContain('Phòng Yoga 1');
    expect(requestsOf(fetcher).some(r => r.url.pathname.endsWith(`/public-sessions/${morningYoga.id}`))).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Đóng' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  // ---------- TC03: Member chưa có gói xem như Guest ----------
  it('US-26-TC03: Member đã đăng nhập nhưng chưa có gói vẫn xem lịch, không bị đòi mua gói hay chuyển trang', async () => {
    const fetcher = fakeServer({ loggedIn: true });
    await renderApp(fetcher);
    await classItem('Yoga buổi sáng');
    expect(window.location.pathname).toBe('/classes');
    expect(screen.queryByText(/mua gói|đăng ký gói|cần có gói/i)).toBeNull();
    expect(bookingButton()).toBeNull();
  });

  // ---------- TC04: lịch trống và lớp quá khứ ----------
  it('US-26-TC04: tuần không có lớp hiện thông báo rỗng rõ ràng, không có danh sách lớp', async () => {
    await renderApp(fakeServer({ list: () => json(pageOf([])) }));
    expect(await screen.findByText(/Không có lớp/)).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('US-26-TC04: lớp đã qua vẫn hiện và có nhãn "Đã kết thúc"; lớp chưa diễn ra không có nhãn này', async () => {
    await renderApp(fakeServer());
    expect((await classItem('Zumba buổi sớm')).textContent).toContain('Đã kết thúc');
    expect((await classItem('Yoga buổi sáng')).textContent).not.toContain('Đã kết thúc');
  });

  // ---------- TC05: lọc kết hợp, thứ tự và phân trang ----------
  it('US-26-TC05: hiện lớp đúng thứ tự server trả (startAt rồi id), không tự sắp lại', async () => {
    await renderApp(fakeServer());
    const items = within(await classList()).getAllByRole('listitem').map(li => li.textContent ?? '');
    expect(items).toHaveLength(3);
    expect(items[0]).toContain('Zumba buổi sớm');
    expect(items[1]).toContain('Aerobics nửa đêm');
    expect(items[2]).toContain('Yoga buổi sáng');
  });

  it('US-26-TC05: ô "Bộ môn" lấy từ taxonomy; chọn Yoga thì gửi subjectCode=YOGA kèm khoảng ngày và về trang 1', async () => {
    const fetcher = fakeServer({ list: query => json(pageOf(query.get('subjectCode') === 'YOGA' ? [morningYoga] : weekItems)) });
    await renderApp(fetcher);
    await classList();
    const select = screen.getByLabelText('Bộ môn') as HTMLSelectElement;
    const optionLabels = within(select).getAllByRole('option').map(o => o.textContent);
    expect(optionLabels).toEqual(['Tất cả bộ môn', 'Yoga', 'Aerobics', 'Zumba', 'Tập chức năng', 'Khác']);
    await userEvent.setup().selectOptions(select, 'Yoga');
    await waitFor(() => expect(lastListQuery(fetcher).get('subjectCode')).toBe('YOGA'));
    const query = lastListQuery(fetcher);
    expect(query.get('fromDate')).toBe('2026-11-02');
    expect(query.get('toDate')).toBe('2026-11-08');
    expect(query.get('page') ?? '1').toBe('1');
    await waitFor(() => expect(screen.queryByText('Zumba buổi sớm')).toBeNull());
    expect(within(await classList()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('US-26-TC05: "Tuần sau" gửi 09/11–15/11 và giữ bộ môn đang lọc (AND)', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    await classList();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Bộ môn'), 'Zumba');
    await waitFor(() => expect(lastListQuery(fetcher).get('subjectCode')).toBe('ZUMBA'));
    await user.click(screen.getByRole('button', { name: 'Tuần sau' }));
    await waitFor(() => expect(lastListQuery(fetcher).get('fromDate')).toBe('2026-11-09'));
    expect(lastListQuery(fetcher).get('toDate')).toBe('2026-11-15');
    expect(lastListQuery(fetcher).get('subjectCode')).toBe('ZUMBA');
  });

  it('US-26-TC05: "Tuần trước" gửi 26/10–01/11', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    await classList();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Tuần trước' }));
    await waitFor(() => expect(lastListQuery(fetcher).get('fromDate')).toBe('2026-10-26'));
    expect(lastListQuery(fetcher).get('toDate')).toBe('2026-11-01');
  });

  it('US-26-TC05: có trang sau thì "Trang sau" gửi page=2 và giữ nguyên khoảng ngày, bộ môn', async () => {
    const fetcher = fakeServer({
      list: query => json(query.get('page') === '2'
        ? pageOf([morningYoga], { page: 2, total: 21, totalPages: 2 })
        : pageOf([pastZumba, nightAerobics], { total: 21, totalPages: 2 })),
    });
    await renderApp(fetcher);
    await classItem('Zumba buổi sớm');
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Bộ môn'), 'Yoga');
    await waitFor(() => expect(lastListQuery(fetcher).get('subjectCode')).toBe('YOGA'));
    await user.click(await screen.findByRole('button', { name: 'Trang sau' }));
    await waitFor(() => expect(lastListQuery(fetcher).get('page')).toBe('2'));
    const query = lastListQuery(fetcher);
    expect(query.get('subjectCode')).toBe('YOGA');
    expect(query.get('fromDate')).toBe('2026-11-02');
    expect(await classItem('Yoga buổi sáng')).toBeTruthy();
  });

  // ---------- TC06: ngày Việt Nam giáp ranh UTC ----------
  it('US-26-TC06: lớp 00:30 ngày 05/11 giờ Việt Nam (UTC vẫn là 04/11) hiện ngày 05/11, giờ 00:30–01:30', async () => {
    await renderApp(fakeServer());
    const text = (await classItem('Aerobics nửa đêm')).textContent ?? '';
    expect(text).toContain('05/11');
    expect(text).not.toContain('04/11');
    expect(text).toMatch(timeRange('00:30', '01:30'));
  });

  // ---------- TC08: markup Admin nhập hiện dạng chữ ----------
  it('US-26-TC08: tên lớp và địa điểm có markup được hiện nguyên văn dạng chữ, không tạo thẻ HTML', async () => {
    const markup = session('660000000000000000000004', '<img src=x onerror="alert(1)">Lớp lạ', 'OTHER', '2026-11-06T01:00:00.000Z', '2026-11-06T02:00:00.000Z', { location: '<b>Sân</b>' });
    await renderApp(fakeServer({ list: () => json(pageOf([markup])) }));
    const item = await classItem('Lớp lạ');
    expect(item.textContent).toContain('<img src=x onerror="alert(1)">Lớp lạ');
    expect(item.textContent).toContain('<b>Sân</b>');
    expect(document.body.querySelector('img')).toBeNull();
    expect(item.querySelector('b')).toBeNull();
  });

  // ---------- TC09: lớp bị hủy giữa list và detail ----------
  it('US-26-TC09: detail trả 404 SESSION_NOT_FOUND thì báo lớp không còn được công bố và tự tải lại danh sách', async () => {
    const fetcher = fakeServer({
      list: (_query, callNo) => json(pageOf(callNo === 1 ? weekItems : [pastZumba, nightAerobics])),
      detail: () => apiError('SESSION_NOT_FOUND', 'Không tìm thấy lớp', 404),
    });
    await renderApp(fetcher);
    const user = userEvent.setup();
    await user.click(within(await classItem('Yoga buổi sáng')).getByRole('button', { name: 'Xem chi tiết' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/không còn được công bố/i);
    await waitFor(() => expect(listQueries(fetcher)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('Yoga buổi sáng')).toBeNull());
    expect(lastListQuery(fetcher).get('fromDate')).toBe('2026-11-02');
    expect(writeRequests(fetcher)).toEqual([]);
  });

  // ---------- TC10: đọc thuần, không có đăng ký chỗ ----------
  it('US-26-TC10: Guest tải lịch và bấm xem chi tiết nhiều lần chỉ gửi GET, không có nút đăng ký/đặt chỗ', async () => {
    const fetcher = fakeServer();
    await renderApp(fetcher);
    const user = userEvent.setup();
    for (let i = 0; i < 3; i += 1) {
      await user.click(within(await classItem('Yoga buổi sáng')).getByRole('button', { name: 'Xem chi tiết' }));
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(dialog.textContent).toContain('Phòng Yoga 1'));
      expect(bookingButton()).toBeNull();
      await user.click(within(dialog).getByRole('button', { name: 'Đóng' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    expect(bookingButton()).toBeNull();
    expect(writeRequests(fetcher)).toEqual([]);
  });

  it('US-26-TC10: đăng nhập Member không đổi dữ liệu công khai: cùng query, cùng danh sách, vẫn không có nút đặt chỗ', async () => {
    const guest = fakeServer();
    await renderApp(guest);
    const guestItems = within(await classList()).getAllByRole('listitem').map(li => li.textContent);
    const guestQuery = lastListQuery(guest).toString();
    cleanup();

    const signedIn = fakeServer({ loggedIn: true });
    await renderApp(signedIn);
    await classItem('Yoga buổi sáng');
    const memberItems = within(await classList()).getAllByRole('listitem').map(li => li.textContent);
    expect(memberItems).toEqual(guestItems);
    expect(lastListQuery(signedIn).toString()).toBe(guestQuery);
    expect(bookingButton()).toBeNull();
    expect(writeRequests(signedIn)).toEqual([]);
  });

  // ---------- TC12: loading / empty / lỗi DB và retry ----------
  it('US-26-TC12: đang chờ server thì hiện "Đang tải"', async () => {
    let finish: (response: Response) => void = () => undefined;
    await renderApp(fakeServer({ list: () => new Promise<Response>(resolve => { finish = resolve; }) }));
    expect(await screen.findByText(/Đang tải/)).toBeTruthy();
    finish(json(pageOf(weekItems)));
    await classItem('Yoga buổi sáng');
    expect(screen.queryByText(/Đang tải/)).toBeNull();
  });

  it('US-26-TC12: 503 DB chưa sẵn sàng thì báo lỗi + "Thử lại"; bấm thử lại gọi lại đúng query và hiện lớp', async () => {
    const fetcher = fakeServer({
      list: (_query, callNo) => callNo === 1 ? apiError('DATABASE_UNAVAILABLE', 'Cơ sở dữ liệu chưa sẵn sàng.', 503) : json(pageOf(weekItems)),
    });
    await renderApp(fetcher);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Danh sách lớp' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Thử lại' }));
    await classItem('Yoga buổi sáng');
    const [first, second] = listQueries(fetcher);
    expect(second.toString()).toBe(first.toString());
  });

  it('US-26-TC12: mất mạng thì cũng báo lỗi + "Thử lại", không coi là lịch rỗng', async () => {
    await renderApp(fakeServer({ list: () => { throw new TypeError('offline'); } }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy();
    expect(screen.queryByText(/Không có lớp/)).toBeNull();
  });

  it('US-26-TC12: lỗi sau khi đổi bộ môn thì giữ bộ lọc, không hiện lớp cũ như còn lịch; thử lại vẫn gửi subjectCode', async () => {
    const fetcher = fakeServer({
      list: (query, callNo) => {
        if (query.get('subjectCode') === 'YOGA' && callNo === 2) return apiError('DATABASE_UNAVAILABLE', 'Cơ sở dữ liệu chưa sẵn sàng.', 503);
        return json(pageOf(query.get('subjectCode') === 'YOGA' ? [morningYoga] : weekItems));
      },
    });
    await renderApp(fetcher);
    await classItem('Zumba buổi sớm');
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Bộ môn'), 'Yoga');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByLabelText('Bộ môn') as HTMLSelectElement).value).toBe('YOGA');
    expect(screen.queryByText('Zumba buổi sớm')).toBeNull();
    expect(screen.queryByText('Aerobics nửa đêm')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Thử lại' }));
    await classItem('Yoga buổi sáng');
    expect(lastListQuery(fetcher).get('subjectCode')).toBe('YOGA');
  });
});
