import { useEffect, useState } from 'react';
import { cancellationApi, type OwnOrder } from './order-cancellation.api';
import { OrderCancellation, refundLabel } from './OrderCancellation';
import { orderDate, orderMoney, orderStatus, transactionStatus } from './orders.api';

export function MyOrdersPage() {
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0), [data, setData] = useState<Awaited<ReturnType<typeof cancellationApi.ownList>>>();
  const [row, setRow] = useState<OwnOrder | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [locked, setLocked] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0); const start = Date.now(), timer = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(timer);
  }, [row]);
  const expired = Boolean(row && (row.expired || Date.parse(row.asOf) + elapsed >= Date.parse(row.reservationExpiresAt)));
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    cancellationApi.ownList(page, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(cause => { if (!controller.signal.aborted) { setData(undefined); setError(cause instanceof Error ? cause.message : 'Không tải được đơn'); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, revision]);
  async function open(id: string) {
    setError(''); setLoading(true);
    try { setRow(await cancellationApi.ownDetail(id)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không tải được đơn'); }
    finally { setLoading(false); }
  }
  return <section><h2>Đơn hàng của tôi</h2>{error && <p role="alert">{error}</p>}{loading && <p role="status">Đang tải đơn…</p>}
    {row ? <section><h3>{row.code}</h3><p>{orderStatus[row.status]} · {row.transactionStatus ? transactionStatus[row.transactionStatus] : 'Cần đối chiếu'}</p>
      <p>Hạn giữ: {orderDate(row.reservationExpiresAt)} · Giữ hàng: {row.reservationState}</p>
      {expired && row.reservationState === 'HELD' && <p role="alert">Đã hết hạn, chờ hệ thống xử lý hủy. Chưa xác nhận kho đã được giải phóng.</p>}
      {row.items.map(item => <p key={item.id}>{item.name} × {item.quantity} · {orderMoney(item.lineTotal)}</p>)}
      <p>Tổng: {row.total === null ? 'Cần đối chiếu' : orderMoney(row.total)}</p>
      {row.cancelledAt && <p>Đã hủy: {orderDate(row.cancelledAt)} · {row.cancellationReason}</p>}
      {row.refunds.map(refund => <p key={refund.id}>Khoản hoàn: {orderMoney(refund.amount)} · {refundLabel(refund.status)}</p>)}
      <OrderCancellation key={row.id} order={row} own onLockedChange={setLocked} onChanged={async () => { setRow(await cancellationApi.ownDetail(row.id)); setRevision(value => value + 1); }} />
      <button disabled={locked || loading} onClick={() => void open(row.id)}>Tải lại đơn</button>
      <button disabled={locked || loading} onClick={() => setRow(null)}>Về danh sách</button>
    </section> : <>
      {!loading && data?.memberLinked === false && <p>Tài khoản chưa liên kết hồ sơ hội viên.</p>}
      {!loading && data?.items.length === 0 && <p>Chưa có đơn hàng.</p>}
      {data?.items.map(item => <p key={item.id}>{item.code} · {orderStatus[item.status]} <button disabled={loading} onClick={() => void open(item.id)}>Xem {item.code}</button></p>)}
      <button disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>Trang trước</button>
      <span> Trang {page} / {data?.totalPages ?? 0} </span><button disabled={loading || !data || page >= data.totalPages} onClick={() => setPage(value => value + 1)}>Trang sau</button>
      <button disabled={loading} onClick={() => setRevision(value => value + 1)}>Tải lại danh sách</button>
    </>}
  </section>;
}
