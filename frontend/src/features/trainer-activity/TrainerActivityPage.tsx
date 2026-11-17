import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ApiError, apiClient } from '../../api/client';
import { formatAsOf } from '../pt-bookings/pt-booking-format';
import { trainerActivityApi, type ActivityDetail, type ActivityFilter, type ActivityList, type ActivitySummary,
  type AttendanceSource, type BookingSource, type Page } from './trainer-activity.api';

const time = (value: string | null | undefined) => value ? formatAsOf(value) : 'Chưa có dữ liệu';
const errorText = (error: unknown) => error instanceof ApiError ?
  error.details?.map(item => item.message).join(' ') || error.message : 'Không tải được dữ liệu. Vui lòng thử lại.';
const INITIAL: ActivityFilter = { trainerId: '', fromDate: '', toDate: '', page: 1 };

export function TrainerActivityPage() {
  const auth = useSyncExternalStore(apiClient.subscribe, apiClient.getSnapshot);
  return <section className="auth-card">
    <h2>Đối chiếu chấm công và buổi PT</h2>
    {auth.status === 'authenticated' && auth.user?.roleCode === 'ADMIN'
      ? <ActivityContent key={auth.user.id} /> : <p>Không có quyền truy cập.</p>}
  </section>;
}
function Summary({ value }: { value: ActivitySummary }) {
  return <dl>
    <dt>Tổng ca</dt><dd>{value.shiftCount}</dd>
    <dt>Chấm công CLOSED / OPEN / MISSING</dt><dd>{value.attendanceClosed} / {value.attendanceOpen} / {value.attendanceMissing}</dd>
    <dt>Tổng giờ thực tế (chỉ CLOSED hợp lệ)</dt><dd>{(value.actualMinutesTotal / 60).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} giờ ({value.actualMinutesTotal} phút)</dd>
    <dt>Tổng buổi PT</dt><dd>{value.bookingCount}</dd>
    <dt>Đã xác nhận hoàn tất</dt><dd>{value.completedCount}</dd>
    <dt>Chờ xác nhận (BOOKED)</dt><dd>{value.pendingCompletionCount}</dd>
    <dt>Đã hủy</dt><dd>{value.cancelledCount}</dd>
  </dl>;
}
function Pagination({ data, change }: { data: Page<unknown>; change: (page: number) => void }) {
  return <div className="pagination"><span>{data.total} bản ghi; trang {data.totalPages ? data.page : 0}/{data.totalPages}</span>
    <button disabled={data.page <= 1} onClick={() => change(data.page - 1)}>Trang trước</button>
    <button disabled={data.page >= data.totalPages} onClick={() => change(data.page + 1)}>Trang sau</button></div>;
}
function Issues({ values }: { values: string[] }) {
  return values.length ? <p role="status">Cần đối chiếu dữ liệu nguồn: {values.join(', ')}</p> : null;
}
function ActivityContent() {
  const [form, setForm] = useState(INITIAL);
  const [filter, setFilter] = useState(INITIAL);
  const [list, setList] = useState<ActivityList | null>(null);
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState('');
  const [pages, setPages] = useState({ shiftPage: 1, bookingPage: 1 });
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [source, setSource] = useState<{ kind: 'attendance' | 'booking'; id: string } | null>(null);
  const [sourceData, setSourceData] = useState<AttendanceSource | BookingSource | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);
  const [revision, setRevision] = useState(0);

  // Focus/online and explicit refresh re-read committed source changes; never mutate reporting endpoints.
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setList(null); setListError('');
    trainerActivityApi.list(filter, controller.signal).then(data => {
      if (!controller.signal.aborted) setList(data);
    }).catch(error => { if (!controller.signal.aborted) setListError(errorText(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filter, revision]);
  const fromDate = list?.range.fromDate;
  const toDate = list?.range.toDate;
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null); setDetailError(''); setDetailLoading(false);
    if (selected && fromDate && toDate) {
      setDetailLoading(true);
      trainerActivityApi.detail(selected, { fromDate, toDate }, pages.shiftPage, pages.bookingPage, controller.signal)
        .then(data => { if (!controller.signal.aborted) setDetail(data); })
        .catch(error => { if (!controller.signal.aborted) setDetailError(errorText(error)); })
        .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    }
    return () => controller.abort();
  }, [selected, fromDate, toDate, pages, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setSourceData(null); setSourceError(''); setSourceLoading(false);
    if (source) {
      setSourceLoading(true);
      const request = source.kind === 'attendance' ? trainerActivityApi.attendance(source.id, controller.signal) : trainerActivityApi.booking(source.id, controller.signal);
      request.then(data => { if (!controller.signal.aborted) setSourceData(data); })
        .catch(error => { if (!controller.signal.aborted) setSourceError(errorText(error)); })
        .finally(() => { if (!controller.signal.aborted) setSourceLoading(false); });
    }
    return () => controller.abort();
  }, [source, revision]);
  function apply(event: FormEvent) {
    event.preventDefault(); setSelected(''); setSource(null); setPages({ shiftPage: 1, bookingPage: 1 }); setFilter({ ...form, page: 1 });
  }
  return <>
    <p>Lọc theo giờ bắt đầu ca và buổi PT, múi giờ Việt Nam. Giờ xác nhận hoàn tất hiển thị riêng. Mặc định 30 ngày gần nhất, tối đa 366 ngày.</p>
    <form onSubmit={apply}>
      <label>Mã PT (tùy chọn)<input value={form.trainerId} onChange={e => setForm({ ...form, trainerId: e.target.value })} /></label>
      <label>Từ ngày<input type="date" value={form.fromDate} onChange={e => setForm({ ...form, fromDate: e.target.value })} /></label>
      <label>Đến ngày<input type="date" value={form.toDate} onChange={e => setForm({ ...form, toDate: e.target.value })} /></label>
      <button>Lọc</button>
    </form>
    <button type="button" onClick={() => setRevision(value => value + 1)}>Tải lại dữ liệu</button>
    {loading && <p role="status">Đang tải báo cáo...</p>}
    {listError && <div role="alert">{listError}<button onClick={() => setRevision(value => value + 1)}>Thử lại</button></div>}
    {list && <>
      <p>Kỳ {list.range.fromDate} – {list.range.toDate}; dữ liệu tại {time(list.asOf)}.</p>
      <section aria-label="Tổng toàn bộ tập lọc"><h3>Tổng toàn bộ tập lọc</h3><Summary value={list.summary} /></section>
      <h3>Danh sách PT (gồm PT ngừng hoạt động)</h3>
      {list.items.length === 0 && <p>Không có PT hoặc nguồn phù hợp.</p>}
      {list.items.map(trainer => <article key={trainer.id}>
        <p>{trainer.displayName ?? 'Thiếu hồ sơ/tài khoản PT'} — {trainer.id} — {trainer.status ?? 'Không có trạng thái'}</p>
        <Issues values={trainer.dataIssue} />
        {/^[a-f0-9]{24}$/i.test(trainer.id) && <button onClick={() => {
          setSelected(trainer.id); setPages({ shiftPage: 1, bookingPage: 1 }); setSource(null);
        }}>Đối chiếu {trainer.displayName ?? trainer.id}</button>}
      </article>)}
      <Pagination data={list} change={page => { setSelected(''); setSource(null); setFilter({ ...filter, page }); }} />
    </>}
    {detailLoading && <p role="status">Đang tải chi tiết...</p>}
    {detailError && <div role="alert">{detailError}<button onClick={() => setRevision(value => value + 1)}>Thử lại chi tiết</button></div>}
    {detail && <section aria-label="Đối chiếu PT">
      <h3>{detail.trainer.displayName ?? detail.trainer.id}</h3>
      <p>Chi tiết tại {time(detail.asOf)}; tổng của toàn kỳ {detail.range.fromDate} – {detail.range.toDate}.</p>
      <Issues values={detail.trainer.dataIssue} /><Summary value={detail.summary} />
      <section aria-label="Ca và chấm công"><h3>Ca và chấm công</h3>
        <p>MISSING: chưa ghi nhận; OPEN: chưa có giờ ra; CLOSED: đã có giờ vào/ra. Trạng thái ca không chứng minh đã chấm công.</p>
        {detail.shiftsPage.items.length === 0 && <p>Không có ca trong kỳ.</p>}
        {detail.shiftsPage.items.map(shift => <article key={shift.id}>
          <p>Ca {shift.id}: {time(shift.startAt)} – {time(shift.endAt)}; {shift.status}; {shift.location}</p>
          <p>Chấm công: {shift.attendance.state}; vào {time(shift.attendance.checkInAt)}; ra {time(shift.attendance.checkOutAt)}</p>
          <p>Thời lượng thực: {shift.attendance.actualMinutes === null ? 'Chưa có dữ liệu hợp lệ' : `${shift.attendance.actualMinutes} phút`}</p>
          <p>Người ghi vào: {shift.attendance.recordedBy ?? 'Chưa có'}; người ghi ra: {shift.attendance.checkedOutBy ?? 'Chưa có'}</p>
          <Issues values={shift.dataIssue} /><button onClick={() => setSource({ kind: 'attendance', id: shift.id })}>Xem nguồn ca/chấm công</button>
        </article>)}
        <Pagination data={detail.shiftsPage} change={shiftPage => { setSource(null); setPages({ ...pages, shiftPage }); }} />
      </section>
      <section aria-label="Buổi PT"><h3>Buổi PT</h3><p>BOOKED kể cả quá giờ vẫn chưa được xác nhận hoàn tất.</p>
        {detail.bookingsPage.items.length === 0 && <p>Không có buổi PT trong kỳ.</p>}
        {detail.bookingsPage.items.map(booking => <article key={booking.id}>
          <p>Buổi {booking.id}: {time(booking.startAt)} – {time(booking.endAt)}; {booking.status}</p>
          <p>Xác nhận lúc: {time(booking.completedAt)}; người xác nhận: {booking.completedBy ?? 'Chưa có'}; lần hiệu chỉnh: {booking.completionRevision ?? 'Chưa có'}</p>
          <Issues values={booking.dataIssue} /><button onClick={() => setSource({ kind: 'booking', id: booking.id })}>Xem nguồn buổi PT</button>
        </article>)}
        <Pagination data={detail.bookingsPage} change={bookingPage => { setSource(null); setPages({ ...pages, bookingPage }); }} />
      </section>
    </section>}
    {sourceLoading && <p role="status">Đang tải nguồn...</p>}
    {sourceError && <div role="alert">{sourceError}<button onClick={() => setRevision(value => value + 1)}>Thử lại nguồn</button></div>}
    {sourceData && <SourceView value={sourceData} />}
  </>;
}
function SourceView({ value }: { value: AttendanceSource | BookingSource }) {
  return <section aria-label="Chi tiết nguồn"><h3>Chi tiết nguồn và lịch sử</h3>
    {'shift' in value ? <>
      <p>Ca {value.shift.id}; {time(value.shift.startAt)} – {time(value.shift.endAt)}; {value.shift.status}</p>
      <p>Attendance {value.shift.attendance.id ?? 'MISSING'}; version {value.shift.attendance.version ?? 'Chưa có'}; {value.state}</p>
      <p>Giờ vào {time(value.shift.attendance.checkInAt)}; giờ ra {time(value.shift.attendance.checkOutAt)}; thời lượng {value.shift.attendance.actualMinutes === null ? 'Chưa có dữ liệu hợp lệ' : `${value.shift.attendance.actualMinutes} phút`}</p>
      <p>Người ghi vào {value.shift.attendance.recordedBy ?? 'Chưa có'}; người ghi ra {value.shift.attendance.checkedOutBy ?? 'Chưa có'}</p>
      <p>Hiệu chỉnh gần nhất: {time(value.shift.attendance.lastCorrectedAt)}; bởi {value.shift.attendance.lastCorrectedBy ?? 'Chưa có'}</p>
      <Issues values={value.shift.dataIssue} />
      {value.events.map(event => <article key={event.id}>
        <p>{event.action}; {time(event.occurredAt)}; người thực hiện {event.actorId}; lý do {event.reason ?? 'Không có'}</p>
        <p>Trước: {time(event.before?.checkInAt)} – {time(event.before?.checkOutAt)}; version {event.before?.version ?? 'Chưa có'}</p>
        <p>Sau: {time(event.after?.checkInAt)} – {time(event.after?.checkOutAt)}; version {event.after?.version ?? 'Chưa có'}</p>
      </article>)}
    </> : <>
      <p>Buổi {value.id}; {value.status}; {time(value.startAt)} – {time(value.endAt)}</p>
      <p>Xác nhận {time(value.completedAt)}; bởi {value.completedBy ?? 'Chưa có'}; revision {value.completionRevision}</p>
      <p>Gói nguồn {value.quotaSource.membershipId}; đã dùng {value.quotaSource.sessionsUsed ?? 'Chưa có dữ liệu'} / {value.quotaSource.sessionsQuota ?? 'Chưa có dữ liệu'}</p>
      {value.events.map((event, index) => <article key={index}>
        <p>{event.action}; {time(event.occurredAt)}; người thực hiện {event.actorId}; lý do {event.reason ?? 'Không có'}</p>
        <p>{event.beforeStatus} → {event.afterStatus}; revision {event.completionRevision ?? 'Chưa có'}; số buổi đã dùng {event.usedBefore ?? 'Chưa có'} → {event.usedAfter ?? 'Chưa có'}</p>
      </article>)}
    </>}
    {value.events.length === 0 && <p>Chưa có lịch sử nguồn.</p>}
  </section>;
}
