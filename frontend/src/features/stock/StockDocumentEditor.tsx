import { stockIssuesApi, type IssueOperation, type StockIssue } from './stock-issues.api';
import { inventoryApi, inventoryNumber, type InventoryBalance } from '../inventory/inventory.api';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { stockReceiptsApi, stockMoney, stockDate, type Receipt, type ReceiptInput, type ReceiptOperation, type ProductOption, type StockPage } from './stock-receipts.api';

export const stockIssue = (failure: unknown) => failure instanceof ApiError ? failure : new ApiError(failure instanceof Error ? failure.message : 'Không thể xử lý chứng từ kho');
interface Line { productId: string; sku: string; name: string; quantity: string; unitCost: string; inactiveWarning: boolean }
interface Command { key: string; operation: ReceiptOperation | IssueOperation; input: ReceiptInput | { version: number }; id?: string }
const formLines = (receipt?: Receipt): Line[] => receipt?.items.map(item => ({ productId: item.productId, sku: item.skuSnapshot, name: item.nameSnapshot,
  quantity: String(item.quantity), unitCost: item.unitCost, inactiveWarning: item.inactiveWarning })) ?? [];
const content = (reason: string, sourceReference: string, lines: Line[]) => JSON.stringify({ reason, sourceReference, lines });

