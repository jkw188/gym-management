import { useEffect, useRef, useState } from 'react';
import { apiClient, ApiError } from '../../api/client';
import { ordersApi, orderDate, orderStatus, type FulfilledOrder, type OrderDetail } from './orders.api';

interface Command { key: string; version: number }
function recover(storageKey: string): Command | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Command | null;
    return value && typeof value.key === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.key) &&
      Number.isInteger(value.version) && value.version >= 0 && value.version <= 2147483647 ? { key: value.key, version: value.version } : null;
  } catch { return null; }
}
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : 'Không thực hiện được bàn giao';

export function OrderFulfillment({ order, expired, onLockedChange, onCompleted, onConflict }: {
  order: OrderDetail; expired: boolean; onLockedChange: (locked: boolean) => void;
  onCompleted: (result: FulfilledOrder) => Promise<void>; onConflict: (message: string) => Promise<void>;
}) {
  const storageKey = `order-fulfill:${apiClient.getSnapshot().user?.id ?? 'session'}:${order.id}`;
  const [command, setCommand] = useState<Command | null>(() => recover(storageKey));
  const [checked, setChecked] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [denied, setDenied] = useState(false), [observed, setObserved] = useState<OrderDetail | null>(null), [notice, setNotice] = useState('');
  const busy = useRef(false);
  useEffect(() => { onLockedChange(Boolean(command) || pending); }, [command, pending, onLockedChange]);
  useEffect(() => { setChecked(false); }, [order.version, order.status]);
  function keep(next: Command | null) {
    setCommand(next);
    try { if (next) sessionStorage.setItem(storageKey, JSON.stringify(next)); else sessionStorage.removeItem(storageKey); }
    catch { if (next) setNotice('Trình duyệt không lưu được yêu cầu. Giữ trang này mở và giữ nguyên khóa để đối chiếu.'); }
  }
  async function complete(result: FulfilledOrder) {
    if (result.id !== order.id || result.status !== 'COMPLETED' || result.reservationState !== 'CONSUMED') throw new ApiError('Kết quả chưa khớp đơn. Giữ nguyên khóa để đối chiếu.');
    keep(null); onLockedChange(false); await onCompleted(result);
  }
  async function send(next: Command) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(''); keep(next);
    try { await complete(await ordersApi.fulfill(order.id, next.version, next.key)); }
    catch (cause) {
      setError(messageOf(cause));
      // Auth changes or fingerprint conflicts cannot establish the outcome of an earlier request.
      const unresolved = !(cause instanceof ApiError) || !cause.status || cause.status >= 500 || [401, 403].includes(cause.status) || cause.code === 'IDEMPOTENCY_CONFLICT';
      if (!unresolved) { keep(null); setChecked(false); if (cause.status === 409) { setError(''); onLockedChange(false); await onConflict(messageOf(cause)); } }
      if (cause instanceof ApiError && [401, 403].includes(cause.status ?? 0)) setDenied(true);
    } finally { busy.current = false; setPending(false); }
  }
  async function lookup() {
    if (busy.current || !command) return;
    busy.current = true; setPending(true); setError('');
    try { await complete((await ordersApi.lookupFulfillment(command.key)).responseBody); }
    catch (cause) { setError(messageOf(cause)); } finally { busy.current = false; setPending(false); }
  }
  async function inspect() {
    if (busy.current) return;
    busy.current = true; setPending(true); setError('');
    try { setObserved(await ordersApi.detail(order.id)); }
    catch (cause) { setError(messageOf(cause)); } finally { busy.current = false; setPending(false); }
  }
  return <section aria-label="Bàn giao đơn website" aria-busy={pending}>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {order.fulfilledAt && <p>Đã bàn giao lúc {orderDate(order.fulfilledAt)} · Nhân viên: {order.fulfilledBy}</p>}
    {order.status === 'COMPLETED' && <p>Đơn đã hoàn tất. Trả hàng cần quy trình riêng; hiện chưa hỗ trợ hủy hoặc mở lại bàn giao.</p>}
    {command ? <><p>Chưa xác định kết quả bàn giao. Không giao lại sản phẩm vì mất phản hồi; cần tra cứu và xác minh thực tế tại quầy.</p>
      <p>Khóa tra cứu: {command.key} · Phiên bản đã gửi: {command.version}</p>
      <button type="button" disabled={pending} onClick={() => void lookup()}>Tra cứu kết quả bàn giao</button>
      <button type="button" disabled={pending || denied} onClick={() => void send(command)}>Gửi lại cùng yêu cầu bàn giao</button>
      <button type="button" disabled={pending} onClick={() => void inspect()}>Kiểm tra trạng thái đơn</button>
      {observed && <p>Trạng thái hiện tại: {orderStatus[observed.status]}{observed.fulfilledAt && ` · Bàn giao lúc ${orderDate(observed.fulfilledAt)} · Nhân viên ${observed.fulfilledBy}`}. Vẫn giữ khóa để đối chiếu kết quả yêu cầu.</p>}
    </> : order.channel === 'WEBSITE' && order.permittedActions.fulfill && !expired && !denied && <>
      <p>Đối chiếu mã đơn, người nhận/liên hệ, chứng từ và đủ sản phẩm thực tế. Bàn giao toàn bộ đơn trong một lần.</p>
      <label><input type="checkbox" checked={checked} disabled={pending} onChange={event => setChecked(event.target.checked)} />Tôi đã đối chiếu người nhận, chứng từ thu hợp lệ và bàn giao đủ sản phẩm thực tế</label>
      <button type="button" disabled={!checked || pending} onClick={() => { if (checked && !busy.current) void send({ key: crypto.randomUUID(), version: order.version }); }}>Xác nhận đã bàn giao</button>
    </>}
    {!command && ['ORDER_INTEGRITY_ERROR', 'INVENTORY_INTEGRITY_ERROR'].includes(order.permittedActions.fulfillBlockedReason ?? '') && <p role="alert">Cần đối chiếu dữ liệu đơn, chứng từ hoặc tồn kho trước khi bàn giao. Không thể ép xuất âm.</p>}
    {pending && <p role="status">Đang xử lý bàn giao…</p>}
  </section>;
}
