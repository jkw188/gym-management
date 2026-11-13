import { useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useAuth } from './AuthProvider';
import { AuthChecking, LogoutPending } from './AuthRoutes';
import { rolePaths } from './auth.routes';
import { registrationApi } from './registration.api';
import { Icon } from '../../components/Icon';

const fieldOrder = ['fullName', 'phone', 'email', 'password', 'confirmPassword'];

export function RegisterPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const form = useRef<HTMLFormElement>(null);
  const sending = useRef(false);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const errorBox = useRef<HTMLDivElement>(null);

  if (auth.status === 'checking') return <AuthChecking />;
  if (auth.status === 'loggingOut') return <LogoutPending />;
  if (auth.user) return <Navigate to={rolePaths[auth.user.roleCode]} replace />;

  function focusError(errors: Record<string, string>) {
    const field = fieldOrder.find(name => errors[name]);
    // Chờ React hiển thị lỗi và bỏ disabled trước khi chuyển focus.
    requestAnimationFrame(() => {
      if (field) (form.current?.elements.namedItem(field) as HTMLInputElement | null)?.focus();
      else errorBox.current?.focus();
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    const invalid: Record<string, string> = {};
    const nameLength = Array.from(fullName.trim().replace(/\s+/g, ' ')).length;
    if (nameLength < 2 || nameLength > 120) invalid.fullName = 'Họ tên phải từ 2 đến 120 ký tự.';
    const digits = phone.replace(/[\s.()\-]/g, '').replace(/^0/, '+84').replace(/^84/, '+84');
    if (phone.length > 32 || !/^[+\d\s.()\-]+$/.test(phone) || !/^\+[1-9]\d{7,14}$/.test(digits)) invalid.phone = 'Số điện thoại không hợp lệ.';
    if (email.trim() && (email.trim().length > 190 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))) invalid.email = 'Email không hợp lệ.';
    if (Array.from(password).length < 12 || Array.from(password).length > 128) invalid.password = 'Mật khẩu phải từ 12 đến 128 ký tự.';
    if (password !== confirmPassword) invalid.confirmPassword = 'Xác nhận mật khẩu không khớp.';
    setFields(invalid); setError(null);
    if (Object.keys(invalid).length) { focusError(invalid); return; }
    sending.current = true; setPending(true);
    try {
      await registrationApi.register({ fullName, phone, ...(email.trim() ? { email } : {}), password });
      setPassword(''); setConfirmPassword('');
      navigate('/login?reason=registered', { replace: true });
    } catch (failure) {
      const problem = failure instanceof ApiError ? failure : new ApiError('Chưa xác định được kết quả đăng ký.');
      const errors = Object.fromEntries((problem.details ?? []).filter(detail => fieldOrder.includes(detail.field)).map(detail => [detail.field, detail.message]));
      setError(problem); setFields(errors); focusError(errors);
    } finally { sending.current = false; setPending(false); }
  }

  const attributes = (name: string) => ({ id: `register-${name}`, name, required: name !== 'email',
    'aria-invalid': !!fields[name], 'aria-describedby': fields[name] ? `register-${name}-error` : undefined });
  const fieldError = (name: string) => fields[name] && <p id={`register-${name}-error`} className="field-error" role="alert">{fields[name]}</p>;

  return <section className="auth-card" aria-labelledby="register-title">
    <h2 id="register-title">Đăng ký tài khoản</h2>
    <p>Tạo tài khoản để đăng nhập. Vui lòng liên hệ quầy để được hỗ trợ hồ sơ hội viên và gói tập.</p>
    <form ref={form} onSubmit={event => void submit(event)} noValidate aria-busy={pending}>
      <fieldset disabled={pending}>
        <label htmlFor="register-fullName">Họ tên</label>
        <input {...attributes('fullName')} autoComplete="name" value={fullName} onChange={event => setFullName(event.target.value)} />{fieldError('fullName')}
        <label htmlFor="register-phone">Số điện thoại</label>
        <input {...attributes('phone')} type="tel" inputMode="tel" autoComplete="username" maxLength={32} value={phone} onChange={event => setPhone(event.target.value)} />{fieldError('phone')}
        <label htmlFor="register-email">Email (tùy chọn)</label>
        <input {...attributes('email')} type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} />{fieldError('email')}
        <label htmlFor="register-password">Mật khẩu</label>
        <div className="password-field"><input {...attributes('password')} type={visible ? 'text' : 'password'} autoComplete="new-password"
          value={password} onChange={event => setPassword(event.target.value)} />
          <button type="button" className="secondary" aria-controls="register-password register-confirmPassword" aria-pressed={visible}
            onClick={() => setVisible(value => !value)}><Icon name={visible ? 'eyeOff' : 'eye'} label={visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} /></button></div>{fieldError('password')}
        <label htmlFor="register-confirmPassword">Xác nhận mật khẩu</label>
        <input {...attributes('confirmPassword')} type={visible ? 'text' : 'password'} autoComplete="new-password" value={confirmPassword}
          onChange={event => setConfirmPassword(event.target.value)} />{fieldError('confirmPassword')}
      </fieldset>
      {error && <div ref={errorBox} tabIndex={-1} className="form-error" role="alert">
        <p>{error.status === undefined || (error.status >= 500 && error.code !== 'SERVICE_UNAVAILABLE')
          ? 'Chưa xác định được kết quả đăng ký. Bạn có thể chuyển sang đăng nhập hoặc liên hệ quầy để kiểm tra trước khi chủ động gửi lại.' : error.message}</p>
        {error.retryAfter && <p>Vui lòng thử lại sau {error.retryAfter} giây.</p>}
        {error.requestId && <small>Mã tra cứu: {error.requestId}</small>}
        <Link to="/login">Chuyển sang đăng nhập</Link>
      </div>}
      <button type="submit" disabled={pending}>{pending ? 'Đang đăng ký…' : 'Đăng ký'}</button>
    </form>
    <p>Đã có tài khoản? <Link to="/login">Đăng nhập</Link></p>
  </section>;
}
