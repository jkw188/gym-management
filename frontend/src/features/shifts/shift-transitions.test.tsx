// Tầng kiểm thử frontend (Vitest, jsdom): US-25 bước 3 – công bố và hủy ca trên trang /trainer/shifts.
// Kiểm tra nút đúng ca, lý do hủy, blocker BOOKED kèm hướng dẫn, 409 tải lại khi bấm, chặn gửi kép, giữ key khi lỗi mạng (TC12; phần UI của TC01, TC03–TC05, TC10).
// Hợp đồng test đặt ra cho Builder (US-25 bước 3), bổ sung vào hợp đồng US-24 bước 3:
//   src/features/shifts/shifts.api.ts thêm vào shiftsApi:
//     get(id: string): Promise<ShiftDetail>                    – GET /api/me/work-shifts/:id (ShiftDetail = Shift & { bookedCount: number })
//     confirm(id: string, input: { version: number }, idempotencyKey: string): Promise<Shift>             – POST /:id/confirm
//     cancel(id: string, input: { version: number; reason: string }, idempotencyKey: string): Promise<Shift> – POST /:id/cancel
//     (kiểu ShiftDetail export từ file này)
//   src/features/shifts/ShiftsPage.tsx:
//     - Ca "Nháp" chưa bắt đầu có nút "Công bố ca". Ca Nháp/Công bố chưa bắt đầu có nút "Hủy ca". Ca khác không có hai nút này.
//     - "Công bố ca" gọi confirm với version đang hiển thị và một UUID; thành công: role="status" "Đã công bố ca", tải lại danh sách từ REST.
//     - "Hủy ca" mở role="dialog" tên "Hủy ca": gọi get(id) lấy bookedCount; ô nhãn "Lý do hủy"; nút "Xác nhận hủy ca", "Đóng".
//       Lý do sau trim dưới 10 ký tự thì không gọi API. bookedCount > 0: hiện số lịch đặt và hướng dẫn Member hoặc Staff/Admin
//       hủy từng lịch trước (US-29), không có nút "hủy tất cả".
//     - Hủy thành công: đóng dialog, role="status" "Đã hủy ca", tải lại danh sách.
//     - 409 VERSION_CONFLICT hoặc INVALID_SHIFT_STATE: role="alert" + nút "Tải lại ca"; chỉ tải lại khi bấm.
//     - 409 SHIFT_HAS_BOOKINGS: role="alert" có hướng dẫn hủy từng lịch. Lỗi mạng: alert, giữ lý do, bấm lại dùng đúng key cũ.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { shiftsApi, type Shift, type ShiftDetail, type ShiftPage } from './shifts.api';
import { ShiftsPage } from './ShiftsPage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// "Bây giờ": thứ Tư 04/11/2026 10:00 giờ Việt Nam → tuần hiện tại 02/11 – 08/11.
const NOW = new Date('2026-11-04T03:00:00.000Z');
const REASON = 'PT bận việc gia đình';

