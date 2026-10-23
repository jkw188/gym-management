import { useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { usersApi, type UserAccount, type UserRole, type UpdateUserInput } from './users.api';
import type { RoleCode } from '../auth/auth.types';

interface Props {
  account?: UserAccount; roles: UserRole[]; onClose: () => void;
  onSaved: (account: UserAccount, created: boolean, identityChanged: boolean) => void;
  onReload: () => void;
}

export function UserForm({ account, roles, onClose, onSaved, onReload }: Props) {
  const [fullName, setFullName] = useState(account?.fullName ?? '');
  const [phone, setPhone] = useState(account?.phone ?? '');
  const [email, setEmail] = useState(account?.email ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [roleCode, setRoleCode] = useState<RoleCode | ''>('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const sending = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || error?.code === 'VERSION_CONFLICT') return;
    const errors: Record<string, string> = {};
    const normalizedName = fullName.trim().replace(/\s+/g, ' ');
    if (Array.from(normalizedName).length < 2 || Array.from(normalizedName).length > 120) errors.fullName = 'Họ tên phải từ 2 đến 120 ký tự.';
    if (!phone.trim() || phone.length > 32) errors.phone = 'Nhập số điện thoại hợp lệ, tối đa 32 ký tự.';
    if (email.trim() && (email.trim().length > 190 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))) errors.email = 'Email không hợp lệ.';
    if (!account) {
      if (Array.from(password).length < 12 || Array.from(password).length > 128) errors.password = 'Mật khẩu phải từ 12 đến 128 ký tự.';
      if (confirmPassword !== password) errors.confirmPassword = 'Xác nhận mật khẩu không khớp.';
      if (!roles.some(role => role.code === roleCode)) errors.roleCode = 'Chọn vai trò đã được cấu hình.';
    }
    setFields(errors);
    if (Object.keys(errors).length) return;
    setError(null); sending.current = true; setPending(true);
    try {
      let saved: UserAccount;
      if (account) {
        const input: UpdateUserInput = { version: account.version };
        if (fullName !== account.fullName) input.fullName = fullName;
        if (phone !== account.phone) input.phone = phone;
        if (email !== (account.email ?? '')) input.email = email.trim() ? email : null;
        // A form with no edits still uses the API's version-checked no-op contract.
        if (Object.keys(input).length === 1) input.fullName = fullName;
        saved = await usersApi.update(account.id, input);
      } else {
        saved = await usersApi.create({ fullName, phone, ...(email.trim() ? { email } : {}), password, roleCode: roleCode as RoleCode });
      }
      setPassword(''); setConfirmPassword('');
      onSaved(saved, !account, !!account && (saved.phone !== account.phone || saved.email !== account.email));
    } catch (failure) {
      const problem = failure instanceof ApiError ? failure : new ApiError('Không thể lưu tài khoản.');
      setError(problem);
      setFields(Object.fromEntries((problem.details ?? []).map(detail => [detail.field, detail.message])));
    } finally { sending.current = false; setPending(false); }
  }

  const fieldError = (name: string) => fields[name] && <p id={`user-${name}-error`} className="field-error" role="alert">{fields[name]}</p>;
  const attributes = (name: string) => ({ 'aria-invalid': !!fields[name], 'aria-describedby': fields[name] ? `user-${name}-error` : undefined });

  return <section className="status-card" aria-labelledby="user-form-title">
    <h3 id="user-form-title">{account ? 'Thông tin tài khoản' : 'Tạo tài khoản'}</h3>
    <p>Thông tin đăng nhập và hiển thị của tài khoản được quản lý riêng với hồ sơ hội viên/PT.</p>
    {account && <dl className="user-details"><dt>ID</dt><dd>{account.id}</dd><dt>Vai trò</dt><dd>{account.roleName}</dd>
      <dt>Trạng thái</dt><dd>{account.status}</dd><dt>Phiên bản</dt><dd>{account.version}</dd>
      <dt>Ngày tạo</dt><dd>{new Date(account.createdAt).toLocaleString('vi-VN')}</dd>
      <dt>Cập nhật</dt><dd>{new Date(account.updatedAt).toLocaleString('vi-VN')}</dd></dl>}
    <form onSubmit={event => void submit(event)} noValidate aria-busy={pending}>
      <fieldset disabled={pending}>
        <label htmlFor="user-fullName">Họ tên</label><input id="user-fullName" value={fullName} onChange={event => setFullName(event.target.value)} autoComplete="name" {...attributes('fullName')} />{fieldError('fullName')}
        <label htmlFor="user-phone">Số điện thoại</label><input id="user-phone" type="tel" value={phone} onChange={event => setPhone(event.target.value)} maxLength={32} autoComplete="tel" {...attributes('phone')} />{fieldError('phone')}
        <label htmlFor="user-email">Email (tùy chọn)</label><input id="user-email" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" {...attributes('email')} />{fieldError('email')}
        {!account && <>
          <label htmlFor="user-roleCode">Vai trò</label><select id="user-roleCode" value={roleCode} onChange={event => setRoleCode(event.target.value as RoleCode | '')} {...attributes('roleCode')}>
            <option value="">Chọn vai trò</option>{roles.map(role => <option key={role.code} value={role.code}>{role.name}</option>)}
          </select>{fieldError('roleCode')}
          <label htmlFor="user-password">Mật khẩu ban đầu</label><input id="user-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" {...attributes('password')} />{fieldError('password')}
          <label htmlFor="user-confirmPassword">Xác nhận mật khẩu</label><input id="user-confirmPassword" type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" {...attributes('confirmPassword')} />{fieldError('confirmPassword')}
        </>}
      </fieldset>
      {error && <div className="form-error" role="alert"><p>{error.message}</p>
        {error.requestId && <small>Mã tra cứu: {error.requestId}</small>}
        {!account && error.status === undefined && <p>Yêu cầu có thể đã được xử lý. Hãy đóng form và tìm theo số điện thoại trước khi thử tạo lại.</p>}
        {error.code === 'VERSION_CONFLICT' && <>
          <p>Bản nháp đang được giữ lại. Tải bản mới sẽ thay toàn bộ dữ liệu chưa lưu.</p>
          {!confirmReload ? <button type="button" onClick={() => setConfirmReload(true)}>Tải bản mới</button> : <>
            <p>Xác nhận bỏ bản nháp để tải lại?</p><button type="button" onClick={onReload}>Xác nhận tải lại</button>
            <button type="button" className="secondary" onClick={() => setConfirmReload(false)}>Giữ bản nháp</button></>}
        </>}
      </div>}
      <div className="user-actions"><button type="submit" disabled={pending || error?.code === 'VERSION_CONFLICT' || (!account && !roles.length)}>{pending ? 'Đang lưu…' : account ? 'Lưu thay đổi' : 'Tạo tài khoản'}</button>
        <button type="button" className="secondary" disabled={pending} onClick={onClose}>Đóng</button></div>
    </form>
  </section>;
}
