// Tầng kiểm thử frontend (Vitest, jsdom): US-24 bước 3 – trang /trainer/shifts (lịch tuần + form ca nháp của PT).
// Kiểm tra đổi tuần, giờ Việt Nam, nhãn trạng thái, preview slot phần dư, chặn gửi kép, lỗi mạng giữ key, conflict và tải lại (TC12).
// Hợp đồng test đặt ra cho Builder (US-24 bước 3):
//   src/features/shifts/shifts.api.ts:
//     export const shiftsApi = {
//       list(query: { fromDate: string; toDate: string; status?: string; page?: number; limit?: number }): Promise<ShiftPage>,
//       create(input: { startAt: string; endAt: string; location: string }, idempotencyKey: string): Promise<Shift>,
//       update(id: string, input: { version: number; startAt: string; endAt: string; location: string }, idempotencyKey: string): Promise<Shift>,
//     }  (gọi GET/POST/PATCH /api/me/work-shifts qua apiClient, gửi header Idempotency-Key; kiểu Shift, ShiftPage export từ file này)
//   src/features/shifts/ShiftsPage.tsx: export function ShiftsPage()
//     - Tiêu đề "Ca làm việc"; đang tải hiện "Đang tải"; lỗi hiện role="alert" + nút "Thử lại".
//     - Mặc định tuần hiện tại (thứ Hai → Chủ nhật, theo ngày Việt Nam); nút "Tuần trước" / "Tuần sau".
//     - Mỗi ngày là <section aria-label="Thứ Hai 02/11"> … "Chủ nhật 08/11"; mỗi ca là một listitem hiện "HH:mm–HH:mm"
//       giờ Asia/Ho_Chi_Minh, địa điểm và nhãn trạng thái: SCHEDULED "Nháp", CONFIRMED "Công bố", COMPLETED "Hoàn tất", CANCELLED "Hủy".
//     - Ca "Nháp" chưa bắt đầu có nút "Sửa"; ca khác không có nút sửa.
//     - Nút "Thêm ca nháp" mở form có các ô nhãn "Ngày" (YYYY-MM-DD), "Giờ bắt đầu", "Giờ kết thúc" (HH:mm), "Địa điểm";
//       nút "Lưu ca nháp" và "Đóng". Vùng aria-label "Xem trước slot" liệt kê slot 60 phút và phần dư "Dư N phút … không mở đặt".
//     - Gửi startAt/endAt là chuỗi ISO có offset (+07:00 hoặc Z). Mỗi ý định một UUID; gửi lại sau lỗi mạng dùng LẠI key cũ.
//     - Thành công: đóng form, role="status" "Đã lưu ca nháp", tải lại danh sách từ server.
//     - 409 VERSION_CONFLICT: role="alert" + nút "Tải lại ca"; chỉ tải lại khi bấm.
//     - profileLinked=false: báo "chưa có hồ sơ PT", không có nút "Thêm ca nháp".
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { shiftsApi, type Shift, type ShiftPage } from './shifts.api';
import { ShiftsPage } from './ShiftsPage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WITH_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;
// "Bây giờ": thứ Tư 04/11/2026 10:00 giờ Việt Nam → tuần hiện tại 02/11 – 08/11.
const NOW = new Date('2026-11-04T03:00:00.000Z');

