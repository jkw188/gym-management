import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import type { RoleCode } from '../auth/auth.types';
import { usersApi, type AccessRole, type ChangeStatusResult, type UserAccount } from './users.api';
import { Icon } from '../../components/Icon';

interface Props {
  id: string; ownAccount: boolean; onClose: () => void;
  onSaved: (result: ChangeStatusResult) => void; onUnauthenticated: () => void;
}

export function AccountRoleDialog({ id, ownAccount, onClose, onSaved, onUnauthenticated }: Props) {
  const [account, setAccount] = useState<UserAccount>();
  const [roles, setRoles] = useState<AccessRole[]>([]);
  const [roleCode, setRoleCode] = useState<RoleCode | ''>('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [blocked, setBlocked] = useState(true);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const initialFocus = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    if (typeof dialog.current?.showModal === 'function') dialog.current.showModal();
    else dialog.current?.setAttribute('open', '');
    initialFocus.current?.focus();
    return () => { if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, []);

  function message(failure: unknown) {
    const text = failure instanceof Error ? failure.message : 'Không thể tải dữ liệu phân quyền.';
    return `${text}${failure instanceof ApiError && failure.requestId ? ` Mã tra cứu: ${failure.requestId}` : ''}`;
  }

  async function reload(signal?: AbortSignal) {
    if (busy.current) return;
    busy.current = true; setLoading(true); setBlocked(true); setConfirmed(false); setError('');
    try {
      // A possible self-demotion must never trigger automatic refresh or PATCH replay.
      const [current, catalog] = await Promise.all([usersApi.statusDetail(id, signal), usersApi.accessRoles(signal)]);
      if (signal?.aborted) return;
      if (catalog.items.length !== 4) throw new Error('Danh mục quyền chưa đủ bốn vai trò. Cần kiểm tra cấu hình trước khi phân quyền.');
      setAccount(current); setRoles(catalog.items); setRoleCode(previous => previous || current.roleCode); setBlocked(false);
    } catch (failure) {
      if (signal?.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) { onUnauthenticated(); return; }
      setError(message(failure));
    } finally { if (!signal?.aborted) { busy.current = false; setLoading(false); } }
  }

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => { controller.abort(); busy.current = false; };
  }, [id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !account || !roleCode || blocked || !confirmed) return;
    if (reason.trim().length < 10 || reason.trim().length > 500) { setError('Lý do phải có 10–500 ký tự sau khi bỏ khoảng trắng hai đầu.'); return; }
    busy.current = true; setPending(true); setError('');
    try {
      onSaved(await usersApi.changeRole(id, { roleCode, version: account.version, reason: reason.trim() }));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { onUnauthenticated(); return; }
      const uncertain = !(failure instanceof ApiError) || failure.status === undefined || failure.status >= 500;
      setBlocked(uncertain || failure instanceof ApiError && failure.status === 409);
      const explanations: Record<string, string> = {
        ROLE_IN_USE: 'Cần xử lý hồ sơ hội viên/PT liên kết qua module quản trị trước khi đổi vai trò.',
        LAST_ACTIVE_ADMIN: 'Cần giữ ít nhất một Admin đang hoạt động.',
        ROLE_NOT_CONFIGURED: 'Vai trò đích chưa được seed. Cần kiểm tra cấu hình.',
      };
      setError(`${uncertain ? 'Chưa xác định được kết quả thao tác. Hãy tải lại tài khoản hoặc đăng nhập lại trước khi quyết định gửi lại. ' : ''}${message(failure)} ${failure instanceof ApiError ? explanations[failure.code ?? ''] ?? '' : ''}${failure instanceof ApiError && failure.status === 409 ? ' Hãy tải lại để kiểm tra phiên bản và xác nhận lại.' : ''}`);
    } finally { busy.current = false; setPending(false); }
  }

  const permissions = [...new Map(roles.flatMap(role => role.permissions).map(permission => [permission.code, permission])).values()].sort((a, b) => a.code.localeCompare(b.code));
  return <dialog ref={dialog} aria-modal="true" aria-labelledby="account-role-title" className="status-card account-status-dialog"
    onCancel={event => { event.preventDefault(); if (!busy.current) onClose(); }}>
    <h3 id="account-role-title">Phân quyền tài khoản</h3>
    {loading && <p role="status">Đang tải tài khoản và danh mục quyền…</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {account && <>
      <p>{account.fullName} ({account.phone}) — {account.roleName} — {account.status === 'ACTIVE' ? 'Hoạt động' : 'Đã khóa'} — phiên bản {account.version}.</p>
      <p>Mỗi tài khoản có một vai trò. Đổi vai trò sẽ thu hồi mọi phiên cũ; tài khoản cần đăng nhập lại. Tài khoản đã khóa vẫn giữ khóa. Hồ sơ hội viên/PT và gói tập không tự được tạo.</p>
      {ownAccount && roleCode !== 'ADMIN' && <p role="alert">Bạn đang tự hạ quyền Admin. Sau khi lưu thành công, bạn sẽ về trang đăng nhập và phải đăng nhập lại bằng vai trò mới.</p>}
      <div className="users-table-wrap"><table className="users-table"><caption>Ma trận quyền cố định</caption>
        <thead><tr><th scope="col">Quyền</th>{roles.map(role => <th scope="col" key={role.code}>{role.name}</th>)}</tr></thead>
        <tbody>{permissions.map(permission => <tr key={permission.code}><th scope="row">{permission.name} ({permission.code})</th>
          {roles.map(role => <td key={role.code}>{role.permissions.some(item => item.code === permission.code) ? 'Có' : 'Không'}</td>)}</tr>)}</tbody>
      </table></div>
      <form onSubmit={submit}>
        <label htmlFor="account-role-code">Vai trò đích</label>
        <select id="account-role-code" value={roleCode} disabled={loading || pending} onChange={event => { setRoleCode(event.target.value as RoleCode); setConfirmed(false); }}>
          {roles.map(role => <option value={role.code} key={role.code}>{role.name}</option>)}
        </select>
        <label htmlFor="account-role-reason">Lý do đổi vai trò</label>
        <textarea id="account-role-reason" value={reason} maxLength={500} disabled={loading || pending} onChange={event => { setReason(event.target.value); setConfirmed(false); }} />
        <label className="account-status-confirm"><input type="checkbox" checked={confirmed} disabled={loading || pending || blocked} onChange={event => setConfirmed(event.target.checked)} />
          Tôi xác nhận vai trò đích và tác động thu hồi phiên đăng nhập.</label>
        <button type="submit" disabled={loading || pending || blocked || !confirmed}>{pending ? 'Đang xử lý…' : 'Xác nhận phân quyền'}</button>
      </form>
    </>}
    <div className="user-actions">
      <button ref={initialFocus} type="button" disabled={loading || pending} onClick={() => void reload()}><Icon name="retry" label="Tải lại tài khoản và quyền" showLabel /></button>
      <button type="button" className="secondary" disabled={pending} onClick={onClose}><Icon name="close" label="Đóng" /></button>
    </div>
  </dialog>;
}
