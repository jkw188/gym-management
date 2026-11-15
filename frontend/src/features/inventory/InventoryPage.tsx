import { useEffect, useState, type FormEvent } from 'react';
import { InventoryDetail } from './InventoryDetail';
import { inventoryApi, inventoryError, inventoryNumber, inventoryState, type InventoryBalance, type InventoryQuery } from './inventory.api';
import type { StockPage } from '../stock/stock-receipts.api';
import { stockDate } from '../stock/stock-receipts.api';

export function InventoryPage() {
  const [q, setQ] = useState(''), [categoryId, setCategoryId] = useState(''), [productStatus, setProductStatus] = useState(''), [stockState, setStockState] = useState('');
  const [query, setQuery] = useState<InventoryQuery>({ page: 1, limit: 20 }), [revision, setRevision] = useState(0);
  const [data, setData] = useState<StockPage<InventoryBalance> & { asOf: string }>(), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    inventoryApi.list(query, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(inventoryError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, revision]);
  // Refresh when returning from posting a receipt in another tab/window.
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh);
  }, []);
  function filter(event: FormEvent) { event.preventDefault(); setQuery({ q: q.trim(), categoryId: categoryId.trim(), productStatus, stockState, page: 1, limit: 20 }); }
  return <section><h2>Tra cứu tồn kho</h2><p>Tồn thực tế bán được, lượng đã giữ và khả dụng hiện tại. Giỏ hàng chưa tạo đơn không giữ tồn.</p>
    <form onSubmit={filter}><label>Tìm SKU / tên sản phẩm<input value={q} maxLength={120} onChange={event => setQ(event.target.value)} /></label>
      <label>Mã danh mục<input value={categoryId} onChange={event => setCategoryId(event.target.value)} /></label>
      <label>Trạng thái sản phẩm<select value={productStatus} onChange={event => setProductStatus(event.target.value)}><option value="">Tất cả</option><option value="ACTIVE">Đang bán</option><option value="INACTIVE">Ngừng bán</option></select></label>
      <label>Tình trạng tồn<select value={stockState} onChange={event => setStockState(event.target.value)}><option value="">Tất cả</option><option value="IN_STOCK">Còn khả dụng</option><option value="OUT_OF_STOCK">Hết khả dụng</option><option value="ERROR">Dữ liệu lỗi</option></select></label>
      <button type="submit">Lọc kho</button><button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>Tải lại kho</button></form>
    {loading && <p role="status">Đang tải tồn kho…</p>}{error && <p role="alert">{error} <button type="button" onClick={() => setRevision(value => value + 1)}>Thử lại</button></p>}
    {!loading && !error && data && <><p>Số dư hiện tại tại {stockDate(data.asOf)} (giờ Việt Nam).</p>
      {data.items.length === 0 ? <p>Không có sản phẩm phù hợp.</p> : <table><thead><tr><th>Sản phẩm</th><th>Trạng thái bán</th><th>Dữ liệu kho</th><th>Tồn thực tế</th><th>Đã giữ</th><th>Khả dụng</th><th>Phiên bản</th><th>Tra cứu</th></tr></thead>
        <tbody>{data.items.map(row => <tr key={row.productId}><td>{row.sku} · {row.name}</td><td>{row.productStatus === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE'} · {row.effectiveActive ? 'Được bán' : 'Đang ngừng bán (sản phẩm hoặc danh mục)'}</td>
          <td>{inventoryState(row.inventoryState)}</td><td>{inventoryNumber(row.onHand)}</td><td>{inventoryNumber(row.reserved)}</td><td>{inventoryNumber(row.available)}</td><td>{inventoryNumber(row.version)}</td>
          <td><button type="button" onClick={() => setSelected(row.productId)}>Xem kho {row.sku}</button></td></tr>)}</tbody></table>}
      <div className="user-actions"><button type="button" disabled={query.page <= 1} onClick={() => setQuery({ ...query, page: query.page - 1 })}>Trang kho trước</button><span>Trang {query.page} / {data.totalPages}</span>
        <button type="button" disabled={query.page >= data.totalPages} onClick={() => setQuery({ ...query, page: query.page + 1 })}>Trang kho sau</button></div></>}
    {selected && <InventoryDetail key={selected} productId={selected} revision={revision} onClose={() => setSelected(null)} />}
  </section>;
}
