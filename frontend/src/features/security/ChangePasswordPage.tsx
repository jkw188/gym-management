// Tầng giao diện – trang: form đổi mật khẩu cho Member và PT (US-67).
// Chỉ kiểm tra ô trống và ô xác nhận; policy mật khẩu do backend quyết định.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, apiClient } from '../../api/client';
import { securityApi } from './security.api';

type FieldName = 'currentPassword' | 'newPassword' | 'confirmPassword';

const FIELDS: { name: FieldName; label: string; autoComplete: string }[] = [
  { name: 'currentPassword', label: 'Mật khẩu hiện tại', autoComplete: 'current-password' },
  { name: 'newPassword', label: 'Mật khẩu mới', autoComplete: 'new-password' },
  { name: 'confirmPassword', label: 'Xác nhận mật khẩu mới', autoComplete: 'new-password' },
];

export function ChangePasswordPage() {
  const navigate = useNavigate();
  const [values, setValues] = useState<Record<FieldName, string>>({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [visible, setVisible] = useState<Partial<Record<FieldName, boolean>>>({});
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState(false);
  const submitting = useRef(false); // Chặn gửi kép ngay cả khi state pending chưa kịp cập nhật (US-67-TC13).

  // US-67-TC13: có lỗi thì focus vào ô lỗi đầu tiên.
  useEffect(() => {
    const first = FIELDS.find(field => fieldErrors[field.name]);
    if (first) document.getElementById(`security-${first.name}`)?.focus();
  }, [fieldErrors]);

  function validate() {
    const errors: Partial<Record<FieldName, string>> = {};
    if (!values.currentPassword) errors.currentPassword = 'Vui lòng nhập mật khẩu hiện tại.';
    if (!values.newPassword) errors.newPassword = 'Vui lòng nhập mật khẩu mới.';
    if (values.confirmPassword !== values.newPassword) errors.confirmPassword = 'Mật khẩu xác nhận không khớp.';
    return errors;
  }

  // Xóa thông tin đăng nhập trong bộ nhớ rồi về trang đăng nhập.
  function leaveToLogin(reason: string) {
    apiClient.requireLogin(reason);
    navigate(`/login?reason=${reason}`, { replace: true });
  }

  function showError(failure: unknown) {
    // US-67-TC11: mất response hoặc máy chủ lỗi thì không biết mật khẩu đã đổi chưa, nên về đăng nhập và không gửi lại.
    if (!(failure instanceof ApiError) || failure.status === undefined || failure.status >= 500) {
      leaveToLogin('password-unconfirmed');
      return;
    }
    if (failure.status === 401) {
      leaveToLogin('credentials-changed');
      return;
    }
    // US-67-TC10: 429 giữ nguyên phiên, chỉ báo thời gian chờ.
    if (failure.status === 429) {
      setFormError(failure.retryAfter ? `${failure.message} Thử lại sau ${failure.retryAfter} giây.` : failure.message);
      return;
    }
    // US-67-TC13: lỗi nghiệp vụ hiện đúng ô, giữ phiên để người dùng thử lại.
    if (failure.code === 'CURRENT_PASSWORD_INVALID') {
      setFieldErrors({ currentPassword: failure.message });
      return;
    }
    if (failure.code === 'PASSWORD_UNCHANGED') {
      setFieldErrors({ newPassword: failure.message });
      return;
    }
    const errors: Partial<Record<FieldName, string>> = {};
    for (const detail of failure.details ?? []) {
      if (detail.field === 'currentPassword' || detail.field === 'newPassword') errors[detail.field] = detail.message;
    }
    if (Object.keys(errors).length > 0) setFieldErrors(errors);
    else setFormError(failure.message);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    const errors = validate();
    setFieldErrors(errors);
    setFormError('');
    if (Object.keys(errors).length > 0) return;

    submitting.current = true;
    setPending(true);
    try {
      // US-67-F02: chỉ gửi 2 field nguyên văn, không gửi ô xác nhận.
      await securityApi.changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword });
      leaveToLogin('password-changed');
    } catch (failure) {
      showError(failure);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return <section className="auth-card" aria-labelledby="security-title">
    <h2 id="security-title">Đổi mật khẩu</h2>
    <p>Sau khi đổi thành công, mọi phiên đăng nhập cũ sẽ hết hiệu lực và bạn cần đăng nhập lại.</p>
    <form onSubmit={event => void submit(event)} noValidate aria-busy={pending}>
      {FIELDS.map(field => {
        const id = `security-${field.name}`;
        const error = fieldErrors[field.name];
        const shown = visible[field.name] === true;
        return <div key={field.name}>
          <label htmlFor={id}>{field.label}</label>
          <div className="password-field">
            <input id={id} type={shown ? 'text' : 'password'} autoComplete={field.autoComplete} value={values[field.name]}
              onChange={event => setValues(current => ({ ...current, [field.name]: event.target.value }))}
              disabled={pending} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} required />
            <button type="button" className="secondary" aria-controls={id} aria-pressed={shown} disabled={pending}
              onClick={() => setVisible(current => ({ ...current, [field.name]: !shown }))}>
              {`${shown ? 'Ẩn' : 'Hiện'} ${field.label.toLowerCase()}`}
            </button>
          </div>
          {error && <p id={`${id}-error`} className="field-error" role="alert">{error}</p>}
        </div>;
      })}
      {formError && <div className="form-error" role="alert"><p>{formError}</p></div>}
      <button type="submit" disabled={pending}>Đổi mật khẩu</button>
    </form>
    <Link to="..">Quay lại</Link>
  </section>;
}
