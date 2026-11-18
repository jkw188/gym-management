import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../api/client';
import type { AuthSnapshot } from '../auth/auth.types';
import { resolveReturnTo } from '../auth/auth.routes';
import { attendanceApi, type AttendanceDetail } from './attendance.api';
import { TrainerAttendancePage } from './TrainerAttendancePage';

const shiftId = 'b'.repeat(24), trainerId = 'a'.repeat(24);
let auth: AuthSnapshot, listeners: Set<() => void>, source: AttendanceDetail;
beforeEach(() => {
  auth = { status: 'authenticated', user: { id: 'c'.repeat(24), fullName: 'Staff', phone: '0900000000', roleCode: 'STAFF' } };
  listeners = new Set();
  vi.spyOn(apiClient, 'getSnapshot').mockImplementation(() => auth);
  vi.spyOn(apiClient, 'subscribe').mockImplementation(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; });
  source = { asOf: '2026-11-17T03:00:00Z', state: 'MISSING', shift: {
    id: shiftId, trainerId, startAt: '2026-11-17T01:00:00Z', endAt: '2026-11-17T04:00:00Z', status: 'CONFIRMED', location: 'Gym', dataIssue: [],
    attendance: { id: null, state: 'MISSING', checkInAt: null, checkOutAt: null, actualMinutes: null,
      recordedBy: null, checkedOutBy: null, version: null, lastCorrectedBy: null, lastCorrectedAt: null },
  } };
  vi.spyOn(attendanceApi, 'list').mockImplementation(async () => ({ items: [structuredClone(source.shift)], trainers: [{ id: trainerId, displayName: 'PT A' }],
    total: 1, totalPages: 1, page: 1, limit: 20, asOf: source.asOf }));
  vi.spyOn(attendanceApi, 'detail').mockImplementation(async () => structuredClone(source));
  vi.spyOn(attendanceApi, 'send').mockResolvedValue({});
  vi.spyOn(attendanceApi, 'lookup').mockResolvedValue({ status: 'COMMITTED', responseStatus: 201, responseBody: {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function select() { render(<TrainerAttendancePage />); await userEvent.click(await screen.findByRole('button', { name: 'Chọn ca' })); await screen.findByText('Ca đã chọn — MISSING'); }
const verify = () => userEvent.click(screen.getByRole('checkbox'));

describe('US-63 attendance UI', () => {
  it('allows returning after login only to the attendance page for the current Staff/Admin role', () => {
    expect(resolveReturnTo('/staff/trainer-attendance', 'STAFF')).toBe('/staff/trainer-attendance');
    expect(resolveReturnTo('/admin/trainer-attendance', 'ADMIN')).toBe('/admin/trainer-attendance');
    expect(resolveReturnTo('/admin/trainer-attendance', 'STAFF')).toBe('/staff');
    expect(resolveReturnTo('/staff/trainer-attendance', 'MEMBER')).toBe('/member');
  });
  it('TC01/04/12: MISSING is not zero hours; Staff verifies and sends only note with no client time/source', async () => {
    await select();
    expect(screen.getByText('Thời lượng thực tế: Chưa có dữ liệu')).toBeTruthy();
    expect(screen.queryByLabelText('Giờ vào mới')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sửa sai / bổ sung bỏ sót' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Ghi vào' }) as HTMLButtonElement).disabled).toBe(true);
    await verify(); await userEvent.click(screen.getByRole('button', { name: 'Ghi vào' }));
    await screen.findByText('Đã lưu chấm công.');
    const command = vi.mocked(attendanceApi.send).mock.calls[0][0];
    expect(command).toMatchObject({ operation: 'ATTENDANCE_CHECK_IN', shiftId, body: { note: '' } });
    expect(command.body).toEqual({ note: '' }); expect(command.key).toMatch(/^[a-f\d-]{36}$/);
  });
  it('TC06: OPEN checkout uses current version and server time', async () => {
    source.state = 'OPEN'; Object.assign(source.shift.attendance, { state: 'OPEN', id: shiftId, version: 3, checkInAt: '2026-11-17T01:10:00Z' });
    render(<TrainerAttendancePage />); await userEvent.click(await screen.findByRole('button', { name: 'Chọn ca' }));
    await screen.findByText('Ca đã chọn — OPEN'); await verify(); await userEvent.click(screen.getByRole('button', { name: 'Ghi ra' }));
    await waitFor(() => expect(attendanceApi.send).toHaveBeenCalled());
    expect(vi.mocked(attendanceApi.send).mock.calls[0][0].body).toEqual({ version: 3, note: '' });
  });
  it('TC07/08: Admin dialog shows old/new values and requires reason, with explicit timezone', async () => {
    auth = { ...auth, user: { ...auth.user!, roleCode: 'ADMIN' } };
    await select(); await verify(); await userEvent.click(screen.getByRole('button', { name: 'Sửa sai / bổ sung bỏ sót' }));
    expect(screen.getByRole('dialog', { name: 'Sửa sai chấm công' })).toBeTruthy();
    expect(screen.getByText(/Giá trị cũ:/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Giờ vào mới'), { target: { value: '2026-11-17T08:00' } });
    fireEvent.change(screen.getByLabelText('Giờ ra mới (bỏ trống để OPEN)'), { target: { value: '2026-11-17T09:00' } });
    await userEvent.type(screen.getByLabelText('Lý do sửa sai'), 'Bổ sung công bị bỏ sót');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu sửa sai' }));
    await waitFor(() => expect(attendanceApi.send).toHaveBeenCalled());
    expect(vi.mocked(attendanceApi.send).mock.calls[0][0]).toMatchObject({ operation: 'ATTENDANCE_CORRECT', body: {
      checkInAt: '2026-11-17T08:00+07:00', checkOutAt: '2026-11-17T09:00+07:00', reason: 'Bổ sung công bị bỏ sót' } });
    expect(vi.mocked(attendanceApi.send).mock.calls[0][0].body.version).toBeUndefined();
  });
  it('TC10/12: unknown outcome retains original command/key; operation lookup 404 does not permit a new key', async () => {
    vi.mocked(attendanceApi.send).mockRejectedValueOnce(new ApiError('Chưa rõ kết quả', 503, undefined, undefined, undefined, 'OPERATION_OUTCOME_UNKNOWN'));
    vi.mocked(attendanceApi.lookup).mockRejectedValueOnce(new ApiError('Chưa thấy kết quả', 404));
    await select(); await verify(); await userEvent.click(screen.getByRole('button', { name: 'Ghi vào' }));
    await screen.findByRole('alert'); const original = vi.mocked(attendanceApi.send).mock.calls[0][0];
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' }));
    await screen.findByText(/Chưa thấy kết quả/);
    await userEvent.click(screen.getByRole('button', { name: 'Gửi lại cùng khóa' }));
    await screen.findByText('Đã lưu chấm công.');
    expect(vi.mocked(attendanceApi.send).mock.calls[1][0]).toEqual(original);
  });
  it('TC12: DB failure has retry and does not fabricate a zero or an empty successful list', async () => {
    vi.mocked(attendanceApi.list).mockRejectedValueOnce(new ApiError('Cơ sở dữ liệu chưa sẵn sàng', 503));
    render(<TrainerAttendancePage />); await screen.findByRole('alert');
    expect(screen.queryByText(/0 ca/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại' })); await screen.findByRole('cell', { name: 'PT A' });
  });
  it('TC12: changing account discards old detail and pending command', async () => {
    await select();
    await act(async () => { auth = { ...auth, user: { ...auth.user!, id: 'd'.repeat(24) } }; listeners.forEach(fn => fn()); });
    expect(screen.queryByText('Ca đã chọn — MISSING')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
