// Tầng kiểm thử frontend (Vitest, jsdom): US-09 bước 3 – trang tạo hồ sơ hội viên và liên kết tài khoản tại quầy.
// Kiểm tra tạo và liên kết là hai bước riêng, không chọn sẵn/tự liên kết, chặn gửi kép, lỗi liên kết vẫn giữ hồ sơ,
// mất response thì gửi lại cùng key, không tự tạo trùng (TC15).
// Hợp đồng test đặt ra cho Builder (US-09 bước 3, theo mục "Giao diện" và API của spec):
//   src/features/members/members.api.ts:
//     export const membersApi = {
//       create(input: { fullName: string; phone: string; birthDate?: string; address?: string }, idempotencyKey: string): Promise<Member>,
//       findLinkCandidates(phone: string): Promise<{ items: LinkCandidate[] }>,
//       link(memberId: string, input: { accountId: string; version: number; verificationMethod: 'IN_PERSON_ACCOUNT' | 'IN_PERSON_DOCUMENT';
//            verificationNote: string }, idempotencyKey: string): Promise<{ member: Member; linked: true }>,
//     }  (gọi POST /api/members, GET /api/members/link-candidates?phone=, POST /api/members/:id/link qua apiClient;
//        kiểu Member {id, memberCode, fullName, phone, birthDate?, address?, accountId?, version, createdAt, updatedAt}
//        và LinkCandidate {id, fullName, phone, canLink} export từ file này)
//   src/features/members/MemberCreatePage.tsx: export function MemberCreatePage()
//     (route /staff/members/new cho STAFF và /admin/members/new cho ADMIN)
//     - Tiêu đề "Tạo hồ sơ hội viên"; ô nhãn "Họ tên", "Số điện thoại", "Ngày sinh", "Địa chỉ"; nút "Tạo hồ sơ".
//     - Đang gửi: nút "Tạo hồ sơ" bị disabled (bấm nhiều lần chỉ gửi một request).
//     - 201: role="status" hiện mã hội viên (memberCode); hiện phần "Liên kết tài khoản" với nhãn "Chưa liên kết".
//     - Lỗi có status (400/409): role="alert" hiện thông điệp lỗi; KHÔNG tự gửi lại bằng key mới.
//     - Lỗi mạng (ApiError không có status): role="alert" + nút "Gửi lại"; bấm "Gửi lại" dùng LẠI key cũ.
//     - Phần liên kết: ô "Số điện thoại tài khoản", nút "Tìm tài khoản". Mỗi kết quả là listitem hiện họ tên, phone và
//       nút "Chọn tài khoản này" (disabled nếu canLink=false). Không có kết quả: hiện "Không tìm thấy tài khoản".
//       KHÔNG tự chọn tài khoản dù kết quả khớp.
//     - Sau khi chọn: nhóm radio "Cách đối chiếu" gồm "Đối chiếu trực tiếp trên tài khoản" (IN_PERSON_ACCOUNT) và
//       "Đối chiếu giấy tờ tại quầy" (IN_PERSON_DOCUMENT), không chọn sẵn; ô "Ghi nhận đối chiếu"; nút "Xác nhận liên kết"
//       chỉ bật khi đã chọn cách đối chiếu và ghi nhận 10–500 ký tự. Gửi version hiện tại của hồ sơ.
//     - Liên kết thành công: role="status" "Đã liên kết tài khoản".
//     - Liên kết lỗi 409 (vd ACCOUNT_NOT_ELIGIBLE): role="alert" hiện thông điệp; hồ sơ vẫn hiện mã và "Chưa liên kết";
//       không gọi lại create, không tự gửi liên kết lại.
//     - Liên kết mất response: role="alert" + nút "Gửi lại"; bấm "Gửi lại" gửi link với LẠI key cũ.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { membersApi, type LinkCandidate, type Member } from './members.api';
import { MemberCreatePage } from './MemberCreatePage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMBER_ID = '6650a1b2c3d4e5f6a7b8c9d0';
const NOTE = 'Khách mở ứng dụng, đối chiếu tên và số điện thoại tại quầy';

