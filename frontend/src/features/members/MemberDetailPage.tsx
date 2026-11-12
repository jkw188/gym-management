import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { membersApi, type Member, type MemberDetail } from './members.api';
import { MemberEntitlements, MemberReadTime } from './MemberEntitlements';
import { MemberHistory } from './MemberHistory';
import { ServiceSalePanel } from '../sales/ServiceSalePanel';

const fields = ['fullName', 'phone', 'birthDate', 'address'] as const;
type Field = typeof fields[number];
type Draft = Record<Field, string>;
type FieldErrors = Partial<Record<Field, string>>;
const draftOf = (member: Member): Draft => ({ fullName: member.fullName, phone: member.phone,
  birthDate: member.birthDate ?? '', address: member.address ?? '' });
const vietnamToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());

function validate(draft: Draft): FieldErrors {
  const errors: FieldErrors = {};
  const length = Array.from(draft.fullName.trim().replace(/\s+/g, ' ')).length;
  if (length < 2 || length > 120) errors.fullName = 'Họ tên phải từ 2 đến 120 ký tự.';
  let depth = 0;
  let balanced = true;
  for (const char of draft.phone) {
    if (char === '(' && ++depth > 1) balanced = false;
    if (char === ')' && --depth < 0) balanced = false;
  }
  let phone = draft.phone.replace(/[\s.()\-]/g, '');
  if (/^0\d{9,10}$/.test(phone)) phone = `+84${phone.slice(1)}`;
  else if (/^84\d{9,10}$/.test(phone)) phone = `+${phone}`;
  if (draft.phone.length > 32 || !/^[+\d\s.()\-]+$/.test(draft.phone) || !/^\+[1-9]\d{7,14}$/.test(phone) ||
    !balanced || depth !== 0 || /\(\s*\)/.test(draft.phone)) errors.phone = 'Số điện thoại không hợp lệ.';
  if (draft.birthDate) {
    const date = new Date(`${draft.birthDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.birthDate) || Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== draft.birthDate || draft.birthDate > vietnamToday()) {
      errors.birthDate = 'Ngày sinh phải hợp lệ và không sau ngày hiện tại (giờ Việt Nam).';
    }
  }
  if (draft.address.trim().length > 255) errors.address = 'Địa chỉ tối đa 255 ký tự.';
  return errors;
}

export function MemberDetailPage() {
  const { id = '' } = useParams();
  return <MemberProfileEditor key={id} id={id} />;
}

function MemberProfileEditor({ id }: { id: string }) {
  const { pathname } = useLocation();
  const [member, setMember] = useState<Member | null>(null);
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [draft, setDraft] = useState<Draft>({ fullName: '', phone: '', birthDate: '', address: '' });
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const firstInput = useRef<HTMLInputElement>(null);
  const reloadButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void membersApi.detail(id, controller.signal).then(result => {
      if (!controller.signal.aborted) { setMember(result.member); setDetail(result); setDraft(draftOf(result.member)); }
    }, cause => { if (!controller.signal.aborted) report(cause); }).finally(() => {
      if (!controller.signal.aborted) setPending(false);
    });
    return () => { alive.current = false; controller.abort(); };
  }, [id]);
  useEffect(() => {
    if (editing && !pending) {
      if (fields.some(field => errors[field])) focusError(errors);
      else firstInput.current?.focus();
    }
  }, [editing, pending]);

  function report(cause: unknown) {
    const problem = cause instanceof ApiError ? cause : new ApiError('Không thể xử lý hồ sơ.');
    setError(problem);
    if ([401, 403, 404].includes(problem.status ?? 0)) { setStopped(true); setEditing(false); }
    return problem;
  }
  async function load(edit: boolean) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null); setStatus('');
    try {
      const result = await membersApi.detail(id);
      if (!alive.current) return;
      setMember(result.member); setDetail(result); setDraft(draftOf(result.member)); setEditing(edit);
      setErrors({}); setBlocked(false); setStopped(false); setConfirmReload(false);
    } catch (cause) { if (alive.current) report(cause); }
    finally { busy.current = false; if (alive.current) setPending(false); }
  }
  function closeReload() { setConfirmReload(false); reloadButton.current?.focus(); }
  function focusError(fieldErrors: FieldErrors) {
    const first = fields.find(field => fieldErrors[field]);
    if (first) (form.current?.elements.namedItem(first) as HTMLInputElement | null)?.focus();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!member || busy.current || blocked || stopped) return;
    const fieldErrors = validate(draft); setErrors(fieldErrors); setError(null); setStatus('');
    if (Object.keys(fieldErrors).length) { focusError(fieldErrors); return; }
    busy.current = true; setPending(true);
    try {
      const result = await membersApi.update(id, { version: member.version, fullName: draft.fullName,
        phone: draft.phone, birthDate: draft.birthDate || null, address: draft.address.trim() || null });
      if (!alive.current) return;
      setMember(result.member); setDraft(draftOf(result.member)); setEditing(false);
      setStatus(result.changed ? 'Đã cập nhật hồ sơ hội viên.' : 'Thông tin không thay đổi.');
    } catch (cause) {
      if (!alive.current) return;
      const problem = report(cause);
      const fieldErrors: FieldErrors = {};
      for (const detail of problem.details ?? []) {
        if (fields.includes(detail.field as Field)) fieldErrors[detail.field as Field] = detail.message;
      }
      if (problem.code === 'MEMBER_PHONE_EXISTS') fieldErrors.phone = 'Số điện thoại đã có hồ sơ hội viên.';
      setErrors(fieldErrors);
      if (problem.code === 'VERSION_CONFLICT' || problem.status === undefined || (problem.status ?? 0) >= 500) setBlocked(true);
    } finally { busy.current = false; if (alive.current) setPending(false); }
  }
  const props = (field: Field) => ({ id: `edit-${field}`, name: field, value: draft[field],
    'aria-invalid': !!errors[field], 'aria-describedby': errors[field] ? `edit-${field}-error` : undefined,
    onChange: (event: { target: { value: string } }) => {
      setDraft(current => ({ ...current, [field]: event.target.value }));
      setErrors(current => ({ ...current, [field]: undefined }));
    } });
  const fieldError = (field: Field) => errors[field] && <p className="field-error" id={`edit-${field}-error`}>{errors[field]}</p>;

  return <section className="auth-card" aria-busy={pending}>
    <h2>Hồ sơ hội viên</h2>
    <Link to={pathname.startsWith('/admin') ? '/admin/members' : '/staff/members'}>Về danh sách hội viên</Link>
    <p>Thông tin hội viên độc lập với thông tin tài khoản đăng nhập. Sửa hồ sơ không đổi tài khoản hoặc gói tập.</p>
    {pending && <p role="status">Đang xử lý…</p>}
    {error && <div role="alert"><p>{error.message}</p>{error.requestId && <small>Mã tra cứu: {error.requestId}</small>}</div>}
    {status && <p role="status">{status}</p>}
    {stopped && <p>Đã dừng thao tác vì hồ sơ không tồn tại hoặc bạn không còn quyền truy cập.</p>}
    {!member && !pending && !stopped && <button type="button" onClick={() => void load(false)}>Tải lại hồ sơ</button>}
    {member && !stopped && <>
      <dl><dt>Mã hội viên</dt><dd>{member.memberCode}</dd><dt>Liên kết tài khoản (chỉ đọc)</dt><dd>{member.accountId ?? 'Chưa liên kết'}</dd></dl>
      {detail && <><MemberEntitlements summary={detail.entitlementSummary} /><MemberReadTime time={detail} /></>}
      {!editing ? <><dl><dt>Họ tên</dt><dd>{member.fullName}</dd><dt>Số điện thoại</dt><dd>{member.phone}</dd>
        <dt>Ngày sinh</dt><dd>{member.birthDate ?? 'Chưa có'}</dd><dt>Địa chỉ</dt><dd>{member.address ?? 'Chưa có'}</dd></dl>
        <button type="button" disabled={pending} onClick={() => void load(true)}>Chỉnh sửa</button></> : <>
        <form ref={form} noValidate onSubmit={save}><fieldset disabled={pending || blocked}><legend>Chỉnh sửa thông tin hội viên</legend>
          <label htmlFor="edit-fullName">Họ tên *</label><input ref={firstInput} {...props('fullName')} required />{fieldError('fullName')}
          <label htmlFor="edit-phone">Số điện thoại *</label><input {...props('phone')} type="tel" required maxLength={32} />{fieldError('phone')}
          <label htmlFor="edit-birthDate">Ngày sinh</label><input {...props('birthDate')} type="date" max={vietnamToday()} />{fieldError('birthDate')}
          <label htmlFor="edit-address">Địa chỉ</label><input {...props('address')} />{fieldError('address')}
          <button type="submit">Lưu</button>
        </fieldset></form>
        <button type="button" disabled={pending} onClick={() => { setDraft(draftOf(member)); setEditing(false); setErrors({}); setError(null);
          if (blocked) { setStatus('Chưa xác định dữ liệu mới nhất. Tải lại hồ sơ trước khi chỉnh sửa tiếp.'); } }}>Hủy sửa</button>
      </>}
      {blocked && <div><p>Hồ sơ đã thay đổi hoặc chưa xác định kết quả lưu. Cần GET lại để đối chiếu; không tự gửi lại bản nhập cũ.</p>
        <button ref={reloadButton} type="button" disabled={pending} onClick={() => setConfirmReload(true)}>Tải lại hồ sơ</button></div>}
      {confirmReload && <div role="dialog" aria-modal="true" aria-label="Xác nhận tải lại" onKeyDown={event => {
        if (event.key === 'Escape' && !pending) { event.preventDefault(); closeReload(); }
        if (event.key === 'Tab') {
          const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
          const first = buttons[0]; const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
        <p>Tải lại sẽ bỏ dữ liệu chưa lưu. Hãy ghi nhận bản nhập để đối chiếu với dữ liệu mới trước khi chỉnh sửa lại.</p>
        <button type="button" autoFocus disabled={pending} onClick={() => void load(false)}>Xác nhận tải lại</button>
        <button type="button" disabled={pending} onClick={closeReload}>Giữ bản nhập</button>
      </div>}
      {!editing && <><button type="button" disabled={pending} onClick={() => void load(false)}>Làm mới hồ sơ và quyền lợi</button>
        <ServiceSalePanel memberId={id} /><MemberHistory id={id} /></>}
    </>}
  </section>;
}
