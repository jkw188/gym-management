import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { ApiError, apiClient } from '../../api/client';
import type { AuthSnapshot } from '../auth/auth.types';
import { trainersApi } from '../trainers/trainers.api';
import { AdminClassesPage } from './AdminClassesPage';
import { ClassForm } from './ClassForm';
import { adminClassesApi, type AdminClass } from './admin-classes.api';
import { classesApi } from './classes.api';
import { invalidateClasses, subscribeClassChanges } from './class-signals';

const subjects = [{ code: 'YOGA', label: 'Yoga' }, { code: 'OTHER', label: 'Khác' }];
const trainerId = 'a'.repeat(24);
const row: AdminClass = { id: 'b'.repeat(24), title: 'Yoga sáng', trainerId, trainerName: 'PT An', subjectCode: 'YOGA', subjectLabel: 'Yoga',
  startAt: '2035-11-16T01:00:00.000Z', endAt: '2035-11-16T01:45:00.000Z', location: 'Phòng 1', status: 'DRAFT', version: 0,
  createdBy: 'c'.repeat(24), updatedBy: 'c'.repeat(24), createdAt: '2035-11-14T17:00:00.000Z', updatedAt: '2035-11-14T17:00:00.000Z', ended: false };
const page = (items = [row]) => ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0 });
beforeEach(() => {
  vi.spyOn(adminClassesApi, 'list').mockResolvedValue(page());
  vi.spyOn(adminClassesApi, 'detail').mockResolvedValue(row);
  vi.spyOn(classesApi, 'subjects').mockResolvedValue(subjects);
  vi.spyOn(trainersApi, 'list').mockResolvedValue({ items: [{ id: trainerId, accountId: 'd'.repeat(24), fullName: 'PT An', specialty: 'Yoga', status: 'ACTIVE', version: 0 }],
    total: 1, totalPages: 1, page: 1, limit: 20 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('US-66 admin UI', () => {
  it('filters, shows VN time, handles empty/error and reloads without stale data', async () => {
    render(<AdminClassesPage />);
    await screen.findByRole('button', { name: 'Chi tiết Yoga sáng' });
    expect(trainersApi.list).toHaveBeenLastCalledWith({ page: 1, limit: 20, q: '' }, expect.any(AbortSignal));
    expect(screen.getByText('2035-11-16 08:00 – 2035-11-16 08:45')).toBeDefined();
    vi.mocked(adminClassesApi.list).mockResolvedValueOnce(page([]));
    fireEvent.change(screen.getByLabelText('Lọc trạng thái lớp'), { target: { value: 'CANCELLED' } });
    await screen.findByText('Không có lớp nào trong khoảng này.');
    expect(adminClassesApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'CANCELLED', page: 1 }), expect.any(AbortSignal));
    vi.mocked(adminClassesApi.list).mockRejectedValueOnce(new ApiError('DB chưa sẵn sàng', 503));
    fireEvent.change(screen.getByLabelText('Lọc bộ môn'), { target: { value: 'YOGA' } });
    await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: 'Chi tiết Yoga sáng' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' })); await screen.findByText('Yoga sáng');
  });
  it('creates only after commit, guards double click and sends UTC offset/minute input', async () => {
    let finish!: (result: AdminClass) => void;
    const send = vi.spyOn(adminClassesApi, 'send').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<AdminClassesPage />); await screen.findByText('Yoga sáng');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo lớp nháp' }));
    await screen.findByRole('option', { name: 'PT An — Yoga' });
    expect(trainersApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ACTIVE' }), expect.any(AbortSignal));
    fireEvent.change(screen.getByLabelText('Tên lớp'), { target: { value: '  Zumba tối  ' } });
    fireEvent.change(screen.getByLabelText('Huấn luyện viên'), { target: { value: trainerId } });
    fireEvent.change(screen.getByLabelText('Bộ môn của lớp'), { target: { value: 'YOGA' } });
    fireEvent.change(screen.getByLabelText('Địa điểm'), { target: { value: ' Phòng 2 ' } });
    fireEvent.change(screen.getByLabelText('Ngày Việt Nam'), { target: { value: '2035-11-16' } });
    fireEvent.change(screen.getByLabelText('Giờ bắt đầu (VN)'), { target: { value: '23:15' } });
    fireEvent.change(screen.getByLabelText('Giờ kết thúc (VN)'), { target: { value: '00:00' } });
    await userEvent.dblClick(screen.getByRole('button', { name: 'Lưu lớp nháp' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ operation: 'PUBLIC_SESSION_CREATE', input: { title: 'Zumba tối', trainerId, subjectCode: 'YOGA', location: 'Phòng 2',
      startAt: '2035-11-16T23:15:00+07:00', endAt: '2035-11-17T00:00:00+07:00' } }, expect.any(String));
    expect(screen.queryByText(/Đã lưu lớp/)).toBeNull();
    await act(async () => finish(row));
    await screen.findByText(/Đã lưu lớp/); expect(adminClassesApi.list).toHaveBeenCalledTimes(2);
  });
  it('published edit requires explicit confirmation; preview warns busy without writing', async () => {
    const submit = vi.fn(), preview = vi.spyOn(adminClassesApi, 'preview').mockResolvedValue({ startAt: row.startAt, endAt: row.endAt, conflictCodes: ['BOOKING_CONFLICT'] });
    render(<ClassForm initial={{ ...row, status: 'PUBLISHED', version: 2 }} subjects={subjects} disabled={false} onSubmit={submit} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Lưu thay đổi lớp' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Xem trước lịch bận' }));
    await screen.findByText('PT bận lịch đặt riêng.'); expect(preview).toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi lớp' }));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'PUBLIC_SESSION_UPDATE', id: row.id, input: expect.objectContaining({ version: 2 }) }));
    fireEvent.change(screen.getByLabelText('Giờ bắt đầu (VN)'), { target: { value: '09:00' } });
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false); expect(screen.queryByText('PT bận lịch đặt riêng.')).toBeNull();
  });
  it('publishes using fresh detail/version; unknown outcome retains exact key/payload and permits lookup', async () => {
    vi.mocked(adminClassesApi.detail).mockResolvedValue({ ...row, version: 3 });
    const send = vi.spyOn(adminClassesApi, 'send').mockRejectedValueOnce(new ApiError('Chưa xác định', 503, undefined, undefined, undefined, 'OPERATION_OUTCOME_UNKNOWN'))
      .mockResolvedValueOnce({ ...row, status: 'PUBLISHED', version: 4 });
    const lookup = vi.spyOn(adminClassesApi, 'lookup').mockRejectedValueOnce(new ApiError('Yêu cầu có thể vẫn đang xử lý', 404));
    render(<AdminClassesPage />); await screen.findByText('Yoga sáng');
    await userEvent.click(screen.getByRole('button', { name: 'Công bố Yoga sáng' }));
    await screen.findByRole('dialog'); expect(adminClassesApi.detail).toHaveBeenCalledWith(row.id); expect(send).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận công bố' }));
    await screen.findByText(/Chưa xác định kết quả/);
    expect(screen.getByRole('button', { name: 'Đóng chi tiết' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' }));
    await screen.findByText('Yêu cầu có thể vẫn đang xử lý');
    expect(lookup).toHaveBeenCalledWith('PUBLIC_SESSION_PUBLISH', send.mock.calls[0][1]);
    await userEvent.click(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu' }));
    await screen.findByText(/Đã lưu lớp/);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]); expect(send.mock.calls[0][0]).toMatchObject({ input: { version: 3 } });
  });
  it('cancels with trimmed valid reason, shows terminal state and safely renders untrusted text', async () => {
    const send = vi.spyOn(adminClassesApi, 'send').mockResolvedValue({ ...row, status: 'CANCELLED', version: 1 });
    render(<AdminClassesPage />); await screen.findByText('Yoga sáng');
    await userEvent.click(screen.getByRole('button', { name: 'Hủy Yoga sáng' }));
    await screen.findByRole('dialog'); expect(screen.getByRole('button', { name: 'Xác nhận hủy lớp' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Lý do hủy (10–500 ký tự)'), { target: { value: ' Thay đổi địa điểm tổ chức ' } });
    vi.mocked(adminClassesApi.list).mockResolvedValue(page([{ ...row, status: 'CANCELLED', version: 1, title: '<img src=x onerror=alert(1)>' }]));
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận hủy lớp' }));
    await screen.findByText('<img src=x onerror=alert(1)>'); expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Công bố Yoga sáng' })).toBeNull();
    expect(send).toHaveBeenCalledWith({ operation: 'PUBLIC_SESSION_CANCEL', id: row.id, input: { version: 0, reason: 'Thay đổi địa điểm tổ chức' } }, expect.any(String));
  });
  it('stale version preserves edit and asks to reload before a new write', async () => {
    vi.spyOn(adminClassesApi, 'send').mockRejectedValueOnce(new ApiError('Lớp đã thay đổi', 409, 'request-us66', undefined, undefined, 'VERSION_CONFLICT'));
    render(<AdminClassesPage />); await screen.findByText('Yoga sáng');
    await userEvent.click(screen.getByRole('button', { name: 'Sửa Yoga sáng' })); await screen.findByRole('form', { name: 'Thông tin lớp' });
    fireEvent.change(screen.getByLabelText('Tên lớp'), { target: { value: 'Yoga mới' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi lớp' }));
    await screen.findByText('Lớp đã thay đổi'); expect(screen.getByLabelText('Tên lớp')).toHaveProperty('value', 'Yoga mới');
    expect(screen.getByRole('button', { name: 'Lưu thay đổi lớp' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại lớp để đối chiếu' }));
    await screen.findByText('Yoga sáng'); expect(screen.queryByLabelText('Tên lớp')).toBeNull();
  });
  it('cross-tab and focus changes notify subscribers; cleanup stops refresh', () => {
    const refresh = vi.fn(), unsubscribe = subscribeClassChanges(refresh);
    invalidateClasses(); expect(refresh).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'gym:classes-revision', newValue: 'revision' }));
    window.dispatchEvent(new Event('focus')); expect(refresh).toHaveBeenCalledTimes(3);
    unsubscribe(); invalidateClasses(); expect(refresh).toHaveBeenCalledTimes(3);
  });
  it.each(['STAFF', 'TRAINER', 'MEMBER'] as const)('route denies %s', async role => {
    const snapshot: AuthSnapshot = { status: 'authenticated', user: { id: 'c'.repeat(24), fullName: 'US66 user', phone: '0900000000', roleCode: role } };
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue(snapshot); vi.spyOn(apiClient, 'restore').mockResolvedValue();
    vi.spyOn(apiClient, 'subscribe').mockReturnValue(() => undefined);
    window.history.replaceState({}, '', '/admin/classes'); render(<App />);
    await screen.findByText(/Không có quyền/); expect(adminClassesApi.list).not.toHaveBeenCalled();
  });
});