const member = (overrides: Partial<Member> = {}): Member => ({
  id: MEMBER_ID, memberCode: `HV-${MEMBER_ID}`, fullName: 'Nguyễn Văn Khách', phone: '+84901234567', version: 0,
  createdAt: '2026-11-08T03:00:00.000Z', updatedAt: '2026-11-08T03:00:00.000Z', ...overrides,
});
const candidate = (overrides: Partial<LinkCandidate> = {}): LinkCandidate =>
  ({ id: '6650aaaaaaaaaaaaaaaaaaaa', fullName: 'Lê Thị Khách', phone: '+84901234567', canLink: true, ...overrides });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderPage = () => render(<MemoryRouter initialEntries={['/staff/members/new']}><MemberCreatePage /></MemoryRouter>);
type User = ReturnType<typeof userEvent.setup>;

async function fillCreateForm(user: User) {
  await user.type(screen.getByLabelText('Họ tên'), 'Nguyễn Văn Khách');
  await user.type(screen.getByLabelText('Số điện thoại'), '0901234567');
}

// Tạo hồ sơ thành công rồi dừng ở phần liên kết.
async function createMemberFlow(user: User) {
  vi.spyOn(membersApi, 'create').mockResolvedValue(member());
  renderPage();
  await fillCreateForm(user);
  await user.click(screen.getByRole('button', { name: 'Tạo hồ sơ' }));
  await screen.findByText(new RegExp(`HV-${MEMBER_ID}`));
}

// Tìm và chọn tài khoản, chọn cách đối chiếu, nhập ghi nhận (chưa bấm xác nhận).
async function prepareLink(user: User, found: LinkCandidate = candidate()) {
  vi.spyOn(membersApi, 'findLinkCandidates').mockResolvedValue({ items: [found] });
  await user.type(screen.getByLabelText('Số điện thoại tài khoản'), '0901234567');
  await user.click(screen.getByRole('button', { name: 'Tìm tài khoản' }));
  const item = await screen.findByRole('listitem');
  await user.click(within(item).getByRole('button', { name: 'Chọn tài khoản này' }));
  await user.click(screen.getByRole('radio', { name: 'Đối chiếu trực tiếp trên tài khoản' }));
  await user.type(screen.getByLabelText('Ghi nhận đối chiếu'), NOTE);
}

