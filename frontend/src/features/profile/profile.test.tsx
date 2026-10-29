import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError, apiClient } from '../../api/client';
import { resolveReturnTo } from '../auth/auth.routes';
import { ProfilePage } from './ProfilePage';
import { profileApi, type Profile, type UpdateProfileResult } from './profile.api';

const profile: Profile = { id: 'b'.repeat(24), fullName: 'Hội Viên', phone: '+84901111111', roleCode: 'MEMBER', status: 'ACTIVE',
  version: 3, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function LoginProbe() {
  const location = useLocation();
  return <p>Trang đăng nhập {location.search}</p>;
}
function renderPage() {
  return render(<MemoryRouter initialEntries={['/member/profile']}><Routes>
    <Route path="/member/profile" element={<ProfilePage role="MEMBER" />} />
    <Route path="/login" element={<LoginProbe />} />
  </Routes></MemoryRouter>);
}
async function editName(value: string) {
  const input = await screen.findByLabelText('Họ tên');
  await userEvent.clear(input);
  await userEvent.type(input, value);
  await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
}

describe('US-04 profile page', () => {
  it('TC01/TC12: loads the own profile, asks for confirmation, then shows the server data', async () => {
    vi.spyOn(profileApi, 'get').mockResolvedValue(profile);
    const saved: UpdateProfileResult = { profile: { ...profile, fullName: 'Tên Mới', version: 4 }, reauthenticationRequired: false };
    const update = vi.spyOn(profileApi, 'update').mockResolvedValue(saved);
    const current = vi.spyOn(apiClient, 'updateCurrentUser').mockImplementation(() => {});
    renderPage();
    await editName('Tên Mới');
    expect(update).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lưu' }));
    expect(update).toHaveBeenCalledWith({ version: 3, fullName: 'Tên Mới', phone: '+84901111111', email: null, birthDate: null, address: null });
    expect(await screen.findByText('Đã lưu thông tin tài khoản.')).toBeDefined();
    expect((screen.getByLabelText('Họ tên') as HTMLInputElement).value).toBe('Tên Mới');
    expect(current).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'Tên Mới' }));
  });

  it('TC11: a phone/email change clears auth and asks to log in again', async () => {
    vi.spyOn(profileApi, 'get').mockResolvedValue(profile);
    vi.spyOn(profileApi, 'update').mockResolvedValue({ profile: { ...profile, phone: '+84908888888', version: 4 }, reauthenticationRequired: true });
    const requireLogin = vi.spyOn(apiClient, 'requireLogin').mockImplementation(() => {});
    renderPage();
    const phone = await screen.findByLabelText('Số điện thoại');
    await userEvent.clear(phone); await userEvent.type(phone, '0908888888');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lưu' }));
    expect(await screen.findByText('Trang đăng nhập ?reason=identity-changed')).toBeDefined();
    expect(requireLogin).toHaveBeenCalledTimes(1);
  });

  it('TC14: a 400 is shown next to the field, focuses it and keeps the draft', async () => {
    vi.spyOn(profileApi, 'get').mockResolvedValue(profile);
    vi.spyOn(profileApi, 'update').mockRejectedValue(new ApiError('Dữ liệu không hợp lệ', 400, 'req-1',
      [{ field: 'phone', message: 'Số điện thoại không hợp lệ' }], undefined, 'VALIDATION_ERROR'));
    renderPage();
    await editName('Bản Nháp');
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lưu' }));
    const phone = screen.getByLabelText('Số điện thoại');
    await waitFor(() => expect(document.activeElement).toBe(phone));
    expect(phone.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Số điện thoại không hợp lệ')).toBeDefined();
    expect((screen.getByLabelText('Họ tên') as HTMLInputElement).value).toBe('Bản Nháp');
  });

  it('TC14: a 409 VERSION_CONFLICT keeps the draft and reloads only after a second confirmation', async () => {
    const get = vi.spyOn(profileApi, 'get').mockResolvedValueOnce(profile).mockResolvedValueOnce({ ...profile, fullName: 'Bản Mới Nhất', version: 5 });
    vi.spyOn(profileApi, 'update').mockRejectedValue(new ApiError('Tài khoản đã thay đổi.', 409, undefined, undefined, undefined, 'VERSION_CONFLICT'));
    renderPage();
    await editName('Bản Nháp');
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lưu' }));
    expect(await screen.findByText(/Bản nháp đang được giữ lại/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toHaveProperty('disabled', true);
    expect((screen.getByLabelText('Họ tên') as HTMLInputElement).value).toBe('Bản Nháp');
    await userEvent.click(screen.getByRole('button', { name: 'Tải bản mới' }));
    expect(get).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận tải lại' }));
    await waitFor(() => expect((screen.getByLabelText('Họ tên') as HTMLInputElement).value).toBe('Bản Mới Nhất'));
  });

  it('TC13: a lost response is not retried automatically and offers a reload to compare', async () => {
    const get = vi.spyOn(profileApi, 'get').mockResolvedValue(profile);
    const update = vi.spyOn(profileApi, 'update').mockRejectedValue(new ApiError('Không kết nối được máy chủ.'));
    renderPage();
    await editName('Tên Mới');
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lưu' }));
    expect(await screen.findByText(/Chưa xác nhận được kết quả lưu/)).toBeDefined();
    expect(update).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('TC14: double confirmation sends one PATCH and local validation blocks future dates', async () => {
    vi.spyOn(profileApi, 'get').mockResolvedValue(profile);
    let finish!: (value: UpdateProfileResult) => void;
    const update = vi.spyOn(profileApi, 'update').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    renderPage();
    const birthDate = await screen.findByLabelText('Ngày sinh (tùy chọn)');
    await userEvent.type(birthDate, '2999-01-01');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    expect(await screen.findByText('Ngày sinh không được sau ngày hiện tại.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Xác nhận lưu' })).toBeNull();
    await userEvent.clear(birthDate);
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    await userEvent.dblClick(screen.getByRole('button', { name: 'Xác nhận lưu' }));
    expect(update).toHaveBeenCalledTimes(1);
    finish({ profile: { ...profile, version: 4 }, reauthenticationRequired: false });
    expect(await screen.findByText('Đã lưu thông tin tài khoản.')).toBeDefined();
  });

  it('allows returning to the own profile page after login', () => {
    expect(resolveReturnTo('/member/profile', 'MEMBER')).toBe('/member/profile');
    expect(resolveReturnTo('/trainer/profile', 'TRAINER')).toBe('/trainer/profile');
    expect(resolveReturnTo('/member/profile', 'TRAINER')).toBe('/trainer');
    expect(resolveReturnTo('/staff/profile', 'STAFF')).toBe('/staff');
  });
});
