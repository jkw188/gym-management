import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { BroadcastsPage } from './BroadcastsPage';
import { broadcastsApi as api, pendingBroadcast } from './broadcasts.api';

const auth = vi.hoisted(() => ({ user: { id: 'admin-a', roleCode: 'ADMIN' } }));
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => auth }));
const preview = { previewId: 'a'.repeat(24), version: 0, recipientCount: 3, title: '<b>Lịch</b>', body: '<script>bad()</script>',
  audienceSummary: 'Vai trò: MEMBER, TRAINER', snapshotAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString() };
const sent = { broadcastId: preview.previewId, notificationId: 'b'.repeat(24), status: 'SENT' as const, recipientCount: 3, dispatchStatus: 'READY' };
const detail = { ...preview, ...sent, counts: { snapshot: 3, sent: 3, delivered: 0, read: 0 }, createdAt: preview.snapshotAt, asOf: preview.snapshotAt };
const tree = (path = '/admin/notifications/new') => <MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/admin/notifications/new" element={<BroadcastsPage />} />
  <Route path="/admin/notifications/:id" element={<BroadcastsPage />} />
  <Route path="/admin/notifications" element={<BroadcastsPage />} />
</Routes></MemoryRouter>;
const mount = (path = '/admin/notifications/new') => render(tree(path));
const fill = () => {
  fireEvent.change(screen.getByLabelText('Tiêu đề'), { target: { value: '<b>Lịch</b>' } });
  fireEvent.change(screen.getByLabelText('Nội dung'), { target: { value: '<script>bad()</script>' } });
};
describe('US-48: giao diện preview/confirm/resolve', () => {
  beforeEach(() => {
    pendingBroadcast.clear();
    auth.user = { id: 'admin-a', roleCode: 'ADMIN' };
    vi.spyOn(api, 'preview').mockResolvedValue(preview);
    vi.spyOn(api, 'send').mockResolvedValue(sent);
    vi.spyOn(api, 'lookup').mockResolvedValue({ responseBody: sent });
    vi.spyOn(api, 'detail').mockResolvedValue(detail);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it('chỉ gửi sau preview; nguyên văn HTML là text; sửa input phải xem trước lại', async () => {
    mount(); fill(); expect(screen.queryByRole('button', { name: 'Xác nhận Gửi' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    await screen.findByRole('button', { name: 'Xác nhận Gửi' });
    expect(screen.getByRole('heading', { level: 4 }).textContent).toBe('<b>Lịch</b>');
    expect(document.querySelector('script')).toBeNull();
    fireEvent.change(screen.getByLabelText('Nội dung'), { target: { value: 'Đổi nội dung' } });
    expect(screen.queryByRole('button', { name: 'Xác nhận Gửi' })).toBeNull(); expect(api.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Xem trước' })); await screen.findByRole('button', { name: 'Xác nhận Gửi' });
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận Gửi' }));
    await screen.findByText('Đã lưu cho 3 tài khoản');
    expect(screen.getByText(/đã nhận \(ack\): 0; đã đọc: 0/)).toBeTruthy();
    expect(api.send).toHaveBeenCalledWith(preview.previewId, 0, expect.stringMatching(/^[a-f\d-]{36}$/i));
  });
  it('unknown commit: khóa input, lookup 404 giữ yêu cầu, retry cùng key rồi resolve', async () => {
    vi.mocked(api.send).mockRejectedValue(new ApiError('Chưa biết kết quả', 503, undefined, undefined, undefined, 'OPERATION_OUTCOME_UNKNOWN'));
    vi.mocked(api.lookup).mockRejectedValueOnce(new ApiError('Chưa thấy', 404));
    mount(); fill(); fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Xác nhận Gửi' }));
    await screen.findByRole('button', { name: 'Tra cứu kết quả' });
    expect(screen.getByLabelText('Tiêu đề').matches(':disabled')).toBe(true);
    const key = vi.mocked(api.send).mock.calls[0][2];
    fireEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' })); await screen.findByText('Chưa thấy');
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại cùng khóa' }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.send).mock.calls[1]).toEqual([preview.previewId, 0, key]);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Tra cứu kết quả' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' }));
    await screen.findByText('Đã lưu cho 3 tài khoản'); expect(api.lookup).toHaveBeenLastCalledWith(key); expect(api.preview).toHaveBeenCalledTimes(1);
  });
  it.each([['hết hạn', { expiresAt: new Date(Date.now() - 1).toISOString() }], ['nhóm rỗng', { recipientCount: 0 }]])('chặn gửi %s', async (_label, changes) => {
    vi.mocked(api.preview).mockResolvedValue({ ...preview, ...changes });
    mount(); fill(); fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    expect((await screen.findByRole('button', { name: 'Xác nhận Gửi' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.send).not.toHaveBeenCalled();
  });
  it('tải lại trang giữ yêu cầu chưa rõ kết quả và resolve bằng đúng khóa', async () => {
    const key = crypto.randomUUID();
    pendingBroadcast.save('admin-a', { id: preview.previewId, version: 0, key });
    mount();
    expect(screen.getByLabelText('Tiêu đề').matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' }));
    await screen.findByText('Đã lưu cho 3 tài khoản');
    expect(api.lookup).toHaveBeenCalledWith(key); expect(api.preview).not.toHaveBeenCalled();
    expect(pendingBroadcast.read('admin-a')).toBeNull();
  });
  it('không dùng khóa đang chờ của account khác', () => {
    pendingBroadcast.save('admin-b', { id: preview.previewId, version: 0, key: crypto.randomUUID() });
    mount(); expect(screen.queryByRole('button', { name: 'Tra cứu kết quả' })).toBeNull();
    expect(pendingBroadcast.read('admin-b')).toBeNull();
  });
  it('PREVIEW_STALE yêu cầu preview lại, không giữ nút gửi cũ', async () => {
    vi.mocked(api.send).mockRejectedValue(new ApiError('Hãy xem trước lại', 409, undefined, undefined, undefined, 'PREVIEW_STALE'));
    mount(); fill(); fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Xác nhận Gửi' })); await screen.findByText('Hãy xem trước lại');
    expect(screen.queryByRole('button', { name: 'Xác nhận Gửi' })).toBeNull();
  });
  it('đổi account xóa preview và bỏ response về muộn', async () => {
    let resolve!: (value: typeof preview) => void;
    vi.mocked(api.preview).mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = mount(); fill(); fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    auth.user = { id: 'admin-b', roleCode: 'ADMIN' }; view.rerender(tree());
    resolve(preview);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Xác nhận Gửi' })).toBeNull());
    expect((screen.getByLabelText('Tiêu đề') as HTMLInputElement).value).toBe('');
  });
});