const shift = (id: string, startAt: string, endAt: string, status: Shift['status'] = 'SCHEDULED', version = 0, location = 'Phòng PT 1'): Shift =>
  ({ id, startAt, endAt, location, status, version, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' });
const pageOf = (items: Shift[], extra: Partial<ShiftPage> = {}): ShiftPage =>
  ({ profileLinked: true, items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0, ...extra });

// Dữ liệu tuần 02/11 – 08/11 (giờ trong comment là giờ Việt Nam).
const draftThu = shift('s1', '2026-11-05T01:10:00.000Z', '2026-11-05T03:40:00.000Z');                       // T5 08:10–10:40 Nháp
const confirmedFri = shift('s2', '2026-11-06T02:00:00.000Z', '2026-11-06T03:00:00.000Z', 'CONFIRMED');     // T6 09:00–10:00
const completedTue = shift('s3', '2026-11-03T00:00:00.000Z', '2026-11-03T01:00:00.000Z', 'COMPLETED');     // T3 07:00–08:00
const cancelledSat = shift('s4', '2026-11-07T07:00:00.000Z', '2026-11-07T08:00:00.000Z', 'CANCELLED');     // T7 14:00–15:00
const earlyWed = shift('s5', '2026-11-03T23:00:00.000Z', '2026-11-04T00:00:00.000Z');                      // T4 06:00–07:00 (UTC vẫn là T3)
const weekItems = [completedTue, earlyWed, draftThu, confirmedFri, cancelledSat];

beforeEach(() => {
  // Chỉ giả lập đồng hồ Date; timer thật để userEvent và waitFor chạy bình thường.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const renderPage = () => render(<MemoryRouter initialEntries={['/trainer/shifts']}><ShiftsPage /></MemoryRouter>);
const timeRange = (from: string, to: string) => new RegExp(`${from}\\s*[–-]\\s*${to}`);
const dayRegion = (name: string) => screen.getByRole('region', { name });
const shiftItem = (region: HTMLElement, from: string, to: string) =>
  within(region).getAllByRole('listitem').find(item => timeRange(from, to).test(item.textContent ?? ''))!;

async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Thêm ca nháp' }));
}
// Điền form ca nháp: ô ngày/giờ đặt giá trị trực tiếp, ô địa điểm gõ như người dùng.
async function fillForm(user: ReturnType<typeof userEvent.setup>, values: { date?: string; from?: string; to?: string; location?: string }) {
  if (values.date !== undefined) fireEvent.change(screen.getByLabelText('Ngày'), { target: { value: values.date } });
  if (values.from !== undefined) fireEvent.change(screen.getByLabelText('Giờ bắt đầu'), { target: { value: values.from } });
  if (values.to !== undefined) fireEvent.change(screen.getByLabelText('Giờ kết thúc'), { target: { value: values.to } });
  if (values.location !== undefined) {
    const location = screen.getByLabelText('Địa điểm');
    await user.clear(location);
    await user.type(location, values.location);
  }
}
const save = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Lưu ca nháp' }));
const sameInstant = (actual: string, expected: string) => {
  expect(actual).toMatch(WITH_OFFSET);
  expect(new Date(actual).toISOString()).toBe(new Date(expected).toISOString());
};

describe('US-24 bước 3: trang ca làm việc của PT', () => {
  // ---------- Lịch tuần, đổi tuần, múi giờ, nhãn trạng thái ----------
  it('US-24-TC12: mở trang tải tuần hiện tại từ thứ Hai 02/11 đến Chủ nhật 08/11, có trạng thái "Đang tải"', async () => {
    let resolve!: (value: ShiftPage) => void;
    const list = vi.spyOn(shiftsApi, 'list').mockReturnValue(new Promise(done => { resolve = done; }));
    renderPage();
    expect(screen.getByRole('heading', { name: 'Ca làm việc' })).toBeTruthy();
    expect(screen.getByText(/Đang tải/)).toBeTruthy();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ fromDate: '2026-11-02', toDate: '2026-11-08' }));
    await act(async () => resolve(pageOf(weekItems)));
    expect(await screen.findByRole('region', { name: 'Thứ Hai 02/11' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Chủ nhật 08/11' })).toBeTruthy();
  });

  it('US-24-TC12: "Tuần sau" tải 09/11–15/11, "Tuần trước" hai lần tải 26/10–01/11', async () => {
    const user = userEvent.setup();
    const list = vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([]));
    renderPage();
    await screen.findByRole('region', { name: 'Thứ Hai 02/11' });
    await user.click(screen.getByRole('button', { name: 'Tuần sau' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ fromDate: '2026-11-09', toDate: '2026-11-15' })));
    expect(await screen.findByRole('region', { name: 'Thứ Hai 09/11' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tuần trước' }));
    await user.click(screen.getByRole('button', { name: 'Tuần trước' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ fromDate: '2026-10-26', toDate: '2026-11-01' })));
    expect(await screen.findByRole('region', { name: 'Thứ Hai 26/10' })).toBeTruthy();
  });

  it('US-24-TC12: giờ hiển thị theo Asia/Ho_Chi_Minh và ca được xếp đúng ngày Việt Nam', async () => {
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf(weekItems));
    renderPage();
    const thursday = await screen.findByRole('region', { name: 'Thứ Năm 05/11' });
    expect(shiftItem(thursday, '08:10', '10:40')).toBeTruthy();
    // 23:00 UTC ngày 03/11 là 06:00 sáng thứ Tư 04/11 giờ Việt Nam.
    expect(shiftItem(dayRegion('Thứ Tư 04/11'), '06:00', '07:00')).toBeTruthy();
    expect(within(dayRegion('Thứ Ba 03/11')).queryByText(timeRange('06:00', '07:00'))).toBeNull();
  });

  it('US-24-TC12: nhãn trạng thái Nháp / Công bố / Hoàn tất / Hủy rõ ràng', async () => {
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf(weekItems));
    renderPage();
    const thursday = await screen.findByRole('region', { name: 'Thứ Năm 05/11' });
    expect(within(shiftItem(thursday, '08:10', '10:40')).getByText('Nháp')).toBeTruthy();
    expect(within(shiftItem(dayRegion('Thứ Sáu 06/11'), '09:00', '10:00')).getByText('Công bố')).toBeTruthy();
    expect(within(shiftItem(dayRegion('Thứ Ba 03/11'), '07:00', '08:00')).getByText('Hoàn tất')).toBeTruthy();
    expect(within(shiftItem(dayRegion('Thứ Bảy 07/11'), '14:00', '15:00')).getByText('Hủy')).toBeTruthy();
  });

  it('US-24-TC12: chỉ ca Nháp chưa bắt đầu có nút "Sửa"; ca Công bố/Hoàn tất/Hủy không có', async () => {
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf(weekItems));
    renderPage();
    const thursday = await screen.findByRole('region', { name: 'Thứ Năm 05/11' });
    expect(within(shiftItem(thursday, '08:10', '10:40')).getByRole('button', { name: 'Sửa' })).toBeTruthy();
    // 06:00–07:00 thứ Tư đã qua lúc 10:00 thứ Tư: ca nháp đã bắt đầu thì không sửa được.
    expect(within(shiftItem(dayRegion('Thứ Tư 04/11'), '06:00', '07:00')).queryByRole('button', { name: 'Sửa' })).toBeNull();
    expect(within(shiftItem(dayRegion('Thứ Sáu 06/11'), '09:00', '10:00')).queryByRole('button', { name: 'Sửa' })).toBeNull();
    expect(within(shiftItem(dayRegion('Thứ Ba 03/11'), '07:00', '08:00')).queryByRole('button', { name: 'Sửa' })).toBeNull();
    expect(within(shiftItem(dayRegion('Thứ Bảy 07/11'), '14:00', '15:00')).queryByRole('button', { name: 'Sửa' })).toBeNull();
  });

  it('US-24-TC12: tải danh sách lỗi mạng thì hiện lỗi và "Thử lại"; bấm thì tải lại được', async () => {
    const user = userEvent.setup();
    const list = vi.spyOn(shiftsApi, 'list')
      .mockRejectedValueOnce(new ApiError('Không kết nối được máy chủ'))
      .mockResolvedValueOnce(pageOf([draftThu]));
    renderPage();
    expect(await screen.findByRole('alert')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(shiftItem(await screen.findByRole('region', { name: 'Thứ Năm 05/11' }), '08:10', '10:40')).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('US-24-TC12: account TRAINER chưa có hồ sơ PT thì báo rõ và không cho thêm ca', async () => {
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([], { profileLinked: false }));
    renderPage();
    expect(await screen.findByText(/chưa có hồ sơ PT/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Thêm ca nháp' })).toBeNull();
  });

  // ---------- Form ca nháp: preview slot, gửi, pending, lỗi ----------
  it('US-24-TC12: preview ca 08:10–10:40 hiện slot 08:10 và 09:10, dư 30 phút không mở đặt', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([]));
    renderPage();
    await openForm(user);
    await fillForm(user, { date: '2026-11-05', from: '08:10', to: '10:40' });
    const preview = screen.getByRole('region', { name: 'Xem trước slot' });
    const slots = within(preview).getAllByRole('listitem').map(item => item.textContent ?? '');
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatch(timeRange('08:10', '09:10'));
    expect(slots[1]).toMatch(timeRange('09:10', '10:10'));
    expect(within(preview).getByText(/Dư 30 phút/i).textContent).toMatch(/không mở đặt/i);
  });

  it('US-24-TC12: lưu ca nháp gửi đúng thời điểm có offset và một UUID, xong thì đóng form, báo đã lưu và tải lại từ server', async () => {
    const user = userEvent.setup();
    const list = vi.spyOn(shiftsApi, 'list').mockResolvedValueOnce(pageOf([])).mockResolvedValueOnce(pageOf([draftThu]));
    const create = vi.spyOn(shiftsApi, 'create').mockResolvedValue(draftThu);
    renderPage();
    await openForm(user);
    await fillForm(user, { date: '2026-11-05', from: '08:10', to: '10:40', location: 'Phòng PT 1' });
    await save(user);

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [input, key] = create.mock.calls[0];
    sameInstant(input.startAt, '2026-11-05T08:10:00+07:00');
    sameInstant(input.endAt, '2026-11-05T10:40:00+07:00');
    expect(input.location).toBe('Phòng PT 1');
    expect(key).toMatch(UUID);

    expect((await screen.findByRole('status')).textContent).toMatch(/Đã lưu ca nháp/i);
    expect(screen.queryByRole('button', { name: 'Lưu ca nháp' })).toBeNull();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(shiftItem(await screen.findByRole('region', { name: 'Thứ Năm 05/11' }), '08:10', '10:40')).toBeTruthy();
  });

  it('US-24-TC12: lưu ca nháp không báo là ca đã công bố', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValueOnce(pageOf([])).mockResolvedValueOnce(pageOf([draftThu]));
    vi.spyOn(shiftsApi, 'create').mockResolvedValue(draftThu);
    renderPage();
    await openForm(user);
    await fillForm(user, { date: '2026-11-05', from: '08:10', to: '10:40', location: 'Phòng PT 1' });
    await save(user);
    await screen.findByRole('status');
    expect(screen.queryByText(/đã công bố/i)).toBeNull();
    expect(within(shiftItem(await screen.findByRole('region', { name: 'Thứ Năm 05/11' }), '08:10', '10:40')).getByText('Nháp')).toBeTruthy();
  });

  it('US-24-TC12: đang gửi thì nút bị khóa, bấm nhiều lần chỉ gọi API một lần', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([]));
    let resolve!: (value: Shift) => void;
    const create = vi.spyOn(shiftsApi, 'create').mockReturnValue(new Promise(done => { resolve = done; }));
    renderPage();
    await openForm(user);
    await fillForm(user, { date: '2026-11-05', from: '08:10', to: '10:40', location: 'Phòng PT 1' });
    const button = screen.getByRole('button', { name: 'Lưu ca nháp' });
    await user.click(button);
    await user.click(button);
    await user.dblClick(button);
    expect(create).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve(draftThu));
  });

  it('US-24-TC12: lỗi mạng khi lưu thì báo lỗi, giữ dữ liệu form, không tự gửi lại; bấm lại dùng đúng key cũ', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([]));
    const create = vi.spyOn(shiftsApi, 'create')
      .mockRejectedValueOnce(new ApiError('Không kết nối được máy chủ'))
      .mockResolvedValueOnce(draftThu);
    renderPage();
    await openForm(user);
    await fillForm(user, { date: '2026-11-05', from: '08:10', to: '10:40', location: 'Phòng PT 1' });
    await save(user);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByLabelText('Địa điểm') as HTMLInputElement).value).toBe('Phòng PT 1');
    expect((screen.getByLabelText('Giờ bắt đầu') as HTMLInputElement).value).toBe('08:10');
    await new Promise(done => setTimeout(done, 50));
    expect(create).toHaveBeenCalledTimes(1);

    await save(user);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][1]).toBe(create.mock.calls[0][1]);
  });

  it('US-24-TC12: lưu xong rồi tạo ca khác thì dùng key mới', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([]));
    const create = vi.spyOn(shiftsApi, 'create').mockResolvedValue(draftThu);
    renderPage();
    await openForm(user);
    await fillForm(user, { date: '2026-11-05', from: '08:10', to: '10:40', location: 'Phòng PT 1' });
    await save(user);
    await screen.findByRole('status');
    await openForm(user);
    await fillForm(user, { date: '2026-11-06', from: '14:00', to: '15:00', location: 'Phòng PT 2' });
    await save(user);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][1]).toMatch(UUID);
    expect(create.mock.calls[1][1]).not.toBe(create.mock.calls[0][1]);
  });

  it('US-24-TC12: 409 SHIFT_OVERLAP hiện thông báo trùng ca dễ hiểu và giữ form', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([]));
    vi.spyOn(shiftsApi, 'create').mockRejectedValue(new ApiError('Ca bị trùng giờ với một ca khác của bạn', 409, 'req-1', undefined, undefined, 'SHIFT_OVERLAP'));
    renderPage();
    await openForm(user);
    await fillForm(user, { date: '2026-11-05', from: '08:10', to: '10:40', location: 'Phòng PT 1' });
    await save(user);
    expect((await screen.findByRole('alert')).textContent).toMatch(/trùng/i);
    expect(screen.getByRole('button', { name: 'Lưu ca nháp' })).toBeTruthy();
    expect((screen.getByLabelText('Địa điểm') as HTMLInputElement).value).toBe('Phòng PT 1');
  });

  it('US-24-TC12: đóng form chưa gửi thì không tạo ca', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([]));
    const create = vi.spyOn(shiftsApi, 'create').mockResolvedValue(draftThu);
    renderPage();
    await openForm(user);
    await fillForm(user, { date: '2026-11-05', from: '08:10', to: '10:40', location: 'Phòng PT 1' });
    await user.click(screen.getByRole('button', { name: 'Đóng' }));
    expect(screen.queryByRole('button', { name: 'Lưu ca nháp' })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  // ---------- Sửa ca nháp và version stale ----------
  it('US-24-TC12: "Sửa" mở form điền sẵn dữ liệu ca; lưu gọi update với id, version hiện tại và key UUID', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([draftThu]));
    const update = vi.spyOn(shiftsApi, 'update').mockResolvedValue({ ...draftThu, location: 'Phòng PT 2', version: 1 });
    renderPage();
    const thursday = await screen.findByRole('region', { name: 'Thứ Năm 05/11' });
    await user.click(within(shiftItem(thursday, '08:10', '10:40')).getByRole('button', { name: 'Sửa' }));
    expect((screen.getByLabelText('Ngày') as HTMLInputElement).value).toBe('2026-11-05');
    expect((screen.getByLabelText('Giờ bắt đầu') as HTMLInputElement).value).toBe('08:10');
    expect((screen.getByLabelText('Giờ kết thúc') as HTMLInputElement).value).toBe('10:40');
    expect((screen.getByLabelText('Địa điểm') as HTMLInputElement).value).toBe('Phòng PT 1');

    await fillForm(user, { location: 'Phòng PT 2' });
    await save(user);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const [id, input, key] = update.mock.calls[0];
    expect(id).toBe('s1');
    expect(input.version).toBe(0);
    expect(input.location).toBe('Phòng PT 2');
    sameInstant(input.startAt, '2026-11-05T08:10:00+07:00');
    sameInstant(input.endAt, '2026-11-05T10:40:00+07:00');
    expect(key).toMatch(UUID);
  });

  it('US-24-TC12: 409 VERSION_CONFLICT báo ca đã đổi, chỉ tải lại khi bấm "Tải lại ca"', async () => {
    const user = userEvent.setup();
    const list = vi.spyOn(shiftsApi, 'list')
      .mockResolvedValueOnce(pageOf([draftThu]))
      .mockResolvedValueOnce(pageOf([{ ...draftThu, location: 'Phòng do tab khác sửa', version: 1 }]));
    vi.spyOn(shiftsApi, 'update').mockRejectedValue(new ApiError('Ca đã được thay đổi. Vui lòng tải lại', 409, 'req-2', undefined, undefined, 'VERSION_CONFLICT'));
    renderPage();
    const thursday = await screen.findByRole('region', { name: 'Thứ Năm 05/11' });
    await user.click(within(shiftItem(thursday, '08:10', '10:40')).getByRole('button', { name: 'Sửa' }));
    await fillForm(user, { location: 'Phòng PT 2' });
    await save(user);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Tải lại ca' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Phòng do tab khác sửa/)).toBeTruthy();
  });
});
