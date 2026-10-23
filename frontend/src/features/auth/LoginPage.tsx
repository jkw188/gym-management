import { useRef, useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { AuthChecking } from './AuthRoutes';
import { useAuth } from './AuthProvider';
import { resolveReturnTo } from './auth.routes';

export function LoginPage() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const [requestId, setRequestId] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  if (auth.status === 'checking') return <AuthChecking />;
  if (auth.user) return <Navigate to={resolveReturnTo(params.get('returnTo'), auth.user.roleCode)} replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const invalid: Record<string, string> = {};
    if (!phone.trim()) invalid.phone = 'Vui lòng nhập số điện thoại.';
    else if (phone.length > 64 || !/^[+\d\s.()\-]+$/.test(phone)) invalid.phone = 'Số điện thoại không hợp lệ.';
    if (!password) invalid.password = 'Vui lòng nhập mật khẩu.';
    setFields(invalid); setError(''); setRequestId(undefined);
    if (Object.keys(invalid).length) return;
    submitting.current = true; setPending(true);
    try { await auth.login(phone, password); setPassword(''); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Không thể đăng nhập. Vui lòng thử lại.');
      if (failure instanceof ApiError) {
        setRequestId(failure.requestId);
        setFields(Object.fromEntries((failure.details ?? []).filter(detail => ['phone', 'password'].includes(detail.field)).map(detail => [detail.field, detail.message])));
        if (failure.retryAfter) setError(`${failure.message} Thử lại sau ${failure.retryAfter} giây.`);
      }
    } finally { submitting.current = false; setPending(false); }
  }

  return <section className="auth-card" aria-labelledby="login-title">
    <h2 id="login-title">Đăng nhập</h2><p>Dùng số điện thoại và mật khẩu của tài khoản phòng Gym.</p>
    {params.get('reason') === 'identity-changed' && <p role="status">Đã lưu thông tin tài khoản. Vui lòng đăng nhập lại bằng thông tin mới.</p>}
    <form onSubmit={event => void submit(event)} noValidate aria-busy={pending}>
      <label htmlFor="phone">Số điện thoại</label>
      <input id="phone" name="phone" type="tel" autoComplete="username" inputMode="tel" value={phone} maxLength={64}
        onChange={event => setPhone(event.target.value)} disabled={pending} aria-invalid={!!fields.phone} aria-describedby={fields.phone ? 'phone-error' : undefined} required />
      {fields.phone && <p id="phone-error" className="field-error" role="alert">{fields.phone}</p>}
      <label htmlFor="password">Mật khẩu</label>
      <div className="password-field"><input id="password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password"
        value={password} onChange={event => setPassword(event.target.value)} disabled={pending} aria-invalid={!!fields.password}
        aria-describedby={fields.password ? 'password-error' : undefined} required />
        <button type="button" className="secondary" onClick={() => setVisible(value => !value)} aria-controls="password" aria-pressed={visible} disabled={pending}>{visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}</button></div>
      {fields.password && <p id="password-error" className="field-error" role="alert">{fields.password}</p>}
      {error && <div className="form-error" role="alert"><p>{error}</p>{requestId && <small>Mã tra cứu: {requestId}</small>}</div>}
      <button type="submit" disabled={pending}>{pending ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
    </form>
  </section>;
}
