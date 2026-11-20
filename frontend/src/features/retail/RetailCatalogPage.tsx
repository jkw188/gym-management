import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { retailApi, type CatalogKind, type Category, type Product, type RetailPage } from './retail.api';
import { RetailForm } from './RetailForm';
import { RetailImage } from './RetailImage';

export function RetailCatalogPage({ kind }: { kind: CatalogKind }) {
  const product = kind === 'products';
  const [q, setQ] = useState(''), [search, setSearch] = useState(''), [status, setStatus] = useState(''), [categoryId, setCategoryId] = useState('');
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [data, setData] = useState<RetailPage<Category | Product>>(), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [categories, setCategories] = useState<RetailPage<Category>>(), [categoryPage, setCategoryPage] = useState(1), [categoryError, setCategoryError] = useState('');
  const [form, setForm] = useState<{ initial?: Category | Product } | null>(null), [notice, setNotice] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const opening = useRef(false), generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setData(undefined);
    retailApi.list(kind, { page, limit: 20, q: search, status, ...(product ? { categoryId } : {}) }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Không tải được danh sách.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); generation.current++; };
  }, [kind, page, search, status, categoryId, revision, product]);
  useEffect(() => {
    if (!product) return;
    const controller = new AbortController(); setCategoryError('');
    retailApi.list<Category>('categories', { page: categoryPage, limit: 100 }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setCategories(result); })
      .catch(failure => { if (!controller.signal.aborted) setCategoryError(failure instanceof Error ? failure.message : 'Không tải được danh mục.'); });
    return () => controller.abort();
  }, [product, categoryPage, revision]);
  async function edit(id: string) {
    if (opening.current || form) return;
    opening.current = true; setDetailLoading(true); setError(''); const current = generation.current;
    try { const initial = await retailApi.detail(kind, id); if (current === generation.current) setForm({ initial }); }
    catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : 'Không tải được chi tiết.'); }
    finally { opening.current = false; setDetailLoading(false); }
  }
  return <section className="auth-card"><h2>{product ? 'Quản lý sản phẩm bán lẻ' : 'Quản lý danh mục bán lẻ'}</h2>
    <p><Link to={product ? '/admin/categories' : '/admin/products'}>{product ? 'Quản lý danh mục' : 'Quản lý sản phẩm'}</Link></p>
    {notice && <p role="status">{notice}</p>}
    <button type="button" disabled={Boolean(form) || detailLoading} onClick={() => { setNotice(''); setForm({}); }}>Tạo {product ? 'sản phẩm' : 'danh mục'}</button>
    {form && <RetailForm kind={kind} initial={form.initial} onClose={() => setForm(null)} onSaved={() => { setForm(null); setNotice('Đã lưu thành công.'); setRevision(value => value + 1); }} />}
    <form className="users-filter toolbar" onSubmit={event => { event.preventDefault(); setSearch(q.trim()); setPage(1); setRevision(value => value + 1); }}>
      <label>Tìm theo tên{product ? ' hoặc SKU' : ''}<input maxLength={120} value={q} onChange={event => setQ(event.target.value)} /></label>
      <label>Lọc trạng thái<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">Tất cả</option><option value="ACTIVE">ACTIVE</option><option value="INACTIVE">INACTIVE</option></select></label>
      {product && <><label>Lọc danh mục<select value={categoryId} onChange={event => { setCategoryId(event.target.value); setPage(1); }}><option value="">Tất cả danh mục</option>
        {categoryId && !categories?.items.some(category => category.id === categoryId) && <option value={categoryId}>Danh mục đã chọn</option>}
        {categories?.items.map(category => <option key={category.id} value={category.id}>{category.name} ({category.status})</option>)}
      </select></label>{categoryError && <p role="alert">{categoryError}</p>}
        <button type="button" disabled={categoryPage <= 1} onClick={() => setCategoryPage(value => value - 1)}>Danh mục trước</button>
        <button type="button" disabled={!categories || categoryPage >= categories.totalPages} onClick={() => setCategoryPage(value => value + 1)}>Danh mục sau</button>
      </>}
      <button type="submit">Tìm kiếm</button><button type="button" onClick={() => setRevision(value => value + 1)}>Tải lại danh sách</button>
    </form>
    {(loading || detailLoading) && <p role="status">Đang tải…</p>}{error && <p role="alert">{error}</p>}
    {!loading && data?.items.length === 0 && <p>Không có {product ? 'sản phẩm' : 'danh mục'} phù hợp.</p>}
    {!loading && data && data.items.length > 0 && <div className="users-table-wrap"><table className="users-table"><thead><tr><th>Tên</th>{product && <><th>Ảnh</th><th>SKU / Danh mục</th><th>Giá bán</th><th>Hiệu lực bán</th></>}<th>Trạng thái</th><th>Phiên bản</th><th>Thao tác</th></tr></thead>
      <tbody>{data.items.map(row => <tr key={row.id}><td>{row.name}</td>{'sku' in row && <><td><RetailImage url={row.imageUrl} name={row.name} /></td><td>{row.sku}<br />{row.categoryName} ({row.categoryStatus})</td><td>{new Intl.NumberFormat('vi-VN').format(BigInt(row.price))} ₫</td><td>{row.effectiveActive ? 'Đang bán' : row.status === 'ACTIVE' ? 'Ẩn do danh mục ngừng bán' : 'Ngừng bán'}</td></>}
        <td>{row.status}</td><td>{row.version}</td><td><button type="button" disabled={Boolean(form) || detailLoading} onClick={() => void edit(row.id)}>Sửa {row.name}</button></td></tr>)}</tbody></table></div>}
    <div className="user-actions"><button type="button" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>Trang trước</button>
      <span>Trang {page} / {data?.totalPages ?? 0} · {data?.total ?? 0} kết quả</span><button type="button" disabled={loading || !data || page >= data.totalPages} onClick={() => setPage(value => value + 1)}>Trang sau</button></div>
  </section>;
}
