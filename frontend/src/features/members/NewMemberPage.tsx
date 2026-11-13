import { useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { membersApi, type LinkCandidate, type LinkInput, type LinkResult, type Member, type MemberInput, type MemberOperation } from './members.api';
import { Icon } from '../../components/Icon';

type Intent = { operation: 'MEMBER_CREATE'; key: string; input: MemberInput } |
  { operation: 'MEMBER_LINK'; key: string; memberId: string; input: LinkInput };

export function NewMemberPage() {
  const [member, setMember] = useState<Member | null>(null);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [address, setAddress] = useState('');
  const [searchPhone, setSearchPhone] = useState('');
  const [candidates, setCandidates] = useState<LinkCandidate[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [method, setMethod] = useState<LinkInput['verificationMethod'] | ''>('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const intent = useRef<Intent | null>(null);
  const busy = useRef(false);

  function showError(cause: unknown) {
    const message = cause instanceof Error ? cause.message : 'Không thể thực hiện thao tác';
    const fields = cause instanceof ApiError ? cause.details?.map(detail => `${detail.field}: ${detail.message}`).join('; ') : '';
    setError(`${message}${fields ? ` (${fields})` : ''}${cause instanceof ApiError && cause.requestId ? ` — Mã tra cứu: ${cause.requestId}` : ''}`);
  }
  function complete(operation: MemberOperation, body: Member | LinkResult) {
    const saved = operation === 'MEMBER_CREATE' ? body as Member : (body as LinkResult).member;
    setMember(saved); setSearchPhone(saved.phone); setCandidates(null); setSelectedId('');
    setStatus(operation === 'MEMBER_CREATE' ? 'Đã tạo hồ sơ hội viên. Có thể liên kết tài khoản ở bước riêng bên dưới.' : 'Đã liên kết tài khoản và lưu ghi nhận đối chiếu.');
    intent.current = null; setUncertain(false);
  }
  async function run(current: Intent, recover = false) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(''); setStatus('');
    intent.current = current;
    try {
      if (recover) {
        try {
          const result = await membersApi.lookup(current.operation, current.key);
          complete(current.operation, result.responseBody);
          return;
        } catch (cause) {
          if (!(cause instanceof ApiError && cause.status === 404 && cause.code === 'OPERATION_UNKNOWN')) throw cause;
          // Unknown means the original may still be running. Only resend the frozen payload and key.
        }
      }
      const result = current.operation === 'MEMBER_CREATE'
        ? await membersApi.create(current.input, current.key)
        : await membersApi.link(current.memberId, current.input, current.key);
      complete(current.operation, result);
    } catch (cause) {
      showError(cause);
      if (!(cause instanceof ApiError) || cause.status === undefined || cause.status >= 500) {
        setUncertain(true);
      } else {
        intent.current = null; setUncertain(false);
        if (cause.code === 'MEMBER_PHONE_EXISTS') setDuplicate(true);
        if (current.operation === 'MEMBER_LINK') { setCandidates(null); setSelectedId(''); setConfirmed(false); }
      }
    } finally { busy.current = false; setPending(false); }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    if (busy.current || intent.current || duplicate) return;
    void run({ operation: 'MEMBER_CREATE', key: crypto.randomUUID(), input: {
      fullName, phone, ...(birthDate ? { birthDate } : {}), ...(address.trim() ? { address: address.trim() } : {}),
    } });
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true; setPending(true); setError(''); setCandidates(null); setSelectedId(''); setConfirmed(false);
    try { setCandidates((await membersApi.candidates(searchPhone)).items); }
    catch (cause) { showError(cause); }
    finally { busy.current = false; setPending(false); }
  }
  function link(event: FormEvent) {
    event.preventDefault();
    if (busy.current || intent.current || !member || !selectedId || !method || !confirmed) return;
    void run({ operation: 'MEMBER_LINK', key: crypto.randomUUID(), memberId: member.id,
      input: { accountId: selectedId, version: member.version, verificationMethod: method, verificationNote: note.trim() } });
  }
  const frozen = pending || uncertain;
  return <section className="auth-card member-create-page"><h2>Tạo hồ sơ hội viên tại quầy</h2>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    {pending && <p role="status">Đang xử lý…</p>}
    {uncertain && <div><p>Chưa xác định kết quả. Giữ nguyên dữ liệu và khóa yêu cầu trong trang này.</p>
      <button type="button" disabled={pending} onClick={() => intent.current && void run(intent.current, true)}>Tra cứu kết quả / thử lại cùng khóa</button></div>}
    {!member ? <form onSubmit={create}><fieldset disabled={frozen}>
      <legend>Thông tin hồ sơ</legend>
      <label>Họ tên *<input required minLength={2} maxLength={120} value={fullName} onChange={e => setFullName(e.target.value)} /></label>
      <label>Số điện thoại *<input required type="tel" maxLength={32} value={phone} onChange={e => { setPhone(e.target.value); setDuplicate(false); }} /></label>
      <label>Ngày sinh<input type="date" max={new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())} value={birthDate} onChange={e => setBirthDate(e.target.value)} /></label>
      <label>Địa chỉ<input maxLength={255} value={address} onChange={e => setAddress(e.target.value)} /></label>
      <button type="submit" disabled={duplicate}>Tạo hồ sơ</button>
      {duplicate && <p>Không gửi lại yêu cầu tạo. Vui lòng tra cứu hồ sơ có sẵn để tiếp tục phục vụ.</p>}
    </fieldset></form> : <>
      <dl><dt>Mã hội viên</dt><dd>{member.memberCode}</dd><dt>Họ tên</dt><dd>{member.fullName}</dd>
        <dt>Số điện thoại</dt><dd>{member.phone}</dd><dt>Tài khoản</dt><dd>{member.accountId ?? 'Chưa liên kết'}</dd></dl>
      <a href={member.id}>Xem và chỉnh sửa hồ sơ</a>
      {!member.accountId && <section aria-label="Liên kết tài khoản"><h3>Liên kết tài khoản sau đối chiếu</h3>
        <form onSubmit={search}><fieldset disabled={frozen}><legend>Tìm tài khoản</legend>
          <label>Số điện thoại tài khoản<input required type="tel" value={searchPhone} onChange={e => { setSearchPhone(e.target.value); setCandidates(null); setSelectedId(''); setConfirmed(false); }} /></label>
          <button type="submit"><Icon name="search" label="Tìm chính xác số điện thoại" showLabel /></button>
        </fieldset></form>
        {candidates?.length === 0 && <p>Không tìm thấy tài khoản MEMBER đang hoạt động.</p>}
        {!!candidates?.length && <form onSubmit={link}><fieldset disabled={frozen}><legend>Đối chiếu trực tiếp tại quầy</legend>
          {candidates.map(candidate => <label key={candidate.id}><input type="radio" name="account" required disabled={!candidate.canLink}
            checked={selectedId === candidate.id} onChange={() => { setSelectedId(candidate.id); setConfirmed(false); }} />
            {candidate.fullName} — {candidate.phone}{!candidate.canLink && ' — Không đủ điều kiện liên kết'}</label>)}
          <p>Khớp số điện thoại chỉ là điều kiện dữ liệu. Nhân viên phải xác minh đúng chủ thể trực tiếp.</p>
          <label>Cách đối chiếu<select required value={method} onChange={e => { setMethod(e.target.value as LinkInput['verificationMethod'] | ''); setConfirmed(false); }}>
            <option value="">Chọn cách đối chiếu</option><option value="IN_PERSON_ACCOUNT">Đối chiếu tài khoản trực tiếp</option>
            <option value="IN_PERSON_DOCUMENT">Đối chiếu giấy tờ trực tiếp</option></select></label>
          <label>Ghi nhận đối chiếu<textarea required minLength={10} maxLength={500} value={note} onChange={e => { setNote(e.target.value); setConfirmed(false); }} /></label>
          <p>Chỉ mô tả cách đối chiếu; không ghi số CCCD hoặc tải ảnh giấy tờ.</p>
          <label><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Tôi đã đối chiếu trực tiếp và xác nhận đúng người</label>
          <button type="submit" disabled={!selectedId || !method || !confirmed || note.trim().length < 10}>Xác nhận liên kết</button>
        </fieldset></form>}
      </section>}
    </>}
  </section>;
}
