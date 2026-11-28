import { useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { membersApi, type LinkCandidate, type LinkInput, type LinkResult, type Member, type MemberOperation } from './members.api';

export function memberErrorMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : 'Không thể thực hiện thao tác';
  const fields = cause instanceof ApiError ? cause.details?.map(detail => `${detail.field}: ${detail.message}`).join('; ') : '';
  return `${message}${fields ? ` (${fields})` : ''}${cause instanceof ApiError && cause.requestId ? ` — Mã tra cứu: ${cause.requestId}` : ''}`;
}

export function isMemberOutcomeUnknown(cause: unknown) {
  return !(cause instanceof ApiError) || cause.status === undefined || cause.status >= 500;
}

export async function recoverMemberOperation(operation: MemberOperation, key: string) {
  try { return (await membersApi.lookup(operation, key)).responseBody; }
  catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 404 && cause.code === 'OPERATION_UNKNOWN')) throw cause;
    // Yêu cầu gốc có thể đang chạy. Chỉ gửi lại dữ liệu và khóa đã lưu.
    return null;
  }
}

export function MemberAccountLink({ member, onLinked, onReloaded, onLockChange }: {
  member: Member; onLinked: (member: Member) => void; onReloaded: (member: Member) => void; onLockChange?: (locked: boolean) => void;
}) {
  const [phone, setPhone] = useState(member.phone);
  const [candidates, setCandidates] = useState<LinkCandidate[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [method, setMethod] = useState<LinkInput['verificationMethod'] | ''>('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const intent = useRef<{ key: string; input: LinkInput } | null>(null);
  const busy = useRef(false);

  function clearSelection() {
    setCandidates(null); setSelectedId(''); setConfirmed(false);
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    if (busy.current || intent.current) return;
    busy.current = true; setPending(true); setError(''); clearSelection();
    try { setCandidates((await membersApi.candidates(phone)).items); }
    catch (cause) { setError(memberErrorMessage(cause)); }
    finally { busy.current = false; setPending(false); }
  }
  async function run(current: NonNullable<typeof intent.current>, recover = false) {
    if (busy.current) return;
    busy.current = true; intent.current = current; setPending(true); setError(''); onLockChange?.(true);
    try {
      const recovered = recover ? await recoverMemberOperation('MEMBER_LINK', current.key) as LinkResult | null : null;
      const result = recovered ?? await membersApi.link(member.id, current.input, current.key);
      intent.current = null; setUncertain(false); onLinked(result.member);
    } catch (cause) {
      setError(memberErrorMessage(cause));
      const unknown = isMemberOutcomeUnknown(cause);
      setUncertain(unknown);
      if (!unknown) {
        intent.current = null;
        clearSelection();
        setStale(cause instanceof ApiError && cause.code === 'VERSION_CONFLICT');
      }
    } finally {
      busy.current = false; setPending(false); onLockChange?.(intent.current !== null);
    }
  }
  function link(event: FormEvent) {
    event.preventDefault();
    if (busy.current || intent.current || !selectedId || !method || !confirmed || note.trim().length < 10) return;
    void run({ key: crypto.randomUUID(), input: { accountId: selectedId, version: member.version,
      verificationMethod: method, verificationNote: note.trim() } });
  }
  async function reload() {
    if (busy.current || intent.current) return;
    busy.current = true; setPending(true); setError(''); onLockChange?.(true);
    try {
      const result = await membersApi.detail(member.id);
      setPhone(result.member.phone); setStale(false); onReloaded(result.member);
    } catch (cause) { setError(memberErrorMessage(cause)); }
    finally { busy.current = false; setPending(false); onLockChange?.(false); }
  }
  const frozen = pending || uncertain || stale;
  return <section aria-label="Liên kết tài khoản">
    {error && <p role="alert">{error}</p>}
    {pending && <p role="status">Đang xử lý liên kết…</p>}
    {stale && <div><p>Tải lại hồ sơ để lấy phiên bản mới nhất trước khi đối chiếu lại.</p>
      <button type="button" disabled={pending} onClick={() => void reload()}>Tải lại dữ liệu liên kết</button></div>}
    {uncertain && <div><p>Chưa xác định kết quả. Giữ nguyên dữ liệu và khóa yêu cầu trong trang này.</p>
      <button type="button" disabled={pending} onClick={() => intent.current && void run(intent.current, true)}>Tra cứu kết quả / thử lại cùng khóa</button></div>}
    <form onSubmit={search}><fieldset disabled={frozen}><legend>Tìm tài khoản</legend>
      <label>Số điện thoại tài khoản<input required type="tel" value={phone}
        onChange={event => { setPhone(event.target.value); clearSelection(); }} /></label>
      <button type="submit"><Icon name="search" label="Tìm chính xác số điện thoại" showLabel /></button>
    </fieldset></form>
    {candidates?.length === 0 && <p>Không tìm thấy tài khoản MEMBER đang hoạt động.</p>}
    {!!candidates?.length && <form onSubmit={link}><fieldset disabled={frozen}><legend>Đối chiếu trực tiếp tại quầy</legend>
      {candidates.map(candidate => <label key={candidate.id}><input type="radio" name="account" required disabled={!candidate.canLink}
        checked={selectedId === candidate.id} onChange={() => { setSelectedId(candidate.id); setConfirmed(false); }} />
        {candidate.fullName} — {candidate.phone}{!candidate.canLink && ' — Không đủ điều kiện liên kết'}</label>)}
      <p>Nhân viên phải xác minh đúng chủ thể trực tiếp tại quầy.</p>
      <label>Cách đối chiếu<select required value={method} onChange={event => { setMethod(event.target.value as typeof method); setConfirmed(false); }}>
        <option value="">Chọn cách đối chiếu</option><option value="IN_PERSON_ACCOUNT">Đối chiếu tài khoản trực tiếp</option>
        <option value="IN_PERSON_DOCUMENT">Đối chiếu giấy tờ trực tiếp</option></select></label>
      <label>Ghi nhận đối chiếu<textarea required minLength={10} maxLength={500} value={note}
        onChange={event => { setNote(event.target.value); setConfirmed(false); }} /></label>
      <p>Chỉ mô tả cách đối chiếu. Tránh ghi số CCCD hoặc tải ảnh giấy tờ.</p>
      <label><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
        Tôi đã đối chiếu trực tiếp và xác nhận đúng người</label>
      <button type="submit" disabled={!selectedId || !method || !confirmed || note.trim().length < 10}>Xác nhận liên kết</button>
    </fieldset></form>}
  </section>;
}
