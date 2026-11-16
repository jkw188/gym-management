import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { stockDate } from '../stock/stock-receipts.api';
import { inventoryApi, inventoryError, inventoryNumber, inventoryState, type InventoryBalance, type Movement, type MovementPage, type MovementQuery } from './inventory.api';

export function InventoryDetail({ productId, revision, onClose }: { productId: string; revision: number; onClose: () => void }) {
  const [balance, setBalance] = useState<InventoryBalance>(), [balanceError, setBalanceError] = useState(''), [balanceLoading, setBalanceLoading] = useState(true);
  const [fromDate, setFromDate] = useState(''), [toDate, setToDate] = useState(''), [kind, setKind] = useState('');
  const [query, setQuery] = useState<MovementQuery>({ page: 1, limit: 20 }), [reload, setReload] = useState(0);
  const [history, setHistory] = useState<MovementPage>(), [error, setError] = useState(''), [loading, setLoading] = useState(true), [movementId, setMovementId] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setBalanceLoading(true); setBalanceError('');
    inventoryApi.detail(productId, controller.signal).then(result => { if (!controller.signal.aborted) setBalance(result); })
      .catch(failure => { if (!controller.signal.aborted) setBalanceError(inventoryError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setBalanceLoading(false); });
    return () => controller.abort();
  }, [productId, revision, reload]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setMovementId(null);
    inventoryApi.history(productId, query, controller.signal).then(result => { if (!controller.signal.aborted) setHistory(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(inventoryError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [productId, query, revision, reload]);
  function filter(event: FormEvent) { event.preventDefault(); setQuery({ fromDate, toDate, kind: kind.trim(), page: 1, limit: 20 }); }
  return <section aria-label="Chi tiết kho"><h3>Số dư hiện tại và sổ biến động</h3><button type="button" onClick={onClose}>Đóng chi tiết kho</button>
    <button type="button" disabled={loading || balanceLoading} onClick={() => setReload(value => value + 1)}>Tải lại chi tiết kho</button>
    {balanceLoading && <p role="status">Đang tải số dư hiện tại…</p>}{balanceError && <p role="alert">{balanceError}</p>}
    {!balanceLoading && !balanceError && balance && <><h4>{balance.sku} · {balance.name}</h4><p>{inventoryState(balance.inventoryState)} · {balance.productStatus} · {balance.effectiveActive ? 'Được bán' : 'Sản phẩm hoặc danh mục đang ngừng bán'}</p>
      {balance.inventoryState !== 'VALID' && <p role="alert">Dữ liệu kho cần đối chiếu. Chưa xác định khả dụng; không quy số dư thiếu về 0.</p>}
      <dl className="info-grid"><dt>Tồn thực tế hiện tại</dt><dd>{inventoryNumber(balance.onHand)}</dd><dt>Đã giữ hiện tại</dt><dd>{inventoryNumber(balance.reserved)}</dd><dt>Khả dụng hiện tại</dt><dd>{inventoryNumber(balance.available)}</dd>
        <dt>Phiên bản kho</dt><dd>{inventoryNumber(balance.version)}</dd><dt>Thời điểm đọc hiện tại</dt><dd>{stockDate(balance.asOf)}</dd></dl></>}
    <form onSubmit={filter}><label>Từ ngày biến động<input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} /></label>
      <label>Đến ngày biến động<input type="date" value={toDate} onChange={event => setToDate(event.target.value)} /></label>
      <label>Loại biến động<input value={kind} maxLength={60} placeholder="Ví dụ: RECEIPT_POST" onChange={event => setKind(event.target.value)} /></label>
      <p>Để trống dùng 30 ngày gần nhất; tối đa 366 ngày, theo giờ Việt Nam. Số dư hiện tại không phải tồn cuối kỳ quá khứ.</p><button type="submit">Lọc biến động</button></form>
    {loading && <p role="status">Đang tải sổ biến động…</p>}{error && <p role="alert">{error}</p>}
    {!loading && !error && history && <><p>Kỳ {history.range.fromDate} – {history.range.toDate} · Đọc sổ tại {stockDate(history.asOf)} (giờ Việt Nam).</p>
      {history.items.length === 0 ? <p>Chưa có biến động trong kỳ đã chọn.</p> : <table><thead><tr><th>Sequence / thời gian</th><th>Loại / snapshot sản phẩm</th><th>Δ thực tế / giữ</th><th>Trước: thực tế / giữ</th><th>Sau: thực tế / giữ</th><th>Nguồn</th><th>Chi tiết</th></tr></thead><tbody>
        {history.items.map(row => <tr key={row.id}><td>{row.sequence}<br />{stockDate(row.createdAt)}</td><td>{row.kind}<br />{row.skuSnapshot} · {row.nameSnapshot}</td>
          <td>{inventoryNumber(row.onHandDelta)} / {inventoryNumber(row.reservedDelta)}</td><td>{inventoryNumber(row.beforeOnHand)} / {inventoryNumber(row.beforeReserved)}</td><td>{inventoryNumber(row.afterOnHand)} / {inventoryNumber(row.afterReserved)}</td>
          <td>{row.sourceType} · {row.sourceCode ?? row.sourceId}</td><td><button type="button" onClick={() => setMovementId(row.id)}>Xem biến động {row.sequence}</button></td></tr>)}</tbody></table>}
      <div className="user-actions"><button type="button" disabled={query.page <= 1} onClick={() => setQuery({ ...query, page: query.page - 1 })}>Trang biến động trước</button><span>Trang {query.page} / {history.totalPages}</span>
        <button type="button" disabled={query.page >= history.totalPages} onClick={() => setQuery({ ...query, page: query.page + 1 })}>Trang biến động sau</button></div></>}
    {movementId && <MovementDetail key={movementId} id={movementId} onClose={() => setMovementId(null)} />}
  </section>;
}

function MovementDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [row, setRow] = useState<Movement>(), [error, setError] = useState(''), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  const location = useLocation();
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    inventoryApi.movement(id, controller.signal).then(result => { if (!controller.signal.aborted) setRow(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(inventoryError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, revision]);
  const home = location.pathname.startsWith('/admin/') ? '/admin' : '/staff';
  // Never navigate to an arbitrary server/client URL. The source endpoint checks its own permission.
  const source = row?.sourceType === 'STOCK_RECEIPT' && /^[a-f\d]{24}$/i.test(row.sourceId) && row.sourcePath === `/stock-receipts/${row.sourceId}`
    ? `${home}/stock-receipts?documentId=${row.sourceId}` : null;
  return <section aria-label="Chi tiết biến động"><h4>Chi tiết biến động</h4><button type="button" onClick={onClose}>Đóng biến động</button>
    {loading && <p role="status">Đang tải biến động…</p>}{error && <p role="alert">{error} <button type="button" onClick={() => setRevision(value => value + 1)}>Thử lại biến động</button></p>}
    {!loading && !error && row && <><p>{row.skuSnapshot} · {row.nameSnapshot} · {row.kind} · Sequence {row.sequence}</p><p>{stockDate(row.createdAt)}</p>
      <p>Δ thực tế / giữ: {inventoryNumber(row.onHandDelta)} / {inventoryNumber(row.reservedDelta)}</p><p>Trước: {inventoryNumber(row.beforeOnHand)} / {inventoryNumber(row.beforeReserved)}. Sau: {inventoryNumber(row.afterOnHand)} / {inventoryNumber(row.afterReserved)}.</p>
      <p>Nguồn: {row.sourceType} · {row.sourceCode ?? row.sourceId}</p>{source && <Link to={source}>Mở phiếu nguồn</Link>}<p>Quyền xem phiếu và giá nhập được kiểm tra riêng khi mở nguồn.</p></>}
  </section>;
}
