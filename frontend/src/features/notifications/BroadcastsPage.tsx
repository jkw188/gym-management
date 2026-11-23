import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useAuth } from '../auth/AuthProvider';
import { roleNames } from '../auth/auth.routes';
import type { RoleCode } from '../auth/auth.types';
import { broadcastsApi as api, pendingBroadcast, type BroadcastDetail, type BroadcastPage, type BroadcastPreview, type BroadcastSent } from './broadcasts.api';

const date = (value: string) => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const issue = (failure: unknown) => failure instanceof Error ? failure.message : 'Chưa thể thực hiện thao tác';
export function BroadcastsPage() {
  const { user } = useAuth();
  const { id } = useParams();
  const location = useLocation();
  // Đổi account/route thì bỏ dữ liệu và kết quả về muộn của màn hình cũ.
  return <BroadcastScreen key={`${user?.id}:${location.pathname}`} actorId={user?.id ?? ''} id={id} create={location.pathname.endsWith('/new')} />;
}
function BroadcastScreen({ actorId, id, create }: { actorId: string; id?: string; create: boolean }) {
  const navigate = useNavigate();
  const [restored] = useState(() => create ? pendingBroadcast.read(actorId) : null);
  const [title, setTitle] = useState(''), [body, setBody] = useState('');
  const [audience, setAudience] = useState<'ALL_ACTIVE' | 'ROLES'>('ALL_ACTIVE'), [roles, setRoles] = useState<RoleCode[]>([]);
  const [preview, setPreview] = useState<BroadcastPreview>(), [now, setNow] = useState(Date.now());
  const [pending, setPending] = useState(false), [unknown, setUnknown] = useState(Boolean(restored)), [error, setError] = useState('');
  const [detail, setDetail] = useState<BroadcastDetail>(), [data, setData] = useState<BroadcastPage>();
  const [query, setQuery] = useState({ status: '', fromDate: '', toDate: '', page: 1, limit: 20 });
  const [revision, setRevision] = useState(0);
  const busy = useRef(false), alive = useRef(true);
  const command = useRef(restored);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!preview) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [preview]);
  useEffect(() => {
    if (create) return;
    const controller = new AbortController(); setPending(true); setError('');
    (id ? api.detail(id, controller.signal).then(result => { if (!controller.signal.aborted) setDetail(result); }) :
      api.list(query, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); }))
      .catch(failure => { if (!controller.signal.aborted) setError(issue(failure)); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [create, id, query, revision]);
  function edit() { if (unknown) return; setPreview(undefined); command.current = null; setError(''); }
  async function showPreview(event: FormEvent) {
    event.preventDefault(); if (busy.current || unknown) return;
    busy.current = true; setPending(true); setError(''); setPreview(undefined);
    try {
      const result = await api.preview({ audience, ...(audience === 'ROLES' ? { roles } : {}), title, body });
      if (alive.current) { setPreview(result); setNow(Date.now()); }
    } catch (failure) { if (alive.current) setError(issue(failure)); }
    finally { busy.current = false; if (alive.current) setPending(false); }
  }
  function finish(result: BroadcastSent) {
    if (!alive.current) return;
    command.current = null; pendingBroadcast.clear(); setUnknown(false);
    navigate(`/admin/notifications/${result.broadcastId}`, { replace: true });
  }
  async function send(resolve = false) {
    if (busy.current || (!preview && !command.current)) return;
    if (!command.current) {
      if (!preview || Date.parse(preview.expiresAt) <= Date.now() || preview.recipientCount === 0) return;
      command.current = { id: preview.previewId, version: preview.version, key: crypto.randomUUID() };
      pendingBroadcast.save(actorId, command.current);
    }
    const current = command.current;
    busy.current = true; setPending(true); setError('');
    try { finish(resolve ? (await api.lookup(current.key)).responseBody : await api.send(current.id, current.version, current.key)); }
    catch (failure) {
      if (!alive.current) return;
      setError(issue(failure));
      if (resolve) return; // 404 lookup chưa chứng minh request gốc thất bại.
      const uncertain = !(failure instanceof ApiError) || failure.status === undefined || failure.status >= 500;
      setUnknown(uncertain);
      if (!uncertain) { command.current = null; pendingBroadcast.clear(); setPreview(undefined); }
    } finally { busy.current = false; if (alive.current) setPending(false); }
  }
  const expired = preview ? Date.parse(preview.expiresAt) <= now : false;
  return <section className="auth-card"><h2>{create ? 'Gửi thông báo nhóm' : id ? 'Chi tiết thông báo nhóm' : 'Lịch sử thông báo nhóm'}</h2>
    <p><Link to="/admin/notifications">Lịch sử</Link> · <Link to="/admin/notifications/new">Soạn thông báo</Link></p>
    {error && <p role="alert">{error}</p>}
    {pending && <p role="status">Đang xử lý…</p>}
    {create && <><form onSubmit={event => void showPreview(event)}>
      <fieldset disabled={pending || unknown}><legend>Nội dung và nhóm nhận</legend>
        <label>Nhóm nhận<select value={audience} onChange={event => { setAudience(event.target.value as typeof audience); edit(); }}>
          <option value="ALL_ACTIVE">Tất cả tài khoản ACTIVE</option><option value="ROLES">Theo vai trò</option>
        </select></label>
        {audience === 'ROLES' && <div>{(['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as RoleCode[]).map(role =>
          <label key={role}><input type="checkbox" checked={roles.includes(role)} onChange={event => {
            setRoles(event.target.checked ? [...roles, role] : roles.filter(value => value !== role)); edit();
          }} />{roleNames[role]}</label>)}</div>}
        <label>Tiêu đề<input required maxLength={190} value={title} onChange={event => { setTitle(event.target.value); edit(); }} /></label>
        <label>Nội dung<textarea required maxLength={2000} value={body} onChange={event => { setBody(event.target.value); edit(); }} /></label>
        <button disabled={audience === 'ROLES' && roles.length === 0}>Xem trước</button>
      </fieldset></form>
      {preview && <div><h3>Xem trước</h3><p>{preview.audienceSummary} — {preview.recipientCount} tài khoản ACTIVE</p>
        <p>Ảnh chụp: {date(preview.snapshotAt)}. Hết hạn: {date(preview.expiresAt)}</p>
        <h4>{preview.title}</h4><p style={{ whiteSpace: 'pre-wrap' }}>{preview.body}</p>
        {expired && <p role="alert">Bản xem trước đã hết hạn. Hãy xem trước lại.</p>}
        {preview.recipientCount === 0 && <p role="alert">Nhóm nhận rỗng. Chưa thể gửi.</p>}
        {!unknown && <button disabled={pending || expired || !preview.recipientCount} onClick={() => void send()}>Xác nhận Gửi</button>}
      </div>}
      {unknown && <div role="status"><p>Chưa xác định kết quả. Giữ nguyên yêu cầu để tra cứu hoặc thử lại cùng khóa.</p>
        <button disabled={pending} onClick={() => void send(true)}>Tra cứu kết quả</button>
        <button disabled={pending} onClick={() => void send()}>Thử lại cùng khóa</button></div>}
    </>}
    {!create && <button disabled={pending} onClick={() => setRevision(value => value + 1)}>Tải lại</button>}
    {detail && <><h3>{detail.title}</h3><p style={{ whiteSpace: 'pre-wrap' }}>{detail.body}</p><p>{detail.audienceSummary}</p>
      {detail.status === 'SENT' ? <p role="status">Đã lưu cho {detail.recipientCount} tài khoản</p> : <p>Bản xem trước, chưa gửi</p>}
      <p>Nhóm tại ảnh chụp: {detail.counts.snapshot}; đã lưu: {detail.counts.sent}; đã nhận (ack): {detail.counts.delivered}; đã đọc: {detail.counts.read}.</p>
      <p>Dispatch: {detail.dispatchStatus ?? 'Chưa phát hành'}. DONE chỉ là hoàn tất lượt dispatch.</p>
      <p>Số liệu tại {date(detail.asOf)}</p></>}
    {!id && !create && <><form onSubmit={event => event.preventDefault()}><label>Trạng thái<select value={query.status} onChange={event => setQuery({ ...query, status: event.target.value, page: 1 })}>
      <option value="">Tất cả</option><option value="PREVIEW">PREVIEW</option><option value="SENT">SENT</option></select></label>
      <label>Từ ngày<input type="date" value={query.fromDate} onChange={event => setQuery({ ...query, fromDate: event.target.value, page: 1 })} /></label>
      <label>Đến ngày<input type="date" value={query.toDate} onChange={event => setQuery({ ...query, toDate: event.target.value, page: 1 })} /></label></form>
      {!pending && data?.total === 0 && <p>Chưa có thông báo trong kỳ.</p>}
      {data && <><p>{data.total} bản ghi — trang {data.page}/{data.totalPages}. Số liệu tại {date(data.asOf)}</p>
        <table><thead><tr><th>Tiêu đề</th><th>Nhóm nhận</th><th>Trạng thái</th><th>Tạo lúc</th></tr></thead><tbody>{data.items.map(row =>
          <tr key={row.broadcastId}><td><Link to={`/admin/notifications/${row.broadcastId}`}>{row.title}</Link></td><td>{row.audienceSummary} ({row.recipientCount})</td><td>{row.status}</td><td>{date(row.createdAt)}</td></tr>)}</tbody></table>
        <div className="pagination"><button disabled={pending || query.page === 1} onClick={() => setQuery({ ...query, page: query.page - 1 })}>Trang trước</button>
        <button disabled={pending || query.page >= data.totalPages} onClick={() => setQuery({ ...query, page: query.page + 1 })}>Trang sau</button></div></>}
    </>}
  </section>;
}
