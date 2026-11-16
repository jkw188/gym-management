import { useEffect, useRef, useState } from 'react';
import { apiClient, ApiError } from '../../api/client';
import { membersApi, type MemberListItem } from '../members/members.api';
import { OrderCancellation } from '../orders/OrderCancellation';
import { OrderFulfillment } from '../orders/OrderFulfillment';
import { ordersApi, orderDate, orderMoney, type OrderDetail } from '../orders/orders.api';
import { InvoiceDetails } from '../payments/InvoiceDetails';
import { PaymentReviewForm } from '../payments/PaymentReviewForm';
import { paymentsApi } from '../payments/payments.api';
import { posApi, type PosCreated, type PosInput, type PosProduct, type PosQuote } from './pos.api';

type Recovery = { key: string } | { orderId: string };
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Không thể kết nối máy chủ';
function recover(storageKey: string): Recovery | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Recovery | null;
    if (value && ('orderId' in value && /^[a-f\d]{24}$/i.test(value.orderId) || 'key' in value && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value.key))) return value;
  } catch { /* Keep the screen usable when storage is unavailable. */ }
  return null;
}
export function PosPage() {
  const storageKey = `pos:${apiClient.getSnapshot().user?.id ?? 'session'}`;
  const [recovery, setRecovery] = useState(() => recover(storageKey));
  const [order, setOrder] = useState<OrderDetail | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false), [denied, setDenied] = useState(false);
  const [q, setQ] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(1), [reload, setReload] = useState(0);
  const [products, setProducts] = useState<Awaited<ReturnType<typeof posApi.products>>>(), [loading, setLoading] = useState(true);
  const [lines, setLines] = useState<{ product: PosProduct; quantity: number }[]>([]);
  const [buyerType, setBuyerType] = useState('ANONYMOUS'), [buyerName, setBuyerName] = useState(''), [phone, setPhone] = useState('');
  const [memberQuery, setMemberQuery] = useState(''), [members, setMembers] = useState<MemberListItem[]>([]), [member, setMember] = useState<MemberListItem | null>(null);
  const [method, setMethod] = useState<'CASH' | 'TRANSFER'>('CASH'), [quote, setQuote] = useState<PosQuote | null>(null);
  const [paymentLocked, setPaymentLocked] = useState(false), [fulfillLocked, setFulfillLocked] = useState(false), [cancelLocked, setCancelLocked] = useState(false);
  const [payment, setPayment] = useState<Awaited<ReturnType<typeof paymentsApi.detail>> | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const busy = useRef(false), command = useRef<(PosInput & { quoteToken: string }) | null>(null);
  const locked = pending || Boolean(recovery && 'key' in recovery) || paymentLocked || fulfillLocked || cancelLocked;
  const expired = Boolean(order && (order.expired || Date.parse(order.asOf) + elapsed >= Date.parse(order.reservationExpiresAt)));
  useEffect(() => {
    setElapsed(0); const start = Date.now(), timer = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(timer);
  }, [order]);
  function keep(value: Recovery | null) {
    setRecovery(value);
    try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); }
    catch { setNotice('Không lưu được khóa trên trình duyệt. Giữ trang mở để tra cứu cùng yêu cầu.'); }
  }
  function report(cause: unknown) {
    setError(message(cause));
    if (cause instanceof ApiError && [401, 403].includes(cause.status ?? 0)) setDenied(true);
  }
  async function loadOrder(id: string) {
    const row = await ordersApi.detail(id); setOrder(row); setPayment(null);
    if (row.transactionStatus === 'PENDING' && !row.expired && row.status === 'CONFIRMED') setPayment(await paymentsApi.detail(row.transactionId));
  }
  useEffect(() => {
    if (recovery && 'orderId' in recovery) void loadOrder(recovery.orderId).catch(report);
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    posApi.products(search, page, controller.signal).then(value => { if (!controller.signal.aborted) setProducts(value); })
      .catch(cause => { if (!controller.signal.aborted) { setProducts(undefined); report(cause); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [search, page, reload]);
  const input: PosInput = { ...(buyerType === 'MEMBER' ? { memberId: member?.id } : {
    ...(buyerName.trim() ? { buyerName: buyerName.trim() } : {}), ...(phone.trim() ? { recipientPhone: phone.trim() } : {}) }),
    preferredPaymentMethod: method, items: lines.map(line => ({ productId: line.product.id, quantity: line.quantity })) };
  async function preview() {
    if (busy.current || locked || denied) return;
    busy.current = true; setPending(true); setError(''); setQuote(null);
    try { setQuote(await posApi.preview(input)); } catch (cause) { report(cause); } finally { busy.current = false; setPending(false); }
  }
  async function complete(result: PosCreated) {
    if (result.channel !== 'POS' || !result.id) throw new ApiError('Kết quả không khớp đơn POS; giữ khóa để đối soát');
    keep({ orderId: result.id }); command.current = null; setQuote(null); setLines([]);
    setNotice('Đã lập POS. Thanh toán và bàn giao được xác nhận riêng.');
    try { await loadOrder(result.id); } catch (cause) { report(cause); }
  }
  async function send(key: string) {
    if (busy.current || !command.current || denied) return;
    busy.current = true; setPending(true); setError(''); keep({ key });
    try { await complete(await posApi.create(command.current, key)); }
    catch (cause) {
      report(cause);
      const unresolved = !(cause instanceof ApiError) || !cause.status || cause.status >= 500 || [401, 403].includes(cause.status) || cause.code === 'IDEMPOTENCY_CONFLICT';
      if (!unresolved) { keep(null); command.current = null; setQuote(null); setReload(value => value + 1); }
    } finally { busy.current = false; setPending(false); }
  }
  async function lookup() {
    if (busy.current || !recovery || !('key' in recovery)) return;
    busy.current = true; setPending(true); setError('');
    try { await complete((await posApi.lookup(recovery.key)).responseBody); } catch (cause) { report(cause); } finally { busy.current = false; setPending(false); }
  }
  async function findMembers() {
    if (busy.current) return;
    busy.current = true; setPending(true); setError('');
    try { setMembers((await membersApi.list({ q: memberQuery.trim(), limit: 20 })).items); }
    catch (cause) { report(cause); } finally { busy.current = false; setPending(false); }
  }
  return <section><h2>Bán sản phẩm tại quầy</h2><p>Lập đơn giữ hàng → Đối soát thu tiền → Bàn giao đủ sản phẩm.</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{pending && <p role="status">Đang xử lý…</p>}
    {recovery && 'key' in recovery ? <section><p>Chưa xác định kết quả lập POS. Khóa: {recovery.key}. Tra cứu chưa thấy không chứng minh thất bại; giữ nguyên ý định, không tạo đơn mới.</p>
      <button disabled={pending} onClick={() => void lookup()}>Tra cứu kết quả lập POS</button>
      {command.current && <button disabled={pending || denied} onClick={() => void send(recovery.key)}>Gửi lại cùng yêu cầu lập POS</button>}
    </section> : order ? <section aria-label="Đơn POS hiện tại"><h3>{order.code}</h3>
      <p>Đã lập POS · {order.status === 'COMPLETED' ? 'Đã bàn giao' : order.status === 'CANCELLED' ? 'Đã hủy' : 'Chưa bàn giao'}</p>
      <p>{order.transactionStatus === 'SETTLED' ? 'Đã thanh toán' : 'Chưa xác nhận thanh toán'} · {orderMoney(order.total ?? '0')}</p>
      <p>Người mua: {order.recipient.name} {order.recipient.phone} · Quầy: {order.pickupLocation}</p>
      <p>Hạn giữ: {orderDate(order.reservationExpiresAt)} {expired && '· Đã hết hạn'}</p>
      {order.items.map(line => <p key={line.id}>{line.skuSnapshot} · {line.nameSnapshot} · {line.quantity} × {orderMoney(line.unitPrice)} = {orderMoney(line.lineTotal)}</p>)}
      {order.invoice && <InvoiceDetails id={order.invoice.id} />}
      {payment && <fieldset disabled={denied || expired || fulfillLocked || cancelLocked}><PaymentReviewForm key={order.transactionId} transaction={payment.transaction}
        onLockedChange={setPaymentLocked} onRefresh={() => { void loadOrder(order.id).catch(report); }} onSettled={() => { setPaymentLocked(false); void loadOrder(order.id).catch(report); }} /></fieldset>}
      <fieldset disabled={denied || paymentLocked || cancelLocked}><OrderFulfillment order={order} expired={expired} onLockedChange={setFulfillLocked}
        onConflict={async text => { setError(text); await loadOrder(order.id); }} onCompleted={async () => { setNotice('Đã bàn giao đủ sản phẩm.'); await loadOrder(order.id); }} /></fieldset>
      <OrderCancellation order={order} disabled={denied || paymentLocked || fulfillLocked} onLockedChange={setCancelLocked} onChanged={() => loadOrder(order.id)} />
      <button disabled={locked} onClick={() => void loadOrder(order.id).catch(report)}>Tải lại đơn POS</button>
      <button disabled={locked || denied} onClick={() => { keep(null); setOrder(null); setPayment(null); setQuote(null); setNotice(''); setReload(value => value + 1); }}>Lập đơn POS mới</button>
    </section> : recovery && 'orderId' in recovery ? <button onClick={() => void loadOrder(recovery.orderId).catch(report)}>Tải lại đơn POS đã lập</button> : <>
      <fieldset disabled={locked || denied}><legend>1. Khách mua và sản phẩm</legend>
        <label>Loại khách<select value={buyerType} onChange={event => { setBuyerType(event.target.value); setQuote(null); setMember(null); }}><option value="ANONYMOUS">Khách lẻ</option><option value="MEMBER">Hội viên đã tồn tại</option></select></label>
        {buyerType === 'ANONYMOUS' ? <><label>Tên khách (tùy chọn)<input value={buyerName} maxLength={120} onChange={event => { setBuyerName(event.target.value); setQuote(null); }} /></label>
          <label>Điện thoại (tùy chọn)<input value={phone} onChange={event => { setPhone(event.target.value); setQuote(null); }} /></label></> : <>
          <label>Tra hội viên<input value={memberQuery} onChange={event => setMemberQuery(event.target.value)} /></label><button onClick={() => void findMembers()}>Tìm hội viên</button>
          {members.map(item => <button key={item.id} onClick={() => { setMember(item); setQuote(null); }}>{item.memberCode} · {item.fullName} · {item.phone}</button>)}
          {member && <p>Đã đối chiếu chọn: {member.memberCode} · {member.fullName} · {member.phone}</p>}</>}
        <label>Phương thức dự kiến<select value={method} onChange={event => { setMethod(event.target.value as 'CASH' | 'TRANSFER'); setQuote(null); }}><option value="CASH">Tiền mặt</option><option value="TRANSFER">Chuyển khoản</option></select></label>
        <form onSubmit={event => { event.preventDefault(); setSearch(q.trim()); setPage(1); setReload(value => value + 1); }}><label>Tìm sản phẩm<input value={q} onChange={event => setQ(event.target.value)} /></label><button>Tìm sản phẩm</button></form>
        {loading ? <p role="status">Đang tải sản phẩm…</p> : !products?.items.length ? <p>Không có sản phẩm đang bán phù hợp.</p> : products.items.map(product => <p key={product.id}>{product.sku} · {product.name} · {orderMoney(product.price)} · Khả dụng {product.available}{' '}
          <button disabled={product.available <= (lines.find(line => line.product.id === product.id)?.quantity ?? 0) || (lines.find(line => line.product.id === product.id)?.quantity ?? 0) >= 999 || lines.length >= 100 && !lines.some(line => line.product.id === product.id)} onClick={() => {
            setQuote(null); setLines(current => current.some(line => line.product.id === product.id) ? current.map(line => line.product.id === product.id ? { product, quantity: line.quantity + 1 } : line) : [...current, { product, quantity: 1 }]);
          }}>Thêm {product.sku}</button></p>)}
        <button disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>Trang sản phẩm trước</button><span> Trang {page}/{products?.totalPages ?? 0} </span><button disabled={loading || !products || page >= products.totalPages} onClick={() => setPage(value => value + 1)}>Trang sản phẩm sau</button>
        {lines.map(line => <p key={line.product.id}>{line.product.sku} · {line.product.name}<label>Số lượng {line.product.sku}<input type="number" min={1} max={Math.min(999, line.product.available)} value={line.quantity} onChange={event => {
          const quantity = Number(event.target.value); setQuote(null); setLines(current => current.map(item => item.product.id === line.product.id ? { ...item, quantity } : item));
        }} /></label><button onClick={() => { setQuote(null); setLines(current => current.filter(item => item.product.id !== line.product.id)); }}>Bỏ {line.product.sku}</button></p>)}
        <button disabled={!lines.length || lines.some(line => !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > Math.min(999, line.product.available)) || buyerType === 'MEMBER' && !member} onClick={() => void preview()}>Xem báo giá POS</button>
      </fieldset>
      {quote && <section aria-label="Báo giá POS"><h3>Xác nhận giá trước khi lập đơn</h3><p>{quote.buyer.name} · {quote.buyer.phone} · {quote.pickupLocation}</p>
        {quote.items.map(line => <p key={line.productId}>{line.sku} · {line.name} · {line.quantity} × {orderMoney(line.unitPrice)} = {orderMoney(line.lineTotal)}</p>)}
        <p>Tổng từ máy chủ: <strong>{orderMoney(quote.total)}</strong></p><p>Báo giá đến {orderDate(quote.quoteExpiresAt)}. Giữ hàng 24 giờ tính từ lúc tạo đơn.</p>
        <button disabled={locked || denied} onClick={() => { if (!busy.current) { command.current = { ...input, quoteToken: quote.quoteToken }; void send(crypto.randomUUID()); } }}>Xác nhận lập POS</button>
      </section>}
    </>}
  </section>;
}
