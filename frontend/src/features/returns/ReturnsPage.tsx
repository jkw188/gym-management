import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { apiClient } from '../../api/client';
import { orderDate, orderMoney } from '../orders/orders.api';
import { refundLabel } from '../orders/OrderCancellation';
import { returnsApi, type Eligibility, type ReturnDetail, type ReturnResult } from './returns.api';
import { CommandRecovery, useReturnCommand } from './useReturnCommand';

export function ReturnsPage() {
  const auth = useSyncExternalStore(apiClient.subscribe, apiClient.getSnapshot);
  return <ReturnsWorkspace key={auth.user?.id ?? 'session'} />;
}
const initial = { orderId: '', fromDate: '', toDate: '', page: 1 };
function ReturnsWorkspace() {
  const [orderId, setOrderId] = useState(''), [order, setOrder] = useState<Eligibility | null>(null), [reason, setReason] = useState('');
  const [lines, setLines] = useState<Record<string, { quantity: number; restockable: boolean; conditionNote: string }>>({});
  const [checked, setChecked] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [filter, setFilter] = useState(initial), [query, setQuery] = useState(initial), [revision, setRevision] = useState(0);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof returnsApi.list>>>(), [detail, setDetail] = useState<ReturnDetail | null>(null);
  const command = useReturnCommand<ReturnResult>('receive', async () => { setOrder(null); setLines({}); setChecked(false); setRevision(value => value + 1); });
  const locked = command.pending || Boolean(command.command) || command.denied;
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    returnsApi.list(query, controller.signal).then(value => { if (!controller.signal.aborted) setHistory(value); })
      .catch(cause => { if (!controller.signal.aborted) { setHistory(undefined); setError(cause instanceof Error ? cause.message : 'Không tải được lịch sử'); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, revision]);
  async function find(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError(''); setOrder(null); setLines({});
    try { setOrder(await returnsApi.eligibility(orderId.trim())); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không tìm được đơn'); } finally { setLoading(false); }
  }
  async function show(id: string) {
    setLoading(true); setError(''); setDetail(null);
    try { setDetail(await returnsApi.detail(id)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không tải được phiếu'); } finally { setLoading(false); }
  }
  function receive(event: FormEvent) {
    event.preventDefault(); if (!order || !checked || locked) return;
    const items = Object.entries(lines).filter(([, line]) => line.quantity > 0).map(([orderItemId, line]) => ({ orderItemId, ...line, conditionNote: line.conditionNote.trim() }));
    if (!items.length || items.some(item => !Number.isInteger(item.quantity) || item.conditionNote.length < 10)) { setError('Chọn ít nhất một dòng và ghi tình trạng từ 10 đến 500 ký tự.'); return; }
    command.submit({ version: order.version, reason: reason.trim(), items }, order.id, 'RETURN_RECEIVE');
  }
  return <section><h2>Tiếp nhận hàng trả</h2><p>Nhận hàng tại quầy trong 7 ngày lịch từ ngày bàn giao theo giờ Việt Nam. Đã nhận hàng và đã hoàn tiền là hai kết quả riêng.</p>
    <CommandRecovery state={command} />{error && <p role="alert">{error}</p>}{loading && <p role="status">Đang tải…</p>}
    <form onSubmit={find}><label>ID đơn gốc<input required value={orderId} onChange={event => setOrderId(event.target.value)} /></label><button disabled={loading || locked}>Tìm đơn gốc</button></form>
    {order && <section><h3>{order.code} · {order.channel}</h3><p>Trạng thái: {order.status} · Bàn giao: {order.fulfilledAt ? orderDate(order.fulfilledAt) : '—'}</p>
      <p>Nhận trả trước: {order.returnDeadline ? orderDate(order.returnDeadline) : '—'}</p>
      {!order.eligible ? <p>Đơn chưa đủ điều kiện hoặc đã hết hạn trả.</p> : <form onSubmit={receive}><fieldset disabled={locked || loading}>
        {order.items.map(item => { const line = lines[item.id] ?? { quantity: 0, restockable: false, conditionNote: '' }; const update = (patch: Partial<typeof line>) => setLines(previous => ({ ...previous, [item.id]: { ...line, ...patch } }));
          return <fieldset key={item.id}><legend>{item.name} · {item.sku}</legend><p>Còn trả: {item.remaining}/{item.quantity} · Giá gốc: {orderMoney(item.unitPrice)}</p>
            <label>Số nhận {item.sku}<input type="number" min="0" max={item.remaining} step="1" value={line.quantity} onChange={event => update({ quantity: Number(event.target.value) })} /></label>
            <label><input type="checkbox" checked={line.restockable} onChange={event => update({ restockable: event.target.checked })} />Đã kiểm tra, bán lại được</label>
            <label>Tình trạng {item.sku}<textarea required={line.quantity > 0} minLength={10} maxLength={500} value={line.conditionNote} onChange={event => update({ conditionNote: event.target.value })} /></label></fieldset>; })}
        <label>Lý do nhận trả<textarea required minLength={10} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <label><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />Đã thực nhận và kiểm tra tình trạng từng sản phẩm</label>
        <button disabled={!checked}>Xác nhận nhận hàng</button></fieldset></form>}</section>}
    <h3>Lịch sử đã nhận hàng</h3><form onSubmit={event => { event.preventDefault(); setQuery({ ...filter, page: 1 }); }}>
      <label>Lọc ID đơn<input value={filter.orderId} onChange={event => setFilter({ ...filter, orderId: event.target.value })} /></label>
      <label>Từ ngày<input type="date" value={filter.fromDate} onChange={event => setFilter({ ...filter, fromDate: event.target.value })} /></label>
      <label>Đến ngày<input type="date" value={filter.toDate} onChange={event => setFilter({ ...filter, toDate: event.target.value })} /></label><button disabled={loading}>Lọc phiếu</button>
      <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>Tải lại lịch sử</button></form>
    {!loading && history?.items.length === 0 && <p>Chưa có phiếu trả phù hợp.</p>}
    {history?.items.map(row => <article key={row.id}><p>Đã nhận hàng: {orderDate(row.receivedAt)} · Đơn {row.orderId} · {orderMoney(row.amount)}</p>
      <p>Nghĩa vụ: {orderMoney(row.refundAmount)} · Đã hoàn tiền: {orderMoney(row.refundedAmount)} · Còn phải hoàn: {orderMoney(row.outstandingRefundAmount)}</p><button disabled={loading} onClick={() => void show(row.id)}>Xem phiếu {row.id}</button></article>)}
    <button disabled={loading || query.page <= 1} onClick={() => setQuery({ ...query, page: query.page - 1 })}>Trang trước</button><span> Trang {query.page}/{history?.totalPages ?? 0} · {history?.total ?? 0} phiếu </span>
    <button disabled={loading || !history || query.page >= history.totalPages} onClick={() => setQuery({ ...query, page: query.page + 1 })}>Trang sau</button>
    {detail && <section><h3>Phiếu {detail.id}</h3><p>{detail.reason} · Nhân viên {detail.createdBy} · {orderDate(detail.receivedAt)}</p>
      {detail.items.map(item => <p key={item.id}>{item.name} × {item.quantity} · {item.restockable ? 'Nhập lại kho bán được' : 'Không nhập kho bán được'} · {item.conditionNote} · {orderMoney(item.amount)}</p>)}
      {detail.refunds.map(refund => <p key={refund.id}>Khoản hoàn {refund.id}: {refundLabel(refund.status)} · {orderMoney(refund.amount)}</p>)}<button onClick={() => setDetail(null)}>Đóng phiếu</button></section>}
  </section>;
}
