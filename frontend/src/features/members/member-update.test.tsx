import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient, ApiError } from '../../api/client';
import { MemberDetailPage } from './MemberDetailPage';
import { membersApi, type Member, type MemberDetail } from './members.api';
import { resolveReturnTo } from '../auth/auth.routes';

const member: Member = { id: '123456789012345678901234', memberCode: 'HV-123456789012345678901234',
  fullName: 'Hội viên gốc', phone: '+84901234567', birthDate: '2000-02-29', address: 'Quận 1',
  accountId: '223456789012345678901234', version: 3, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
const detailOf = (value = member): MemberDetail => ({ member: value, entitlementSummary: { GYM: ['NONE'], PT: ['NONE'] },
  asOf: value.updatedAt, businessDate: '2026-11-01' });

beforeEach(() => vi.spyOn(membersApi, 'memberships').mockResolvedValue({ items: [], page: 1, limit: 20, total: 0,
  totalPages: 0, asOf: member.updatedAt, businessDate: '2026-11-01' }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount() {
  render(<MemoryRouter initialEntries={[`/staff/members/${member.id}`]}><Routes>
    <Route path="/staff/members/:id" element={<MemberDetailPage />} />
  </Routes></MemoryRouter>);
}
async function edit() {
  vi.spyOn(membersApi, 'detail').mockResolvedValue(detailOf());
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Chỉnh sửa' }));
  await screen.findByRole('button', { name: 'Lưu' } );
  return user;
}

describe('US-10 AC04 / TC13–14: deliberate profile edits and recovery', () => {
  it('loads current data before editing, keeps identifiers read-only and cancels without a write', async () => {
    const patch = vi.spyOn(membersApi, 'update'); const user = await edit();
    expect(membersApi.detail).toHaveBeenCalledTimes(2);
    expect(screen.getByText(member.memberCode)).toBeTruthy(); expect(screen.getByText(member.accountId!)).toBeTruthy();
    expect(document.querySelector('input[name="accountId"]')).toBeNull();
    await user.clear(screen.getByLabelText('Họ tên *')); await user.type(screen.getByLabelText('Họ tên *'), 'Bản chưa lưu');
    await user.click(screen.getByRole('button', { name: 'Hủy sửa' }));
    expect(screen.getByText(member.fullName)).toBeTruthy(); expect(patch).not.toHaveBeenCalled();
  });

  it('validates fields and focuses errors; phone conflict preserves all draft fields', async () => {
    const patch = vi.spyOn(membersApi, 'update').mockRejectedValue(new ApiError('Trùng phone', 409, undefined, undefined, undefined, 'MEMBER_PHONE_EXISTS'));
    const user = await edit();
    await user.clear(screen.getByLabelText('Họ tên *')); await user.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Họ tên *')); expect(patch).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Họ tên *'), 'Tên mới');
    await user.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByText('Số điện thoại đã có hồ sơ hội viên.')).toBeTruthy();
    expect((screen.getByLabelText('Họ tên *') as HTMLInputElement).value).toBe('Tên mới');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Số điện thoại *')));
    expect(patch.mock.calls[0][1]).toMatchObject({ version: 3, fullName: 'Tên mới' });
  });

  it('renders backend field validation next to the input and focuses that field', async () => {
    vi.spyOn(membersApi, 'update').mockRejectedValue(new ApiError('Dữ liệu sai', 400, 'request-id', [{ field: 'birthDate', message: 'Ngày không hợp lệ' }]));
    const user = await edit(); await user.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByText('Ngày không hợp lệ')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ngày sinh')));
  });

  it('prevents double submission, clears optional fields with null, and renders the server response as text', async () => {
    let finish!: (result: { member: Member; changed: boolean }) => void;
    const patch = vi.spyOn(membersApi, 'update').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const user = await edit();
    await user.clear(screen.getByLabelText('Ngày sinh')); await user.clear(screen.getByLabelText('Địa chỉ'));
    const button = screen.getByRole('button', { name: 'Lưu' });
    fireEvent.click(button); fireEvent.click(button);
    expect(patch).toHaveBeenCalledTimes(1);
    expect((button.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    expect(patch.mock.calls[0][1]).toMatchObject({ version: 3, birthDate: null, address: null });
    await act(async () => finish({ member: { ...member, fullName: '<img src=x onerror=alert(1)>', version: 4, birthDate: undefined, address: undefined }, changed: true }));
    expect(await screen.findByText('Đã cập nhật hồ sơ hội viên.')).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy(); expect(document.querySelector('img')).toBeNull();
  });

  it('keeps the draft after version conflict, confirms discarding before GET, and never resends it automatically', async () => {
    const patch = vi.spyOn(membersApi, 'update').mockRejectedValue(new ApiError('Version cũ', 409, undefined, undefined, undefined, 'VERSION_CONFLICT'));
    const user = await edit();
    await user.clear(screen.getByLabelText('Họ tên *')); await user.type(screen.getByLabelText('Họ tên *'), 'Bản chưa lưu');
    await user.click(screen.getByRole('button', { name: 'Lưu' }));
    expect((screen.getByLabelText('Họ tên *') as HTMLInputElement).value).toBe('Bản chưa lưu');
    expect((screen.getByRole('button', { name: 'Lưu' }).closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Tải lại hồ sơ' }));
    expect(screen.getByRole('dialog')).toBeTruthy(); expect(membersApi.detail).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Xác nhận tải lại' }));
    await user.tab(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Giữ bản nhập' }));
    await user.tab(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Xác nhận tải lại' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Tải lại hồ sơ' }));
    expect((screen.getByLabelText('Họ tên *') as HTMLInputElement).value).toBe('Bản chưa lưu');
    vi.mocked(membersApi.detail).mockResolvedValue(detailOf({ ...member, fullName: 'Bản người khác lưu', version: 4 }));
    await user.click(screen.getByRole('button', { name: 'Tải lại hồ sơ' }));
    await user.click(screen.getByRole('button', { name: 'Xác nhận tải lại' }));
    expect(await screen.findByText('Bản người khác lưu')).toBeTruthy(); expect(patch).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Chỉnh sửa' }));
    expect((screen.getByLabelText('Họ tên *') as HTMLInputElement).value).toBe('Bản người khác lưu');
  });

  it.each([undefined, 503])('requires GET comparison after uncertain result (%s), without retrying PATCH', async status => {
    const patch = vi.spyOn(membersApi, 'update').mockRejectedValue(new ApiError('Chưa xác định kết quả', status));
    const user = await edit(); await user.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(patch).toHaveBeenCalledTimes(1); expect(membersApi.detail).toHaveBeenCalledTimes(2);
    vi.mocked(membersApi.detail).mockResolvedValue(detailOf({ ...member, version: 4 }));
    await user.click(screen.getByRole('button', { name: 'Tải lại hồ sơ' }));
    await user.click(screen.getByRole('button', { name: 'Xác nhận tải lại' }));
    expect(await screen.findByRole('button', { name: 'Chỉnh sửa' })).toBeTruthy(); expect(patch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404])('stops editing when access/data is lost (%s)', async status => {
    vi.spyOn(membersApi, 'update').mockRejectedValue(new ApiError('Không được tiếp tục', status));
    const user = await edit(); await user.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByText(/Đã dừng thao tác/)).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Lưu' })).toBeNull();
  });

  it('handles initial unavailable/missing data and no-op success', async () => {
    vi.spyOn(membersApi, 'detail').mockRejectedValueOnce(new ApiError('Không tìm thấy hồ sơ', 404));
    mount(); expect(await screen.findByText(/Đã dừng thao tác/)).toBeTruthy(); cleanup();
    vi.spyOn(membersApi, 'update').mockResolvedValue({ member, changed: false });
    const user = await edit(); await user.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByText('Thông tin không thay đổi.')).toBeTruthy();
  });

  it('uses requestOnce for PATCH, without Idempotency-Key or automatic auth retry', async () => {
    const once = vi.spyOn(apiClient, 'requestOnce').mockResolvedValue({ member, changed: false });
    await membersApi.update(member.id, { version: 3, fullName: member.fullName });
    expect(once).toHaveBeenCalledWith(`/members/${member.id}`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 3, fullName: member.fullName }) });
  });

  it('allows only the matching operator role to return to a member detail route after login', () => {
    expect(resolveReturnTo(`/staff/members/${member.id}`, 'STAFF')).toBe(`/staff/members/${member.id}`);
    expect(resolveReturnTo(`/admin/members/${member.id}`, 'ADMIN')).toBe(`/admin/members/${member.id}`);
    expect(resolveReturnTo(`/admin/members/${member.id}`, 'STAFF')).toBe('/staff');
    expect(resolveReturnTo(`/staff/members/${member.id}`, 'MEMBER')).toBe('/member');
    expect(resolveReturnTo('/staff/members/invalid', 'STAFF')).toBe('/staff');
  });
});
