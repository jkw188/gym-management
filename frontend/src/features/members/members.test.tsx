import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { NewMemberPage } from './NewMemberPage';
import { membersApi, type LinkInput, type LinkResult, type Member } from './members.api';

const member: Member = { id: '123456789012345678901234', memberCode: 'HV-123456789012345678901234',
  fullName: 'Hội viên mới', phone: '+84901234567', version: 0, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
const candidate = { id: '223456789012345678901234', fullName: 'Tài khoản Member', phone: member.phone, canLink: true };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function fillCreate() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Họ tên *'), member.fullName);
  await user.type(screen.getByLabelText('Số điện thoại *'), '0901234567');
  return user;
}
async function createdPage() {
  vi.spyOn(membersApi, 'create').mockResolvedValue(member);
  render(<NewMemberPage />);
  const user = await fillCreate();
  await user.click(screen.getByRole('button', { name: 'Tạo hồ sơ' }));
  await screen.findByText(member.memberCode);
  return user;
}
async function verifiedPage() {
  vi.spyOn(membersApi, 'candidates').mockResolvedValue({ items: [candidate] });
  const user = await createdPage();
  await user.click(screen.getByRole('button', { name: 'Tìm chính xác số điện thoại' }));
  await user.click(await screen.findByRole('radio'));
  await user.selectOptions(screen.getByLabelText('Cách đối chiếu'), 'IN_PERSON_ACCOUNT');
  await user.type(screen.getByLabelText('Ghi nhận đối chiếu'), 'Đối chiếu tài khoản trực tiếp tại quầy');
  await user.click(screen.getByRole('checkbox'));
  return user;
}

