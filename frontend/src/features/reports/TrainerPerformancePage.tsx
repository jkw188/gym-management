import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ApiError, apiClient } from '../../api/client';
import { formatAsOf } from '../pt-bookings/pt-booking-format';
import type { AttendanceSource, BookingSource } from '../trainer-activity/trainer-activity.api';
import type { AdminReview } from '../trainer-reviews/admin-trainer-reviews.api';
import { trainerPerformanceApi, type PerformanceDetail, type PerformanceFilter, type PerformanceList, type PerformanceMetrics,
  type PerformancePage, type PerformanceSource, type SourceKind, type SourcePages } from './trainer-performance.api';

const INITIAL: PerformanceFilter = { trainerId: '', fromDate: '', toDate: '', q: '', page: 1 };
const PAGES: SourcePages = { shiftPage: 1, attendancePage: 1, bookingPage: 1, reviewPage: 1 };
const SOURCES: { key: SourceKind; page: keyof SourcePages; label: string }[] = [
  { key: 'shifts', page: 'shiftPage', label: 'Ca công bố' }, { key: 'attendance', page: 'attendancePage', label: 'Chấm công thực tế' },
  { key: 'bookings', page: 'bookingPage', label: 'Buổi đã dạy' }, { key: 'reviews', page: 'reviewPage', label: 'Đánh giá đã gửi' },
];
const hours = (v: string | null) => v === null ? 'Chưa đủ dữ liệu' : `${Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} giờ`;
const time = (v: string | null) => v ? formatAsOf(v) : 'Chưa có dữ liệu';
const errorText = (e: unknown) => e instanceof ApiError ? e.message : 'Không tải được dữ liệu. Vui lòng thử lại.';
function Rate({ value }: { value: PerformanceMetrics }) {
  return <span title={`100 × giờ buổi COMPLETED / giờ ca CONFIRMED hoặc COMPLETED. Tử số ${value.completedBookingMilliseconds ?? '?'} ms; mẫu số ${value.plannedMilliseconds ?? '?'} ms.`}>
    {value.utilizationRate !== null ? `${value.utilizationRate.toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%`
      : value.utilizationStatus === 'NOT_APPLICABLE' ? 'Không áp dụng' : 'Cần đối soát dữ liệu'}</span>;
}
function Quality({ value }: { value: { dataQuality: string; warningCodes: string[]; invalidRecordCount: number } }) {
  return <p role="status">Chất lượng: {value.dataQuality}; bản ghi bất thường: {value.invalidRecordCount}.
    {value.warningCodes.length > 0 && <> Tổng đã biết có thể chưa đầy đủ: {value.warningCodes.join(', ')}.</>}</p>;
}
function Summary({ value }: { value: PerformanceMetrics }) {
  return <div aria-label="Chỉ số hiệu suất"><dl>
    <dt>Giờ ca công bố</dt><dd>{hours(value.plannedHours)} ({value.shiftCount ?? 'Chưa xác định số'} ca)
      {value.plannedHours === null && <>; phần đã biết: {hours(value.knownPlannedHours)}</>}</dd>
    <dt>Giờ ca status COMPLETED</dt><dd>{hours(value.completedShiftHours)} ({value.completedShiftCount ?? 'Chưa xác định số'} ca)</dd>
    <dt>Giờ buổi COMPLETED</dt><dd>{hours(value.completedBookingHours)} ({value.completedBookingCount ?? 'Chưa xác định số'} buổi)
      {value.completedBookingHours === null && <>; phần đã biết: {hours(value.knownCompletedBookingHours)}</>}</dd>
    <dt>Tỷ lệ sử dụng ca</dt><dd><Rate value={value} /></dd>
    <dt>Tổng giờ công thực tế</dt><dd>{hours(value.actualTotalHours)}</dd>
    <dt>Giờ công đã biết (CLOSED)</dt><dd>{hours(value.knownActualHours)}; thiếu {value.missingCount} ca, đang mở {value.openCount} ca</dd>
    <dt>Đánh giá theo ngày gửi</dt><dd>{value.reviewCount ?? 'Chưa xác định số'} lượt; trung bình {value.averageRating === null ? 'Chưa có dữ liệu' : value.averageRating.toLocaleString('vi-VN', { maximumFractionDigits: 2 })}</dd>
    <dt>Phân bố điểm</dt><dd>{value.ratingDistribution === null ? 'Chưa đủ dữ liệu' : Object.entries(value.ratingDistribution).map(([star, count]) => `${star} sao: ${count}`).join(' / ')}</dd>
  </dl><Quality value={value} /></div>;
}
function Pagination({ value, change }: { value: PerformancePage<unknown>; change: (p: number) => void }) {
  return <div className="pagination"><span>{value.total} bản ghi; trang {value.totalPages ? value.page : 0}/{value.totalPages}</span>
    <button disabled={value.page <= 1} onClick={() => change(value.page - 1)}>Trang trước</button>
    <button disabled={value.page >= value.totalPages} onClick={() => change(value.page + 1)}>Trang sau</button></div>;
}
export function TrainerPerformancePage() {
  const auth = useSyncExternalStore(apiClient.subscribe, apiClient.getSnapshot);
  return <section className="auth-card"><h2>Báo cáo hiệu suất huấn luyện viên</h2>
    {auth.status === 'authenticated' && auth.user?.roleCode === 'ADMIN' ? <PerformanceContent key={auth.user.id} /> : <p>Không có quyền truy cập.</p>}</section>;
}
function PerformanceContent() {
  const [form, setForm] = useState(INITIAL), [filter, setFilter] = useState(INITIAL);
  const [list, setList] = useState<PerformanceList | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(''), [pages, setPages] = useState(PAGES);
  const [detail, setDetail] = useState<PerformanceDetail | null>(null), [detailError, setDetailError] = useState(''), [detailLoading, setDetailLoading] = useState(false);
  const [revision, setRevision] = useState(0), [source, setSource] = useState<PerformanceSource | null>(null);
  const [sourceState, setSourceState] = useState<{ loading: boolean; error: string; data: AttendanceSource | BookingSource | AdminReview | null }>({ loading: false, error: '', data: null });
  useEffect(() => {
    const refresh = () => setRevision(v => v + 1);
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setList(null); setDetail(null); setSource(null);
    trainerPerformanceApi.list(filter, controller.signal).then(data => { if (!controller.signal.aborted) setList(data); })
      .catch(e => { if (!controller.signal.aborted) setError(errorText(e)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filter, revision]);
  useEffect(() => {
    const controller = new AbortController(); setDetail(null); setDetailError(''); setDetailLoading(false); setSource(null);
    if (list && selected) {
      setDetailLoading(true);
      trainerPerformanceApi.detail(selected, list.range, pages, controller.signal).then(data => { if (!controller.signal.aborted) setDetail(data); })
        .catch(e => { if (!controller.signal.aborted) setDetailError(errorText(e)); }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    }
    return () => controller.abort();
  }, [selected, list, pages]);
  useEffect(() => {
    const controller = new AbortController(); setSourceState({ loading: !!source, error: '', data: null });
    if (source) Promise.resolve().then(() => trainerPerformanceApi.source(source, controller.signal)).then(data => { if (!controller.signal.aborted) setSourceState({ loading: false, error: '', data }); })
      .catch(e => { if (!controller.signal.aborted) setSourceState({ loading: false, error: errorText(e), data: null }); });
    return () => controller.abort();
  }, [source]);
  function apply(event: FormEvent) { event.preventDefault(); setSelected(''); setPages(PAGES); setFilter({ ...form, page: 1 }); }
  function changePage(page: number) { if (list) setFilter({ ...filter, fromDate: list.range.fromDate, toDate: list.range.toDate, page }); }
  return <>
    <form onSubmit={apply}>
      <label>Từ ngày (VN)<input type="date" value={form.fromDate} onChange={e => setForm({ ...form, fromDate: e.target.value })} /></label>
      <label>Đến ngày (VN)<input type="date" value={form.toDate} onChange={e => setForm({ ...form, toDate: e.target.value })} /></label>
      <label>Mã PT (để trống xem tất cả)<input value={form.trainerId} onChange={e => setForm({ ...form, trainerId: e.target.value.trim() })} /></label>
      <label>Tìm tên hoặc ID trong bảng<input maxLength={120} value={form.q} onChange={e => setForm({ ...form, q: e.target.value })} /></label>
      <button type="submit">Xem báo cáo</button>
    </form>
    <button onClick={() => { if (list) setFilter({ ...filter, fromDate: list.range.fromDate, toDate: list.range.toDate }); else setRevision(v => v + 1); }} disabled={loading}>Tải lại nguồn</button>
    <p>Giờ hiển thị theo Việt Nam. Ca hoàn tất chỉ tính status COMPLETED; checkout và buổi đã dạy không tự hoàn tất ca. Đánh giá tính theo ngày gửi.</p>
    {loading && <p role="status">Đang tải báo cáo…</p>}{error && <p role="alert">{error}</p>}
    {list && <>
      <p>Kỳ đang hiển thị: {list.range.fromDate} – {list.range.toDate}; quan sát lúc {time(list.observedAt)}; {list.metricVersion}.</p>
      <p>Bộ lọc đang hiển thị: PT {list.filter.trainerId ?? 'Tất cả'}; tìm trong bảng: {list.filter.q || 'Không lọc'}.</p>
      {list.range.isOngoing && <p>Kỳ chưa kết thúc; chỉ tính tới {time(list.range.effectiveTo)}.</p>}
      <h3>Tổng toàn tập báo cáo</h3><Summary value={list.totals} />
      {list.items.length === 0 ? <p>Không có PT phù hợp.</p> : <table aria-label="Hiệu suất theo PT"><thead><tr>
        <th>PT</th><th>Giờ ca</th><th>Giờ ca hoàn tất</th><th>Giờ buổi / số buổi</th><th>Giờ công</th><th>Sử dụng ca</th><th>Đánh giá</th><th>Nguồn</th>
      </tr></thead><tbody>{list.items.map(row => <tr key={row.id}>
        <td>{row.displayName ?? row.id} ({row.status ?? 'Mồ côi'})</td><td>{hours(row.summary.plannedHours)}</td>
        <td>{hours(row.summary.completedShiftHours)}</td><td>{hours(row.summary.completedBookingHours)} / {row.summary.completedBookingCount ?? 'Chưa xác định'}</td>
        <td>{hours(row.summary.actualTotalHours)}; đã biết {hours(row.summary.knownActualHours)}; thiếu {row.summary.missingCount}, mở {row.summary.openCount}</td>
        <td><Rate value={row.summary} /></td><td>{row.summary.reviewCount ?? 'Chưa xác định số'} lượt / {row.summary.averageRating ?? 'Chưa có dữ liệu'}</td>
        <td><Quality value={row.summary} />{/^[a-f\d]{24}$/i.test(row.id) && <button onClick={() => { setPages(PAGES); setSelected(row.id); }}>Chi tiết {row.displayName ?? row.id}</button>}</td>
      </tr>)}</tbody></table>}
      <Pagination value={list} change={changePage} />
    </>}
    {detailLoading && <p role="status">Đang tải chi tiết…</p>}{detailError && <p role="alert">{detailError}</p>}
    {detail && <section aria-label="Chi tiết nguồn hiệu suất"><h3>{detail.trainer.displayName ?? detail.trainer.id}</h3>
      <p>Snapshot chi tiết: {time(detail.observedAt)}. Request chi tiết có thể thấy nguồn mới hơn bảng tổng.</p><Summary value={detail.summary} />
      {SOURCES.map(({ key, page, label }) => <section key={key} aria-label={label}><h4>{label}</h4>
        {detail.sourcePages[key].items.length === 0 ? <p>Không có nguồn trong kỳ.</p> : <table><thead><tr><th>ID / trạng thái</th><th>Thời gian gốc</th><th>Giao kỳ</th><th>Ghi nhận / xác nhận</th><th>Truy vết</th></tr></thead>
          <tbody>{detail.sourcePages[key].items.map(s => <tr key={s.id}><td>{s.id}<br />{s.status}{s.rating !== null && ` / ${s.rating} sao`}</td>
            <td>{time(s.startAt)} – {time(s.endAt)}<br />{s.rawMilliseconds === null ? 'Chưa có interval đầy đủ' : `${s.rawMilliseconds} ms`}</td>
            <td>{time(s.clippedStartAt)} – {time(s.clippedEndAt)}<br />{s.clippedMilliseconds === null ? 'Chưa có dữ liệu' : `${s.clippedMilliseconds} ms`}</td>
            <td>Ghi nhận: {time(s.recordedAt)}<br />Hoàn tất: {time(s.completedAt)}<br />Actor: {s.actorId ?? 'Chưa có'}</td>
            <td>Ca: {s.shiftId ?? '—'}<br />Buổi: {s.bookingId ?? '—'}<br />{s.dataIssue.join(', ')}
              {s.sourceLink && <button onClick={() => setSource(s)}>Xem nguồn {s.id}</button>}</td></tr>)}</tbody></table>}
        <Pagination value={detail.sourcePages[key]} change={p => setPages({ ...pages, [page]: p })} />
      </section>)}
    </section>}
    {source && <section aria-label="Nguồn đối chiếu"><h3>Nguồn {source.id}</h3>
      {sourceState.loading && <p role="status">Đang tải nguồn…</p>}{sourceState.error && <p role="alert">{sourceState.error}</p>}
      {sourceState.data && <SourceAudit value={sourceState.data} />}
    </section>}
  </>;
}
function SourceAudit({ value }: { value: AttendanceSource | BookingSource | AdminReview }) {
  if ('rating' in value) return <>
    <p>Đánh giá {value.id}: {value.rating} sao; gửi lúc {time(value.createdAt)}.</p>
    <p>{value.memberDisplayName}: {value.comment || 'Không có nhận xét.'}</p>
    <p>Buổi gốc {value.booking.id}: {time(value.booking.startAt)} – {time(value.booking.endAt)}.</p>
  </>;
  return 'shift' in value ? <>
    <p>Chấm công {value.state}; snapshot nguồn {time(value.asOf)}.</p>
    <p>Vào: {time(value.shift.attendance.checkInAt)}; ra: {time(value.shift.attendance.checkOutAt)}.</p>
    <h4>Lịch sử nguồn</h4><ul>{value.events.map((event, i) => <li key={event.id ?? i}>{event.action} — {time(event.occurredAt)}; người thực hiện {event.actorId}; {event.reason}</li>)}</ul>
  </> : <>
    <p>Buổi {value.id}: {value.status}; {time(value.startAt)} – {time(value.endAt)}.</p>
    <p>Xác nhận: {time(value.completedAt ?? null)}; người xác nhận {value.completedBy ?? 'Chưa có'}.</p>
    <h4>Lịch sử nguồn</h4><ul>{value.events.map((event, i) => <li key={i}>{event.action} — {time(event.occurredAt)}; người thực hiện {event.actorId}; {event.reason}</li>)}</ul>
  </>;
}
