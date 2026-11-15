import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { usersApi, type UsersPage } from '../users/users.api';
import { blockerNames, TrainerBlockers } from './TrainerBlockers';
import { trainersApi, type CreateTrainerInput, type Trainer, type TrainerStatus, type UpdateTrainerInput } from './trainers.api';

interface Props { initial?: Trainer; onClose: () => void; onSaved: () => void }
interface PendingCommand { key: string; input: CreateTrainerInput | UpdateTrainerInput }
const failureError = (failure: unknown) => failure instanceof ApiError ? failure : new ApiError(failure instanceof Error ? failure.message : 'Không thể lưu hồ sơ PT.');
export function TrainerForm({ initial, onClose, onSaved }: Props) {
  const [trainer, setTrainer] = useState(initial);
  const [accountId, setAccountId] = useState('');
  const [specialty, setSpecialty] = useState(initial?.specialty ?? '');
  const [status, setStatus] = useState<TrainerStatus>(initial?.status ?? 'ACTIVE');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [accountPage, setAccountPage] = useState(1);
  const [accounts, setAccounts] = useState<UsersPage>();
  const [accountLoading, setAccountLoading] = useState(!initial);
  const [accountError, setAccountError] = useState('');
  const [accountRevision, setAccountRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [showBlockers, setShowBlockers] = useState(false);
  const command = useRef<PendingCommand | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    if (trainer) return;
    const controller = new AbortController(); setAccountLoading(true); setAccountError('');
    usersApi.list({ page: accountPage, limit: 20, roleCode: 'TRAINER', status: 'ACTIVE', q: search }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setAccounts(result); })
      .catch(failure => { if (!controller.signal.aborted) setAccountError(failureError(failure).message); })
      .finally(() => { if (!controller.signal.aborted) setAccountLoading(false); });
    return () => controller.abort();
  }, [trainer, search, accountPage, accountRevision]);

  async function send(savedCommand: PendingCommand) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try {
      if (trainer) await trainersApi.update(trainer.id, savedCommand.input as UpdateTrainerInput, savedCommand.key);
      else await trainersApi.create(savedCommand.input as CreateTrainerInput, savedCommand.key);
      command.current = null; setUnknown(false); onSaved();
    } catch (failure) {
      const issue = failureError(failure); setError(issue);
      const uncertain = issue.status === undefined || issue.status >= 500;
      setUnknown(uncertain);
      if (!uncertain) command.current = null;
      if (issue.code === 'TRAINER_HAS_ACTIVE_SCHEDULE') setShowBlockers(true);
    } finally { busy.current = false; setPending(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || unknown || error?.code === 'VERSION_CONFLICT') return;
    if (!specialty.trim() || specialty.trim().length > 255) { setError(new ApiError('Chuyên môn phải có 1–255 ký tự.')); return; }
    let input: CreateTrainerInput | UpdateTrainerInput;
    if (trainer) {
      input = { version: trainer.version, ...(specialty.trim() !== trainer.specialty ? { specialty: specialty.trim() } : {}),
        ...(status !== trainer.status ? { status } : {}) };
      if (Object.keys(input).length === 1) { setError(new ApiError('Cần ít nhất một thay đổi.')); return; }
    } else {
      if (!accountId) { setError(new ApiError('Chọn tài khoản PT.')); return; }
      input = { accountId, specialty: specialty.trim(), status };
    }
    const next = { key: crypto.randomUUID(), input }; command.current = next; void send(next);
  }
  async function reload() {
    if (!trainer || busy.current) return;
    busy.current = true; setPending(true);
    try { const fresh = await trainersApi.detail(trainer.id); setTrainer(fresh); setSpecialty(fresh.specialty); setStatus(fresh.status); setError(null); command.current = null; }
    catch (failure) { setError(failureError(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  async function lookup() {
    if (busy.current || !command.current) return;
    busy.current = true; setPending(true);
    try { await trainersApi.lookup(trainer ? 'TRAINER_UPDATE' : 'TRAINER_CREATE', command.current.key); command.current = null; onSaved(); }
    catch (failure) { setError(failureError(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  return <section aria-label={trainer ? 'Sửa hồ sơ PT' : 'Tạo hồ sơ PT'}><h3>{trainer ? `Hồ sơ ${trainer.fullName}` : 'Tạo hồ sơ PT'}</h3>
    {trainer && <p>{trainer.phone} {trainer.email} · Tài khoản: {trainer.accountStatus} / {trainer.roleCode} · Phiên bản {trainer.version}</p>}
    <p>Tên và liên hệ lấy từ tài khoản. Hồ sơ chuyên môn không thay đổi các thông tin này.</p>
    <form onSubmit={submit}><fieldset disabled={pending || unknown}>
      {!trainer && <>
        <label htmlFor="trainer-account-search">Tìm tài khoản PT</label><input id="trainer-account-search" maxLength={120} value={q} onChange={e => setQ(e.target.value)} />
        <button type="button" onClick={() => { setSearch(q); setAccountId(''); setAccountPage(1); setAccountRevision(value => value + 1); }}>Tìm tài khoản</button>
        {accountLoading && <p role="status">Đang tải tài khoản…</p>}{accountError && <p role="alert">{accountError}</p>}
        {accountError && <button type="button" onClick={() => setAccountRevision(value => value + 1)}>Tải lại tài khoản</button>}
        {!accountLoading && !accountError && <>
          {accounts?.items.length === 0 && <p>Không có tài khoản PT đang hoạt động phù hợp.</p>}
          <label htmlFor="trainer-account">Tài khoản PT</label><select id="trainer-account" value={accountId} required onChange={e => setAccountId(e.target.value)}>
            <option value="">Chọn tài khoản</option>{accounts?.items.map(account => <option key={account.id} value={account.id}>{account.fullName} — {account.phone}</option>)}</select>
          <p>Tài khoản phải chưa liên kết hồ sơ PT; máy chủ kiểm tra khi tạo.</p>
          <div className="user-actions"><button type="button" disabled={accountPage <= 1} onClick={() => { setAccountId(''); setAccountPage(value => value - 1); }}>Tài khoản trước</button>
            <span>Trang {accountPage} / {accounts?.totalPages ?? 0}</span><button type="button" disabled={!accounts || accountPage >= accounts.totalPages} onClick={() => { setAccountId(''); setAccountPage(value => value + 1); }}>Tài khoản sau</button></div>
        </>}
      </>}
      <label htmlFor="trainer-specialty">Chuyên môn</label><textarea id="trainer-specialty" required maxLength={255} value={specialty} onChange={e => setSpecialty(e.target.value)} />
      <label htmlFor="trainer-status">Trạng thái PT</label><select id="trainer-status" value={status} onChange={e => setStatus(e.target.value as TrainerStatus)}><option value="ACTIVE">Hoạt động</option><option value="INACTIVE">Ngừng hoạt động</option></select>
      {status === 'INACTIVE' && <p>PT ngừng hoạt động sẽ không nhận lịch mới. Lịch sử được giữ nguyên; chỉ lưu khi không còn lịch đang chặn.</p>}
    </fieldset>
      {error && <div role="alert"><p>{error.message}</p>{error.requestId && <small>Mã tra cứu: {error.requestId}</small>}
        {error.details?.filter(detail => !['blockersUrl', 'managementUrl'].includes(detail.field)).map(detail => <p key={detail.field}>
          {detail.field === 'counts.BOOKING' ? `${blockerNames.BOOKING}: ` : detail.field === 'counts.SHIFT' ? `${blockerNames.SHIFT}: ` : detail.field === 'counts.PUBLIC_SESSION' ? `${blockerNames.PUBLIC_SESSION}: ` : ''}{detail.message}
        </p>)}</div>}
      {error?.code === 'VERSION_CONFLICT' && <p>Bản nhập được giữ lại. Tải lại hồ sơ sẽ thay bản nhập bằng dữ liệu mới; hãy đối chiếu trước khi lưu tiếp.</p>}
      {unknown && <p>Chưa xác định kết quả. Giữ nguyên yêu cầu để tra cứu hoặc gửi lại cùng khóa.</p>}
      <div className="user-actions">
        <button disabled={pending || unknown || error?.code === 'VERSION_CONFLICT' || (!trainer && accountLoading)} type="submit">{pending ? 'Đang xử lý…' : 'Lưu hồ sơ PT'}</button>
        {unknown && <><button type="button" disabled={pending} onClick={() => command.current && void send(command.current)}>Gửi lại cùng yêu cầu</button><button type="button" disabled={pending} onClick={() => void lookup()}>Tra cứu kết quả</button></>}
        {trainer && !unknown && <button type="button" disabled={pending} onClick={() => void reload()}>Tải lại hồ sơ</button>}
        {trainer && <button type="button" onClick={() => setShowBlockers(value => !value)}>{showBlockers ? 'Ẩn trở ngại' : 'Xem trở ngại'}</button>}
        <button type="button" disabled={pending || unknown} onClick={onClose}>Đóng form</button>
      </div>
    </form>
    {trainer && showBlockers && <TrainerBlockers trainerId={trainer.id} />}
  </section>;
}
