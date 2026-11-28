import { useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { isMemberOutcomeUnknown, MemberAccountLink, memberErrorMessage, recoverMemberOperation } from './MemberAccountLink';
import { membersApi, type Member, type MemberInput } from './members.api';

type Intent = { key: string; input: MemberInput };

export function NewMemberPage() {
  const [member, setMember] = useState<Member | null>(null);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [address, setAddress] = useState('');
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const intent = useRef<Intent | null>(null);
  const busy = useRef(false);

  async function run(current: Intent, recover = false) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(''); setStatus('');
    intent.current = current;
    try {
      const recovered = recover ? await recoverMemberOperation('MEMBER_CREATE', current.key) as Member | null : null;
      setMember(recovered ?? await membersApi.create(current.input, current.key));
      setStatus('Đã tạo hồ sơ hội viên. Có thể liên kết tài khoản ở bước riêng bên dưới.');
      intent.current = null; setUncertain(false);
    } catch (cause) {
      setError(memberErrorMessage(cause));
      const unknown = isMemberOutcomeUnknown(cause);
      setUncertain(unknown);
      if (!unknown) {
        intent.current = null;
        if (cause instanceof ApiError && cause.code === 'MEMBER_PHONE_EXISTS') setDuplicate(true);
      }
    } finally { busy.current = false; setPending(false); }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    if (busy.current || intent.current || duplicate) return;
    void run({ key: crypto.randomUUID(), input: {
      fullName, phone, ...(birthDate ? { birthDate } : {}), ...(address.trim() ? { address: address.trim() } : {}),
    } });
  }

  return <section className="auth-card member-create-page"><h2>Tạo hồ sơ hội viên tại quầy</h2>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    {pending && <p role="status">Đang xử lý…</p>}
    {uncertain && <div><p>Chưa xác định kết quả. Giữ nguyên dữ liệu và khóa yêu cầu trong trang này.</p>
      <button type="button" disabled={pending} onClick={() => intent.current && void run(intent.current, true)}>Tra cứu kết quả / thử lại cùng khóa</button></div>}
    {!member ? <form onSubmit={create}><fieldset disabled={pending || uncertain}>
      <legend>Thông tin hồ sơ</legend>
      <label>Họ tên *<input required minLength={2} maxLength={120} value={fullName} onChange={e => setFullName(e.target.value)} /></label>
      <label>Số điện thoại *<input required type="tel" maxLength={32} value={phone} onChange={e => { setPhone(e.target.value); setDuplicate(false); }} /></label>
      <label>Ngày sinh<input type="date" max={new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())}
        value={birthDate} onChange={e => setBirthDate(e.target.value)} /></label>
      <label>Địa chỉ<input maxLength={255} value={address} onChange={e => setAddress(e.target.value)} /></label>
      <button type="submit" disabled={duplicate}>Tạo hồ sơ</button>
      {duplicate && <p>Không gửi lại yêu cầu tạo. Vui lòng tra cứu hồ sơ có sẵn để tiếp tục phục vụ.</p>}
    </fieldset></form> : <>
      <dl><dt>Mã hội viên</dt><dd>{member.memberCode}</dd><dt>Họ tên</dt><dd>{member.fullName}</dd>
        <dt>Số điện thoại</dt><dd>{member.phone}</dd><dt>Tài khoản</dt><dd>{member.accountId ?? 'Chưa liên kết'}</dd></dl>
      <a href={member.id}>Xem và chỉnh sửa hồ sơ</a>
      {!member.accountId && <><h3>Liên kết tài khoản sau đối chiếu</h3>
        <MemberAccountLink key={member.version} member={member} onReloaded={setMember} onLinked={saved => {
          setMember(saved); setStatus('Đã liên kết tài khoản và lưu ghi nhận đối chiếu.');
        }} /></>}
    </>}
  </section>;
}
