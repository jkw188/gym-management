// Tầng kiểm thử frontend (Vitest, jsdom): US-47 bước 3 – trang inbox /member/notifications và badge chuông.
// Kiểm tra lọc/phân trang, mở chi tiết rồi mới mark-read, socket chỉ là tín hiệu tải lại, nội dung an toàn, đổi account không lộ cache.
// Hợp đồng test đặt ra cho Builder (US-47 bước 3):
//   src/features/notifications/inbox.api.ts:
//     export const inboxApi = {
//       list(query: { readState: 'ALL'|'UNREAD'|'READ'; page: number; limit: number }): Promise<InboxPage>,
//       unreadCount(): Promise<{ unreadCount: number; asOf: string }>,
//       detail(id: string): Promise<InboxDetail>,
//       markRead(id: string): Promise<{ id: string; readAt: string }>,
//     }  (gọi GET/POST /api/me/notifications… qua apiClient; kiểu InboxItem, InboxPage, InboxDetail export từ file này)
//   src/features/notifications/NotificationsPage.tsx: export function NotificationsPage()
//     - Tiêu đề "Thông báo"; đang tải hiện chữ "Đang tải"; rỗng hiện "Chưa có thông báo nào."; lỗi hiện role="alert" và nút "Thử lại".
//     - Nút lọc "Tất cả" / "Chưa đọc" / "Đã đọc" (role button); đổi lọc thì về trang 1.
//     - Phân trang: nút "Trang trước" / "Trang sau" (disabled ở đầu/cuối), chữ "Trang <page>/<totalPages>".
//     - Hiện số chưa đọc của server dạng "Chưa đọc: <n>".
//     - Mỗi thông báo là một nút có tên chứa title; bấm thì gọi detail(id), hiện body, detail thành công MỚI gọi markRead(id),
//       markRead thành công thì tải lại số chưa đọc từ server. markRead lỗi thì không giảm số, hiện role="alert".
//   src/features/notifications/NotificationBell.tsx: export function NotificationBell()
//     - Link tới /member/notifications có aria-label "Thông báo: <n> chưa đọc" theo unreadCount() của server.
//   Cả trang và chuông: notificationFeed.subscribe(listener) là tín hiệu socket → tải lại từ REST (không tự mark-read);
//   window 'focus' → tải lại; apiClient.subscribe báo đổi account → xóa dữ liệu account cũ và tải lại.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import type { AuthSnapshot, AuthUser } from '../auth/auth.types';
import { inboxApi, type InboxDetail, type InboxItem, type InboxPage } from './inbox.api';
import { NotificationBell } from './NotificationBell';
import { notificationFeed } from './notification-feed';
import { NotificationsPage } from './NotificationsPage';

// Không mở socket thật trong test.
vi.mock('socket.io-client', () => ({ io: vi.fn(), default: vi.fn() }));

const userA: AuthUser = { id: 'a'.repeat(24), fullName: 'Hội viên A', phone: '+84901234567', roleCode: 'MEMBER' };
const userB: AuthUser = { id: 'b'.repeat(24), fullName: 'Hội viên B', phone: '+84907654321', roleCode: 'MEMBER' };
const asOf = '2026-11-05T03:00:00.000Z';

const item = (id: string, title: string, readAt?: string): InboxItem =>
  ({ id, title, bodyPreview: `Xem trước ${title}`, createdAt: asOf, ...(readAt ? { readAt } : {}) });
const page = (items: InboxItem[], extra: Partial<InboxPage> = {}): InboxPage =>
  ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0, unreadCount: items.filter(entry => !entry.readAt).length, asOf, ...extra });
const detailOf = (entry: InboxItem, body = `Nội dung đầy đủ của ${entry.title}`): InboxDetail =>
  ({ id: entry.id, title: entry.title, body, createdAt: entry.createdAt, ...(entry.readAt ? { readAt: entry.readAt } : {}) });

