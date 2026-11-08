// Tầng giao diện – trang (US-09 bước 3): Staff/Admin tạo hồ sơ hội viên tại quầy, sau đó liên kết tài khoản ở bước riêng.
// Tạo và liên kết là hai ý định khác nhau: liên kết lỗi thì hồ sơ đã tạo vẫn giữ; không tự chọn hay tự liên kết.
import { useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { membersApi, type LinkCandidate, type Member, type VerificationMethod } from './members.api';

// Lỗi mạng (không có status) hoặc server báo chưa rõ kết quả: chưa biết lệnh đã chạy hay chưa, phải gửi lại cùng key.
const isOutcomeUnknown = (error: ApiError) => error.status === undefined || error.code === 'OPERATION_OUTCOME_UNKNOWN';
const asApiError = (error: unknown, fallback: string) => (error instanceof ApiError ? error : new ApiError(fallback));

const EMPTY_FORM = { fullName: '', phone: '', birthDate: '', address: '' };

export function MemberCreatePage() {
  // ---------- Bước 1: tạo hồ sơ ----------
  const [form, setForm] = useState(EMPTY_FORM);
  const [member, setMember] = useState<Member | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ApiError | null>(null);
  // useRef để chặn bấm nhiều lần ngay cả trước khi React vẽ lại nút disabled (US-09-TC15).
  const sending = useRef(false);
  const createKey = useRef<string | null>(null);

  // ---------- Bước 2: liên kết tài khoản ----------
  const [accountPhone, setAccountPhone] = useState('');
  const [candidates, setCandidates] = useState<LinkCandidate[] | null>(null);
  const [searchError, setSearchError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<LinkCandidate | null>(null);
  const [method, setMethod] = useState<VerificationMethod | null>(null);
  const [note, setNote] = useState('');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<ApiError | null>(null);
  const linkKey = useRef<string | null>(null);

  // Sửa dữ liệu là một ý định mới: lần gửi sau dùng key mới.
  function changeField(field: keyof typeof EMPTY_FORM, value: string) {
    createKey.current = null;
    setForm(current => ({ ...current, [field]: value }));
  }

  async function createMember(event?: FormEvent) {
    event?.preventDefault();
    if (sending.current) return;
    sending.current = true;
    setCreating(true);
    setCreateError(null);
    // US-09-TC15: gửi lại sau mất response dùng LẠI key cũ để server trả đúng hồ sơ đã tạo, không tạo trùng.
    createKey.current ??= crypto.randomUUID();
    const input = {
      fullName: form.fullName,
      phone: form.phone,
      // Ô để trống thì không gửi field tùy chọn.
      ...(form.birthDate ? { birthDate: form.birthDate } : {}),
      ...(form.address.trim() ? { address: form.address } : {}),
    };
    try {
      setMember(await membersApi.create(input, createKey.current));
      createKey.current = null;
    } catch (error) {
      const apiError = asApiError(error, 'Không tạo được hồ sơ hội viên.');
      // Server đã trả lời rõ (400, 409…) thì yêu cầu kết thúc, bỏ key; chưa rõ kết quả thì giữ key cho nút "Gửi lại".
      if (!isOutcomeUnknown(apiError)) createKey.current = null;
      setCreateError(apiError);
    } finally {
      sending.current = false;
      setCreating(false);
    }
  }

  async function searchAccounts(event: FormEvent) {
    event.preventDefault();
    setSearchError(null);
    setCandidates(null);
    // Tìm lại thì bỏ lựa chọn cũ: nhân viên phải chọn lại, không giữ ngầm tài khoản trước.
    chooseAccount(null);
    try {
      setCandidates((await membersApi.findLinkCandidates(accountPhone)).items);
    } catch (error) {
      setSearchError(asApiError(error, 'Không tìm được tài khoản.'));
    }
  }

  // Đổi tài khoản, cách đối chiếu hay ghi nhận là ý định liên kết mới: bỏ key và lỗi cũ.
  function chooseAccount(candidate: LinkCandidate | null) {
    linkKey.current = null;
    setLinkError(null);
    setSelected(candidate);
    setMethod(null);
    setNote('');
  }
  function changeMethod(value: VerificationMethod) { linkKey.current = null; setMethod(value); }
  function changeNote(value: string) { linkKey.current = null; setNote(value); }

  const noteLength = note.trim().length;
  // US-09-TC15: chỉ bật khi đã chọn cách đối chiếu và ghi nhận 10–500 ký tự (server vẫn kiểm lại).
  const canConfirm = !!member && !!selected && !!method && noteLength >= 10 && noteLength <= 500 && !linking;

  async function confirmLink() {
    if (!member || !selected || !method || sending.current) return;
    sending.current = true;
    setLinking(true);
    setLinkError(null);
    linkKey.current ??= crypto.randomUUID();
    try {
      // Gửi version hồ sơ đang xem để server kiểm "đúng version".
      const result = await membersApi.link(member.id, {
        accountId: selected.id, version: member.version, verificationMethod: method, verificationNote: note.trim(),
      }, linkKey.current);
      linkKey.current = null;
      setMember(result.member);
    } catch (error) {
      const apiError = asApiError(error, 'Không liên kết được tài khoản.');
      // US-09-TC15: lỗi rõ (409…) thì kết thúc yêu cầu; mất response thì giữ key cho "Gửi lại". Hồ sơ vẫn giữ nguyên.
      if (!isOutcomeUnknown(apiError)) linkKey.current = null;
      setLinkError(apiError);
    } finally {
      sending.current = false;
      setLinking(false);
    }
  }

  const linked = !!member?.accountId;

  return <section className="auth-card">
    <h2>Tạo hồ sơ hội viên</h2>
    {!member && <form onSubmit={createMember} noValidate>
      <label htmlFor="member-full-name">Họ tên</label>
      <input id="member-full-name" value={form.fullName} onChange={event => changeField('fullName', event.target.value)} required />
      <label htmlFor="member-phone">Số điện thoại</label>
      <input id="member-phone" type="tel" value={form.phone} onChange={event => changeField('phone', event.target.value)} required />
      <label htmlFor="member-birth-date">Ngày sinh</label>
      <input id="member-birth-date" type="date" value={form.birthDate} onChange={event => changeField('birthDate', event.target.value)} />
      <label htmlFor="member-address">Địa chỉ</label>
      <input id="member-address" value={form.address} onChange={event => changeField('address', event.target.value)} maxLength={255} />
      <button type="submit" disabled={creating}>Tạo hồ sơ</button>
    </form>}
    {createError && <ErrorAlert error={createError} onRetry={isOutcomeUnknown(createError) ? () => void createMember() : undefined} />}

    {member && <>
      {/* Mã hội viên chỉ hiện ở một chỗ; khi liên kết xong thông báo đổi thành "Đã liên kết tài khoản". */}
      <p role="status">{linked ? `Đã liên kết tài khoản cho hồ sơ ${member.memberCode}.` : `Đã tạo hồ sơ. Mã hội viên: ${member.memberCode}`}</p>
      <h3>Liên kết tài khoản</h3>
      <p>Trạng thái: <span>{linked ? 'Đã liên kết' : 'Chưa liên kết'}</span></p>
      {!linked && <>
        <form onSubmit={searchAccounts} noValidate>
          <label htmlFor="link-account-phone">Số điện thoại tài khoản</label>
          <input id="link-account-phone" type="tel" value={accountPhone} onChange={event => setAccountPhone(event.target.value)} />
          <button type="submit">Tìm tài khoản</button>
        </form>
        {searchError && <ErrorAlert error={searchError} />}
        {candidates?.length === 0 && <p>Không tìm thấy tài khoản</p>}
        {candidates && candidates.length > 0 && <ul>
          {candidates.map(candidate => <li key={candidate.id}>
            {candidate.fullName} – {candidate.phone}{!candidate.canLink && ' (đã gắn hồ sơ khác hoặc là PT)'}{' '}
            {/* Không chọn sẵn dù khớp: nhân viên phải tự bấm sau khi đối chiếu đúng người. */}
            <button type="button" disabled={!candidate.canLink} onClick={() => chooseAccount(candidate)}>Chọn tài khoản này</button>
          </li>)}
        </ul>}
        {selected && <div>
          <p>Tài khoản đã chọn: {selected.fullName} – {selected.phone}</p>
          <fieldset>
            <legend>Cách đối chiếu</legend>
            <label><input type="radio" name="verification-method" checked={method === 'IN_PERSON_ACCOUNT'}
              onChange={() => changeMethod('IN_PERSON_ACCOUNT')} />Đối chiếu trực tiếp trên tài khoản</label>
            <label><input type="radio" name="verification-method" checked={method === 'IN_PERSON_DOCUMENT'}
              onChange={() => changeMethod('IN_PERSON_DOCUMENT')} />Đối chiếu giấy tờ tại quầy</label>
          </fieldset>
          <label htmlFor="link-note">Ghi nhận đối chiếu</label>
          <textarea id="link-note" value={note} onChange={event => changeNote(event.target.value)} maxLength={500} />
          <p>Ghi cách đã đối chiếu, 10–500 ký tự; không ghi số giấy tờ.</p>
          <button type="button" disabled={!canConfirm} onClick={() => void confirmLink()}>Xác nhận liên kết</button>
        </div>}
        {linkError && <ErrorAlert error={linkError} onRetry={isOutcomeUnknown(linkError) ? () => void confirmLink() : undefined} />}
      </>}
    </>}
  </section>;
}

// Hiện thông điệp lỗi (kèm lỗi từng field nếu có). onRetry chỉ có khi chưa rõ kết quả: gửi lại cùng key.
function ErrorAlert({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return <div role="alert">
    <p>{error.message}</p>
    {error.details && error.details.length > 0 && <ul>{error.details.map(detail => <li key={detail.field}>{detail.field}: {detail.message}</li>)}</ul>}
    {onRetry && <button type="button" onClick={onRetry}>Gửi lại</button>}
  </div>;
}
