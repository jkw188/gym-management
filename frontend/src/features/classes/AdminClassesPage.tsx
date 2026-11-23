import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { addDays, mondayOf, vietnamDate, vietnamTime } from '../shifts/shift-time';
import { adminClassesApi, type AdminClass, type AdminClassPage, type ClassCommand, type ClassQuery } from './admin-classes.api';
import { classesApi, type Subject } from './classes.api';
import { invalidateClasses, subscribeClassChanges } from './class-signals';
import { ClassForm, classConflictLabels } from './ClassForm';
import { ClassTrainerPicker } from './ClassTrainerPicker';

const statuses = { DRAFT: 'Nháp', PUBLISHED: 'Đã công bố', CANCELLED: 'Đã hủy' };
const time = (value: string) => `${vietnamDate(new Date(value))} ${vietnamTime(value)}`;
export function AdminClassesPage() {
  const [query, setQuery] = useState<ClassQuery>(() => ({ fromDate: mondayOf(new Date()), toDate: addDays(mondayOf(new Date()), 6), page: 1 }));
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [data, setData] = useState<AdminClassPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<AdminClass | 'new'>();
  const [selected, setSelected] = useState<{ row: AdminClass; action: 'publish' | 'cancel' | 'detail' }>();
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [commandError, setCommandError] = useState<ApiError>();
  const busy = useRef(false);
  const openingRound = useRef(0);
  const command = useRef<{ value: ClassCommand; key: string } | undefined>(undefined);
  useEffect(() => subscribeClassChanges(() => setRevision(n => n + 1)), []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setData(undefined);
    Promise.all([adminClassesApi.list(query, controller.signal), classesApi.subjects()])
      .then(([result, taxonomy]) => { if (!controller.signal.aborted) { setData(result); setSubjects(taxonomy); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Không tải được lớp.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, revision]);
  useEffect(() => () => { openingRound.current++; }, []);
  function saved() {
    command.current = undefined; setUnknown(false); setEditing(undefined); setSelected(undefined); setReason('');
    setCommandError(undefined); setNotice('Đã lưu lớp. Lịch công khai và giờ trống sẽ được tải lại.'); invalidateClasses();
  }
  async function send(next: { value: ClassCommand; key: string }) {
    if (busy.current) return;
    busy.current = true; setPending(true); setCommandError(undefined);
    try { await adminClassesApi.send(next.value, next.key); saved(); }
    catch (failure) {
      const issue = failure instanceof ApiError ? failure : new ApiError(failure instanceof Error ? failure.message : 'Không thể lưu lớp.');
      setCommandError(issue);
      const uncertain = issue.status === undefined || issue.status >= 500;
      setUnknown(uncertain);
      if (!uncertain) command.current = undefined;
    } finally { busy.current = false; setPending(false); }
  }
  function submit(value: ClassCommand) {
    if (busy.current || unknown) return;
    const next = { value, key: crypto.randomUUID() }; command.current = next; void send(next);
  }
  async function lookup() {
    if (!command.current || busy.current) return;
    busy.current = true; setPending(true);
    try { await adminClassesApi.lookup(command.current.value.operation, command.current.key); saved(); }
    catch (failure) { setCommandError(failure instanceof ApiError ? failure : new ApiError('Chưa tra cứu được kết quả.')); }
    finally { busy.current = false; setPending(false); }
  }
  async function open(id: string, action: 'edit' | 'publish' | 'cancel' | 'detail') {
    if (busy.current || unknown) return;
    busy.current = true; setPending(true); setCommandError(undefined); setNotice('');
    const round = ++openingRound.current;
    try {
      const row = await adminClassesApi.detail(id);
      if (round !== openingRound.current) return;
      if (action === 'edit') setEditing(row); else { setSelected({ row, action }); setReason(''); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Không tải được chi tiết lớp.'); }
    finally { busy.current = false; setPending(false); }
  }
  const blocked = pending || unknown;
  return <section className="auth-card classes-page"><h2>Quản lý lớp miễn phí</h2><p>Tất cả ngày và giờ theo Việt Nam (Asia/Ho_Chi_Minh).</p>
    {notice && <p role="status">{notice}</p>}
    {commandError && <div role="alert"><p>{classConflictLabels[commandError.code ?? ''] ?? commandError.message}</p>
      {commandError.requestId && <small>Mã tra cứu: {commandError.requestId}</small>}
      {commandError.code === 'VERSION_CONFLICT' && <button disabled={blocked} onClick={() => { setEditing(undefined); setSelected(undefined); setCommandError(undefined); setRevision(n => n + 1); }}>Tải lại lớp để đối chiếu</button>}</div>}
    {unknown && <div role="status"><p>Chưa xác định kết quả. Giữ nguyên yêu cầu để tra cứu hoặc gửi lại cùng khóa.</p>
      <button disabled={pending} onClick={() => command.current && void send(command.current)}>Gửi lại cùng yêu cầu</button>
      <button disabled={pending} onClick={() => void lookup()}>Tra cứu kết quả</button></div>}
    {pending && <p role="status">Đang xử lý…</p>}
    {editing ? <ClassForm key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? undefined : editing} subjects={subjects}
      disabled={blocked || commandError?.code === 'VERSION_CONFLICT'} onSubmit={submit} onClose={() => { setEditing(undefined); setCommandError(undefined); }} /> : <>
      <fieldset disabled={blocked || Boolean(selected)}><legend>Lọc lịch lớp</legend>
        <div className="toolbar"><div><label htmlFor="admin-class-from">Từ ngày</label><input id="admin-class-from" type="date" value={query.fromDate} onChange={e => setQuery({ ...query, fromDate: e.target.value, page: 1 })} /></div>
          <div><label htmlFor="admin-class-to">Đến ngày</label><input id="admin-class-to" type="date" value={query.toDate} onChange={e => setQuery({ ...query, toDate: e.target.value, page: 1 })} /></div>
          <div><label htmlFor="admin-class-subject">Lọc bộ môn</label><select id="admin-class-subject" value={query.subjectCode ?? ''} onChange={e => setQuery({ ...query, subjectCode: e.target.value, page: 1 })}>
            <option value="">Tất cả bộ môn</option>{subjects.map(subject => <option key={subject.code} value={subject.code}>{subject.label}</option>)}</select></div>
          <div><label htmlFor="admin-class-status">Lọc trạng thái lớp</label><select id="admin-class-status" value={query.status ?? ''} onChange={e => setQuery({ ...query, status: e.target.value, page: 1 })}>
            <option value="">Tất cả trạng thái</option>{Object.entries(statuses).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></div></div>
        <ClassTrainerPicker value={query.trainerId ?? ''} onChange={trainerId => setQuery({ ...query, trainerId, page: 1 })} />
      </fieldset>
      <div className="user-actions"><button disabled={blocked || Boolean(selected) || !subjects.length} onClick={() => { setEditing('new'); setCommandError(undefined); setNotice(''); }}>Tạo lớp nháp</button>
        <button disabled={blocked} onClick={() => setRevision(n => n + 1)}>Tải lại lịch lớp</button></div>
      {loading && <p role="status">Đang tải lớp…</p>}{error && <div role="alert">{error} <button disabled={blocked} onClick={() => setRevision(n => n + 1)}>Thử lại</button></div>}
      {!loading && !error && data && <>
        {data.items.length === 0 && <p>Không có lớp nào trong khoảng này.</p>}
        <ul className="class-list" aria-label="Lớp quản trị">{data.items.map(row => <li key={row.id} className="shift-item"><strong>{row.title}</strong>
          <span>{row.subjectLabel} · PT: {row.trainerName ?? 'Chưa có tên'}</span><span>{time(row.startAt)} – {time(row.endAt)}</span><span>{row.location}</span>
          <span>{statuses[row.status]} · Phiên bản {row.version}{row.ended ? ' · Đã kết thúc' : ''}</span>
          <div className="user-actions"><button disabled={blocked || Boolean(selected)} onClick={() => void open(row.id, 'detail')}>Chi tiết {row.title}</button>
            {row.status !== 'CANCELLED' && new Date(row.startAt) > new Date() && <>
              <button disabled={blocked || Boolean(selected)} onClick={() => void open(row.id, 'edit')}>Sửa {row.title}</button>
              {row.status === 'DRAFT' && <button disabled={blocked || Boolean(selected)} onClick={() => void open(row.id, 'publish')}>Công bố {row.title}</button>}
              <button disabled={blocked || Boolean(selected)} onClick={() => void open(row.id, 'cancel')}>Hủy {row.title}</button></>}
          </div></li>)}</ul>
        <div className="pagination"><button disabled={blocked || Boolean(selected) || query.page <= 1} onClick={() => setQuery({ ...query, page: query.page - 1 })}>Trang trước</button>
          <span>Trang {query.page}/{data.totalPages} · {data.total} lớp</span><button disabled={blocked || Boolean(selected) || query.page >= data.totalPages} onClick={() => setQuery({ ...query, page: query.page + 1 })}>Trang sau</button></div>
      </>}
    </>}
    {selected && <section role="dialog" aria-modal="true" aria-label="Xác nhận lớp" className="auth-card">
      <h3>{selected.row.title} · {statuses[selected.row.status]}</h3><p>{time(selected.row.startAt)} – {time(selected.row.endAt)} (VN) · {selected.row.location}</p>
      <p>Bộ môn: {selected.row.subjectLabel} · PT: {selected.row.trainerName ?? 'Chưa có tên'}</p>
      <p>Phiên bản {selected.row.version} · Tạo lúc {time(selected.row.createdAt)} · Sửa lúc {time(selected.row.updatedAt)}</p>
      {selected.row.publishedAt && <p>Công bố lúc {time(selected.row.publishedAt)}</p>}
      {selected.row.cancelledAt && <p>Hủy lúc {time(selected.row.cancelledAt)} · {selected.row.cancellationReason}</p>}
      {selected.action === 'publish' && <p>Công bố lớp này cho mọi người và chặn giờ PT tương ứng. {selected.row.subjectCode === 'OTHER' && 'Hãy kiểm tra bộ môn Khác trước khi công bố.'}</p>}
      {selected.action === 'cancel' && <><label htmlFor="class-cancel-reason">Lý do hủy (10–500 ký tự)</label><textarea id="class-cancel-reason" disabled={blocked} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></>}
      <div className="user-actions">
        {selected.action === 'publish' && <button disabled={blocked} onClick={() => submit({ operation: 'PUBLIC_SESSION_PUBLISH', id: selected.row.id, input: { version: selected.row.version } })}>Xác nhận công bố</button>}
        {selected.action === 'cancel' && <button disabled={blocked || reason.trim().length < 10} onClick={() => submit({ operation: 'PUBLIC_SESSION_CANCEL', id: selected.row.id, input: { version: selected.row.version, reason: reason.trim() } })}>Xác nhận hủy lớp</button>}
        <button disabled={blocked} onClick={() => { setSelected(undefined); setCommandError(undefined); }}>Đóng chi tiết</button>
      </div>
    </section>}
  </section>;
}