const shift = (id: string, startAt: string, endAt: string, status: Shift['status'] = 'SCHEDULED', version = 0): Shift =>
  ({ id, startAt, endAt, location: 'Phòng PT 1', status, version, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' });
const pageOf = (items: Shift[]): ShiftPage =>
  ({ profileLinked: true, items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0 });
const detailOf = (item: Shift, bookedCount = 0): ShiftDetail => ({ ...item, bookedCount });
const conflict = (code: string, message = 'Xung đột') => new ApiError(message, 409, 'req-1', undefined, undefined, code);

// Dữ liệu tuần 02/11 – 08/11 (giờ trong comment là giờ Việt Nam).
const draftThu = shift('s1', '2026-11-05T01:00:00.000Z', '2026-11-05T03:00:00.000Z', 'SCHEDULED', 2);  // T5 08:00–10:00 Nháp
const confirmedFri = shift('s2', '2026-11-06T02:00:00.000Z', '2026-11-06T03:00:00.000Z', 'CONFIRMED', 1); // T6 09:00–10:00
const startedWed = shift('s3', '2026-11-04T02:00:00.000Z', '2026-11-04T04:00:00.000Z', 'CONFIRMED');     // T4 09:00–11:00 đang diễn ra
const pastDraftWed = shift('s4', '2026-11-04T00:00:00.000Z', '2026-11-04T01:00:00.000Z');                 // T4 07:00–08:00 Nháp đã qua
const completedTue = shift('s5', '2026-11-03T00:00:00.000Z', '2026-11-03T01:00:00.000Z', 'COMPLETED');    // T3 07:00–08:00
const cancelledSat = shift('s6', '2026-11-07T07:00:00.000Z', '2026-11-07T08:00:00.000Z', 'CANCELLED');    // T7 14:00–15:00
const weekItems = [completedTue, pastDraftWed, startedWed, draftThu, confirmedFri, cancelledSat];

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
const draftItem = async () => shiftItem(await screen.findByRole('region', { name: 'Thứ Năm 05/11' }), '08:00', '10:00');
const confirmedItem = async () => shiftItem(await screen.findByRole('region', { name: 'Thứ Sáu 06/11' }), '09:00', '10:00');

type User = ReturnType<typeof userEvent.setup>;
// Mở dialog hủy của ca và chờ tải xong chi tiết ca.
async function openCancel(user: User, item: HTMLElement) {
  await user.click(within(item).getByRole('button', { name: 'Hủy ca' }));
  const dialog = await screen.findByRole('dialog', { name: 'Hủy ca' });
  await within(dialog).findByLabelText('Lý do hủy');
  return dialog;
}
async function typeReason(user: User, dialog: HTMLElement, text: string) {
  const field = within(dialog).getByLabelText('Lý do hủy');
  await user.clear(field);
  await user.type(field, text);
}
const submitCancel = (user: User, dialog: HTMLElement) => user.click(within(dialog).getByRole('button', { name: 'Xác nhận hủy ca' }));

describe('US-25 bước 3: công bố và hủy ca trên trang ca làm việc', () => {
  // ---------- Nút đúng ca ----------
  it('US-25-TC01: chỉ ca Nháp chưa bắt đầu có nút "Công bố ca"', async () => {
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf(weekItems));
    renderPage();
    expect(within(await draftItem()).getByRole('button', { name: 'Công bố ca' })).toBeTruthy();
    expect(within(await confirmedItem()).queryByRole('button', { name: 'Công bố ca' })).toBeNull();
    expect(within(shiftItem(dayRegion('Thứ Tư 04/11'), '07:00', '08:00')).queryByRole('button', { name: 'Công bố ca' })).toBeNull();
    expect(within(shiftItem(dayRegion('Thứ Ba 03/11'), '07:00', '08:00')).queryByRole('button', { name: 'Công bố ca' })).toBeNull();
    expect(within(shiftItem(dayRegion('Thứ Bảy 07/11'), '14:00', '15:00')).queryByRole('button', { name: 'Công bố ca' })).toBeNull();
  });

  it('US-25-TC07: chỉ ca Nháp/Công bố chưa bắt đầu có nút "Hủy ca"; ca đang diễn ra, đã qua, Hoàn tất, Hủy thì không', async () => {
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf(weekItems));
    renderPage();
    expect(within(await draftItem()).getByRole('button', { name: 'Hủy ca' })).toBeTruthy();
    expect(within(await confirmedItem()).getByRole('button', { name: 'Hủy ca' })).toBeTruthy();
    expect(within(shiftItem(dayRegion('Thứ Tư 04/11'), '09:00', '11:00')).queryByRole('button', { name: 'Hủy ca' })).toBeNull();
    expect(within(shiftItem(dayRegion('Thứ Tư 04/11'), '07:00', '08:00')).queryByRole('button', { name: 'Hủy ca' })).toBeNull();
    expect(within(shiftItem(dayRegion('Thứ Ba 03/11'), '07:00', '08:00')).queryByRole('button', { name: 'Hủy ca' })).toBeNull();
    expect(within(shiftItem(dayRegion('Thứ Bảy 07/11'), '14:00', '15:00')).queryByRole('button', { name: 'Hủy ca' })).toBeNull();
  });

  // ---------- Công bố ----------
  it('US-25-TC01: "Công bố ca" gửi version đang hiển thị và một UUID; xong báo "Đã công bố ca" và tải lại từ REST', async () => {
    const user = userEvent.setup();
    const list = vi.spyOn(shiftsApi, 'list')
      .mockResolvedValueOnce(pageOf([draftThu]))
      .mockResolvedValueOnce(pageOf([{ ...draftThu, status: 'CONFIRMED', version: 3 }]));
    const confirm = vi.spyOn(shiftsApi, 'confirm').mockResolvedValue({ ...draftThu, status: 'CONFIRMED', version: 3 });
    renderPage();
    await user.click(within(await draftItem()).getByRole('button', { name: 'Công bố ca' }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const [id, input, key] = confirm.mock.calls[0];
    expect(id).toBe('s1');
    expect(input).toEqual({ version: 2 });
    expect(key).toMatch(UUID);
    expect((await screen.findByRole('status')).textContent).toMatch(/Đã công bố ca/i);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(within(await draftItem()).getByText('Công bố')).toBeTruthy();
  });

  it('US-25-TC12: sau công bố không báo booking cần PT duyệt, trạng thái lấy từ REST (không cần realtime)', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list')
      .mockResolvedValueOnce(pageOf([draftThu]))
      .mockResolvedValueOnce(pageOf([{ ...draftThu, status: 'CONFIRMED', version: 3 }]));
    vi.spyOn(shiftsApi, 'confirm').mockResolvedValue({ ...draftThu, status: 'CONFIRMED', version: 3 });
    renderPage();
    await user.click(within(await draftItem()).getByRole('button', { name: 'Công bố ca' }));
    await screen.findByRole('status');
    await waitFor(async () => expect(within(await draftItem()).getByText('Công bố')).toBeTruthy());
    expect(screen.queryByText(/duyệt/i)).toBeNull();
    expect(screen.queryByText(/WAITING_APPROVAL/i)).toBeNull();
  });

  it('US-25-TC10: đang công bố thì nút bị khóa, bấm nhiều lần chỉ gọi API một lần', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([draftThu]));
    let resolve!: (value: Shift) => void;
    const confirm = vi.spyOn(shiftsApi, 'confirm').mockReturnValue(new Promise(done => { resolve = done; }));
    renderPage();
    const button = within(await draftItem()).getByRole('button', { name: 'Công bố ca' });
    await user.click(button);
    await user.click(button);
    await user.dblClick(button);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve({ ...draftThu, status: 'CONFIRMED', version: 3 }));
  });

  for (const code of ['VERSION_CONFLICT', 'INVALID_SHIFT_STATE'] as const) {
    it(`US-25-TC03: công bố bị 409 ${code} thì báo ca đã đổi, chỉ tải lại khi bấm "Tải lại ca"`, async () => {
      const user = userEvent.setup();
      const list = vi.spyOn(shiftsApi, 'list')
        .mockResolvedValueOnce(pageOf([draftThu]))
        .mockResolvedValueOnce(pageOf([{ ...draftThu, status: 'CONFIRMED', version: 3 }]));
      vi.spyOn(shiftsApi, 'confirm').mockRejectedValue(conflict(code, 'Ca đã được thay đổi'));
      renderPage();
      await user.click(within(await draftItem()).getByRole('button', { name: 'Công bố ca' }));
      expect(await screen.findByRole('alert')).toBeTruthy();
      expect(list).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole('button', { name: 'Tải lại ca' }));
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      expect(within(await draftItem()).getByText('Công bố')).toBeTruthy();
    });
  }

  it('US-25-TC03: công bố bị 409 SHIFT_ALREADY_STARTED thì hiện lỗi, ca vẫn hiển thị Nháp', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([draftThu]));
    vi.spyOn(shiftsApi, 'confirm').mockRejectedValue(conflict('SHIFT_ALREADY_STARTED', 'Ca đã bắt đầu'));
    renderPage();
    await user.click(within(await draftItem()).getByRole('button', { name: 'Công bố ca' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(within(await draftItem()).getByText('Nháp')).toBeTruthy();
  });

  it('US-25-TC10: công bố lỗi mạng thì báo lỗi, không tự gửi lại; bấm lại dùng đúng key cũ', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([draftThu]));
    const confirm = vi.spyOn(shiftsApi, 'confirm')
      .mockRejectedValueOnce(new ApiError('Không kết nối được máy chủ'))
      .mockResolvedValueOnce({ ...draftThu, status: 'CONFIRMED', version: 3 });
    renderPage();
    await user.click(within(await draftItem()).getByRole('button', { name: 'Công bố ca' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    await new Promise(done => setTimeout(done, 50));
    expect(confirm).toHaveBeenCalledTimes(1);
    await user.click(within(await draftItem()).getByRole('button', { name: 'Công bố ca' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(confirm.mock.calls[1][2]).toBe(confirm.mock.calls[0][2]);
  });

  // ---------- Hủy ca ----------
  it('US-25-TC04: "Hủy ca" mở dialog có ô lý do; gửi version, lý do và UUID; xong đóng dialog, báo "Đã hủy ca", tải lại', async () => {
    const user = userEvent.setup();
    const list = vi.spyOn(shiftsApi, 'list')
      .mockResolvedValueOnce(pageOf([confirmedFri]))
      .mockResolvedValueOnce(pageOf([{ ...confirmedFri, status: 'CANCELLED', version: 2 }]));
    const get = vi.spyOn(shiftsApi, 'get').mockResolvedValue(detailOf(confirmedFri));
    const cancel = vi.spyOn(shiftsApi, 'cancel').mockResolvedValue({ ...confirmedFri, status: 'CANCELLED', version: 2 });
    renderPage();
    const dialog = await openCancel(user, await confirmedItem());
    expect(get).toHaveBeenCalledWith('s2');
    await typeReason(user, dialog, REASON);
    await submitCancel(user, dialog);

    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    const [id, input, key] = cancel.mock.calls[0];
    expect(id).toBe('s2');
    expect(input.version).toBe(1);
    expect(input.reason.trim()).toBe(REASON);
    expect(key).toMatch(UUID);
    expect((await screen.findByRole('status')).textContent).toMatch(/Đã hủy ca/i);
    expect(screen.queryByRole('dialog', { name: 'Hủy ca' })).toBeNull();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(within(await confirmedItem()).getByText('Hủy')).toBeTruthy();
  });

  it('US-25-TC04: lý do dưới 10 ký tự sau trim thì không gọi API', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([confirmedFri]));
    vi.spyOn(shiftsApi, 'get').mockResolvedValue(detailOf(confirmedFri));
    const cancel = vi.spyOn(shiftsApi, 'cancel').mockResolvedValue({ ...confirmedFri, status: 'CANCELLED', version: 2 });
    renderPage();
    const dialog = await openCancel(user, await confirmedItem());
    await typeReason(user, dialog, '   ngắn   ');
    await submitCancel(user, dialog);
    await new Promise(done => setTimeout(done, 50));
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Hủy ca' })).toBeTruthy();
  });

  it('US-25-TC04: đóng dialog chưa gửi thì không hủy ca', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([confirmedFri]));
    vi.spyOn(shiftsApi, 'get').mockResolvedValue(detailOf(confirmedFri));
    const cancel = vi.spyOn(shiftsApi, 'cancel').mockResolvedValue({ ...confirmedFri, status: 'CANCELLED', version: 2 });
    renderPage();
    const dialog = await openCancel(user, await confirmedItem());
    await typeReason(user, dialog, REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Đóng' }));
    expect(screen.queryByRole('dialog', { name: 'Hủy ca' })).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('US-25-TC12: ca còn lịch đặt thì dialog hiện số lịch và hướng dẫn hủy từng lịch, không có nút "hủy tất cả"', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([confirmedFri]));
    vi.spyOn(shiftsApi, 'get').mockResolvedValue(detailOf(confirmedFri, 2));
    renderPage();
    const dialog = await openCancel(user, await confirmedItem());
    const text = dialog.textContent ?? '';
    expect(text).toMatch(/2 lịch đặt/i);
    expect(text).toMatch(/từng lịch/i);
    expect(text).toMatch(/Member/);
    expect(text).toMatch(/Staff|Admin/);
    expect(within(dialog).queryByRole('button', { name: /tất cả/i })).toBeNull();
    expect(screen.queryByText(/duyệt/i)).toBeNull();
  });

  it('US-25-TC05: server trả 409 SHIFT_HAS_BOOKINGS (có lịch mới sau khi mở dialog) thì báo lỗi kèm hướng dẫn, không đóng dialog', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([confirmedFri]));
    vi.spyOn(shiftsApi, 'get').mockResolvedValue(detailOf(confirmedFri, 0));
    vi.spyOn(shiftsApi, 'cancel').mockRejectedValue(conflict('SHIFT_HAS_BOOKINGS', 'Ca còn lịch đặt'));
    renderPage();
    const dialog = await openCancel(user, await confirmedItem());
    await typeReason(user, dialog, REASON);
    await submitCancel(user, dialog);
    expect((await screen.findByRole('alert')).textContent).toMatch(/từng lịch/i);
    expect(screen.getByRole('dialog', { name: 'Hủy ca' })).toBeTruthy();
    expect(within(await confirmedItem()).getByText('Công bố')).toBeTruthy();
  });

  it('US-25-TC10: đang hủy thì nút "Xác nhận hủy ca" bị khóa, bấm nhiều lần chỉ gọi API một lần', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([confirmedFri]));
    vi.spyOn(shiftsApi, 'get').mockResolvedValue(detailOf(confirmedFri));
    let resolve!: (value: Shift) => void;
    const cancel = vi.spyOn(shiftsApi, 'cancel').mockReturnValue(new Promise(done => { resolve = done; }));
    renderPage();
    const dialog = await openCancel(user, await confirmedItem());
    await typeReason(user, dialog, REASON);
    const button = within(dialog).getByRole('button', { name: 'Xác nhận hủy ca' });
    await user.click(button);
    await user.click(button);
    await user.dblClick(button);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve({ ...confirmedFri, status: 'CANCELLED', version: 2 }));
  });

  it('US-25-TC10: hủy lỗi mạng thì báo lỗi, giữ lý do, không tự gửi lại; bấm lại dùng đúng key cũ', async () => {
    const user = userEvent.setup();
    vi.spyOn(shiftsApi, 'list').mockResolvedValue(pageOf([confirmedFri]));
    vi.spyOn(shiftsApi, 'get').mockResolvedValue(detailOf(confirmedFri));
    const cancel = vi.spyOn(shiftsApi, 'cancel')
      .mockRejectedValueOnce(new ApiError('Không kết nối được máy chủ'))
      .mockResolvedValueOnce({ ...confirmedFri, status: 'CANCELLED', version: 2 });
    renderPage();
    const dialog = await openCancel(user, await confirmedItem());
    await typeReason(user, dialog, REASON);
    await submitCancel(user, dialog);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((within(dialog).getByLabelText('Lý do hủy') as HTMLTextAreaElement).value.trim()).toBe(REASON);
    await new Promise(done => setTimeout(done, 50));
    expect(cancel).toHaveBeenCalledTimes(1);
    await submitCancel(user, dialog);
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
    expect(cancel.mock.calls[1][2]).toBe(cancel.mock.calls[0][2]);
  });

  it('US-25-TC10: hủy bị 409 VERSION_CONFLICT thì báo ca đã đổi, chỉ tải lại khi bấm "Tải lại ca"', async () => {
    const user = userEvent.setup();
    const list = vi.spyOn(shiftsApi, 'list')
      .mockResolvedValueOnce(pageOf([confirmedFri]))
      .mockResolvedValueOnce(pageOf([{ ...confirmedFri, status: 'CANCELLED', version: 2 }]));
    vi.spyOn(shiftsApi, 'get').mockResolvedValue(detailOf(confirmedFri));
    vi.spyOn(shiftsApi, 'cancel').mockRejectedValue(conflict('VERSION_CONFLICT', 'Ca đã được thay đổi'));
    renderPage();
    const dialog = await openCancel(user, await confirmedItem());
    await typeReason(user, dialog, REASON);
    await submitCancel(user, dialog);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Tải lại ca' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(within(await confirmedItem()).getByText('Hủy')).toBeTruthy();
  });
});
