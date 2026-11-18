// Tầng giao diện – trang (US-35 bước 3): /shop – Guest/Member tìm, lọc sản phẩm đang bán và mở trang chi tiết.
// Chỉ xem: không gửi request ghi, không giữ hàng hay giữ giá (US-35-F04, TC09).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { formatVnd } from '../../utils/money';
import { shopApi, type PublicCategory, type PublicPage, type PublicProduct } from './shop.api';
import { AVAILABILITY_TEXT, canRetry, ShopImage } from './ShopParts';

// Lỗi 400 có details thì hiện lý do cụ thể; lỗi khác hiện message của server hoặc câu chung.
function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Không kết nối được máy chủ. Bộ lọc vẫn được giữ, hãy thử lại.';
  if (error.details && error.details.length > 0) return error.details.map(detail => detail.message).join('. ');
  return error.message;
}

export function ShopPage() {
  // Chữ đang gõ trong ô tìm kiếm; q là giá trị đã chốt sau 300ms ngừng gõ.
  const [searchText, setSearchText] = useState('');
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [availability, setAvailability] = useState('');
  // Tăng số này để tải lại đúng bộ lọc hiện tại (nút "Thử lại").
  const [reloadCount, setReloadCount] = useState(0);

  const [categories, setCategories] = useState<PublicCategory[]>([]);
  const [data, setData] = useState<PublicPage<PublicProduct> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(false);

  // Danh mục cho ô chọn; lỗi thì ô chỉ còn "Tất cả", danh sách sản phẩm vẫn dùng được.
  useEffect(() => {
    shopApi.listCategories().then(page => setCategories(page.items)).catch(() => setCategories([]));
  }, []);

  // Debounce 300ms: gõ nhanh "nước" chỉ gửi một request q=nước.
  useEffect(() => {
    const timer = setTimeout(() => setQ(searchText.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  // Tải danh sách mỗi khi bộ lọc đã chốt đổi hoặc bấm "Thử lại".
  useEffect(() => {
    // ignore = true khi bộ lọc đã đổi tiếp, để response cũ về muộn không ghi đè kết quả mới.
    let ignore = false;
    setLoading(true);
    setError('');
    // US-35-TC12: đang tải hoặc lỗi thì không hiện danh sách cũ như thể vẫn đúng.
    setData(null);
    shopApi.listProducts({ q, categoryId, availability })
      .then(result => { if (!ignore) setData(result); })
      .catch(failure => {
        if (ignore) return;
        setError(errorText(failure));
        setRetry(canRetry(failure));
      })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [q, categoryId, availability, reloadCount]);

  return <section className="auth-card classes-page">
    <h1>Cửa hàng</h1>
    <p>Giá và tình trạng hàng tại thời điểm xem. Xem sản phẩm không giữ hàng hay giữ giá.</p>

    {/* US-35-F02: các bộ lọc kết hợp AND; đổi một ô không làm mất giá trị các ô khác. */}
    <div className="toolbar">
      <label>Tìm sản phẩm
        <input type="search" maxLength={120} value={searchText} onChange={event => setSearchText(event.target.value)} />
      </label>
      <label>Danh mục
        <select value={categoryId} onChange={event => setCategoryId(event.target.value)}>
          <option value="">Tất cả</option>
          {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
      </label>
      <label>Tình trạng
        <select value={availability} onChange={event => setAvailability(event.target.value)}>
          <option value="">Tất cả</option>
          <option value="IN_STOCK">Còn hàng</option>
          <option value="OUT_OF_STOCK">Hết hàng</option>
        </select>
      </label>
    </div>

    {loading && <p>Đang tải sản phẩm...</p>}

    {/* US-35-TC12: lỗi mạng/503 có nút thử lại, giữ nguyên bộ lọc; không hiện danh sách giả. */}
    {error && <div className="form-error" role="alert"><p>{error}</p>
      {retry && <button type="button" onClick={() => setReloadCount(count => count + 1)}><Icon name="retry" label="Thử lại" /></button>}</div>}

    {data && data.items.length === 0 && <p>Không tìm thấy sản phẩm phù hợp</p>}

    {/* Giữ đúng thứ tự server trả. Dữ liệu hiển thị bằng {} nên luôn là chữ, không chèn HTML (US-35-TC04). */}
    {data && data.items.length > 0 && <ul aria-label="Danh sách sản phẩm" className="class-list">
      {data.items.map(product => <li key={product.id} className="shift-item">
        <ShopImage url={product.imageUrl} name={product.name} size={64} />
        <strong>{product.name}</strong>
        {/* US-35-TC12: giá "0" vẫn hiện "0 ₫", không đổi thành "Liên hệ". */}
        <span>{formatVnd(product.price)}</span>
        <span>{AVAILABILITY_TEXT[product.availability]}</span>
        <div className="shift-item-actions"><Link to={`/shop/${product.id}`}>Xem chi tiết</Link></div>
      </li>)}
    </ul>}
  </section>;
}
