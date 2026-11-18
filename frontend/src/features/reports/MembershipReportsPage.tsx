import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ApiError, apiClient } from '../../api/client';
import { membershipReportsApi, type MembershipReportDetail, type MembershipReportFilter,
  type MembershipReportPage, type MembershipReportSummary } from './membership-reports.api';

const INITIAL: MembershipReportFilter = { asOfAt: '', kind: 'ALL', activity: 'ALL', q: '', page: 1 };
const vnTimestamp = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false });
const time = (value: string | null) => value ? `${vnTimestamp.format(new Date(value))} (VN)` : 'Không đủ dữ liệu';
const value = (number: number | null) => number === null ? 'Không xác định' : number.toLocaleString('vi-VN');
const errorText = (error: unknown) => error instanceof ApiError ? error.message : 'Không tải được báo cáo. Vui lòng thử lại.';
function Quality({ data }: { data: MembershipReportSummary }) {
  return <>
    <p>Mốc nghiệp vụ (VN): {time(data.asOfAt)}; đọc dữ liệu (observedAt): {time(data.observedAt)}; {data.metricVersion}.</p>
    {data.dataQuality !== 'COMPLETE' && <div role="alert">
      <strong>{data.dataQuality === 'PARTIAL' ? 'Dữ liệu một phần (PARTIAL)' : 'Chưa đủ căn cứ báo cáo (UNAVAILABLE)'}</strong>
      <p>{data.invalidRecordCount} bản ghi cần đối chiếu: {data.warningCodes.join(', ')}</p>
      <p>Phần đã biết, chưa phải tổng đầy đủ: {data.knownTotals.totalMembers} hồ sơ, {data.knownTotals.activeMembers} hội viên có gói hiệu lực, {data.knownTotals.activeMemberships} quyền gói.</p>
      <p>Phạm vi lịch sử đủ căn cứ: {data.historyCoverageFrom ? time(data.historyCoverageFrom) : 'Chưa xác định'}.</p>
    </div>}
  </>;
}
export function MembershipReportsPage() {
  const auth = useSyncExternalStore(apiClient.subscribe, apiClient.getSnapshot);
  return <section className="auth-card"><h2>Báo cáo hội viên và membership</h2>
    {auth.status === 'authenticated' && auth.user?.roleCode === 'ADMIN'
      ? <ReportContent key={auth.user.id} /> : <p>Không có quyền truy cập.</p>}
  </section>;
}
function ReportContent() {
  const [form, setForm] = useState(INITIAL);
  const [filter, setFilter] = useState(INITIAL);
  const [data, setData] = useState<MembershipReportPage | null>(null);
  const [detail, setDetail] = useState<MembershipReportDetail | null>(null);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision(v => v + 1);
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null); setSelected(''); setDetail(null);
    membershipReportsApi.members(filter, controller.signal).then(result => {
      if (!controller.signal.aborted) setData(result);
    }, err => { if (!controller.signal.aborted) setError(errorText(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filter, revision]);
  useEffect(() => {
    setDetail(null); setDetailError('');
    if (!selected || !data) { setDetailLoading(false); return; }
    const controller = new AbortController(); setDetailLoading(true);
    membershipReportsApi.detail(selected, data.asOfAt, controller.signal).then(result => {
      if (!controller.signal.aborted) setDetail(result);
    }, err => { if (!controller.signal.aborted) setDetailError(errorText(err)); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selected, data]);
  function submit(event: FormEvent) {
    event.preventDefault();
    setFilter({ ...form, asOfAt: form.asOfAt ? new Date(`${form.asOfAt}+07:00`).toISOString() : '', q: form.q.trim(), page: 1 });
  }
  return <>
    <p>“Có gói hiệu lực” là quyền sử dụng GYM/PT; không phải số người đã check-in. Quota PT và trạng thái đăng nhập không quyết định KPI này.</p>
    <form onSubmit={submit}>
      <label>Thời điểm theo giờ Việt Nam (UTC+07:00)<input type="datetime-local" step="1" value={form.asOfAt}
        onChange={e => setForm({ ...form, asOfAt: e.target.value })} /></label>
      <small>Để trống để dùng giờ server hiện tại.</small>
      <label>Loại quyền<select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as MembershipReportFilter['kind'] })}>
        <option value="ALL">Tất cả GYM và PT</option><option value="GYM">GYM</option><option value="PT">PT</option></select></label>
      <label>Lọc bảng hội viên<select value={form.activity} onChange={e => setForm({ ...form, activity: e.target.value as MembershipReportFilter['activity'] })}>
        <option value="ALL">Tất cả</option><option value="ACTIVE">Có gói hiệu lực</option><option value="INACTIVE">Không có gói hiệu lực</option></select></label>
      <label>Tìm mã hoặc tên (chỉ lọc bảng)<input value={form.q} maxLength={120} onChange={e => setForm({ ...form, q: e.target.value })} /></label>
      <button type="submit">Xem báo cáo</button>
    </form>
    <button onClick={() => setRevision(v => v + 1)}>Tải lại dữ liệu nguồn</button>
    {loading && <p role="status">Đang tải báo cáo...</p>}
    {error && <p role="alert">{error}</p>}
    {data && <>
      <Quality data={data} />
      <p>Loại quyền đang hiển thị: {data.filter.kind}; mẫu số là toàn phòng. Bộ lọc bảng: {data.filter.activity}, {data.filter.q || 'không tìm kiếm'}.</p>
      <dl className="info-grid" aria-label="KPI hội viên">
        <dt>Tổng hồ sơ hội viên</dt><dd>{value(data.totalMembers)}</dd>
        <dt>Hội viên có gói hiệu lực</dt><dd>{value(data.activeMembers)}</dd>
        <dt>Hội viên không có gói hiệu lực</dt><dd>{value(data.inactiveMembers)}</dd>
        <dt>Tỷ lệ có gói hiệu lực</dt><dd>{data.activeRate === null ? data.totalMembers === 0 ? 'Không áp dụng' : 'Không xác định' : `${value(data.activeRate)}%`}</dd>
        <dt>Số quyền gói hiệu lực (khác số hội viên)</dt><dd>{value(data.activeMemberships)}</dd>
        <dt>Hội viên GYM / số quyền GYM</dt><dd>{value(data.byKind.GYM.activeMembers)} / {value(data.byKind.GYM.activeMemberships)}</dd>
        <dt>Hội viên PT / số quyền PT</dt><dd>{value(data.byKind.PT.activeMembers)} / {value(data.byKind.PT.activeMemberships)}</dd>
      </dl>
      <p>Hai nhóm GYM/PT có thể giao nhau, không cộng để suy tổng hội viên.</p>
      <h3>Danh sách hội viên distinct</h3>
      {!data.items.length && <p>Không có hội viên phù hợp bộ lọc bảng.</p>}
      {!!data.items.length && <table><thead><tr><th>Mã</th><th>Họ tên</th><th>Liên kết tài khoản</th><th>Quyền hiệu lực</th><th>Chi tiết</th></tr></thead>
        <tbody>{data.items.map(member => <tr key={member.memberId}><td>{member.code}</td><td>{member.displayName}</td>
          <td>{member.linkedAccount ? 'Có' : 'Chưa liên kết'}</td><td>{value(member.qualifyingMembershipCount)} ({member.activity === 'ACTIVE' ? 'Có gói hiệu lực' : member.activity === 'INACTIVE' ? 'Không có gói hiệu lực' : 'Chưa xác định'})</td>
          <td><button onClick={() => setSelected(member.memberId)}>Xem quyền nguồn {member.displayName}</button></td></tr>)}</tbody></table>}
      <div className="pagination"><span>{data.total} hội viên; trang {data.totalPages ? data.page : 0}/{data.totalPages}</span>
        <button disabled={data.page <= 1} onClick={() => setFilter({ ...filter, asOfAt: data.asOfAt, page: data.page - 1 })}>Trang trước</button>
        <button disabled={data.page >= data.totalPages} onClick={() => setFilter({ ...filter, asOfAt: data.asOfAt, page: data.page + 1 })}>Trang sau</button></div>
    </>}
    {detailLoading && <p role="status">Đang tải quyền nguồn...</p>}
    {detailError && <p role="alert">{detailError}</p>}
    {detail && <section aria-label="Quyền nguồn"><h3>Quyền nguồn của {detail.member.displayName}</h3>
      <p>Chi tiết được đọc bằng request riêng, có observedAt riêng; không coi là cùng snapshot với bảng.</p>
      <Quality data={detail} />
      {!detail.memberships.length && <p>Hội viên chưa có quyền gói được cấp.</p>}
      {detail.memberships.map((source, index) => <article key={source.membershipId ?? `missing-${index}`}>
        <h4>{source.planNameSnapshot ?? 'Thiếu snapshot tên gói'} ({source.kind ?? 'Chưa rõ loại'})</h4>
        <p>Membership: {source.membershipId ?? 'Thiếu'}; sale: {source.serviceSaleId}; giao dịch: {source.transactionId ?? 'Thiếu'}.</p>
        <p>Kỳ snapshot (VN): {source.startDate} – {source.endDate}. Hiệu lực [bắt đầu, kết thúc): {time(source.effectiveStart)} – {time(source.effectiveEnd)}.</p>
        <p>Tại mốc chọn: {source.qualifies === null ? 'Không đủ căn cứ' : source.qualifies ? 'Được tính' : 'Không được tính'}; {source.reasonCodes.join(', ')}.</p>
        <p>Trạng thái hiện tại của nguồn: membership {source.currentStatus ?? 'Thiếu'}, giao dịch {source.currentTransactionStatus ?? 'Thiếu'}.</p>
      </article>)}
    </section>}
  </>;
}
