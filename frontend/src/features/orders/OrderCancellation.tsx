import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiClient, ApiError } from '../../api/client';
import { cancellationApi, type CancelResult, type LateReceiptResult, type OrderCommand } from './order-cancellation.api';
import { orderMoney } from './orders.api';

type Target = { id: string; status: string; version: number; total: string | null; transactionStatus: string | null; reservationState: string; refunds: { id: string; status: string; amount: string }[] };
function recover(storageKey: string, own: boolean): OrderCommand | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as OrderCommand | null;
    if (!value || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value.key) || !value.body) return null;
    if (own ? value.operation !== 'ORDER_CANCEL_OWN' : !['ORDER_CANCEL_SUPPORT', 'RETAIL_LATE_RECEIPT'].includes(value.operation)) return null;
    return value;
  } catch { return null; }
}
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : 'Không thực hiện được yêu cầu';
// allowed (US-42): cờ cancelAllowed của server; không truyền thì giữ điều kiện cũ (PENDING/CONFIRMED và còn giữ hàng).
export function OrderCancellation({ order, own = false, disabled = false, allowed, onLockedChange, onChanged }: {
  order: Target; own?: boolean; disabled?: boolean; allowed?: boolean; onLockedChange: (locked: boolean) => void; onChanged: () => Promise<void>;
}) {
  const showCancelForm = allowed ?? (['PENDING', 'CONFIRMED'].includes(order.status) && order.reservationState === 'HELD');
  const storageKey = `order-cancel:${apiClient.getSnapshot().user?.id ?? 'session'}:${order.id}:${own ? 'own' : 'support'}`;
  const [command, setCommand] = useState<OrderCommand | null>(() => recover(storageKey, own));
  const [reason, setReason] = useState(''), [checked, setChecked] = useState(false), [pending, setPending] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [denied, setDenied] = useState(false);
  const [receipt, setReceipt] = useState({ amount: order.total ?? '', evidenceNote: '', receivingAccountCode: '', bankReference: '', receivedAt: '' });
  const busy = useRef(false);
  useEffect(() => { onLockedChange(Boolean(command) || pending); }, [command, pending, onLockedChange]);
  function keep(value: OrderCommand | null) {
    setCommand(value);
    try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); }
    catch { setNotice('Không lưu được khóa trên trình duyệt. Giữ trang mở để đối soát cùng yêu cầu.'); }
  }
  async function complete(result: CancelResult | LateReceiptResult) {
    if (('id' in result ? result.id : result.orderId) !== order.id) throw new ApiError('Kết quả chưa khớp đơn; giữ khóa để đối soát');
    keep(null); onLockedChange(false); setChecked(false);
    setNotice('refundAmount' in result ? `Đã hủy đơn. Khoản hoàn ${orderMoney(result.refundAmount)} · ${refundLabel(result.refundState)}.` : 'Đã ghi khoản thu muộn và nghĩa vụ chờ hoàn. Đơn vẫn hủy; chưa thực chi hoàn tiền.');
    try { await onChanged(); } catch (cause) { setError(`Đã ghi nhận kết quả; chưa tải lại được đơn. ${messageOf(cause)}`); }
  }
  async function send(next: OrderCommand) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(''); keep(next);
    try { await complete(await cancellationApi.send(order.id, next)); }
    catch (cause) {
      setError(messageOf(cause));
      const unknown = !(cause instanceof ApiError) || !cause.status || cause.status >= 500 || [401, 403].includes(cause.status) || cause.code === 'IDEMPOTENCY_CONFLICT';
      if (!unknown) { keep(null); onLockedChange(false); try { await onChanged(); } catch { /* Keep the original business error visible. */ } }
      if (cause instanceof ApiError && [401, 403].includes(cause.status ?? 0)) setDenied(true);
    } finally { busy.current = false; setPending(false); }
  }
  async function lookup() {
    if (!command || busy.current) return;
    busy.current = true; setPending(true); setError('');
    try { await complete((await cancellationApi.lookup(command)).responseBody); }
    catch (cause) {
      setError(messageOf(cause));
      if (cause instanceof ApiError && [401, 403].includes(cause.status ?? 0)) setDenied(true);
    } finally { busy.current = false; setPending(false); }
  }
  function cancel(event: FormEvent) {
    event.preventDefault();
    if (!checked || disabled || denied || reason.trim().length < 10 || command) return;
    void send({ key: crypto.randomUUID(), operation: own ? 'ORDER_CANCEL_OWN' : 'ORDER_CANCEL_SUPPORT', body: { version: order.version, reason: reason.trim() } });
  }
  function late(event: FormEvent) {
    event.preventDefault();
    if (!checked || disabled || denied || command) return;
    void send({ key: crypto.randomUUID(), operation: 'RETAIL_LATE_RECEIPT', body: { ...receipt, method: 'TRANSFER',
      evidenceNote: receipt.evidenceNote.trim(), bankReference: receipt.bankReference.trim(), receivingAccountCode: receipt.receivingAccountCode.trim(),
      receivedAt: new Date(`${receipt.receivedAt}+07:00`).toISOString() } });
  }
  return <section aria-label="Hủy và đối soát đơn" aria-busy={pending}>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {command ? <><p>Chưa xác định kết quả. Giữ nguyên khóa {command.key}; tra cứu chưa thấy không chứng minh yêu cầu thất bại. Không tạo khoản thu hoặc nghĩa vụ hoàn khác.</p>
      <button type="button" disabled={pending} onClick={() => void lookup()}>Tra cứu kết quả hủy / khoản muộn</button>
      <button type="button" disabled={pending || denied || disabled} onClick={() => void send(command)}>Gửi lại cùng yêu cầu hủy / khoản muộn</button></>
      : <>
        {showCancelForm && <form onSubmit={cancel}>
          <h4>Hủy đơn hàng</h4><p>Giải phóng hàng đang giữ. Khoản đã thu được ghi nghĩa vụ chờ hoàn để đối soát.</p>
          {/* US-42-TC09: đơn đã thu – nói rõ hủy chỉ ghi khoản chờ hoàn, chưa phải tiền đã về. */}
          {order.transactionStatus === 'SETTLED' && <p>Đơn đã thanh toán: sau khi hủy, số tiền được ghi là khoản chờ hoàn, chưa phải tiền đã về tài khoản của bạn.</p>}
          <label>Lý do hủy<textarea required minLength={10} maxLength={500} value={reason} disabled={pending || disabled || denied} onChange={event => setReason(event.target.value)} /></label>
          <label><input type="checkbox" checked={checked} disabled={pending || disabled || denied} onChange={event => setChecked(event.target.checked)} />Tôi xác nhận hủy toàn bộ đơn chưa bàn giao</label>
          <button type="submit" disabled={!checked || reason.trim().length < 10 || pending || disabled || denied}>Xác nhận hủy đơn</button>
        </form>}
        {order.status === 'COMPLETED' && <p>Đơn đã bàn giao; hủy không còn khả dụng. Cần xử lý theo quy trình trả hàng.</p>}
        {!own && order.status === 'CANCELLED' && order.reservationState === 'RELEASED' && order.transactionStatus === 'CANCELLED' && order.refunds.length === 0 && <form onSubmit={late}>
          <h4>Ghi nhận khoản chuyển muộn</h4><p>Chỉ một khoản chuyển đủ tiền, có chứng từ ngân hàng thật. Thời điểm báo có theo giờ Việt Nam, có thể trước lúc hủy. Đơn vẫn hủy và không có chứng từ bán mới.</p>
          <label>Số tiền chuyển<input required pattern="[0-9]{1,12}" value={receipt.amount} onChange={event => setReceipt({ ...receipt, amount: event.target.value })} /></label>
          <label>Mã tài khoản nhận<input required maxLength={40} pattern="[A-Z0-9_-]+" value={receipt.receivingAccountCode} onChange={event => setReceipt({ ...receipt, receivingAccountCode: event.target.value })} /></label>
          <label>Tham chiếu ngân hàng<input required maxLength={100} value={receipt.bankReference} onChange={event => setReceipt({ ...receipt, bankReference: event.target.value })} /></label>
          <label>Thời điểm báo có (Việt Nam)<input type="datetime-local" required value={receipt.receivedAt} onChange={event => setReceipt({ ...receipt, receivedAt: event.target.value })} /></label>
          <label>Căn cứ đối soát<textarea required minLength={10} maxLength={500} value={receipt.evidenceNote} onChange={event => setReceipt({ ...receipt, evidenceNote: event.target.value })} /></label>
          <label><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />Tôi đã đối chiếu chứng từ khoản chuyển thực tế</label>
          <button type="submit" disabled={!checked || pending || disabled || denied}>Ghi khoản muộn và nghĩa vụ chờ hoàn</button>
        </form>}
      </>}
    {!own && <p>Yêu cầu bị từ chối hoặc lỗi mạng không chứng minh chưa nhận tiền. Khoản thiếu, thừa hoặc chuyển lần hai cần đối soát tại quầy; không đổi tham chiếu để vượt lỗi.</p>}
    {pending && <p role="status">Đang xử lý hủy / đối soát…</p>}
  </section>;
}
export const refundLabel = (status: string) => ({ PENDING: 'Chờ hoàn', FAILED: 'Thực chi thất bại, cần đối soát', SUCCEEDED: 'Đã hoàn', NONE: 'Không có nghĩa vụ hoàn' })[status] ?? status;
