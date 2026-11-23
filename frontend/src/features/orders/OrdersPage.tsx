import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { ordersApi, orderDate, orderMoney, orderStatus, transactionStatus, type OrderDetail, type OrderQuery } from './orders.api';
import { OrderFulfillment } from './OrderFulfillment';
import { OrderCancellation } from './OrderCancellation';

const initialQuery: OrderQuery = { channel: 'WEBSITE', status: 'PENDING', transactionStatus: '', q: '', memberId: '', fromDate: '', toDate: '', page: 1, limit: 20 };
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Không thực hiện được yêu cầu';
type Command = { id: string; version: number; key: string };
export function OrdersPage() {
  const [filter, setFilter] = useState(initialQuery), [query, setQuery] = useState(initialQuery), [revision, setRevision] = useState(0);
  const [data, setData] = useState<Awaited<ReturnType<typeof ordersApi.list>>>(), [loading, setLoading] = useState(true), [opening, setOpening] = useState(false);
  const [row, setRow] = useState<OrderDetail | null>(null), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const [checked, setChecked] = useState(false), [pending, setPending] = useState(false), [unknown, setUnknown] = useState(false), [elapsed, setElapsed] = useState(0);
  const [fulfillmentLocked, setFulfillmentLocked] = useState(false);
  const [cancellationLocked, setCancellationLocked] = useState(false);
  const busy = useRef(false), command = useRef<Command | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    ordersApi.list(query, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(failure => { if (!controller.signal.aborted) { setData(undefined); setError(messageOf(failure)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, revision]);
  useEffect(() => {
    setElapsed(0); const start = Date.now(), timer = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(timer);
  }, [row]);
  const expired = Boolean(row && (row.expired || Date.parse(row.asOf) + elapsed >= Date.parse(row.reservationExpiresAt)));
  const awaitingExpiryCancellation = expired && row?.reservationState === 'HELD' && ['PENDING', 'CONFIRMED'].includes(row.status);
  async function open(id: string) {
    if (busy.current || opening || unknown) return;
    setOpening(true); setError(''); setSuccess(''); setChecked(false); setRow(null);
    try { setRow(await ordersApi.detail(id)); } catch (failure) { setError(messageOf(failure)); } finally { setOpening(false); }
  }
  async function refresh(id: string) {
    setRow(null); setChecked(false); setOpening(true); setRevision(value => value + 1);
    try { setRow(await ordersApi.detail(id)); } catch (failure) { setError(messageOf(failure)); } finally { setOpening(false); }
  }
  async function complete(id: string) {
    command.current = null; setUnknown(false); setSuccess('Đã xác nhận chuẩn bị hàng. Thanh toán và bàn giao là các bước riêng.');
    await refresh(id);
  }
  async function send(next: Command) {
    if (busy.current) return; busy.current = true; setPending(true); setError(''); setSuccess('');
    try { const result = await ordersApi.prepare(next.id, next.version, next.key); await complete(result.id); }
    catch (failure) {
      setError(messageOf(failure));
      const unresolved = !(failure instanceof ApiError) || !failure.status || failure.status >= 500;
      setUnknown(unresolved);
      if (!unresolved) {
        command.current = null;
        if (failure.status === 409) await refresh(next.id);
        if (failure.status === 403) { setChecked(false); setRow(current => current ? { ...current, permittedActions: { ...current.permittedActions, prepare: false, prepareBlockedReason: 'FORBIDDEN' } } : null); }
      }
    } finally { busy.current = false; setPending(false); }
  }
  async function lookup() {
    if (busy.current || !command.current) return; busy.current = true; setPending(true); setError('');
    try { const result = await ordersApi.lookup(command.current.key); await complete(result.responseBody.id); }
    catch (failure) { setError(messageOf(failure)); } finally { busy.current = false; setPending(false); }
  }
  function apply(event: FormEvent) { event.preventDefault(); setError(''); setQuery({ ...filter, q: filter.q.trim(), page: 1 }); }
  return <section><h2>Chuẩn bị và bàn giao đơn hàng website</h2><p>Kiểm tra hàng thực tế trước khi xác nhận. Chuẩn bị không xác nhận thu tiền hoặc bàn giao và không gia hạn giữ hàng.</p>
    <p>Hủy hỗ trợ áp dụng cho đơn Website/POS chưa bàn giao. Đơn đã hủy có khoản chuyển được phát hiện muộn cần ghi nhận và đối soát riêng.</p>
    {error && <p role="alert">{error}</p>}{success && <p role="status">{success}</p>}
    {opening && <p role="status">Đang tải chi tiết đơn…</p>}
    {row ? <section aria-label={`Chi tiết ${row.code}`}><h3>{row.code}</h3>
      <p>Trạng thái đơn: <strong>{orderStatus[row.status]}</strong></p><p>Thanh toán: <strong>{row.transactionStatus ? transactionStatus[row.transactionStatus] : 'Cần đối chiếu'}</strong></p>
      <p>Hạn giữ hàng (giờ Việt Nam): {orderDate(row.reservationExpiresAt)}</p><p>Giữ hàng: {row.reservationState} · Phiên bản: {row.version}</p>
      {awaitingExpiryCancellation && <p role="alert">Đã hết hạn giữ hàng, chờ xử lý hủy. Không thể gia hạn, chuẩn bị hoặc bàn giao.</p>}
      <p>Người nhận: {row.recipient.name} · {row.recipient.phone}</p><p>Nhận tại: {row.pickupLocation}</p>
      <table><thead><tr><th>SKU / tên khi đặt</th><th>Số lượng</th><th>Đơn giá</th><th>Thành tiền</th></tr></thead>
        <tbody>{row.items.map(item => <tr key={item.id}><td>{item.skuSnapshot} · {item.nameSnapshot}</td><td>{item.quantity}</td><td>{orderMoney(item.unitPrice)}</td><td>{orderMoney(item.lineTotal)}</td></tr>)}</tbody></table>
      <p>Tổng: {row.total !== null ? orderMoney(row.total) : 'Cần đối chiếu'}</p>
      {row.confirmedAt && <p>Đã chuẩn bị lúc {orderDate(row.confirmedAt)} · Người xác nhận: {row.confirmedBy}</p>}
      {row.invoice && <p>Chứng từ {row.invoice.invoiceNo} · {orderMoney(row.invoice.totalAmount)}</p>}
      {row.refunds.map(refund => <p key={refund.id}>Khoản hoàn: {orderMoney(refund.amount)} · {refund.status === 'PENDING' ? 'Chờ hoàn' : refund.status === 'SUCCEEDED' ? 'Đã hoàn' : 'Hoàn thất bại'}</p>)}
      {row.permittedActions.prepare && !expired && <><label><input type="checkbox" checked={checked} disabled={pending || unknown || cancellationLocked || fulfillmentLocked} onChange={event => setChecked(event.target.checked)} />Tôi đã kiểm tra và chuẩn bị đủ hàng thực tế</label>
        <button type="button" disabled={!checked || pending || unknown || cancellationLocked || fulfillmentLocked} onClick={() => {
          if (busy.current || unknown || cancellationLocked || fulfillmentLocked) return;
          const next = { id: row.id, version: row.version, key: crypto.randomUUID() }; command.current = next; void send(next);
        }}>Xác nhận đã chuẩn bị</button></>}
      {row.permittedActions.prepareBlockedReason === 'ORDER_INTEGRITY_ERROR' && <p role="alert">Dữ liệu đơn cần đối chiếu trước khi thao tác.</p>}
      <fieldset disabled={cancellationLocked || pending || unknown}><OrderFulfillment key={row.id} order={row} expired={expired} onLockedChange={setFulfillmentLocked}
        onConflict={async message => { setError(message); await refresh(row.id); }} onCompleted={async result => {
          setError(''); setSuccess(`Đã bàn giao đủ sản phẩm lúc ${orderDate(result.fulfilledAt)} · Nhân viên: ${result.fulfilledBy}.`); await refresh(result.id);
        }} /></fieldset>
      {/* Hàng nút cuối chi tiết đơn (giống trang của Member): Tải lại đơn, Về danh sách bên trái; Hủy đơn mở cửa sổ nổi, nằm bên phải. */}
      <div className="order-actions">
        <OrderCancellation key={`cancel:${row.id}`} order={row} dialog disabled={pending || unknown || fulfillmentLocked} onLockedChange={setCancellationLocked}
          onChanged={async () => { setRow(await ordersApi.detail(row.id)); setRevision(value => value + 1); }} />
        <button type="button" className="secondary" disabled={pending || unknown || fulfillmentLocked || cancellationLocked} onClick={() => void open(row.id)}>Tải lại đơn</button>
        <button type="button" className="secondary" disabled={pending || unknown || fulfillmentLocked || cancellationLocked} onClick={() => { setRow(null); setChecked(false); setError(''); }}>Về danh sách</button>
      </div>
    </section> : !opening && <><form onSubmit={apply}>
      <label>Mã đơn<input value={filter.q} maxLength={120} onChange={event => setFilter({ ...filter, q: event.target.value })} /></label>
      <label>Kênh<select value={filter.channel} onChange={event => setFilter({ ...filter, channel: event.target.value })}><option value="WEBSITE">Website</option><option value="POS">Tại quầy</option><option value="">Tất cả</option></select></label>
      <label>Trạng thái đơn<select value={filter.status} onChange={event => setFilter({ ...filter, status: event.target.value })}><option value="">Tất cả</option>{Object.entries(orderStatus).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Thanh toán<select value={filter.transactionStatus} onChange={event => setFilter({ ...filter, transactionStatus: event.target.value })}><option value="">Tất cả</option>{Object.entries(transactionStatus).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>ID hội viên<input value={filter.memberId} onChange={event => setFilter({ ...filter, memberId: event.target.value })} /></label>
      <label>Từ ngày<input type="date" value={filter.fromDate} onChange={event => setFilter({ ...filter, fromDate: event.target.value })} /></label>
      <label>Đến ngày<input type="date" value={filter.toDate} onChange={event => setFilter({ ...filter, toDate: event.target.value })} /></label>
      <p>Ngày Việt Nam; để trống dùng 30 ngày gần nhất, tối đa 366 ngày.</p><button disabled={pending || unknown || cancellationLocked || fulfillmentLocked} type="submit">Lọc đơn</button>
      <button type="button" disabled={loading || pending || unknown} onClick={() => { setError(''); setRevision(value => value + 1); }}>Tải lại danh sách</button></form>
      {loading && <p role="status">Đang tải đơn…</p>}{!loading && data?.items.length === 0 && <p>Không có đơn phù hợp.</p>}
      {!loading && Boolean(data?.items.length) && <table><thead><tr><th>Hàng / mã đơn</th><th>Chuẩn bị / bàn giao</th><th>Thanh toán</th><th>Hạn giữ</th><th>Thao tác</th></tr></thead><tbody>
        {data?.items.map(item => <tr key={item.id}>
          {/* Tên hàng làm dòng chính, mã đơn chữ nhỏ bên dưới (giống danh sách của Member). Server cũ chưa có itemsSummary thì chỉ hiện mã. */}
          <td><strong>{item.itemsSummary || item.code}</strong>{item.itemsSummary && <><br /><small className="order-row-meta">{item.code}</small></>}</td><td>{orderStatus[item.status]}{item.expired && item.reservationState === 'HELD' && ['PENDING', 'CONFIRMED'].includes(item.status) && ' · Hết hạn, chờ xử lý hủy'}</td><td>{item.transactionStatus ? transactionStatus[item.transactionStatus] : 'Cần đối chiếu'}</td>
          <td>{orderDate(item.reservationExpiresAt)}</td><td><button type="button" disabled={pending || unknown || cancellationLocked || fulfillmentLocked} aria-label={`Mở ${item.code}`} className="secondary" onClick={() => void open(item.id)}>Xem chi tiết</button></td></tr>)}</tbody></table>}
      <div className="pagination"><button disabled={loading || query.page <= 1 || pending || unknown} onClick={() => setQuery({ ...query, page: query.page - 1 })}>Trang trước</button>
        <span>Trang {query.page} / {data?.totalPages ?? 0} · {data?.total ?? 0} đơn</span><button disabled={loading || !data || query.page >= data.totalPages || pending || unknown} onClick={() => setQuery({ ...query, page: query.page + 1 })}>Trang sau</button></div>
    </>}
    {pending && <p role="status">Đang xử lý yêu cầu…</p>}
    {unknown && <section><p>Chưa xác định kết quả. Giữ nguyên khóa {command.current?.key}; tra cứu chưa thấy không chứng minh thao tác thất bại.</p>
      <button type="button" disabled={pending} onClick={() => void lookup()}>Tra cứu kết quả</button>
      <button type="button" disabled={pending} onClick={() => command.current && void send(command.current)}>Gửi lại cùng yêu cầu</button></section>}
  </section>;
}
