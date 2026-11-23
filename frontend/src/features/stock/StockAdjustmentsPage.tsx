import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { StockAdjustmentEditor } from './StockAdjustmentEditor';
import { stockIssue } from './StockDocumentEditor';
import { stockDate, stockMoney, type ReceiptSummary, type StockPage } from './stock-receipts.api';
import { stockAdjustmentsApi as api, type Adjustment } from './stock-adjustments.api';

export function StockAdjustmentsPage() {
  const [search] = useSearchParams(), sourceId = search.get('documentId');
  const [q, setQ] = useState(''), [status, setStatus] = useState(''), [fromDate, setFromDate] = useState(''), [toDate, setToDate] = useState('');
  const [query, setQuery] = useState({ q: '', status: '', fromDate: '', toDate: '', page: 1, limit: 20 });
  const [data, setData] = useState<StockPage<ReceiptSummary>>(), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [revision, setRevision] = useState(0), [editor, setEditor] = useState<Adjustment | 'new' | null>(null), [opening, setOpening] = useState(false);
  useEffect(() => {
    if (!sourceId) return;
    const controller = new AbortController(); setOpening(true); setError('');
    api.detail(sourceId, controller.signal).then(result => { if (!controller.signal.aborted) setEditor(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(stockIssue(failure).message); })
      .finally(() => { if (!controller.signal.aborted) setOpening(false); });
    return () => controller.abort();
  }, [sourceId]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    api.list(query, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(stockIssue(failure).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, revision]);
  function filter(event: FormEvent) { event.preventDefault(); setQuery({ q: q.trim(), status, fromDate, toDate, page: 1, limit: 20 }); }
  async function open(id: string) {
    if (opening) return; setOpening(true); setError('');
    try { setEditor(await api.detail(id)); } catch (failure) { setError(stockIssue(failure).message); } finally { setOpening(false); }
  }
  return <section><h2>Kiểm kê và điều chỉnh kho</h2><p>Ghi số đếm và căn cứ tại mốc tồn đã xác nhận. Có biến động mới phải kiểm đếm lại thực tế trước khi ghi sổ.</p>
    {editor ? <StockAdjustmentEditor key={editor === 'new' ? 'new' : editor.id} initial={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} onChanged={() => setRevision(value => value + 1)} /> : <>
      <button type="button" disabled={opening} onClick={() => setEditor('new')}>Tạo phiếu kiểm kê</button>
      <form onSubmit={filter}><label>Tìm mã phiếu / chứng từ<input value={q} maxLength={120} onChange={event => setQ(event.target.value)} /></label>
        <label>Trạng thái<select value={status} onChange={event => setStatus(event.target.value)}><option value="">Tất cả</option><option value="DRAFT">Nháp</option><option value="POSTED">Đã ghi sổ</option></select></label>
        <label>Từ ngày<input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} /></label>
        <label>Đến ngày<input type="date" value={toDate} onChange={event => setToDate(event.target.value)} /></label>
        <p>Để trống dùng 30 ngày gần nhất; tối đa 366 ngày, theo giờ Việt Nam.</p>
        <button type="submit" disabled={opening}>Lọc phiếu</button><button type="button" disabled={loading || opening} onClick={() => setRevision(value => value + 1)}>Tải lại danh sách</button></form>
      {loading && <p role="status">Đang tải phiếu kiểm kê…</p>}{opening && <p role="status">Đang mở phiếu…</p>}{error && <p role="alert">{error}</p>}
      {!loading && !error && data?.items.length === 0 && <p>Không có phiếu kiểm kê phù hợp.</p>}
      {!loading && !error && Boolean(data?.items.length) && <table><thead><tr><th>Phiếu / nguồn</th><th>Trạng thái</th><th>Giá trị biến động (không phải doanh thu)</th><th>Ngày lập</th><th>Thao tác</th></tr></thead>
        <tbody>{data?.items.map(row => <tr key={row.id}><td>{row.code}<br />{row.sourceReference}</td><td>{row.status === 'POSTED' ? 'Đã ghi sổ' : 'Nháp'}</td>
          <td>{stockMoney(row.totalCost)}</td><td>{stockDate(row.createdAt)}</td><td><button type="button" disabled={opening} onClick={() => void open(row.id)}>Mở {row.code}</button></td></tr>)}</tbody></table>}
      <div className="pagination"><button type="button" disabled={loading || opening || query.page <= 1} onClick={() => setQuery({ ...query, page: query.page - 1 })}>Trang trước</button>
        <span>Trang {query.page} / {data?.totalPages ?? 0}</span><button type="button" disabled={loading || opening || !data || query.page >= data.totalPages} onClick={() => setQuery({ ...query, page: query.page + 1 })}>Trang sau</button></div>
    </>}</section>;
}
