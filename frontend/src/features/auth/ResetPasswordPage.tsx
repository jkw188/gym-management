// Tầng giao diện – trang: bước 2 quên mật khẩu, nhập mã OTP và mật khẩu mới, có nút gửi lại mã (US-05).
// Chỉ kiểm tra ô trống, OTP 6 chữ số và ô xác nhận; policy mật khẩu và mã đúng/sai do backend quyết định.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError, apiClient } from '../../api/client';
import { passwordResetApi } from './password-reset.api';
import { useResetFlow } from './PasswordResetFlow';

const RESEND_SECONDS = 60; // US-05-F02: gửi lại mã sau tối thiểu 60 giây.

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const { flow, setFlow } = useResetFlow();
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  // Đếm ngược theo mốc thời gian: resendAt = lúc được bấm "Gửi lại mã", now = giờ hiện tại (cập nhật mỗi giây).
  const [resendAt, setResendAt] = useState(() => Date.now() + RESEND_SECONDS * 1000);
  const [now, setNow] = useState(() => Date.now());
  const busy = useRef(false); // US-05-TC16: chặn bấm kép khi state pending chưa kịp cập nhật.

  // US-05-TC16: mỗi giây chỉ cập nhật giờ để vẽ lại số giây; không tự gửi request nào.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const secondsLeft = Math.max(0, Math.ceil((resendAt - now) / 1000));

  // Khóa nút "Gửi lại mã" thêm một số giây, tính từ bây giờ.
  function lockResend(seconds: number) {
    setNow(Date.now());
    setResendAt(Date.now() + seconds * 1000);
  }

  // US-05-TC16: chưa có challenge trong bộ nhớ (mở thẳng link, tải lại trang) thì về bước nhập định danh.
  if (!flow) return <Navigate to="/forgot-password" replace />;
  const currentFlow = flow;

  // Người dùng tự bấm "Bắt đầu lại" mới bỏ challenge cũ; trang không tự gửi request mới.
  function restart() {
    setFlow(null);
    navigate('/forgot-password', { replace: true });
  }

  async function resend() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      // US-05-F05: gửi lại kèm challenge đang giữ và không thay challenge.
      const result = await passwordResetApi.requestCode({ identifier: currentFlow.identifier, challenge: currentFlow.challenge });
      setFlow({ ...currentFlow, message: result.message });
      lockResend(RESEND_SECONDS);
    } catch (failure) {
      // US-05-TC16: bị giới hạn thì giữ mã đang nhập, chỉ báo lỗi, không tự gửi lại khi hết thời gian chờ.
      if (failure instanceof ApiError && failure.retryAfter) {
        setError(`${failure.message} Thử lại sau ${failure.retryAfter} giây.`);
        lockResend(failure.retryAfter);
      } else {
        setError(failure instanceof Error ? failure.message : 'Không gửi lại được mã, hãy thử lại.');
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    setError('');
    let invalid = '';
    if (!/^\d{6}$/.test(otp)) invalid = 'Mã xác thực gồm 6 chữ số.';
    else if (!newPassword) invalid = 'Vui lòng nhập mật khẩu mới.';
    else if (confirmPassword !== newPassword) invalid = 'Mật khẩu xác nhận không khớp.';
    if (invalid) {
      setError(invalid);
      return;
    }

    busy.current = true;
    setPending(true);
    try {
      // US-05-TC05: gửi otp dạng chuỗi nguyên văn; không gửi ô xác nhận.
      await passwordResetApi.confirm({ challenge: currentFlow.challenge, otp, newPassword });
      // US-05-TC16: thành công thì xóa phiên trong bộ nhớ và về trang đăng nhập (không tự đăng nhập).
      // Không cần setFlow(null): rời sang /login thì PasswordResetFlow bị gỡ nên challenge tự mất khỏi bộ nhớ.
      apiClient.requireLogin('password-reset');
      navigate('/login?reason=password-reset', { replace: true });
    } catch (failure) {
      showConfirmError(failure);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  function showConfirmError(failure: unknown) {
    // US-05-TC16: mất phản hồi hoặc máy chủ lỗi thì có thể mật khẩu ĐÃ đổi, nên hướng dẫn thử đăng nhập, không tự gửi lại.
    if (!(failure instanceof ApiError) || failure.status === undefined || failure.status >= 500) {
      setError('Không nhận được phản hồi từ máy chủ. Mật khẩu có thể đã được đặt lại, hãy thử đăng nhập bằng mật khẩu mới trước.');
      return;
    }
    if (failure.retryAfter) {
      setError(`${failure.message} Thử lại sau ${failure.retryAfter} giây.`);
      return;
    }
    // 400 RESET_INVALID / VALIDATION_ERROR: hiện thông báo của server và chi tiết từng ô nếu có.
    const details = (failure.details ?? []).map(detail => detail.message);
    setError([failure.message, ...details].join(' '));
  }

  return <section className="auth-card" aria-labelledby="reset-title">
    <h2 id="reset-title">Đặt lại mật khẩu</h2>
    <p role="status">{flow.message}</p>
    <form onSubmit={event => void submit(event)} noValidate aria-busy={pending}>
      {/* US-05-TC05: ô văn bản (không phải type="number") để giữ số 0 đầu. */}
      <label htmlFor="reset-otp">Mã xác thực</label>
      <input id="reset-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp}
        onChange={event => setOtp(event.target.value)} disabled={pending} required />
      <label htmlFor="reset-new-password">Mật khẩu mới</label>
      <input id="reset-new-password" type="password" autoComplete="new-password" value={newPassword}
        onChange={event => setNewPassword(event.target.value)} disabled={pending} required />
      <label htmlFor="reset-confirm-password">Xác nhận mật khẩu mới</label>
      <input id="reset-confirm-password" type="password" autoComplete="new-password" value={confirmPassword}
        onChange={event => setConfirmPassword(event.target.value)} disabled={pending} required />
      {error && <div className="form-error" role="alert"><p>{error}</p></div>}
      <button type="submit" disabled={pending}>Đặt lại mật khẩu</button>
    </form>
    <button type="button" className="secondary" onClick={() => void resend()} disabled={pending || secondsLeft > 0}>
      {secondsLeft > 0 ? `Gửi lại mã (${secondsLeft} giây)` : 'Gửi lại mã'}
    </button>
    {confirmRestart ? <div role="group" aria-label="Xác nhận bắt đầu lại">
      <p>Bỏ mã đang giữ để bắt đầu yêu cầu mới?</p>
      <button type="button" className="secondary" onClick={restart} disabled={pending}>Xác nhận bắt đầu lại</button>
      <button type="button" className="secondary" onClick={() => setConfirmRestart(false)} disabled={pending}>Giữ mã hiện tại</button>
    </div> : <button type="button" className="secondary" onClick={() => setConfirmRestart(true)} disabled={pending}>Bắt đầu lại</button>}
    <Link to="/login">Đến trang đăng nhập</Link>
  </section>;
}
