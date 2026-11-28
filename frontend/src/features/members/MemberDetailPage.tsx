import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { membersApi, type Member, type MemberDetail } from './members.api';
import { MemberEntitlements, MemberReadTime } from './MemberEntitlements';
import { MemberHistory } from './MemberHistory';
import { ServiceSalePanel } from '../sales/ServiceSalePanel';
import { Icon } from '../../components/Icon';
import { MemberAccountLink } from './MemberAccountLink';

const fields = ['fullName', 'phone', 'birthDate', 'address'] as const;
type Field = typeof fields[number];
type Draft = Record<Field, string>;
type FieldErrors = Partial<Record<Field, string>>;
const draftOf = (member: Member): Draft => ({ fullName: member.fullName, phone: member.phone,
  birthDate: member.birthDate ?? '', address: member.address ?? '' });
const vietnamToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
const profileTabs = [
  { id: 'overview', label: 'Thông tin' },
  { id: 'rights', label: 'Quyền lợi' },
  { id: 'memberships', label: 'Lịch sử gói' },
  { id: 'transactions', label: 'Giao dịch' },
] as const;
type ProfileTab = typeof profileTabs[number]['id'];

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
  const { pathname, state } = useLocation();
  const listPath = pathname.toLowerCase().startsWith('/admin') ? '/admin/members' : '/staff/members';
  const listSearch = typeof state?.memberListSearch === 'string' ? state.memberListSearch : '';
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
  const [tab, setTab] = useState<ProfileTab>('overview');
  const [linkLocked, setLinkLocked] = useState(false);
  const [linkRevision, setLinkRevision] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [rightsRevision, setRightsRevision] = useState(0);
  const [rightsError, setRightsError] = useState('');
  const tabButtons = useRef<Partial<Record<ProfileTab, HTMLButtonElement | null>>>({});
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
    if (!rightsRevision) return;
    const controller = new AbortController();
    setRightsError('');
    void membersApi.detail(id, controller.signal).then(result => {
      if (!controller.signal.aborted) setDetail(result);
    }, cause => {
      if (!controller.signal.aborted) setRightsError(cause instanceof ApiError ? cause.message : 'Không tải được quyền lợi.');
    });
    return () => controller.abort();
  }, [id, rightsRevision]);
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
      setRightsError(''); setLinkRevision(value => value + 1);
      setErrors({}); setBlocked(false); setStopped(false); setConfirmReload(false);
    } catch (cause) { if (alive.current) report(cause); }
    finally { busy.current = false; if (alive.current) setPending(false); }
  }
  function selectTabFromKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = profileTabs.length - 1;
    const indexes: Record<string, number> = {
      ArrowRight: (index + 1) % profileTabs.length, ArrowLeft: (index + last) % profileTabs.length, Home: 0, End: last,
    };
    const next = profileTabs[indexes[event.key]];
    if (!next) return;
    event.preventDefault();
    setTab(next.id);
    tabButtons.current[next.id]?.focus();
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

  return <section className="gm-member-profile" aria-busy={pending}>
    <Link className="gm-profile-back" to={{ pathname: listPath, search: listSearch }}><Icon name="back" />Về danh sách hội viên</Link>
    {member && !stopped ? <ServiceSalePanel memberId={id} heading={<h1>Hồ sơ hội viên</h1>}
      disabled={editing} onUpdated={() => { setHistoryRevision(value => value + 1); setRightsRevision(value => value + 1); }} />
      : <h1>Hồ sơ hội viên</h1>}
    {pending && <p role="status">Đang xử lý…</p>}
    {error && <div role="alert"><p>{error.message}</p>{error.requestId && <small>Mã tra cứu: {error.requestId}</small>}</div>}
    {status && <p role="status">{status}</p>}
    {stopped && <p>Đã dừng thao tác vì hồ sơ không tồn tại hoặc bạn không còn quyền truy cập.</p>}
    {!member && !pending && !stopped && <button type="button" onClick={() => void load(false)}><Icon name="retry" label="Tải lại hồ sơ" showLabel /></button>}
    {member && !stopped && <>
      <header className="gm-panel gm-profile-summary">
        <span className="gm-avatar" aria-hidden="true">{member.fullName.trim().split(/\s+/).pop()?.charAt(0).toUpperCase()}</span>
        <div><h2>{member.fullName}</h2><p><span>{member.memberCode}</span> · {member.phone}</p></div>
        <span className="gm-chip" data-state={member.accountId ? 'LINKED' : 'NONE'}>{member.accountId ? 'Đã liên kết' : 'Chưa liên kết'}</span>
        {!editing && <button type="button" disabled={pending || blocked || linkLocked}
          onClick={() => { setTab('overview'); void load(true); }}>Chỉnh sửa</button>}
      </header>
      <div className="gm-profile-tabs" role="tablist" aria-label="Hồ sơ hội viên">
        {profileTabs.map((item, index) => <button type="button" role="tab" key={item.id} id={`gm-member-tab-${item.id}`}
          ref={element => { tabButtons.current[item.id] = element; }} aria-selected={tab === item.id}
          aria-controls={`gm-member-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
          onClick={() => setTab(item.id)} onKeyDown={event => selectTabFromKey(event, index)}>{item.label}</button>)}
      </div>
      <section className="gm-panel gm-profile-panel" role="tabpanel" id="gm-member-panel-overview" aria-labelledby="gm-member-tab-overview"
        hidden={tab !== 'overview'} tabIndex={0}>
      <h3>Thông tin cá nhân</h3>
      <dl className="gm-profile-facts"><div><dt>Số điện thoại</dt><dd>{member.phone}</dd></div>
        <div><dt>Ngày sinh</dt><dd>{member.birthDate ?? 'Chưa có'}</dd></div>
        <div><dt>Địa chỉ</dt><dd>{member.address ?? 'Chưa có'}</dd></div>
        <div><dt>Tài khoản</dt><dd>{member.accountId ?? 'Chưa có tài khoản liên kết'}</dd></div></dl>
      {editing && <>
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
        <button ref={reloadButton} type="button" disabled={pending} onClick={() => setConfirmReload(true)}><Icon name="retry" label="Tải lại hồ sơ" showLabel /></button></div>}
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
      {!member.accountId && <details className="gm-link-account" hidden={editing || blocked}>
        <summary>Liên kết tài khoản</summary>
        <MemberAccountLink key={`${member.version}:${linkRevision}`} member={member} onLockChange={setLinkLocked}
          onReloaded={setMember} onLinked={saved => { setMember(saved); setStatus('Đã liên kết tài khoản và lưu ghi nhận đối chiếu.'); }} />
      </details>}
      </section>
      <section className="gm-panel gm-profile-panel" role="tabpanel" id="gm-member-panel-rights" aria-labelledby="gm-member-tab-rights"
        hidden={tab !== 'rights'} tabIndex={0}>
        <div className="gm-section-head"><h3>Quyền lợi tập luyện</h3>
          <button type="button" disabled={pending || editing || blocked || linkLocked} onClick={() => void load(false)}>
            <Icon name="retry" label="Làm mới hồ sơ và quyền lợi" showLabel /></button></div>
        {rightsError && <p role="alert">{rightsError}</p>}
        {detail && <><MemberEntitlements summary={detail.entitlementSummary} /><MemberReadTime time={detail} /></>}
      </section>
      <MemberHistory id={id} tab={tab === 'memberships' || tab === 'transactions' ? tab : null}
        revision={historyRevision} onUpdated={() => setRightsRevision(value => value + 1)} />
    </>}
  </section>;
}