// ---------- Giả lập đăng nhập và tín hiệu socket ----------
let snapshot: AuthSnapshot;
let authListeners: Array<() => void>;
let feedListeners: Array<() => void>;

beforeEach(() => {
  snapshot = { status: 'authenticated', user: userA };
  authListeners = [];
  feedListeners = [];
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(listener => {
    authListeners.push(listener);
    return () => { authListeners = authListeners.filter(entry => entry !== listener); };
  });
  vi.spyOn(notificationFeed, 'subscribe').mockImplementation(listener => {
    feedListeners.push(listener);
    return () => { feedListeners = feedListeners.filter(entry => entry !== listener); };
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Socket báo có thông báo mới (hoặc reconnect xong sync).
const socketSignal = () => act(() => { for (const listener of [...feedListeners]) listener(); });
// Đổi account (logout rồi đăng nhập account khác).
const switchAccount = (user: AuthUser) => act(() => {
  snapshot = { status: 'authenticated', user };
  for (const listener of [...authListeners]) listener();
});

const renderPage = () => render(<MemoryRouter initialEntries={['/member/notifications']}><NotificationsPage /></MemoryRouter>);
const renderBell = () => render(<MemoryRouter><NotificationBell /></MemoryRouter>);
const bellLabel = (count: number) => `Thông báo: ${count} chưa đọc`;

describe('US-47 bước 3: trang inbox và badge chuông', () => {
  // ---------- US-47-AC02: đọc/đã đọc trên giao diện ----------
  it('US-47-TC05: mở danh sách và nhận tín hiệu socket (toast) không tự gọi mark-read', async () => {
    const list = vi.spyOn(inboxApi, 'list').mockResolvedValue(page([item('n1', 'Gói tập kích hoạt')]));
    vi.spyOn(inboxApi, 'unreadCount').mockResolvedValue({ unreadCount: 1, asOf });
    const markRead = vi.spyOn(inboxApi, 'markRead');
    const detail = vi.spyOn(inboxApi, 'detail');
    renderPage();
    expect(await screen.findByRole('button', { name: /Gói tập kích hoạt/ })).toBeDefined();

    await socketSignal();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2));

    expect(markRead).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
  });

  it('US-47-TC07: bấm thông báo thì hiện body trước, sau đó mới mark-read và số chưa đọc lấy lại từ server', async () => {
    const entry = item('n1', 'Gói tập kích hoạt');
    // Server: trước khi read có 2 chưa đọc, sau khi read thành công còn 1 (list và unread-count cùng phản ánh).
    let readDone = false;
    vi.spyOn(inboxApi, 'list').mockImplementation(async () =>
      page([readDone ? { ...entry, readAt: asOf } : entry, item('n2', 'Thanh toán thành công')]));
    const unread = vi.spyOn(inboxApi, 'unreadCount').mockImplementation(async () => ({ unreadCount: readDone ? 1 : 2, asOf }));
    const order: string[] = [];
    vi.spyOn(inboxApi, 'detail').mockImplementation(async (id: string) => {
      order.push(`detail:${id}`);
      return detailOf(entry, 'Gói Gym 1 tháng, hạn dùng đến 2026-12-04');
    });
    const markRead = vi.spyOn(inboxApi, 'markRead').mockImplementation(async (id: string) => {
      order.push(`read:${id}`);
      readDone = true;
      return { id, readAt: asOf };
    });
    renderPage();
    expect(await screen.findByText('Chưa đọc: 2')).toBeDefined();

    await userEvent.click(await screen.findByRole('button', { name: /Gói tập kích hoạt/ }));

    expect(await screen.findByText('Gói Gym 1 tháng, hạn dùng đến 2026-12-04')).toBeDefined();
    await waitFor(() => expect(markRead).toHaveBeenCalledWith('n1'));
    expect(order).toEqual(['detail:n1', 'read:n1']);
    expect(await screen.findByText('Chưa đọc: 1')).toBeDefined();
    expect(unread).toHaveBeenCalled();
  });

  it('US-47-TC07: mở chi tiết lỗi thì KHÔNG gọi mark-read (chỉ đánh dấu khi đã thấy nội dung)', async () => {
    vi.spyOn(inboxApi, 'list').mockResolvedValue(page([item('n1', 'Gói tập kích hoạt')]));
    vi.spyOn(inboxApi, 'unreadCount').mockResolvedValue({ unreadCount: 1, asOf });
    vi.spyOn(inboxApi, 'detail').mockRejectedValue(new ApiError('Không tìm thấy thông báo', 404, 'req-1', undefined, undefined, 'NOT_FOUND'));
    const markRead = vi.spyOn(inboxApi, 'markRead');
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /Gói tập kích hoạt/ }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(markRead).not.toHaveBeenCalled();
    expect(screen.getByText('Chưa đọc: 1')).toBeDefined();
  });

  // ---------- US-47-TC08: lọc và phân trang ----------
  it('US-47-TC08: lần đầu tải readState ALL trang 1; bấm "Chưa đọc" thì tải UNREAD về trang 1', async () => {
    const list = vi.spyOn(inboxApi, 'list').mockResolvedValue(page([item('n1', 'Gói tập kích hoạt')]));
    vi.spyOn(inboxApi, 'unreadCount').mockResolvedValue({ unreadCount: 1, asOf });
    renderPage();
    await screen.findByRole('button', { name: /Gói tập kích hoạt/ });
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ readState: 'ALL', page: 1 }));

    await userEvent.click(screen.getByRole('button', { name: 'Chưa đọc' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ readState: 'UNREAD', page: 1 })));

    await userEvent.click(screen.getByRole('button', { name: 'Đã đọc' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ readState: 'READ', page: 1 })));
  });

  it('US-47-TC08: phân trang "Trang sau"/"Trang trước" theo totalPages của server, nút bị khóa ở đầu/cuối', async () => {
    const list = vi.spyOn(inboxApi, 'list').mockImplementation(async (query: { readState: string; page: number; limit: number }) =>
      page([item(`p${query.page}`, `Thông báo trang ${query.page}`)], { page: query.page, total: 3, totalPages: 2, limit: query.limit }));
    vi.spyOn(inboxApi, 'unreadCount').mockResolvedValue({ unreadCount: 3, asOf });
    renderPage();
    expect(await screen.findByText('Trang 1/2')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Trang trước' }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Trang sau' }));

    expect(await screen.findByText('Trang 2/2')).toBeDefined();
    expect(await screen.findByRole('button', { name: /Thông báo trang 2/ })).toBeDefined();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    expect((screen.getByRole('button', { name: 'Trang sau' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('US-47-TC08: inbox rỗng hiện "Chưa có thông báo nào."', async () => {
    vi.spyOn(inboxApi, 'list').mockResolvedValue(page([]));
    vi.spyOn(inboxApi, 'unreadCount').mockResolvedValue({ unreadCount: 0, asOf });
    renderPage();
    expect(await screen.findByText('Chưa có thông báo nào.')).toBeDefined();
  });

  // ---------- US-47-AC03: offline/realtime/nội dung an toàn ----------
  it('US-47-TC09: không có socket vẫn đọc lịch sử qua REST, có trạng thái "Đang tải" trước khi có dữ liệu', async () => {
    let resolve!: (value: InboxPage) => void;
    vi.spyOn(inboxApi, 'list').mockReturnValue(new Promise(done => { resolve = done; }));
    vi.spyOn(inboxApi, 'unreadCount').mockResolvedValue({ unreadCount: 1, asOf });
    renderPage();

    expect(screen.getByText(/Đang tải/)).toBeDefined();
    resolve(page([item('n1', 'Thông báo cũ khi offline')]));

    expect(await screen.findByRole('button', { name: /Thông báo cũ khi offline/ })).toBeDefined();
  });

  it('US-47-TC09: socket báo nhiều lần (event lặp/reconnect) thì tải lại từ REST, mỗi id chỉ hiện một lần', async () => {
    const list = vi.spyOn(inboxApi, 'list')
      .mockResolvedValueOnce(page([item('n1', 'Thông báo một')]))
      .mockResolvedValue(page([item('n2', 'Thông báo hai'), item('n1', 'Thông báo một')]));
    vi.spyOn(inboxApi, 'unreadCount').mockResolvedValue({ unreadCount: 2, asOf });
    renderPage();
    await screen.findByRole('button', { name: /Thông báo một/ });

    await socketSignal();
    await socketSignal();

    expect(await screen.findByRole('button', { name: /Thông báo hai/ })).toBeDefined();
    expect(screen.getAllByRole('button', { name: /Thông báo một/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Thông báo hai/ })).toHaveLength(1);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('US-47-TC10: event socket lặp chỉ tải lại dữ liệu đọc, không gửi lệnh ghi nào (không mark-read, không tạo sale/thu)', async () => {
    vi.spyOn(inboxApi, 'list').mockResolvedValue(page([item('n1', 'Gói tập kích hoạt')]));
    vi.spyOn(inboxApi, 'unreadCount').mockResolvedValue({ unreadCount: 1, asOf });
    const markRead = vi.spyOn(inboxApi, 'markRead');
    // Mọi request đi qua apiClient: ghi lại method để chắc không có POST/PUT/PATCH/DELETE nào.
    const request = vi.spyOn(apiClient, 'request');
    renderPage();
    await screen.findByRole('button', { name: /Gói tập kích hoạt/ });

    for (let index = 0; index < 3; index += 1) await socketSignal();

    expect(markRead).not.toHaveBeenCalled();
    for (const [, init] of request.mock.calls) expect((init?.method ?? 'GET').toUpperCase()).toBe('GET');
  });

  it('US-47-TC11: title/body chứa HTML và URL ngoài được hiện như chữ, không tạo thẻ HTML hay link ra ngoài', async () => {
    const entry = item('n1', '<b>Khuyến mãi</b>');
    const body = 'Bấm <a href="https://evil.example/login">đây</a> <img src="x" onerror="alert(1)"> https://evil.example/pay';
    vi.spyOn(inboxApi, 'list').mockResolvedValue(page([entry]));
    vi.spyOn(inboxApi, 'unreadCount').mockResolvedValue({ unreadCount: 1, asOf });
    vi.spyOn(inboxApi, 'detail').mockResolvedValue(detailOf(entry, body));
    vi.spyOn(inboxApi, 'markRead').mockResolvedValue({ id: 'n1', readAt: asOf });
    const { container } = renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /<b>Khuyến mãi<\/b>/ }));

    expect(await screen.findByText(body)).toBeDefined();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('a[href^="http"]')).toBeNull();
  });

  it('US-47-TC12: mark-read lỗi (DB 503) thì không giảm số chưa đọc giả, hiện lỗi', async () => {
    const entry = item('n1', 'Gói tập kích hoạt');
    vi.spyOn(inboxApi, 'list').mockResolvedValue(page([entry, item('n2', 'Thanh toán thành công')]));
    vi.spyOn(inboxApi, 'unreadCount').mockResolvedValue({ unreadCount: 2, asOf });
    vi.spyOn(inboxApi, 'detail').mockResolvedValue(detailOf(entry));
    vi.spyOn(inboxApi, 'markRead').mockRejectedValue(new ApiError('Hệ thống tạm thời gián đoạn', 503, 'req-2', undefined, undefined, 'SERVICE_UNAVAILABLE'));
    renderPage();
    expect(await screen.findByText('Chưa đọc: 2')).toBeDefined();

    await userEvent.click(await screen.findByRole('button', { name: /Gói tập kích hoạt/ }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('Chưa đọc: 2')).toBeDefined();
    expect(screen.queryByText('Chưa đọc: 1')).toBeNull();
  });

  it('US-47-TC12: tải danh sách lỗi thì hiện lỗi và nút "Thử lại"; bấm thì tải lại được', async () => {
    const list = vi.spyOn(inboxApi, 'list')
      .mockRejectedValueOnce(new ApiError('Hệ thống tạm thời gián đoạn', 503, 'req-3', undefined, undefined, 'SERVICE_UNAVAILABLE'))
      .mockResolvedValue(page([item('n1', 'Gói tập kích hoạt')]));
    vi.spyOn(inboxApi, 'unreadCount').mockResolvedValue({ unreadCount: 1, asOf });
    renderPage();

    expect(await screen.findByRole('alert')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));

    expect(await screen.findByRole('button', { name: /Gói tập kích hoạt/ })).toBeDefined();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('US-47-TC12: đổi account thì không còn hiện thông báo của account trước, tải lại cho account mới', async () => {
    const list = vi.spyOn(inboxApi, 'list').mockImplementation(async () =>
      (snapshot.user?.id === userA.id ? page([item('a1', 'Riêng của A')]) : page([item('b1', 'Riêng của B')])));
    vi.spyOn(inboxApi, 'unreadCount').mockResolvedValue({ unreadCount: 1, asOf });
    renderPage();
    await screen.findByRole('button', { name: /Riêng của A/ });

    await switchAccount(userB);

    expect(await screen.findByRole('button', { name: /Riêng của B/ })).toBeDefined();
    expect(screen.queryByText(/Riêng của A/)).toBeNull();
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // ---------- Badge chuông ----------
  it('US-47-TC07: badge chuông hiện số chưa đọc lấy từ server', async () => {
    vi.spyOn(inboxApi, 'unreadCount').mockResolvedValue({ unreadCount: 3, asOf });
    renderBell();
    const link = await screen.findByRole('link', { name: bellLabel(3) });
    expect(link.getAttribute('href')).toBe('/member/notifications');
  });

  it('US-47-TC09: socket báo có thông báo mới thì badge tải lại số từ server (không tự cộng)', async () => {
    const unread = vi.spyOn(inboxApi, 'unreadCount').mockResolvedValueOnce({ unreadCount: 1, asOf }).mockResolvedValue({ unreadCount: 2, asOf });
    renderBell();
    await screen.findByRole('link', { name: bellLabel(1) });

    await socketSignal();

    expect(await screen.findByRole('link', { name: bellLabel(2) })).toBeDefined();
    expect(unread).toHaveBeenCalledTimes(2);
  });

  it('US-47-TC12: nhiều tab – quay lại tab (window focus) thì badge tải lại số từ server', async () => {
    const unread = vi.spyOn(inboxApi, 'unreadCount').mockResolvedValueOnce({ unreadCount: 2, asOf }).mockResolvedValue({ unreadCount: 0, asOf });
    renderBell();
    await screen.findByRole('link', { name: bellLabel(2) });

    await act(async () => { window.dispatchEvent(new Event('focus')); });

    expect(await screen.findByRole('link', { name: bellLabel(0) })).toBeDefined();
    expect(unread).toHaveBeenCalledTimes(2);
  });

  it('US-47-TC12: đổi account thì badge không giữ số của account trước', async () => {
    vi.spyOn(inboxApi, 'unreadCount').mockImplementation(async () =>
      ({ unreadCount: snapshot.user?.id === userA.id ? 5 : 0, asOf }));
    renderBell();
    await screen.findByRole('link', { name: bellLabel(5) });

    await switchAccount(userB);

    expect(await screen.findByRole('link', { name: bellLabel(0) })).toBeDefined();
    expect(screen.queryByRole('link', { name: bellLabel(5) })).toBeNull();
  });
});
