import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { InventoryDetail } from '../inventory/InventoryDetail';
import { inventoryApi } from '../inventory/inventory.api';
import { stockIssue } from './StockDocumentEditor';
import { stockDate, stockMoney, type ProductOption, type StockPage, type PostedReceipt } from './stock-receipts.api';
import { stockAdjustmentsApi as api, type Adjustment, type AdjustmentInput, type AdjustmentOperation } from './stock-adjustments.api';

interface Line { productId: string; sku: string; name: string; count: string; unitCost: string; base: number; version: number; currentVersion: number | null; reserved: number | null; current: number | null; stale: boolean; countedAt?: string }
interface Command { operation: AdjustmentOperation; key: string; id?: string; input: AdjustmentInput | { version: number } }
const formLines = (row: Adjustment): Line[] => row.items.map(item => ({ productId: item.productId, sku: item.skuSnapshot, name: item.nameSnapshot,
  count: String(item.countedQuantity), unitCost: item.unitCost, base: item.baseOnHand, version: item.baseInventoryVersion, reserved: item.currentReserved,
  current: item.currentOnHand, currentVersion: item.currentInventoryVersion, stale: item.stale, countedAt: item.countedAt }));
const content = (reason: string, source: string, lines: Line[]) => JSON.stringify([reason.trim(), source.trim(), lines.map(line => [line.productId, line.count, line.unitCost, line.version])]);
export function StockAdjustmentEditor({ initial, onClose, onChanged }: { initial?: Adjustment; onClose: () => void; onChanged: () => void }) {
  const [row, setRow] = useState(initial), [reason, setReason] = useState(initial?.reason ?? ''), [source, setSource] = useState(initial?.sourceReference ?? '');
  const [lines, setLines] = useState<Line[]>(initial ? formLines(initial) : []);
  const [baseline, setBaseline] = useState(initial ? content(initial.reason, initial.sourceReference ?? '', formLines(initial)) : '');
  const [q, setQ] = useState(''), [page, setPage] = useState(1), [options, setOptions] = useState<StockPage<ProductOption>>(), [picked, setPicked] = useState('');
  const [pickerLoading, setPickerLoading] = useState(false), [pickerError, setPickerError] = useState(''), [pickerRevision, setPickerRevision] = useState(0);
  const [pending, setPending] = useState(false), [unknown, setUnknown] = useState(false), [error, setError] = useState<ApiError | null>(null), [success, setSuccess] = useState('');
  const [confirm, setConfirm] = useState(false), [recounted, setRecounted] = useState(!initial), [blocked, setBlocked] = useState(Boolean(initial?.stale));
  const [historyId, setHistoryId] = useState<string | null>(null);
  const busy = useRef(false), command = useRef<Command | null>(null);
  const posted = row?.status === 'POSTED', dirty = !row || baseline !== content(reason, source, lines);
  useEffect(() => {
    if (posted) return;
    const controller = new AbortController(); setPickerLoading(true); setPickerError('');
    api.options({ q, page, limit: 20 }, controller.signal).then(result => { if (!controller.signal.aborted) setOptions(result); })
      .catch(failure => { if (!controller.signal.aborted) setPickerError(stockIssue(failure).message); })
      .finally(() => { if (!controller.signal.aborted) setPickerLoading(false); });
    return () => controller.abort();
  }, [q, page, posted, pickerRevision]);
  function load(fresh: Adjustment) {
    setRow(fresh); setReason(fresh.reason); setSource(fresh.sourceReference ?? ''); setLines(formLines(fresh));
    setBaseline(content(fresh.reason, fresh.sourceReference ?? '', formLines(fresh))); setRecounted(false); setBlocked(fresh.stale); setConfirm(false);
  }
  async function finish(result: Adjustment | PostedReceipt) {
    load('items' in result ? result : await api.detail(result.id)); setUnknown(false); command.current = null;
    setSuccess(result.status === 'POSTED' ? 'Đã ghi sổ kiểm kê.' : 'Đã lưu nháp. Tồn kho chưa thay đổi.'); onChanged();
  }
  async function send(next: Command) {
    if (busy.current) return; busy.current = true; setPending(true); setError(null); setSuccess('');
    try {
      await finish(next.operation === 'STOCK_ADJUST_POST' ? await api.post(next.id!, (next.input as { version: number }).version, next.key)
        : await api.save(next.input as AdjustmentInput, next.key, next.id));
    } catch (failure) {
      const issue = stockIssue(failure); setError(issue);
      const uncertain = issue.status === undefined || issue.status >= 500; setUnknown(uncertain);
      if (!uncertain) {
        command.current = null; setConfirm(false);
        if (issue.code === 'COUNT_SNAPSHOT_STALE' || issue.code === 'VERSION_CONFLICT') setBlocked(true);
        if (issue.code === 'COUNT_SNAPSHOT_STALE') {
          // Refresh only comparison values. Keep the old count and baseline until the explicit recount step.
          try {
            const current = await Promise.all(lines.map(line => inventoryApi.detail(line.productId)));
            setLines(previous => previous.map(line => {
              const balance = current.find(item => item.productId === line.productId);
              return balance ? { ...line, current: balance.onHand, reserved: balance.reserved, currentVersion: balance.version, stale: true } : line;
            }));
          } catch { /* The original conflict stays visible; history and recount can be retried. */ }
        }
      }
    } finally { busy.current = false; setPending(false); }
  }
  async function lookup() {
    if (busy.current || !command.current) return; busy.current = true; setPending(true);
    try { await finish((await api.lookup(command.current.operation, command.current.key)).responseBody); }
    catch (failure) { setError(stockIssue(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  async function reload() {
    if (!row || busy.current || unknown) return; busy.current = true; setPending(true); setError(null);
    try { load(await api.detail(row.id)); command.current = null; }
    catch (failure) { setError(stockIssue(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  async function recount() {
    if (busy.current || unknown || posted) return; busy.current = true; setPending(true); setError(null); setConfirm(false);
    try {
      // Read the current document version first, then current balances. No counts survive this explicit recount step.
      const fresh = row ? await api.detail(row.id) : undefined;
      if (fresh?.status === 'POSTED') { load(fresh); return; }
      const sourceLines = fresh ? formLines(fresh) : lines;
      const balances = await Promise.all(sourceLines.map(line => inventoryApi.detail(line.productId)));
      if (balances.some(balance => balance.inventoryState !== 'VALID' || balance.version === null || balance.onHand === null)) throw new ApiError('Kho cần đối chiếu trước khi kiểm kê.');
      if (fresh) load(fresh);
      setLines(sourceLines.map((line, index) => ({ ...line, count: '', base: balances[index].onHand!, current: balances[index].onHand!, version: balances[index].version!, currentVersion: balances[index].version!, reserved: balances[index].reserved, stale: false, countedAt: undefined })));
      setRecounted(true); setBlocked(false); setSuccess('Hãy kiểm đếm lại thực tế và nhập lại số đếm cho tất cả dòng, gồm hàng đang giữ còn trong kho.');
    } catch (failure) { setError(stockIssue(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  async function add() {
    if (busy.current || !picked || lines.length >= 100 || lines.some(line => line.productId === picked)) return;
    const option = options?.items.find(item => item.id === picked); if (!option) return;
    busy.current = true; setPending(true); setError(null);
    try {
      const balance = await inventoryApi.detail(option.id);
      if (balance.inventoryState !== 'VALID' || balance.onHand === null || balance.version === null) throw new ApiError('Kho cần đối chiếu trước khi kiểm kê.');
      setLines([...lines, { productId: option.id, sku: option.sku, name: option.name, count: '', unitCost: '0', base: balance.onHand, current: balance.onHand, version: balance.version, currentVersion: balance.version, reserved: balance.reserved, stale: false }]); setPicked('');
    } catch (failure) { setError(stockIssue(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  function save(event: FormEvent) {
    event.preventDefault(); if (busy.current || unknown || posted || blocked || !recounted || confirm) return;
    if (!lines.length || lines.some(line => line.count === '')) { setError(new ApiError('Nhập số kiểm đếm cho tất cả dòng.')); return; }
    const input: AdjustmentInput = { reason: reason.trim(), sourceReference: source.trim(), ...(row ? { version: row.version } : {}),
      items: lines.map(line => ({ productId: line.productId, countedQuantity: Number(line.count), expectedInventoryVersion: line.version, unitCost: line.unitCost })) };
    const next: Command = { key: crypto.randomUUID(), operation: row ? 'STOCK_ADJUST_UPDATE' : 'STOCK_ADJUST_CREATE', input, id: row?.id };
    command.current = next; void send(next);
  }
  return <section aria-label="Phiếu kiểm kê"><h3>{row?.code ?? 'Tạo phiếu kiểm kê'}</h3>
    <p>{posted ? 'Đã ghi sổ · Chứng từ bất biến' : 'Nháp chưa thay đổi tồn kho'}{row && ` · Phiên bản ${row.version}`}</p>
    <p>Số đếm gồm hàng đang giữ nhưng còn trong kho bán được. Giá trị biến động là tổng |chênh lệch| × đơn giá, không phải doanh thu.</p>
    {error && <p role="alert">{error.message}{error.requestId && ` · Mã tra cứu: ${error.requestId}`}</p>}{success && <p role="status">{success}</p>}
    {(blocked || lines.some(line => line.stale)) && <p role="alert">Mốc kiểm kê đã cũ (stale). Xem biến động và kiểm đếm lại thực tế; không dùng số đếm cũ với phiên bản mới.</p>}
    <form onSubmit={save}><fieldset disabled={pending || unknown || posted || confirm}>
      <label>Lý do kiểm kê<textarea required minLength={10} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <label>Chứng từ nguồn<input maxLength={100} value={source} onChange={event => setSource(event.target.value)} /></label>
      {!posted && <><label>Tìm SKU (gồm hàng ngừng bán)<input maxLength={120} value={q} onChange={event => { setQ(event.target.value); setPage(1); }} /></label>
        {pickerLoading && <p role="status">Đang tải SKU…</p>}{pickerError && <p role="alert">{pickerError}</p>}{!pickerLoading && options?.items.length === 0 && <p>Không có SKU phù hợp.</p>}
        <label>Chọn SKU<select value={picked} onChange={event => setPicked(event.target.value)} disabled={pickerLoading || Boolean(pickerError)}><option value="">Chọn SKU kiểm kê</option>
          {options?.items.map(option => <option key={option.id} value={option.id} disabled={option.inventoryState !== 'VALID' || lines.some(line => line.productId === option.id)}>{option.sku} · {option.name}{!option.effectiveActive && ' · Ngừng bán'}{option.inventoryState !== 'VALID' && ' · Cần đối chiếu'}</option>)}</select></label>
        <button type="button" disabled={!picked || lines.length >= 100 || Boolean(row && !recounted)} onClick={() => void add()}>Thêm dòng</button>
        <button type="button" disabled={page <= 1 || pickerLoading} onClick={() => setPage(value => value - 1)}>SKU trước</button><span>Trang SKU {page} / {options?.totalPages ?? 0}</span>
        <button type="button" disabled={pickerLoading || !options || page >= options.totalPages} onClick={() => setPage(value => value + 1)}>SKU sau</button>
        <button type="button" onClick={() => setPickerRevision(value => value + 1)}>Tải lại SKU</button></>}
      {lines.length === 0 && <p>Chưa có dòng kiểm kê.</p>}
      {lines.map((line, index) => <div key={line.productId} className="form-section"><h4>{line.sku} · {line.name}</h4>
        <p>Tồn sổ tại mốc: {line.base} · Phiên bản kho {line.version}{line.countedAt && ` · Ghi nhận ${stockDate(line.countedAt)}`}</p>
        <p>Tồn hiện tại: {line.current ?? '—'} · Đang giữ hiện tại: {line.reserved ?? '—'} · Phiên bản hiện tại: {line.currentVersion ?? '—'}{line.stale && ' · Đã phát sinh biến động'}</p>
        <label>Số đếm {line.sku}<input required type="number" min={0} max={2147483647} step={1} disabled={Boolean(row && !recounted) || blocked} value={line.count}
          onChange={event => setLines(lines.map((item, at) => at === index ? { ...item, count: event.target.value } : item))} /></label>
        <p>Chênh lệch dự kiến: {line.count === '' ? 'Chưa đếm' : `${Number(line.count) - line.base >= 0 ? '+' : ''}${Number(line.count) - line.base}`}</p>
        <label>Đơn giá ghi nhận VND {line.sku}<input required inputMode="numeric" pattern="[0-9]{1,12}" maxLength={12} disabled={Boolean(row && !recounted)} value={line.unitCost}
          onChange={event => setLines(lines.map((item, at) => at === index ? { ...item, unitCost: event.target.value } : item))} /></label>
        {!posted && <button type="button" disabled={Boolean(row && !recounted)} onClick={() => setLines(lines.filter(item => item.productId !== line.productId))}>Bỏ dòng {line.sku}</button>}
      </div>)}
    </fieldset>
    {lines.map(line => <button key={line.productId} type="button" onClick={() => setHistoryId(line.productId)}>Lịch sử kho {line.sku}</button>)}
    {row && <><p>Giá trị biến động đã lưu: <strong>{stockMoney(row.totalCost)}</strong> (không phải doanh thu).</p>
      <p>Người lập: {row.createdBy} · {stockDate(row.createdAt)}{row.postedAt && ` · Ghi sổ: ${row.postedBy} · ${stockDate(row.postedAt)}`}</p>
      <h4>Lịch sử chứng từ</h4><ul>{row.audit?.map(event => <li key={event.id}>{event.action} · {event.actorId} · {stockDate(event.occurredAt)} · {event.before?.version ?? '—'} → {event.after.version} · {event.after.reason}</li>)}</ul></>}
    {posted && <><p>Sai sau ghi sổ: lập phiếu đối chiếu mới có chứng từ nguồn.</p>{row.movements.length === 0 ? <p>Chênh lệch bằng 0: ghi nhận kiểm kê, không tạo biến động hoặc tăng phiên bản kho.</p> : <ul>{row.movements.map(movement => <li key={movement.id}>{movement.skuSnapshot}: {movement.beforeOnHand} → {movement.afterOnHand} · Giữ {movement.beforeReserved} → {movement.afterReserved} · Sequence {movement.sequence} · Nguồn {movement.sourceCode} · {movement.id}</li>)}</ul>}</>}
    {dirty && row && <p>Có thay đổi chưa lưu. Lưu nháp trước khi ghi sổ.</p>}
    {confirm && <section role="dialog" aria-label="Xác nhận ghi sổ"><h4>Xác nhận toàn phiếu {row?.code}</h4>
      <ul>{lines.map(line => <li key={line.productId}>{line.sku}: mốc {line.base}, đếm {line.count}, chênh lệch {Number(line.count) - line.base}, giữ {line.reserved}</li>)}</ul>
      <p>Giá trị biến động {row && stockMoney(row.totalCost)}. Giữ nguyên reserved; phiếu đã ghi sổ không thể sửa.</p>
      <button type="button" disabled={pending || unknown} onClick={() => {
        if (busy.current || !row || unknown) return;
        const next: Command = { key: crypto.randomUUID(), operation: 'STOCK_ADJUST_POST', id: row.id, input: { version: row.version } };
        command.current = next; void send(next);
      }}>Xác nhận ghi sổ</button><button type="button" disabled={pending || unknown} onClick={() => setConfirm(false)}>Quay lại</button></section>}
    {unknown && <><p>Chưa xác định kết quả. Giữ nguyên khóa; tra cứu chưa thấy không chứng minh thao tác thất bại.</p>
      <button type="button" disabled={pending} onClick={() => void lookup()}>Tra cứu kết quả</button><button type="button" disabled={pending} onClick={() => command.current && void send(command.current)}>Gửi lại cùng yêu cầu</button></>}
    <div className="user-actions">{!posted && <><button type="button" disabled={pending || unknown || confirm || !lines.length} onClick={() => void recount()}>Kiểm đếm lại và nhập số mới</button>
      <button type="submit" disabled={pending || unknown || confirm || blocked || !recounted}>Lưu nháp</button>
      <button type="button" disabled={!row || dirty || pending || unknown || confirm || blocked} onClick={() => setConfirm(true)}>Ghi sổ</button></>}
      {row && <button type="button" disabled={pending || unknown} onClick={() => void reload()}>Tải lại phiếu</button>}
      <button type="button" disabled={pending || unknown} onClick={onClose}>Đóng form</button></div>
    {pending && <p role="status">Đang xử lý kiểm kê…</p>}</form>
    {historyId && <InventoryDetail productId={historyId} revision={row?.version ?? 0} onClose={() => setHistoryId(null)} />}
    <Link to="/admin/inventory">Tra cứu tồn kho</Link>
  </section>;
}
