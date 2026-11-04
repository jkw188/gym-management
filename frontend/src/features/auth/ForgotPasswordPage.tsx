// Tầng giao diện – trang: bước 1 quên mật khẩu, nhập số điện thoại hoặc email để xin mã (US-05).
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { passwordResetApi } from './password-reset.api';
import { useResetFlow } from './PasswordResetFlow';

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const { setFlow } = useResetFlow();
  const [identifier, setIdentifier] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const submitting = useRef(false); // US-05-TC16: chặn bấm kép khi state pending chưa kịp cập nhật.

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    setError('');
    if (!identifier.trim()) {
      setError('Vui lòng nhập số điện thoại hoặc email.');
      return;
    }

    submitting.current = true;
    setPending(true);
    try {
      // Flow mới: không gửi challenge, server tạo challenge mới.
      const result = await passwordResetApi.requestCode({ identifier });
      setFlow({ identifier, challenge: result.challenge, message: result.message });
      navigate('/reset-password');
    } catch (failure) {
      // US-05-TC16: chỉ báo lỗi, không tự gửi lại.
      if (failure instanceof ApiError && failure.retryAfter) setError(`${failure.message} Thử lại sau ${failure.retryAfter} giây.`);
      else setError(failure instanceof Error ? failure.message : 'Không gửi được yêu cầu, hãy thử lại.');
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return <section className="auth-card" aria-labelledby="forgot-title">
    <h2 id="forgot-title">Quên mật khẩu</h2>
    <p>Nhập số điện thoại hoặc email của tài khoản. Mã xác thực sẽ được gửi đến email đã lưu.</p>
    <form onSubmit={event => void submit(event)} noValidate aria-busy={pending}>
      <label htmlFor="reset-identifier">Số điện thoại hoặc email</label>
      <input id="reset-identifier" autoComplete="username" value={identifier} maxLength={190}
        onChange={event => setIdentifier(event.target.value)} disabled={pending} required />
      {error && <div className="form-error" role="alert"><p>{error}</p></div>}
      <button type="submit" disabled={pending}>Gửi mã</button>
    </form>
    <p>Không còn dùng được email đã lưu? Vui lòng liên hệ quầy lễ tân.</p>
    <Link to="/login">Quay lại đăng nhập</Link>
  </section>;
}
