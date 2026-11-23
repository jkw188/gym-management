import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ApiError, apiClient } from '../../api/client';
import { attendanceApi, type AttendanceDetail, type AttendanceFilter, type AttendancePage, type PendingAttendance } from './attendance.api';

const time = (value?: string | null) => value ? new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }) : 'Chưa có dữ liệu';
const localTime = (value?: string | null) => value ? new Date(Date.parse(value) + 7 * 3600000).toISOString().slice(0, 23) : '';
const message = (error: unknown) => error instanceof Error ? error.message : 'Không tải được dữ liệu';
const initialFilter: AttendanceFilter = { fromDate: '', toDate: '', trainerId: '', page: 1 };

export function TrainerAttendancePage() {
  const auth = useSyncExternalStore(apiClient.subscribe, apiClient.getSnapshot);
  return <section className="auth-card"><h2>Chấm công huấn luyện viên</h2>
    {auth.status === 'authenticated' && auth.user && ['ADMIN', 'STAFF'].includes(auth.user.roleCode)
      ? <AttendanceContent key={auth.user.id} admin={auth.user.roleCode === 'ADMIN'} /> : <p>Không có quyền truy cập.</p>}
  </section>;
}
function AttendanceContent({ admin }: { admin: boolean }) {
  const [form, setForm] = useState(initialFilter), [filter, setFilter] = useState(initialFilter);
  const [list, setList] = useState<AttendancePage | null>(null), [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<AttendanceDetail | null>(null);
  const [loading, setLoading] = useState(false), [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState(''), [detailError, setDetailError] = useState('');
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [revision, setRevision] = useState(0);
  const [verified, setVerified] = useState(false), [note, setNote] = useState('');
  const [correction, setCorrection] = useState(false), [checkIn, setCheckIn] = useState(''), [checkOut, setCheckOut] = useState(''), [reason, setReason] = useState('');
  const [pending, setPending] = useState<PendingAttendance | null>(null), [busy, setBusy] = useState(false);
  const active = useRef(true), submitting = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setList(null); setListError('');
    attendanceApi.list(filter, controller.signal).then(value => { if (!controller.signal.aborted) setList(value); },
      err => { if (!controller.signal.aborted) setListError(message(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filter, revision]);
  useEffect(() => {
    setDetail(null); setDetailError(''); setVerified(false); setCorrection(false); setNote('');
    if (!selected) return;
    const controller = new AbortController(); setDetailLoading(true);
    attendanceApi.detail(selected, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setDetail(value); setNote(value.note ?? '');
    }, err => { if (!controller.signal.aborted) setDetailError(message(err)); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selected, revision]);
  const done = () => { setPending(null); setError(''); setSuccess('Đã lưu chấm công.'); setRevision(value => value + 1); };
  async function execute(command: PendingAttendance, lookup = false) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(''); setSuccess(''); setPending(command);
    try {
      if (lookup) await attendanceApi.lookup(command); else await attendanceApi.send(command);
      if (active.current) done();
    } catch (err) {
      if (!active.current) return;
      const uncertain = lookup || !(err instanceof ApiError) || !err.status || err.status >= 500;
      setError(uncertain ? `${message(err)} Chưa xác định kết quả. Giữ nguyên khóa và tra cứu hoặc gửi lại.` : message(err));
      if (!uncertain) { setPending(null); if (err instanceof ApiError && err.status === 409) setRevision(value => value + 1); }
    } finally { submitting.current = false; if (active.current) setBusy(false); }
  }
  function submit(operation: PendingAttendance['operation'], event?: FormEvent) {
    event?.preventDefault();
    if (!detail || pending || !verified || submitting.current) return;
    const version = detail.shift.attendance.version;
    const body: PendingAttendance['body'] = { note: note.trim() };
    if (operation !== 'ATTENDANCE_CHECK_IN' && detail.state !== 'MISSING' && version !== null) body.version = version;
    if (operation === 'ATTENDANCE_CORRECT') {
      body.checkInAt = `${checkIn}+07:00`; if (checkOut) body.checkOutAt = `${checkOut}+07:00`;
      body.reason = reason.trim();
    }
    void execute({ operation, shiftId: selected, body, key: crypto.randomUUID() });
  }
  const eligible = detail && ['CONFIRMED', 'COMPLETED'].includes(detail.shift.status ?? '') && !detail.shift.dataIssue.length;
  const locked = busy || pending !== null;
  return <>
    <p>Giờ hiển thị theo Việt Nam (UTC+7). Giờ vào/ra do máy chủ ghi nhận; giờ ca và giờ thực tế là hai nguồn riêng.</p>
    <form onSubmit={event => { event.preventDefault(); setSelected(''); setFilter({ ...form, page: 1 }); }}>
      <fieldset disabled={locked}><legend>Chọn ngày và PT</legend>
        <label>Từ ngày<input type="date" value={form.fromDate} onChange={e => setForm({ ...form, fromDate: e.target.value })} /></label>
        <label>Đến ngày<input type="date" value={form.toDate} onChange={e => setForm({ ...form, toDate: e.target.value })} /></label>
        <label>Huấn luyện viên<select value={form.trainerId} onChange={e => setForm({ ...form, trainerId: e.target.value })}>
          <option value="">Tất cả PT</option>{list?.trainers.map(t => <option key={t.id} value={t.id}>{t.displayName ?? t.id}</option>)}</select></label>
        <button type="submit">Tra cứu ca</button>
      </fieldset>
    </form>
    {loading && <p role="status">Đang tải ca…</p>}{listError && <p role="alert">{listError}</p>}
    <button disabled={locked || loading} onClick={() => setRevision(v => v + 1)}>Tải lại</button>
    {list && <><p>{list.total} ca; trang {list.totalPages ? list.page : 0}/{list.totalPages}</p>
      {!list.items.length ? <p>Không có ca trong khoảng ngày đã chọn.</p> : <table><thead><tr><th>PT</th><th>Giờ ca</th><th>Trạng thái ca</th><th>Chấm công</th><th>Giờ thực tế</th><th>Thao tác</th></tr></thead>
        <tbody>{list.items.map(shift => <tr key={shift.id}><td>{list.trainers.find(t => t.id === shift.trainerId)?.displayName ?? shift.trainerId}</td>
          <td>{time(shift.startAt)} – {time(shift.endAt)}</td><td>{shift.status}</td><td>{shift.attendance.state}</td>
          <td>{time(shift.attendance.checkInAt)} – {time(shift.attendance.checkOutAt)}</td>
          <td><button disabled={locked} onClick={() => { setSelected(shift.id); setError(''); setSuccess(''); }}>Chọn ca</button></td></tr>)}</tbody></table>}
      <div className="pagination"><button disabled={locked || list.page <= 1} onClick={() => setFilter({ ...filter, page: filter.page - 1 })}>Trang trước</button>
      <button disabled={locked || list.page >= list.totalPages} onClick={() => setFilter({ ...filter, page: filter.page + 1 })}>Trang sau</button></div></>}
    {detailLoading && <p role="status">Đang tải chấm công…</p>}{detailError && <p role="alert">{detailError}</p>}
    {error && <p role="alert">{error}</p>}{success && <p role="status">{success}</p>}
    {pending && <div><p>Khóa tra cứu: {pending.key}</p>
      <button disabled={busy} onClick={() => void execute(pending, true)}>Tra cứu kết quả</button>
      <button disabled={busy} onClick={() => void execute(pending)}>Gửi lại cùng khóa</button></div>}
    {detail && <section><h3>Ca đã chọn — {detail.state}</h3>
      <p>Giờ ca: {time(detail.shift.startAt)} – {time(detail.shift.endAt)}; {detail.shift.location}</p>
      <p>Giờ thực tế: {time(detail.shift.attendance.checkInAt)} – {time(detail.shift.attendance.checkOutAt)}</p>
      <p>Thời lượng thực tế: {detail.shift.attendance.actualMinutes === null ? 'Chưa có dữ liệu' : `${detail.shift.attendance.actualMinutes} phút`}</p>
      {!!detail.shift.dataIssue.length && <p role="alert">Cần đối chiếu dữ liệu: {detail.shift.dataIssue.join(', ')}</p>}
      <fieldset disabled={locked || !eligible}><legend>Xác minh trước khi ghi nhận</legend>
        <label><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />Tôi đã kiểm tra đúng PT, ngày, ca và có mặt thực tế (kể cả đến sớm).</label>
        <label>Ghi chú (không nhập thông tin sức khỏe không cần thiết)<textarea maxLength={255} value={note} onChange={e => setNote(e.target.value)} /></label>
        {detail.state === 'MISSING' && <button disabled={!verified} onClick={() => submit('ATTENDANCE_CHECK_IN')}>Ghi vào</button>}
        {detail.state === 'OPEN' && <button disabled={!verified || detail.shift.attendance.version === null} onClick={() => submit('ATTENDANCE_CHECK_OUT')}>Ghi ra</button>}
        {admin && <button onClick={() => { setCorrection(true); setCheckIn(localTime(detail.shift.attendance.checkInAt)); setCheckOut(localTime(detail.shift.attendance.checkOutAt)); setReason(''); }}>Sửa sai / bổ sung bỏ sót</button>}
      </fieldset>
      {admin && correction && <div role="dialog" aria-modal="true" aria-label="Sửa sai chấm công"><h3>Sửa sai chấm công</h3>
        <p>Giá trị cũ: {time(detail.shift.attendance.checkInAt)} – {time(detail.shift.attendance.checkOutAt)}</p>
        <form onSubmit={event => submit('ATTENDANCE_CORRECT', event)}><fieldset disabled={locked}><legend>Giá trị mới (UTC+7)</legend>
          <label>Giờ vào mới<input type="datetime-local" step="0.001" required value={checkIn} onChange={e => setCheckIn(e.target.value)} /></label>
          <label>Giờ ra mới (bỏ trống để OPEN)<input type="datetime-local" step="0.001" value={checkOut} onChange={e => setCheckOut(e.target.value)} /></label>
          <label>Lý do sửa sai<textarea required minLength={10} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
          <p>Giá trị mới: {checkIn || 'Chưa nhập'} – {checkOut || 'OPEN'}; ghi chú: {note || 'Trống'}</p>
          <button type="submit" disabled={!verified || reason.trim().length < 10}>Lưu sửa sai</button>
          <button type="button" onClick={() => setCorrection(false)}>Đóng</button>
        </fieldset></form></div>}
      {admin && <><h3>Lịch sử chấm công</h3>{!detail.events?.length && <p>Chưa có sự kiện.</p>}
        {detail.events?.map(event => <div key={event.id}><p>{event.action} — {time(event.occurredAt)} — {event.actorId}</p>
          <p>Trước: {time(event.before?.checkInAt)} – {time(event.before?.checkOutAt)}; sau: {time(event.after?.checkInAt)} – {time(event.after?.checkOutAt)}</p>
          {event.reason && <p>Lý do: {event.reason}</p>}</div>)}</>}
    </section>}
  </>;
}
