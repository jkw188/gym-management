import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, apiClient } from '../../api/client';
import { rolePaths } from '../auth/auth.routes';
import type { RoleCode } from '../auth/auth.types';
import { profileApi, type Profile } from './profile.api';

interface Draft { fullName: string; phone: string; email: string; birthDate: string; address: string }

const toDraft = (profile: Profile): Draft => ({
  fullName: profile.fullName, phone: profile.phone, email: profile.email ?? '',
  birthDate: profile.birthDate ?? '', address: profile.address ?? '',
});
const todayInVietnam = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());

function validate(draft: Draft): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = draft.fullName.trim().replace(/\s+/g, ' ');
  if (Array.from(name).length < 2 || Array.from(name).length > 120) errors.fullName = 'Họ tên phải từ 2 đến 120 ký tự.';
  if (!draft.phone.trim() || draft.phone.length > 32) errors.phone = 'Nhập số điện thoại hợp lệ, tối đa 32 ký tự.';
  if (draft.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) errors.email = 'Email không hợp lệ.';
  if (draft.birthDate && draft.birthDate > todayInVietnam()) errors.birthDate = 'Ngày sinh không được sau ngày hiện tại.';
  if (draft.address.trim().length > 255) errors.address = 'Địa chỉ tối đa 255 ký tự.';
  return errors;
}

