import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ApiError, apiClient } from '../../api/client';
import { cashFlowApi, type CashEvent, type CashFlowDetail, type CashFlowFilter, type CashFlowPage, type CashMetrics } from './cash-flow.api';

const INITIAL: CashFlowFilter = { fromDate: '', toDate: '', kind: 'ALL', paymentMethod: 'ALL', payoutMethod: 'ALL', eventType: 'ALL', q: '', page: 1 };
const timestamp = (value: string | null) => value ? `${new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh',
  dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value))} (VN)` : 'Không xác định';
// Format the exact integer string; never coerce report totals through Number.
const money = (value: string | null) => value === null ? 'Không xác định' : `${value.replace(/\B(?=(\d{3})+(?!\d))/g, '.')} ₫`;
const message = (error: unknown) => error instanceof ApiError ? error.message : 'Không tải được báo cáo. Vui lòng thử lại.';
function MoneyCells({ metrics }: { metrics: CashMetrics }) {
  return <><td>{money(metrics.totals.grossReceipts)}</td><td>{money(metrics.totals.refundPaid)}</td><td>{money(metrics.totals.netCash)}</td></>;
}
export function CashFlowReportsPage() {
  const auth = useSyncExternalStore(apiClient.subscribe, apiClient.getSnapshot);
  return <section><h2>Báo cáo khoản thu và hoàn tiền</h2>
    {auth.status === 'authenticated' && auth.user?.roleCode === 'ADMIN'
      ? <CashFlowContent key={auth.user.id} /> : <p>Không có quyền truy cập.</p>}
  </section>;
}
function CashFlowContent() {
  const [form, setForm] = useState(INITIAL), [filter, setFilter] = useState(INITIAL);
  const [data, setData] = useState<CashFlowPage | null>(null), [detail, setDetail] = useState<CashFlowDetail | null>(null);
  const [selected, setSelected] = useState<CashEvent | null>(null);
  const [loading, setLoading] = useState(false), [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(''), [detailError, setDetailError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision(v => v + 1);
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setData(null); setSelected(null); setDetail(null); setError('');
    cashFlowApi.events(filter, controller.signal).then(result => {
      if (!controller.signal.aborted) setData(result);
    }, err => { if (!controller.signal.aborted) setError(message(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filter, revision]);
  useEffect(() => {
    setDetail(null); setDetailError('');
    if (!selected || !data) { setDetailLoading(false); return; }
    const controller = new AbortController(); setDetailLoading(true);
    cashFlowApi.detail(selected, { ...filter, fromDate: data.range.fromDate, toDate: data.range.toDate }, controller.signal).then(result => {
      if (!controller.signal.aborted) setDetail(result);
    }, err => { if (!controller.signal.aborted) setDetailError(message(err)); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selected, data, filter]);
  function submit(event: FormEvent) { event.preventDefault(); setFilter({ ...form, q: form.q.trim(), page: 1 }); }
  const paginate = (page: number) => data && setFilter({ ...filter, fromDate: data.range.fromDate, toDate: data.range.toDate, page });
  return <>
    <p>Dòng tiền thực nhận và thực chi, chưa phân bổ kế toán. “Thu trừ hoàn” có thể âm; không phải lợi nhuận.</p>
    <form onSubmit={submit}>
      <label>Từ ngày (VN)<input type="date" value={form.fromDate} onChange={e => setForm({ ...form, fromDate: e.target.value })} /></label>
      <label>Đến ngày (VN)<input type="date" value={form.toDate} onChange={e => setForm({ ...form, toDate: e.target.value })} /></label>
      <small>Để trống: tháng hiện tại tới hôm nay VN. Tối đa 366 ngày.</small>
      <label>Loại dịch vụ<select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as CashFlowFilter['kind'] })}>
        {['ALL', 'GYM', 'PT', 'RETAIL'].map(v => <option key={v} value={v}>{v === 'ALL' ? 'Tất cả' : v}</option>)}</select></label>
      <label>Phương thức thu<select value={form.paymentMethod} onChange={e => setForm({ ...form, paymentMethod: e.target.value as CashFlowFilter['paymentMethod'] })}>
        <option value="ALL">Tất cả</option><option value="CASH">Tiền mặt</option><option value="TRANSFER">Chuyển khoản</option></select></label>
      <label>Phương thức chi hoàn<select value={form.payoutMethod} onChange={e => setForm({ ...form, payoutMethod: e.target.value as CashFlowFilter['payoutMethod'] })}>
        <option value="ALL">Tất cả</option><option value="CASH">Tiền mặt</option><option value="TRANSFER">Chuyển khoản</option></select></label>
      <label>Loại sự kiện (chỉ lọc bảng)<select value={form.eventType} onChange={e => setForm({ ...form, eventType: e.target.value as CashFlowFilter['eventType'] })}>
        <option value="ALL">Tất cả</option><option value="RECEIPT">Thu</option><option value="REFUND">Hoàn</option></select></label>
      <label>Tìm mã hoặc ID nguồn (chỉ lọc bảng)<input value={form.q} maxLength={120} onChange={e => setForm({ ...form, q: e.target.value })} /></label>
      <button type="submit">Xem báo cáo</button>
    </form>
    <button onClick={() => setRevision(v => v + 1)}>Tải lại dữ liệu nguồn</button>
    {loading && <p role="status">Đang tải báo cáo...</p>}{error && <p role="alert">{error}</p>}
    {data && <>
      <p>Kỳ đang hiển thị: {data.range.fromDate} – {data.range.toDate} (VN){data.range.isOngoing ? '; hôm nay chưa kết thúc' : ''}.
        Đọc dữ liệu (observedAt): {timestamp(data.observedAt)}; {data.metricVersion}.</p>
      <p>Bộ lọc đang hiển thị: {data.filter.kind}; thu {data.filter.paymentMethod}; chi {data.filter.payoutMethod}.
        Phương thức thu chỉ lọc thu; phương thức chi chỉ lọc đã hoàn. Xác minh muộn có thể làm thay đổi kỳ cũ khi tải lại.</p>
      {data.dataQuality !== 'COMPLETE' && <div role="alert"><strong>Dữ liệu {data.dataQuality}</strong>
        <p>{data.invalidRecordCount} bản ghi cần đối chiếu: {data.warningCodes.join(', ')}</p>
        <p>Phần đã biết (PARTIAL), chưa phải tổng đầy đủ: Thu {money(data.knownTotals.grossReceipts)};
          đã hoàn {money(data.knownTotals.refundPaid)}; thu trừ hoàn {money(data.knownTotals.netCash)}.</p></div>}
      <dl className="info-grid" aria-label="KPI dòng tiền"><dt>Thu</dt><dd>{money(data.totals.grossReceipts)}</dd>
        <dt>Đã hoàn</dt><dd>{money(data.totals.refundPaid)}</dd><dt>Thu trừ hoàn</dt><dd>{money(data.totals.netCash)}</dd></dl>
      <h3>Theo loại dịch vụ</h3><table aria-label="Theo loại dịch vụ"><thead><tr><th>Loại</th><th>Thu</th><th>Đã hoàn</th><th>Thu trừ hoàn</th></tr></thead>
        <tbody>{Object.entries(data.byKind).map(([kind, metrics]) => <tr key={kind}><th>{kind}</th><MoneyCells metrics={metrics} /></tr>)}</tbody></table>
      <h3>Theo ngày Việt Nam</h3><table aria-label="Theo ngày"><thead><tr><th>Ngày</th><th>Thu</th><th>Đã hoàn</th><th>Thu trừ hoàn</th></tr></thead>
        <tbody>{data.byDate.map(row => <tr key={row.date}><th>{row.date}{!row.isComplete && ' (chưa kết thúc)'}</th><MoneyCells metrics={row} /></tr>)}</tbody></table>
      <h3>Theo phương thức thực tế</h3><table aria-label="Theo phương thức"><thead><tr><th>Phương thức</th><th>Thu</th><th>Đã hoàn</th></tr></thead>
        <tbody>{(['CASH', 'TRANSFER', 'UNKNOWN'] as const).map(method => <tr key={method}><th>{method}</th>
          <td>{money(data.byMethod.receipts[method].totals.grossReceipts)}</td><td>{money(data.byMethod.refunds[method].totals.refundPaid)}</td></tr>)}</tbody></table>
      <section aria-label="Còn phải hoàn hiện tại"><h3>Còn phải hoàn hiện tại</h3>
        <p>PENDING/FAILED tại {timestamp(data.currentOutstandingRefunds.observedAt)}, loại {data.currentOutstandingRefunds.kind}.
          Không áp dụng kỳ ngày hoặc phương thức thu/chi; không phải số dư cuối kỳ quá khứ.</p>
        <p>{money(data.currentOutstandingRefunds.outstandingRefundAmount)} / {data.currentOutstandingRefunds.count ?? 'Không xác định'} nghĩa vụ.</p>
        {data.currentOutstandingRefunds.dataQuality !== 'COMPLETE' && <p>Phần đã biết (PARTIAL): {money(data.currentOutstandingRefunds.knownAmount)} / {data.currentOutstandingRefunds.knownCount} nghĩa vụ.</p>}
      </section>
      <h3>Sự kiện nguồn</h3><p>Bộ lọc bảng: {data.eventFilter.eventType}; {data.eventFilter.q || 'không tìm kiếm'}.</p>
      {!data.items.length ? <p>Không có sự kiện phù hợp.</p> : <table aria-label="Sự kiện nguồn"><thead><tr><th>Loại</th><th>Ngày thực tế (VN)</th><th>Số tiền</th><th>Nguồn</th><th>Chi tiết</th></tr></thead>
        <tbody>{data.items.map(event => <tr key={event.eventId}><td>{event.eventType === 'RECEIPT' ? 'Thu' : 'Hoàn'} / {event.kind} / {event.method}</td>
          <td>{timestamp(event.occurredAt)}</td><td>{money(event.amount)}</td><td>{event.transactionCode ?? event.eventId}{event.lateReceipt && ' (thu muộn đơn hủy)'}</td>
          <td><button onClick={() => setSelected(event)}>Xem nguồn {event.eventId}</button></td></tr>)}</tbody></table>}
      <div className="pagination"><span>{data.total} sự kiện; trang {data.totalPages ? data.page : 0}/{data.totalPages}</span>
        <button disabled={data.page <= 1} onClick={() => paginate(data.page - 1)}>Trang trước</button>
        <button disabled={data.page >= data.totalPages} onClick={() => paginate(data.page + 1)}>Trang sau</button></div>
    </>}
    {detailLoading && <p role="status">Đang tải nguồn...</p>}{detailError && <p role="alert">{detailError}</p>}
    {detail && <section aria-label="Chi tiết nguồn"><h3>Chi tiết {detail.event.eventId}</h3>
      <p>Request chi tiết có snapshot riêng, observedAt: {timestamp(detail.observedAt)}.</p>
      <p>{detail.event.status}; {detail.event.kind}; {detail.event.method}; {money(detail.event.amount)}; {timestamp(detail.event.occurredAt)}.</p>
      {detail.event.lateReceipt && <p>Khoản thu muộn của đơn hủy.</p>}
      <dl><dt>Payment</dt><dd>{detail.event.paymentId ?? 'Không có'}</dd><dt>Refund</dt><dd>{detail.event.refundId ?? 'Không có'}</dd>
        <dt>Giao dịch</dt><dd>{detail.event.transactionCode} ({detail.event.transactionId})</dd>
        <dt>Đơn hàng</dt><dd>{detail.event.orderCode} ({detail.event.orderId ?? 'Không có'})</dd>
        <dt>Phiếu trả</dt><dd>{detail.event.returnId ?? 'Không có'}</dd><dt>Chứng từ</dt>
        <dd>{detail.event.invoiceCode ?? detail.event.invoiceId ?? 'Không có hóa đơn'}</dd></dl>
      {!!detail.event.warningCodes.length && <p role="alert">Nguồn cần đối chiếu: {detail.event.warningCodes.join(', ')}</p>}
    </section>}
  </>;
}
