import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiClient } from '../../api/client';
import { usersApi, type ChangeStatusResult, type UserAccount } from './users.api';
import { Icon } from '../../components/Icon';

interface Props {
  id: string; ownAccount: boolean; onClose: () => void;
  onSaved: (result: ChangeStatusResult) => void; onUnauthenticated: () => void;
}

export function AccountStatusDialog({ id, ownAccount, onClose, onSaved, onUnauthenticated }: Props) {
  const [account, setAccount] = useState<UserAccount>();
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
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

  function failureMessage(failure: unknown) {
    return failure instanceof Error ? `${failure.message}${failure instanceof ApiError && failure.requestId ? ` Mã tra cứu: ${failure.requestId}` : ''}` : 'Không thể tải trạng thái.';
  }

  async function reload(signal?: AbortSignal) {
    if (busy.current) return;
    busy.current = true; setLoading(true); setError('');
    try {
      // Do not refresh/replay after a possible self-lock.
      const current = await usersApi.statusDetail(id, signal);
      if (signal?.aborted) return;
      setAccount(current); setBlocked(false); setConfirmed(false);
    } catch (failure) {
      if (signal?.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) { onUnauthenticated(); return; }
      setError(failureMessage(failure));
    } finally {
      if (!signal?.aborted) { busy.current = false; setLoading(false); }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => { controller.abort(); busy.current = false; };
  }, [id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !account || blocked || !confirmed) return;
    if (reason.trim().length < 10 || reason.trim().length > 500) { setError('Lý do phải có 10–500 ký tự sau khi bỏ khoảng trắng hai đầu.'); return; }
    busy.current = true; setPending(true); setError('');
    try {
      const result = await usersApi.changeStatus(id, { status: account.status === 'ACTIVE' ? 'LOCKED' : 'ACTIVE', version: account.version, reason: reason.trim() });
      onSaved(result);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { apiClient.requireLogin(); onUnauthenticated(); return; }
      const uncertain = !(failure instanceof ApiError) || failure.status === undefined || failure.status >= 500;
      setBlocked(uncertain || failure instanceof ApiError && failure.status === 409);
      setError(uncertain
        ? `Chưa xác định được kết quả thao tác. Hãy tải lại trạng thái trước khi quyết định gửi lại. ${failureMessage(failure)}`
        : `${failureMessage(failure)}${failure instanceof ApiError && failure.status === 409 ? ' Hãy tải lại trạng thái để kiểm tra.' : ''}`);
    } finally { busy.current = false; setPending(false); }
  }

  const locking = account?.status === 'ACTIVE';
  return <dialog ref={dialog} aria-modal="true" aria-labelledby="account-status-title" className="status-card account-status-dialog"
    onCancel={event => { event.preventDefault(); if (!busy.current) onClose(); }}>
    <h3 id="account-status-title">Khóa / Mở khóa tài khoản</h3>
    {loading && <p role="status">Đang tải trạng thái hiện tại…</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {account && <>
      <p>{account.fullName} ({account.phone}) — {account.status === 'ACTIVE' ? 'Hoạt động' : 'Đã khóa'} — phiên bản {account.version}.</p>
      <p>Thao tác chỉ thay đổi quyền truy cập. Hồ sơ PT, gói tập, lịch hẹn và đơn hàng được giữ nguyên; lịch tương lai cần xử lý tại module vận hành tương ứng.</p>
      {ownAccount && locking && <p role="alert">Bạn đang tự khóa tài khoản. Sau khi xác nhận thành công, bạn sẽ mất quyền truy cập và phải nhờ Admin khác mở khóa để đăng nhập lại.</p>}
      <form onSubmit={submit}>
        <label htmlFor="account-status-reason">Lý do khóa / mở khóa</label>
        <textarea id="account-status-reason" value={reason} maxLength={500} disabled={pending || loading} onChange={event => setReason(event.target.value)} />
        <label className="account-status-confirm"><input type="checkbox" checked={confirmed} disabled={pending || loading || blocked} onChange={event => setConfirmed(event.target.checked)} />
          Tôi xác nhận {locking ? 'khóa' : 'mở khóa'} tài khoản{ownAccount && locking ? ' của mình và mất quyền truy cập' : ''}.</label>
        <button type="submit" disabled={pending || loading || blocked || !confirmed}>{pending ? 'Đang xử lý…' : locking ? 'Xác nhận khóa' : 'Xác nhận mở khóa'}</button>
      </form>
    </>}
    <div className="user-actions">
      <button ref={initialFocus} type="button" disabled={pending || loading} onClick={() => void reload()}><Icon name="retry" label="Tải lại trạng thái" showLabel /></button>
      <button type="button" className="secondary" disabled={pending} onClick={onClose}><Icon name="close" label="Đóng" /></button>
    </div>
  </dialog>;
}