export function ProfilePage({ role }: { role: RoleCode }) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoadError(null); setError(null); setFields({}); setConfirming(false); setConfirmReload(false);
    try {
      const current = await profileApi.get(controller.signal);
      if (controller.signal.aborted) return;
      setProfile(current); setDraft(toDraft(current));
    } catch (failure) {
      if (!controller.signal.aborted) setLoadError(failure instanceof ApiError ? failure : new ApiError('Không thể tải thông tin tài khoản.'));
    }
  }, []);

  useEffect(() => { void load(); return () => request.current?.abort(); }, [load]);

  useEffect(() => {
    const first = Object.keys(fields)[0];
    if (first) document.getElementById(`profile-${first}`)?.focus();
  }, [fields]);

  function change(field: keyof Draft, value: string) {
    setDraft(current => current && { ...current, [field]: value });
    setNotice(''); setConfirming(false);
  }

  function review(event: FormEvent) {
    event.preventDefault();
    if (!draft || error?.code === 'VERSION_CONFLICT') return;
    const errors = validate(draft);
    setFields(errors);
    if (!Object.keys(errors).length) setConfirming(true);
  }

  async function save() {
    if (!profile || !draft || sending.current) return;
    sending.current = true; setPending(true); setError(null); setNotice('');
    try {
      const result = await profileApi.update({
        version: profile.version, fullName: draft.fullName, phone: draft.phone,
        email: draft.email.trim() ? draft.email : null,
        birthDate: draft.birthDate || null,
        address: draft.address.trim() ? draft.address : null,
      });
      if (result.reauthenticationRequired) {
        apiClient.requireLogin();
        navigate('/login?reason=identity-changed', { replace: true });
        return;
      }
      setProfile(result.profile); setDraft(toDraft(result.profile)); setFields({});
      apiClient.updateCurrentUser({ id: result.profile.id, fullName: result.profile.fullName, phone: result.profile.phone,
        ...(result.profile.email ? { email: result.profile.email } : {}), roleCode: result.profile.roleCode });
      setNotice('Đã lưu thông tin tài khoản.');
    } catch (failure) {
      const problem = failure instanceof ApiError ? failure : new ApiError('Không thể lưu thông tin tài khoản.');
      setError(problem);
      setFields(Object.fromEntries((problem.details ?? []).map(detail => [detail.field, detail.message])));
    } finally { sending.current = false; setPending(false); setConfirming(false); }
  }

  const fieldError = (name: string) => fields[name] && <p id={`profile-${name}-error`} className="field-error" role="alert">{fields[name]}</p>;
  const attributes = (name: keyof Draft) => ({
    id: `profile-${name}`, value: draft?.[name] ?? '', onChange: (event: { target: { value: string } }) => change(name, event.target.value),
    'aria-invalid': !!fields[name], 'aria-describedby': fields[name] ? `profile-${name}-error` : undefined,
  });

  if (loadError) return <section className="auth-card" aria-labelledby="profile-title"><h2 id="profile-title">Thông tin tài khoản</h2>
    <p role="alert">{loadError.message}</p>{loadError.requestId && <small>Mã tra cứu: {loadError.requestId}</small>}
    <button type="button" onClick={() => void load()}>Thử lại</button></section>;
  if (!profile || !draft) return <section className="auth-card" aria-busy="true"><p role="status">Đang tải thông tin tài khoản…</p></section>;

  return <section className="auth-card" aria-labelledby="profile-title">
    <Link to={rolePaths[role]}>Quay lại</Link>
    <h2 id="profile-title">Thông tin tài khoản</h2>
    <p>Thông tin đăng nhập và liên hệ của tài khoản. Hồ sơ hội viên/PT được quản lý riêng. Đổi số điện thoại hoặc email sẽ phải đăng nhập lại.</p>
    {notice && <p role="status" className="user-notice">{notice}</p>}
    <form onSubmit={review} noValidate aria-busy={pending}>
      <fieldset disabled={pending}>
        <label htmlFor="profile-fullName">Họ tên</label><input {...attributes('fullName')} autoComplete="name" />{fieldError('fullName')}
        <label htmlFor="profile-phone">Số điện thoại</label><input {...attributes('phone')} type="tel" maxLength={32} autoComplete="tel" />{fieldError('phone')}
        <label htmlFor="profile-email">Email (tùy chọn)</label><input {...attributes('email')} type="email" autoComplete="email" />{fieldError('email')}
        <label htmlFor="profile-birthDate">Ngày sinh (tùy chọn)</label><input {...attributes('birthDate')} type="date" max={todayInVietnam()} autoComplete="bday" />{fieldError('birthDate')}
        <label htmlFor="profile-address">Địa chỉ (tùy chọn)</label><input {...attributes('address')} maxLength={255} autoComplete="street-address" />{fieldError('address')}
      </fieldset>
      {error && <div className="form-error" role="alert"><p>{error.message}</p>
        {error.requestId && <small>Mã tra cứu: {error.requestId}</small>}
        {error.status === undefined && <><p>Chưa xác nhận được kết quả lưu. Hãy tải lại để xem dữ liệu thực tế trước khi sửa tiếp.</p>
          <button type="button" onClick={() => void load()}>Tải lại</button></>}
        {error.code === 'VERSION_CONFLICT' && <>
          <p>Bản nháp đang được giữ lại. Tải bản mới sẽ thay toàn bộ dữ liệu chưa lưu.</p>
          {!confirmReload ? <button type="button" onClick={() => setConfirmReload(true)}>Tải bản mới</button> : <>
            <p>Xác nhận bỏ bản nháp để tải lại?</p><button type="button" onClick={() => void load()}>Xác nhận tải lại</button>
            <button type="button" className="secondary" onClick={() => setConfirmReload(false)}>Giữ bản nháp</button></>}
        </>}
      </div>}
      {confirming ? <div className="user-actions" role="group" aria-label="Xác nhận lưu">
        <p>Lưu các thay đổi này?</p>
        <button type="button" onClick={() => void save()} disabled={pending} autoFocus>{pending ? 'Đang lưu…' : 'Xác nhận lưu'}</button>
        <button type="button" className="secondary" onClick={() => setConfirming(false)} disabled={pending}>Hủy</button>
      </div> : <div className="user-actions">
        <button type="submit" disabled={pending || error?.code === 'VERSION_CONFLICT'}>Lưu thay đổi</button>
      </div>}
    </form>
  </section>;
}