describe('US-09 bước 3: trang tạo hồ sơ và liên kết tài khoản', () => {
  // ---------- Tạo hồ sơ ----------
  it('US-09-TC15: tạo hồ sơ thành công hiện mã hội viên và phần liên kết ở trạng thái "Chưa liên kết"', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(membersApi, 'create').mockResolvedValue(member());
    renderPage();
    expect(screen.getByRole('heading', { name: 'Tạo hồ sơ hội viên' })).toBeTruthy();

    await fillCreateForm(user);
    await user.click(screen.getByRole('button', { name: 'Tạo hồ sơ' }));

    expect((await screen.findByRole('status')).textContent).toContain(`HV-${MEMBER_ID}`);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'Nguyễn Văn Khách', phone: '0901234567' }), expect.stringMatching(UUID));
    expect(screen.getByText('Liên kết tài khoản')).toBeTruthy();
    expect(screen.getByText('Chưa liên kết')).toBeTruthy();
  });

  it('US-09-TC15: bấm "Tạo hồ sơ" nhiều lần khi đang gửi chỉ gửi một request', async () => {
    const user = userEvent.setup();
    let resolve!: (value: Member) => void;
    const create = vi.spyOn(membersApi, 'create').mockReturnValue(new Promise(done => { resolve = done; }));
    renderPage();
    await fillCreateForm(user);

    const button = screen.getByRole('button', { name: 'Tạo hồ sơ' });
    await user.click(button);
    await user.click(button);
    await user.click(button);

    expect(create).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    resolve(member());
    await screen.findByText(new RegExp(`HV-${MEMBER_ID}`));
  });

  it('US-09-TC15: tạo hồ sơ mất response → "Gửi lại" dùng lại đúng key cũ, không tạo trùng bằng key mới', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(membersApi, 'create')
      .mockRejectedValueOnce(new ApiError('Không kết nối được máy chủ'))
      .mockResolvedValueOnce(member());
    renderPage();
    await fillCreateForm(user);
    await user.click(screen.getByRole('button', { name: 'Tạo hồ sơ' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Gửi lại' }));

    await screen.findByText(new RegExp(`HV-${MEMBER_ID}`));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][1]).toBe(create.mock.calls[0][1]);
  });

  it('US-09-TC15: tạo hồ sơ bị 409 trùng phone → báo lỗi, không tự gửi lại bằng key mới', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(membersApi, 'create')
      .mockRejectedValue(new ApiError('Số điện thoại đã có hồ sơ hội viên', 409, 'req-1', undefined, undefined, 'MEMBER_PHONE_EXISTS'));
    renderPage();
    await fillCreateForm(user);
    await user.click(screen.getByRole('button', { name: 'Tạo hồ sơ' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Số điện thoại đã có hồ sơ hội viên');
    await new Promise(done => setTimeout(done, 50));
    expect(create).toHaveBeenCalledTimes(1);
  });

  // ---------- Liên kết tách riêng, không chọn sẵn ----------
  it('US-09-TC15: tìm thấy tài khoản khớp nhưng KHÔNG tự chọn hay tự liên kết; nút xác nhận chưa bật', async () => {
    const user = userEvent.setup();
    await createMemberFlow(user);
    vi.spyOn(membersApi, 'findLinkCandidates').mockResolvedValue({ items: [candidate()] });
    const link = vi.spyOn(membersApi, 'link');

    await user.type(screen.getByLabelText('Số điện thoại tài khoản'), '0901234567');
    await user.click(screen.getByRole('button', { name: 'Tìm tài khoản' }));

    const item = await screen.findByRole('listitem');
    expect(item.textContent).toContain('Lê Thị Khách');
    expect(screen.queryByRole('radio', { name: 'Đối chiếu trực tiếp trên tài khoản' })).toBeNull();
    expect(link).not.toHaveBeenCalled();
    expect(screen.getByText('Chưa liên kết')).toBeTruthy();
  });

  it('US-09-TC15: tài khoản canLink=false thì nút "Chọn tài khoản này" bị disabled', async () => {
    const user = userEvent.setup();
    await createMemberFlow(user);
    vi.spyOn(membersApi, 'findLinkCandidates').mockResolvedValue({ items: [candidate({ canLink: false })] });

    await user.type(screen.getByLabelText('Số điện thoại tài khoản'), '0901234567');
    await user.click(screen.getByRole('button', { name: 'Tìm tài khoản' }));

    const item = await screen.findByRole('listitem');
    expect((within(item).getByRole('button', { name: 'Chọn tài khoản này' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('US-09-TC15: không tìm thấy tài khoản → hiện "Không tìm thấy tài khoản"', async () => {
    const user = userEvent.setup();
    await createMemberFlow(user);
    vi.spyOn(membersApi, 'findLinkCandidates').mockResolvedValue({ items: [] });

    await user.type(screen.getByLabelText('Số điện thoại tài khoản'), '0909999999');
    await user.click(screen.getByRole('button', { name: 'Tìm tài khoản' }));

    expect(await screen.findByText('Không tìm thấy tài khoản')).toBeTruthy();
  });

  it('US-09-TC15: cách đối chiếu không chọn sẵn; "Xác nhận liên kết" chỉ bật khi đã chọn cách và ghi nhận 10–500 ký tự', async () => {
    const user = userEvent.setup();
    await createMemberFlow(user);
    vi.spyOn(membersApi, 'findLinkCandidates').mockResolvedValue({ items: [candidate()] });
    await user.type(screen.getByLabelText('Số điện thoại tài khoản'), '0901234567');
    await user.click(screen.getByRole('button', { name: 'Tìm tài khoản' }));
    await user.click(within(await screen.findByRole('listitem')).getByRole('button', { name: 'Chọn tài khoản này' }));

    const confirm = () => screen.getByRole('button', { name: 'Xác nhận liên kết' }) as HTMLButtonElement;
    const accountRadio = screen.getByRole('radio', { name: 'Đối chiếu trực tiếp trên tài khoản' }) as HTMLInputElement;
    const documentRadio = screen.getByRole('radio', { name: 'Đối chiếu giấy tờ tại quầy' }) as HTMLInputElement;
    expect(accountRadio.checked).toBe(false);
    expect(documentRadio.checked).toBe(false);
    expect(confirm().disabled).toBe(true);

    await user.type(screen.getByLabelText('Ghi nhận đối chiếu'), 'a'.repeat(9));
    await user.click(documentRadio);
    expect(confirm().disabled).toBe(true);

    await user.type(screen.getByLabelText('Ghi nhận đối chiếu'), 'a');
    expect(confirm().disabled).toBe(false);
  });

  it('US-09-TC15: liên kết thành công gửi đúng accountId, version, cách đối chiếu, ghi nhận và hiện "Đã liên kết tài khoản"', async () => {
    const user = userEvent.setup();
    await createMemberFlow(user);
    await prepareLink(user);
    const link = vi.spyOn(membersApi, 'link').mockResolvedValue({ member: member({ accountId: candidate().id, version: 1 }), linked: true });

    await user.click(screen.getByRole('button', { name: 'Xác nhận liên kết' }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Đã liên kết tài khoản'));
    expect(link).toHaveBeenCalledWith(MEMBER_ID, {
      accountId: candidate().id, version: 0, verificationMethod: 'IN_PERSON_ACCOUNT', verificationNote: NOTE,
    }, expect.stringMatching(UUID));
  });

  // ---------- Liên kết lỗi: giữ hồ sơ, không tự xóa/tạo trùng ----------
  it('US-09-TC15: liên kết bị 409 → báo lỗi, hồ sơ vẫn hiện mã và "Chưa liên kết", không gọi lại tạo hồ sơ', async () => {
    const user = userEvent.setup();
    await createMemberFlow(user);
    await prepareLink(user);
    const link = vi.spyOn(membersApi, 'link')
      .mockRejectedValue(new ApiError('Tài khoản không đủ điều kiện liên kết', 409, 'req-2', undefined, undefined, 'ACCOUNT_NOT_ELIGIBLE'));

    await user.click(screen.getByRole('button', { name: 'Xác nhận liên kết' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Tài khoản không đủ điều kiện liên kết');
    expect(screen.getByText(new RegExp(`HV-${MEMBER_ID}`))).toBeTruthy();
    expect(screen.getByText('Chưa liên kết')).toBeTruthy();
    await new Promise(done => setTimeout(done, 50));
    expect(link).toHaveBeenCalledTimes(1);
    expect(membersApi.create).toHaveBeenCalledTimes(1);
  });

  it('US-09-TC15: bấm "Xác nhận liên kết" nhiều lần khi đang gửi chỉ gửi một request', async () => {
    const user = userEvent.setup();
    await createMemberFlow(user);
    await prepareLink(user);
    let resolve!: (value: { member: Member; linked: true }) => void;
    const link = vi.spyOn(membersApi, 'link').mockReturnValue(new Promise(done => { resolve = done; }));

    const button = screen.getByRole('button', { name: 'Xác nhận liên kết' });
    await user.click(button);
    await user.click(button);

    expect(link).toHaveBeenCalledTimes(1);
    resolve({ member: member({ accountId: candidate().id, version: 1 }), linked: true });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Đã liên kết tài khoản'));
  });

  it('US-09-TC15: liên kết mất response → hồ sơ vẫn giữ, "Gửi lại" gửi link với lại đúng key cũ', async () => {
    const user = userEvent.setup();
    await createMemberFlow(user);
    await prepareLink(user);
    const link = vi.spyOn(membersApi, 'link')
      .mockRejectedValueOnce(new ApiError('Không kết nối được máy chủ'))
      .mockResolvedValueOnce({ member: member({ accountId: candidate().id, version: 1 }), linked: true });

    await user.click(screen.getByRole('button', { name: 'Xác nhận liên kết' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(new RegExp(`HV-${MEMBER_ID}`))).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Gửi lại' }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Đã liên kết tài khoản'));
    expect(link).toHaveBeenCalledTimes(2);
    expect(link.mock.calls[1][2]).toBe(link.mock.calls[0][2]);
    expect(membersApi.create).toHaveBeenCalledTimes(1);
  });
});
