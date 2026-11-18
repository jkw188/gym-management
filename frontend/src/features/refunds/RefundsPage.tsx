import { apiClient } from '../../api/client';
import { RefundPayout } from './RefundPayout';
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { refundsApi, type RefundDetail, type RefundQuery } from './refunds.api';
import { orderDate, orderMoney } from '../orders/orders.api';
import { refundLabel } from '../orders/OrderCancellation';

const initial: RefundQuery = { status: 'PENDING', orderId: '', fromDate: '', toDate: '', page: 1, limit: 20 };
export function RefundsPage() {
  const auth = useSyncExternalStore(apiClient.subscribe, apiClient.getSnapshot);
  return <RefundsWorkspace key={auth.user?.id ?? 'session'} />;
}
function RefundsWorkspace() {
  const [filter, setFilter] = useState(initial), [query, setQuery] = useState(initial), [revision, setRevision] = useState(0);
  const [data, setData] = useState<Awaited<ReturnType<typeof refundsApi.list>>>(), [row, setRow] = useState<RefundDetail | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    refundsApi.list(query, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(cause => { if (!controller.signal.aborted) { setData(undefined); setError(cause instanceof Error ? cause.message : 'Không tải được nghĩa vụ'); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, revision]);
  async function open(id: string) { setLoading(true); setError(''); try { setRow(await refundsApi.detail(id)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không tải được nghĩa vụ'); } finally { setLoading(false); } }
  function apply(event: FormEvent) { event.preventDefault(); setQuery({ ...filter, page: 1 }); }
  return <section><h2>Nghĩa vụ hoàn tiền</h2><p>Chờ hoàn là nghĩa vụ cần đối soát, chưa phải thực chi. RF là mã nội bộ chống lặp, không phải mã chuyển tiền ngân hàng.</p>
    {error && <p role="alert">{error}</p>}{loading && <p role="status">Đang tải nghĩa vụ…</p>}
    {row ? <section><h3>{row.reference}</h3><p>{orderMoney(row.amount)} · {refundLabel(row.status)}</p><p>Nguồn: {row.source} · Đơn: {row.orderCode ?? row.orderId}</p>
      <p>Lý do hủy: {row.cancellationReason ?? '—'}</p><p>Tạo lúc: {orderDate(row.createdAt)} · Tác nhân: {row.actorType} {row.createdBy}</p>
      {row.refundedAt && <p>Thực chi lúc: {orderDate(row.refundedAt)}</p>}
      {row.payment && <><p>Khoản thu {row.payment.id} · {orderMoney(row.payment.amount)} · {row.payment.method} · {row.payment.receiptPurpose}</p>
        <p>Tham chiếu đối soát khoản thu: {row.payment.reference}</p><p>Báo có: {row.payment.paidAt ? orderDate(row.payment.paidAt) : '—'} · Xác minh: {row.payment.verifiedAt ? orderDate(row.payment.verifiedAt) : '—'}</p>
        <p>Căn cứ: {row.payment.evidenceNote ?? '—'}</p></>}
      <p>Nghĩa vụ: {orderMoney(row.refundAmount ?? row.amount)} · Đã hoàn tiền: {orderMoney(row.refundedAmount ?? (row.status === 'SUCCEEDED' ? row.amount : '0'))} · Còn phải hoàn: {orderMoney(row.outstandingRefundAmount ?? (row.status === 'SUCCEEDED' ? '0' : row.amount))}</p>
      <RefundPayout key={row.id} refund={row} onChanged={async () => { setRow(await refundsApi.detail(row.id)); setRevision(value => value + 1); }} />
      <button disabled={loading} onClick={() => setRow(null)}>Về hàng đợi</button>
    </section> : <><form onSubmit={apply}>
      <label>Trạng thái<select value={filter.status} onChange={event => setFilter({ ...filter, status: event.target.value })}><option value="">Tất cả</option>{['PENDING', 'FAILED', 'SUCCEEDED'].map(value => <option key={value} value={value}>{refundLabel(value)}</option>)}</select></label>
      <label>ID đơn<input value={filter.orderId} onChange={event => setFilter({ ...filter, orderId: event.target.value })} /></label>
      <label>Từ ngày<input type="date" value={filter.fromDate} onChange={event => setFilter({ ...filter, fromDate: event.target.value })} /></label>
      <label>Đến ngày<input type="date" value={filter.toDate} onChange={event => setFilter({ ...filter, toDate: event.target.value })} /></label>
      <p>Lọc ngày tạo theo giờ Việt Nam; mặc định 30 ngày, tối đa 366 ngày.</p><button disabled={loading}>Lọc nghĩa vụ</button>
      <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>Tải lại</button>
    </form>
      {!loading && data?.items.length === 0 && <p>Không có nghĩa vụ phù hợp.</p>}
      {!loading && Boolean(data?.items.length) && <table><thead><tr><th>Mã nội bộ / nguồn</th><th>Đơn</th><th>Số tiền</th><th>Trạng thái</th><th>Ngày tạo</th><th>Chi tiết</th></tr></thead><tbody>
        {data?.items.map(item => <tr key={item.id}><td>{item.reference} · {item.source}</td><td>{item.orderId}</td><td>{orderMoney(item.amount)}</td><td>{refundLabel(item.status)}</td><td>{orderDate(item.createdAt)}</td><td><button disabled={loading} onClick={() => void open(item.id)}>Xem {item.reference}</button></td></tr>)}
      </tbody></table>}
      <button disabled={loading || query.page <= 1} onClick={() => setQuery({ ...query, page: query.page - 1 })}>Trang trước</button><span> Trang {query.page} / {data?.totalPages ?? 0} · {data?.total ?? 0} nghĩa vụ </span>
      <button disabled={loading || !data || query.page >= data.totalPages} onClick={() => setQuery({ ...query, page: query.page + 1 })}>Trang sau</button>
    </>}
  </section>;
}
