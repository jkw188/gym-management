import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { retailApi, type CatalogKind, type Category, type Product, type ProductInput, type RetailPage, type RetailStatus } from './retail.api';
import { RetailImage } from './RetailImage';

const issueOf = (failure: unknown) => failure instanceof ApiError ? failure : new ApiError(failure instanceof Error ? failure.message : 'Không thể lưu dữ liệu.');
interface Props { kind: CatalogKind; initial?: Category | Product; onSaved: () => void; onClose: () => void }
interface Command { key: string; input: ProductInput }
export function RetailForm({ kind, initial, onSaved, onClose }: Props) {
  const product = kind === 'products';
  const [row, setRow] = useState(initial);
  const existing = row && 'sku' in row ? row : undefined;
  const [name, setName] = useState(row?.name ?? ''), [status, setStatus] = useState<RetailStatus>(row?.status ?? 'ACTIVE');
  const [sku, setSku] = useState(existing?.sku ?? ''), [price, setPrice] = useState(existing?.price ?? '0');
  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? '');
  const [description, setDescription] = useState(existing?.description ?? ''), [imageUrl, setImageUrl] = useState(existing?.imageUrl ?? '');
  const [categories, setCategories] = useState<RetailPage<Category>>(), [categoryPage, setCategoryPage] = useState(1);
  const [categoryError, setCategoryError] = useState(''), [categoryLoading, setCategoryLoading] = useState(false), [revision, setRevision] = useState(0);
  const [error, setError] = useState<ApiError | null>(null), [pending, setPending] = useState(false), [unknown, setUnknown] = useState(false);
  const [preview, setPreview] = useState<ProductInput | null>(null), [affected, setAffected] = useState(0);
  const command = useRef<Command | null>(null), busy = useRef(false);
  useEffect(() => {
    if (!product) return;
    const controller = new AbortController(); setCategoryLoading(true); setCategoryError('');
    retailApi.list<Category>('categories', { page: categoryPage, limit: 100 }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setCategories(result); })
      .catch(failure => { if (!controller.signal.aborted) setCategoryError(issueOf(failure).message); })
      .finally(() => { if (!controller.signal.aborted) setCategoryLoading(false); });
    return () => controller.abort();
  }, [product, categoryPage, revision]);
  async function prepare(event: FormEvent) {
    event.preventDefault(); if (busy.current || unknown || preview || error?.code === 'VERSION_CONFLICT') return;
    const input: ProductInput = { ...(row ? { version: row.version } : {}), name: name.trim(), status };
    if (product) Object.assign(input, { categoryId, price, description: description.trim() || null, imageUrl: imageUrl.trim() || null,
      ...(!row ? { sku: sku.trim().replace(/[a-z]/g, letter => letter.toUpperCase()) } : {}) });
    if (row) {
      for (const key of Object.keys(input) as (keyof ProductInput)[]) {
        if (key === 'version') continue;
        if (input[key] === (row as unknown as Record<string, unknown>)[key]) delete input[key];
      }
      if (Object.keys(input).length === 1) { setError(new ApiError('Cần ít nhất một thay đổi.')); return; }
    }
    busy.current = true; setPending(true); setError(null);
    try {
      if (!product && row && status !== row.status) {
        const fresh = await retailApi.detail<Category>('categories', row.id);
        if (fresh.version !== row.version) throw new ApiError('Dữ liệu đã thay đổi. Hãy tải lại trước khi lưu.', 409, undefined, undefined, undefined, 'VERSION_CONFLICT');
        setAffected(fresh.affectedActiveProductCount);
      }
      setPreview(input);
    } catch (failure) { setError(issueOf(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  async function send(next: Command) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try { await retailApi.save(kind, next.input, next.key, row?.id); command.current = null; onSaved(); }
    catch (failure) {
      const issue = issueOf(failure); setError(issue);
      const uncertain = issue.status === undefined || issue.status >= 500; setUnknown(uncertain);
      if (!uncertain) { command.current = null; setPreview(null); }
    } finally { busy.current = false; setPending(false); }
  }
  async function lookup() {
    if (busy.current || !command.current) return;
    busy.current = true; setPending(true);
    try { await retailApi.lookup(kind, command.current.key, Boolean(row)); command.current = null; onSaved(); }
    catch (failure) { setError(issueOf(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  async function reload() {
    if (!row || busy.current || unknown) return;
    busy.current = true; setPending(true);
    try {
      const fresh = await retailApi.detail<Category | Product>(kind, row.id);
      setRow(fresh); setName(fresh.name); setStatus(fresh.status);
      if ('sku' in fresh) { setSku(fresh.sku); setPrice(fresh.price); setCategoryId(fresh.categoryId); setDescription(fresh.description ?? ''); setImageUrl(fresh.imageUrl ?? ''); }
      setError(null); setPreview(null); command.current = null;
    } catch (failure) { setError(issueOf(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  const targetCategory = categories?.items.find(category => category.id === categoryId);
  const effective = status === 'ACTIVE' && (targetCategory?.status ?? existing?.categoryStatus) === 'ACTIVE';
  return <section aria-label={product ? 'Biểu mẫu sản phẩm' : 'Biểu mẫu danh mục'}><h3>{row ? 'Sửa' : 'Tạo'} {product ? 'sản phẩm' : 'danh mục'}</h3>
    {row && <p>Phiên bản {row.version}</p>}
    <form onSubmit={event => void prepare(event)}><fieldset disabled={pending || unknown || Boolean(preview)}>
      <label>Tên<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>Trạng thái<select value={status} onChange={event => setStatus(event.target.value as RetailStatus)}><option value="ACTIVE">Đang bán</option><option value="INACTIVE">Ngừng bán</option></select></label>
      {product && <>
        <label>SKU<input required disabled={Boolean(row)} maxLength={40} pattern="[A-Za-z0-9_\-]+" value={sku} onChange={event => setSku(event.target.value)} /></label>
        <p>SKU không đổi sau khi tạo. Tồn kho khởi tạo bằng 0 và được quản lý qua nghiệp vụ kho.</p>
        {categoryLoading && <p role="status">Đang tải danh mục…</p>}
        {categoryError && <p role="alert">{categoryError}</p>}
        <label>Danh mục<select required value={categoryId} onChange={event => setCategoryId(event.target.value)}>
          <option value="">Chọn danh mục</option>
          {existing && !categories?.items.some(category => category.id === existing.categoryId) && <option value={existing.categoryId}>{existing.categoryName} ({existing.categoryStatus})</option>}
          {categories?.items.map(category => <option key={category.id} value={category.id}>{category.name} ({category.status})</option>)}
        </select></label>
        {!categoryLoading && categories?.items.length === 0 && <p>Chưa có danh mục. Tạo danh mục trước khi tạo sản phẩm.</p>}
        <div className="user-actions"><button type="button" disabled={categoryPage <= 1} onClick={() => setCategoryPage(value => value - 1)}>Danh mục trước</button>
          <span>Trang danh mục {categoryPage} / {categories?.totalPages ?? 0}</span>
          <button type="button" disabled={!categories || categoryPage >= categories.totalPages} onClick={() => setCategoryPage(value => value + 1)}>Danh mục sau</button>
          <button type="button" onClick={() => setRevision(value => value + 1)}>Tải lại danh mục</button></div>
        <label>Giá bán VND<input required inputMode="numeric" pattern="[0-9]{1,12}" maxLength={12} value={price} onChange={event => setPrice(event.target.value)} /></label>
        <label>Mô tả<textarea maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} /></label>
        <label>URL ảnh HTTPS<input maxLength={500} value={imageUrl} onChange={event => setImageUrl(event.target.value)} /></label>
        <p>Hiệu lực bán dự kiến: {effective ? 'Đang bán' : 'Ẩn'}. Sản phẩm chỉ xuất hiện khi cả sản phẩm và danh mục đều đang bán.</p>
      </>}
    </fieldset>
      {error && <div role="alert"><p>{error.message}</p>{error.details?.map(detail => <p key={detail.field}>{detail.message}</p>)}{error.requestId && <small>Mã tra cứu: {error.requestId}</small>}</div>}
      {error?.code === 'VERSION_CONFLICT' && <p>Bản nhập được giữ lại. Tải lại dữ liệu sẽ thay bản nhập bằng phiên bản mới; hãy đối chiếu trước khi tiếp tục.</p>}
      {preview && <section aria-label="Xem trước thay đổi"><h4>Xem trước thay đổi</h4><p>{name} · {status === 'ACTIVE' ? 'Đang bán' : 'Ngừng bán'}</p>
        {product && <><p>SKU: {sku} · Giá: {price} VND</p><p>{description}</p><RetailImage url={imageUrl} name={name} /></>}
        {!product && row && status !== row.status && <p>{affected} sản phẩm có trạng thái ACTIVE sẽ {status === 'ACTIVE' ? 'xuất hiện lại' : 'bị ẩn'}. Trạng thái từng sản phẩm được giữ nguyên.</p>}
        <button type="button" disabled={pending || unknown} onClick={() => {
          if (busy.current || unknown) return;
          const next = { key: crypto.randomUUID(), input: preview }; command.current = next; void send(next);
        }}>Xác nhận lưu</button>
        <button type="button" disabled={pending || unknown} onClick={() => setPreview(null)}>Quay lại sửa</button></section>}
      {unknown && <><p>Chưa xác định kết quả. Giữ nguyên khóa yêu cầu; kết quả tra cứu chưa thấy không có nghĩa thao tác thất bại.</p>
        <button type="button" disabled={pending} onClick={() => command.current && void send(command.current)}>Gửi lại cùng yêu cầu</button>
        <button type="button" disabled={pending} onClick={() => void lookup()}>Tra cứu kết quả</button></>}
      <div className="user-actions"><button type="submit" disabled={pending || unknown || Boolean(preview) || error?.code === 'VERSION_CONFLICT' || (product && categoryLoading)}>Xem trước</button>
        {row && <button type="button" disabled={pending || unknown} onClick={() => void reload()}>Tải lại dữ liệu</button>}
        <button type="button" disabled={pending || unknown} onClick={onClose}>Đóng form</button></div>
    </form></section>;
}