describe('US-09 AC04 / TC15: separate create/link with recoverable intentions', () => {
  it('prevents double submit and displays the server member code without automatically searching or linking', async () => {
    let resolve!: (value: Member) => void;
    const create = vi.spyOn(membersApi, 'create').mockReturnValue(new Promise(done => { resolve = done; }));
    const search = vi.spyOn(membersApi, 'candidates');
    const link = vi.spyOn(membersApi, 'link');
    render(<NewMemberPage />); await fillCreate();
    const button = screen.getByRole('button', { name: 'Tạo hồ sơ' });
    fireEvent.click(button); fireEvent.click(button);
    expect(create).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled || (button.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    await act(async () => resolve(member));
    expect(await screen.findByText(member.memberCode)).toBeTruthy();
    expect(search).not.toHaveBeenCalled(); expect(link).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0]).toEqual({ fullName: member.fullName, phone: '0901234567' });
    expect(create.mock.calls[0][1]).toMatch(/^[a-f\d-]{36}$/i);
  });

  it('keeps the create key/payload after response loss and looks up the committed response', async () => {
    const create = vi.spyOn(membersApi, 'create').mockRejectedValue(new ApiError('Mất kết nối'));
    const lookup = vi.spyOn(membersApi, 'lookup').mockResolvedValue({ status: 'COMMITTED', responseStatus: 201, responseBody: member });
    render(<NewMemberPage />); const user = await fillCreate();
    await user.click(screen.getByRole('button', { name: 'Tạo hồ sơ' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByLabelText('Họ tên *') as HTMLInputElement).closest('fieldset')!.disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Tra cứu kết quả / thử lại cùng khóa' }));
    expect(await screen.findByText(member.memberCode)).toBeTruthy();
    expect(lookup).toHaveBeenCalledWith('MEMBER_CREATE', create.mock.calls[0][1]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('resends only the original payload and key when operation lookup is still unknown', async () => {
    const create = vi.spyOn(membersApi, 'create').mockRejectedValueOnce(new ApiError('Mất kết nối')).mockResolvedValueOnce(member);
    vi.spyOn(membersApi, 'lookup').mockRejectedValue(new ApiError('Đang xử lý', 404, undefined, undefined, undefined, 'OPERATION_UNKNOWN'));
    render(<NewMemberPage />); const user = await fillCreate();
    await user.click(screen.getByRole('button', { name: 'Tạo hồ sơ' }));
    await user.click(await screen.findByRole('button', { name: 'Tra cứu kết quả / thử lại cùng khóa' }));
    await screen.findByText(member.memberCode);
    expect(create).toHaveBeenCalledTimes(2); expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  });

  it('does not repeat a duplicate phone create with a new key', async () => {
    const create = vi.spyOn(membersApi, 'create').mockRejectedValue(new ApiError('Đã có hồ sơ', 409, undefined, undefined, undefined, 'MEMBER_PHONE_EXISTS'));
    render(<NewMemberPage />); const user = await fillCreate();
    await user.click(screen.getByRole('button', { name: 'Tạo hồ sơ' }));
    await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: 'Tạo hồ sơ' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/tra cứu hồ sơ có sẵn/)).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('requires explicit account selection, verification method, note and confirmation', async () => {
    vi.spyOn(membersApi, 'candidates').mockResolvedValue({ items: [candidate] });
    const link = vi.spyOn(membersApi, 'link').mockImplementation(async (_id: string, input: LinkInput): Promise<LinkResult> =>
      ({ member: { ...member, accountId: input.accountId, version: 1 }, linked: true }));
    const user = await createdPage();
    await user.click(screen.getByRole('button', { name: 'Tìm chính xác số điện thoại' }));
    expect((await screen.findByRole('radio') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: 'Xác nhận liên kết' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('radio'));
    await user.selectOptions(screen.getByLabelText('Cách đối chiếu'), 'IN_PERSON_DOCUMENT');
    await user.type(screen.getByLabelText('Ghi nhận đối chiếu'), 'Đối chiếu giấy tờ trực tiếp tại quầy');
    expect(link).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Xác nhận liên kết' }));
    expect(await screen.findByText(candidate.id)).toBeTruthy();
    expect(link).toHaveBeenCalledWith(member.id, { accountId: candidate.id, version: 0,
      verificationMethod: 'IN_PERSON_DOCUMENT', verificationNote: 'Đối chiếu giấy tờ trực tiếp tại quầy' }, expect.any(String));
  });

  it('retains the created member after a link conflict without creating or deleting another profile', async () => {
    vi.spyOn(membersApi, 'link').mockRejectedValue(new ApiError('Tài khoản đã bị khóa', 409, undefined, undefined, undefined, 'ACCOUNT_NOT_ELIGIBLE'));
    const user = await verifiedPage();
    await user.click(screen.getByRole('button', { name: 'Xác nhận liên kết' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Tài khoản đã bị khóa');
    expect(screen.getByText(member.memberCode)).toBeTruthy(); expect(screen.getByText('Chưa liên kết')).toBeTruthy();
    expect(membersApi.create).toHaveBeenCalledTimes(1);
  });

  it('recovers a lost link response with MEMBER_LINK lookup and preserves the member', async () => {
    const link = vi.spyOn(membersApi, 'link').mockRejectedValue(new ApiError('Mất phản hồi', 503));
    const lookup = vi.spyOn(membersApi, 'lookup').mockResolvedValue({ status: 'COMMITTED', responseStatus: 200,
      responseBody: { member: { ...member, accountId: candidate.id, version: 1 }, linked: true } });
    const user = await verifiedPage();
    await user.click(screen.getByRole('button', { name: 'Xác nhận liên kết' }));
    await screen.findByRole('alert');
    expect(screen.getByText(member.memberCode)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tra cứu kết quả / thử lại cùng khóa' }));
    await screen.findByText(candidate.id);
    expect(lookup).toHaveBeenCalledWith('MEMBER_LINK', link.mock.calls[0][2]); expect(link).toHaveBeenCalledTimes(1);
  });

  it('handles empty lookup and ineligible candidates', async () => {
    const search = vi.spyOn(membersApi, 'candidates').mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [{ ...candidate, canLink: false }] });
    const user = await createdPage();
    await user.click(screen.getByRole('button', { name: 'Tìm chính xác số điện thoại' }));
    expect(await screen.findByText(/Không tìm thấy tài khoản MEMBER/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tìm chính xác số điện thoại' }));
    expect((await screen.findByRole('radio') as HTMLInputElement).disabled).toBe(true);
    expect(search).toHaveBeenCalledWith(member.phone);
  });
});