export function StockDocumentEditor({ initial, onClose, onChanged, issue = false }: { issue?: boolean; initial?: StockIssue; onClose: () => void; onChanged: () => void }) {
  const api = issue ? stockIssuesApi : stockReceiptsApi;
  const [balances, setBalances] = useState<InventoryBalance[]>([]);
  const [row, setRow] = useState(initial), [reason, setReason] = useState(initial?.reason ?? ''), [sourceReference, setSourceReference] = useState(initial?.sourceReference ?? '');
  const [lines, setLines] = useState<Line[]>(formLines(initial)), [baseline, setBaseline] = useState(content(initial?.reason ?? '', initial?.sourceReference ?? '', formLines(initial)));
  const [options, setOptions] = useState<StockPage<ProductOption>>(), [q, setQ] = useState(''), [page, setPage] = useState(1), [picked, setPicked] = useState('');
  const [pickerLoading, setPickerLoading] = useState(false), [pickerError, setPickerError] = useState(''), [pickerRevision, setPickerRevision] = useState(0);
  const [pending, setPending] = useState(false), [unknown, setUnknown] = useState(false), [error, setError] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState(false), [success, setSuccess] = useState('');
  const busy = useRef(false), command = useRef<Command | null>(null);
  const posted = row?.status === 'POSTED', dirty = content(reason, sourceReference, lines) !== baseline;
  const needsReload = error?.code === 'VERSION_CONFLICT' || issue && error?.code === 'INSUFFICIENT_AVAILABLE_STOCK';
  useEffect(() => {
    if (posted) return;
    const controller = new AbortController(); setPickerLoading(true); setPickerError(''); setPicked('');
    api.options({ q, page, limit: 20 }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setOptions(result); })
      .catch(failure => { if (!controller.signal.aborted) setPickerError(stockIssue(failure).message); })
      .finally(() => { if (!controller.signal.aborted) setPickerLoading(false); });
    return () => controller.abort();
  }, [q, page, pickerRevision, posted, api]);
  function load(receipt: Receipt) {
    setRow(receipt); setReason(receipt.reason); setSourceReference(receipt.sourceReference ?? ''); setLines(formLines(receipt));
    setBaseline(content(receipt.reason, receipt.sourceReference ?? '', formLines(receipt))); setConfirm(false); setError(null);
  }
  async function finish(result: Receipt | { id: string }) {
    const fresh = 'items' in result ? result : await api.detail(result.id);
    load(fresh); setUnknown(false); command.current = null;
    setSuccess(fresh.status === 'POSTED' ? 'Đã ghi sổ. Tồn kho đã được cập nhật.' : 'Đã lưu nháp. Tồn kho chưa thay đổi.'); onChanged();
  }
  async function send(next: Command) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null); setSuccess('');
    try {
      const result = next.operation.endsWith('_POST')
        ? await api.post(next.id!, (next.input as { version: number }).version, next.key)
        : await api.save(next.input as ReceiptInput, next.key, next.id);
      await finish(result);
    } catch (failure) {
      const issue = stockIssue(failure); setError(issue);
      const uncertain = issue.status === undefined || issue.status >= 500; setUnknown(uncertain);
      if (!uncertain) { command.current = null; setConfirm(false); }
    } finally { busy.current = false; setPending(false); }
  }
  async function lookup() {
    if (busy.current || !command.current) return;
    busy.current = true; setPending(true);
    try {
      const result = issue
        ? await stockIssuesApi.lookup(command.current.operation as IssueOperation, command.current.key)
        : await stockReceiptsApi.lookup(command.current.operation as ReceiptOperation, command.current.key);
      await finish(result.responseBody);
    }
    catch (failure) { setError(stockIssue(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  async function reload() {
    if (!row || busy.current || unknown) return;
    busy.current = true; setPending(true);
    try { load(await api.detail(row.id)); setBalances([]); command.current = null; }
    catch (failure) { setError(stockIssue(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  async function checkAvailability(confirmPost = false) {
    if (busy.current || unknown || posted) return;
    busy.current = true; setPending(true); setError(null);
    try {
      const current = await Promise.all(lines.map(line => inventoryApi.detail(line.productId)));
      setBalances(current);
      if (current.some((balance, index) => balance.inventoryState !== 'VALID' || balance.available === null || Number(lines[index].quantity) > balance.available)) {
        setError(new ApiError('Không đủ tồn khả dụng hoặc kho cần đối chiếu. Hãy kiểm tra lại phiếu; không xuất phần hàng đang giữ.'));
      } else if (confirmPost) setConfirm(true);
    } catch (failure) { setError(stockIssue(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  function save(event: FormEvent) {
    event.preventDefault(); if (busy.current || unknown || posted || confirm || needsReload) return;
    if (lines.length < 1) { setError(new ApiError('Cần ít nhất một dòng hàng.')); return; }
    const input: ReceiptInput = { reason: reason.trim(), sourceReference: sourceReference.trim(), ...(row ? { version: row.version } : {}),
      items: lines.map(line => ({ productId: line.productId, quantity: Number(line.quantity), unitCost: line.unitCost })) };
    const next: Command = { key: crypto.randomUUID(), operation: issue ? (row ? 'STOCK_ISSUE_UPDATE' : 'STOCK_ISSUE_CREATE') : (row ? 'STOCK_RECEIPT_UPDATE' : 'STOCK_RECEIPT_CREATE'), input, id: row?.id };
    command.current = next; void send(next);
  }
  function add() {
    const option = options?.items.find(item => item.id === picked);
    if (!option || lines.length >= 100 || lines.some(line => line.productId === option.id)) return;
    setLines([...lines, { productId: option.id, sku: option.sku, name: option.name, quantity: '1', unitCost: '0', inactiveWarning: !option.effectiveActive }]); setPicked('');
  }
  return <section aria-label={issue ? 'Phiếu xuất' : 'Phiếu nhập'}><h3>{row?.code ?? (issue ? 'Tạo phiếu xuất' : 'Tạo phiếu nhập')}</h3>
    <p><strong>{posted ? 'Đã ghi sổ' : issue ? 'Nháp chưa trừ tồn' : 'Nháp chưa cộng tồn'}</strong>{row && ` · Phiên bản ${row.version}`}</p>
    {success && <p role="status">{success}</p>}
    {error && <div role="alert"><p>{error.message}</p>{error.details?.map(item => <p key={item.field}>{item.field}: {item.message}</p>)}{error.requestId && <small>Mã tra cứu: {error.requestId}</small>}</div>}
    {needsReload && <p>Đã giữ bản nhập. Tải lại sẽ thay bản nhập bằng dữ liệu mới nhất để đối chiếu.{issue && ' Tải lại phiếu rồi kiểm tra lại tồn khả dụng trước khi tiếp tục.'}</p>}
    <form onSubmit={save}><fieldset disabled={pending || unknown || posted || confirm}>
      <label>Lý do / chứng từ nguồn<textarea required minLength={10} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <label>Mã chứng từ nguồn<input maxLength={100} value={sourceReference} onChange={event => setSourceReference(event.target.value)} /></label>
      <p>{issue ? 'Chỉ xuất ngoài bán: hao hụt, hư hỏng hoặc sử dụng nội bộ. Ghi rõ căn cứ và chứng từ nguồn; không lập phiếu này để xuất lại đơn bán đã bàn giao. Giá ghi nhận do Admin nhập, không phải giá vốn bình quân.' : 'Đối chiếu chứng từ và hàng thực nhận để tránh lập hai phiếu cho cùng lô hàng. Hàng tặng có giá nhập 0 cần ghi căn cứ trong lý do.'}</p>
      {!posted && <><label>Tìm SKU hoặc tên (gồm hàng ngừng bán)<input value={q} onChange={event => { setQ(event.target.value); setPage(1); }} maxLength={120} /></label>
        {pickerLoading && <p role="status">Đang tải SKU…</p>}{pickerError && <p role="alert">{pickerError}</p>}
        {!pickerLoading && options?.items.length === 0 && <p>Không có SKU phù hợp.</p>}
        <label>Chọn SKU<select value={picked} onChange={event => setPicked(event.target.value)} disabled={pickerLoading || Boolean(pickerError)}>
          <option value="">{issue ? 'Chọn hàng xuất ngoài bán' : 'Chọn hàng thực nhận'}</option>{options?.items.map(option => <option key={option.id} value={option.id} disabled={lines.some(line => line.productId === option.id) || issue && option.inventoryState !== 'VALID'}>
            {option.sku} · {option.name}{!option.effectiveActive ? ' · Ngừng bán' : ''}{option.inventoryState !== 'VALID' ? ' · Cần đối chiếu kho' : ''}</option>)}
        </select></label>
        <div className="user-actions"><button type="button" disabled={!picked || lines.length >= 100} onClick={add}>Thêm dòng</button>
          <button type="button" disabled={pickerLoading || page <= 1} onClick={() => setPage(value => value - 1)}>SKU trước</button>
          <span>Trang SKU {page} / {options?.totalPages ?? 0}</span><button type="button" disabled={pickerLoading || !options || page >= options.totalPages} onClick={() => setPage(value => value + 1)}>SKU sau</button>
          <button type="button" onClick={() => setPickerRevision(value => value + 1)}>Tải lại SKU</button></div></>}
      {lines.length === 0 ? <p>Chưa có dòng hàng.</p> : lines.map((line, index) => <div key={line.productId} className="form-section">
        <p><strong>{line.sku} · {line.name}</strong></p>{line.inactiveWarning && <p>{issue ? 'Hàng hoặc danh mục ngừng bán vẫn được xuất ngoài bán khi kho hợp lệ.' : 'Hàng hoặc danh mục đang ngừng bán. Nhập kho không tự bật bán lại.'}</p>}
        <label>Số lượng {line.sku}<input required type="number" min={1} max={issue ? 999 : 1000000} step={1} value={line.quantity} onChange={event => setLines(lines.map((item, at) => at === index ? { ...item, quantity: event.target.value } : item))} /></label>
        <label>{issue ? 'Giá ghi nhận VND' : 'Giá nhập VND'} {line.sku}<input required inputMode="numeric" pattern="[0-9]{1,12}" maxLength={12} value={line.unitCost} onChange={event => setLines(lines.map((item, at) => at === index ? { ...item, unitCost: event.target.value } : item))} /></label>
        {!posted && <button type="button" onClick={() => setLines(lines.filter(item => item.productId !== line.productId))}>Bỏ dòng {line.sku}</button>}
      </div>)}
    </fieldset>
    {issue && !posted && <><button type="button" disabled={pending || unknown || confirm || needsReload || lines.length === 0} onClick={() => void checkAvailability()}>Kiểm tra tồn khả dụng</button>
      {balances.filter(balance => lines.some(line => line.productId === balance.productId)).map(balance => <p key={balance.productId}>{balance.sku}: thực tế {inventoryNumber(balance.onHand)}, đang giữ {inventoryNumber(balance.reserved)}, khả dụng {inventoryNumber(balance.available)} · {stockDate(balance.asOf)}</p>)}
      <p>Số lượng nhập dương; biến động ghi sổ âm. Tồn được kiểm tra lại khi ghi sổ; không giảm hàng đang giữ cho đơn.</p></>}
    {row && <><p>Tổng phiếu đã lưu: <strong>{stockMoney(row.totalCost)}</strong>. Tổng do server tính.</p>
      <p>Người lập: {row.createdBy} · {stockDate(row.createdAt)}</p>
      <ul>{row.items.map(item => <li key={item.id}>{item.skuSnapshot}: {item.quantity} × {stockMoney(item.unitCost)} = {stockMoney(item.lineTotalCost)}</li>)}</ul></>}
    {issue && row?.audit && <><h4>Lịch sử chứng từ</h4><ul>{row.audit.map(event => <li key={event.id}>{event.action} · {event.actorId} · {stockDate(event.occurredAt)} · Phiên bản {event.before?.version ?? '—'} → {event.after.version} · {event.after.reason}</li>)}</ul></>}
    {dirty && row && <p>Có chỉnh sửa chưa lưu. Lưu nháp trước khi ghi sổ.</p>}
    {posted && <><p>Người ghi sổ: {row.postedBy} · {stockDate(row.postedAt!)}</p>
      <p>Phiếu đã ghi sổ bất biến. Sai sót cần đối chiếu và xử lý bằng nghiệp vụ điều chỉnh.</p>
      <h4>Biến động kho nguồn</h4>{row.movements.length === 0 ? <p>Chưa có biến động để hiển thị. Hãy tải lại phiếu để đối chiếu.</p> :
        <table><thead><tr><th>SKU / movement</th><th>Sequence</th><th>Tồn thực tế trước → sau</th><th>Giữ trước → sau</th><th>Nguồn</th></tr></thead>
          <tbody>{row.movements.map(movement => <tr key={movement.id}><td>{movement.skuSnapshot} · {movement.nameSnapshot}<br /><code>{movement.id}</code></td>
            <td>{movement.sequence}</td><td>{movement.beforeOnHand} → {movement.afterOnHand} ({movement.onHandDelta > 0 ? '+' : ''}{movement.onHandDelta})</td>
            <td>{movement.beforeReserved} → {movement.afterReserved} ({movement.reservedDelta})</td><td>Nguồn: {movement.sourceCode}<br />Dòng: <code>{movement.documentItemId}</code><br />{stockDate(movement.createdAt)}</td></tr>)}</tbody></table>}</>}
    {confirm && <section role="dialog" aria-label="Xác nhận ghi sổ"><h4>{issue ? 'Xác nhận xuất ngoài bán hàng' : 'Xác nhận hàng đã thực nhận'}</h4>
      <p>Ghi sổ {row?.code} với {lines.length} dòng, tổng {row && stockMoney(row.totalCost)} sẽ {issue ? 'trừ tồn khả dụng, giữ nguyên hàng đang giữ' : 'cộng tồn'}. Phiếu đã ghi sổ không thể sửa hoặc hủy.</p>
      <button type="button" disabled={pending || unknown} onClick={() => {
        if (busy.current || !row || unknown) return;
        const next: Command = { key: crypto.randomUUID(), operation: issue ? 'STOCK_ISSUE_POST' : 'STOCK_RECEIPT_POST', id: row.id, input: { version: row.version } };
        command.current = next; void send(next);
      }}>Xác nhận ghi sổ</button><button type="button" disabled={pending || unknown} onClick={() => setConfirm(false)}>Quay lại</button></section>}
    {unknown && <><p>Chưa xác định kết quả. Giữ nguyên khóa yêu cầu; tra cứu chưa thấy không chứng minh thao tác thất bại.</p>
      <button type="button" disabled={pending} onClick={() => void lookup()}>Tra cứu kết quả</button>
      <button type="button" disabled={pending} onClick={() => command.current && void send(command.current)}>Gửi lại cùng yêu cầu</button></>}
    <div className="user-actions">{!posted && <><button type="submit" disabled={pending || unknown || confirm || needsReload}>Lưu nháp</button>
      <button type="button" disabled={!row || dirty || pending || unknown || confirm || needsReload} onClick={() => issue ? void checkAvailability(true) : setConfirm(true)}>Ghi sổ</button></>}
      {row && <button type="button" disabled={pending || unknown} onClick={() => void reload()}>Tải lại phiếu</button>}
      <button type="button" disabled={pending || unknown} onClick={onClose}>Đóng form</button></div>
    {pending && <p role="status">Đang xử lý phiếu…</p>}</form>
  </section>;
}
