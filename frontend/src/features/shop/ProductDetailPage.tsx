// Tầng giao diện – trang (US-35 bước 3): /shop/:id – xem chi tiết sản phẩm, chọn số lượng và nút "Thêm vào giỏ".
// Guest bấm thêm thì sang đăng nhập kèm returnTo; PT/Staff/Admin không có nút mua (US-35-F05, TC11).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { useAuth } from '../auth/AuthProvider';
import { formatVnd } from '../../utils/money';
import { shopApi, type PublicProduct } from './shop.api';
import { AVAILABILITY_TEXT, canRetry, ShopImage } from './ShopParts';

// Số lượng chọn trên trang: số nguyên 1–999, khớp giới hạn mỗi dòng giỏ của US-40 (US-40 kiểm lại với tồn thật).
const MAX_QUANTITY = 999;

// Giờ Việt Nam, ví dụ "10:00 18/11/2026".
function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit',
    day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function ProductDetailPage() {
  const { id = '' } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const [product, setProduct] = useState<PublicProduct | null>(null);
  const [loading, setLoading] = useState(true);
  const [notAvailable, setNotAvailable] = useState(false);
  const [error, setError] = useState('');
  // Lỗi hiện tại có nên cho bấm "Thử lại" không.
  const [retry, setRetry] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [notice, setNotice] = useState('');

  // Luôn hỏi lại server khi mở trang, không dùng bản trong danh sách (US-35-TC10).
  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError('');
    setNotAvailable(false);
    setProduct(null);
    shopApi.detail(id)
      .then(result => { if (!ignore) setProduct(result); })
      .catch(failure => {
        if (ignore) return;
        // US-35-TC02: sản phẩm ngừng bán hoặc danh mục ngừng → 404 PRODUCT_NOT_AVAILABLE.
        if (failure instanceof ApiError && failure.status === 404) setNotAvailable(true);
        else {
          setError(failure instanceof ApiError ? failure.message : 'Không kết nối được máy chủ.');
          setRetry(canRetry(failure));
        }
      })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [id, reloadCount]);

  function addToCart() {
    // US-35-TC11: Guest sang đăng nhập, chỉ mang theo đường dẫn nội bộ của trang này; không tạo giỏ Guest.
    if (!auth.user) {
      navigate(`/login?returnTo=${encodeURIComponent(`/shop/${id}`)}`);
      return;
    }
    // Giỏ hàng của Member làm ở US-40 (chưa có API). Không báo thành công giả (US-35-TC12).
    setNotice('Giỏ hàng trực tuyến chưa mở. Vui lòng mua tại quầy.');
  }

  if (loading) return <section className="auth-card"><p>Đang tải sản phẩm...</p></section>;

  if (notAvailable) return <section className="auth-card">
    <p className="form-error" role="alert">Sản phẩm này không còn được bán.</p>
    <Link to="/shop">Quay lại cửa hàng</Link>
  </section>;

  // US-35-TC12: lỗi mạng/503 có nút thử lại, không hiện giá giả. Lỗi 400 (id sai cú pháp) chỉ hiện lý do.
  if (error || !product) return <section className="auth-card">
    <div className="form-error" role="alert"><p>{error || 'Không tải được sản phẩm.'}</p>
      {retry && <button type="button" onClick={() => setReloadCount(count => count + 1)}><Icon name="retry" label="Thử lại" /></button>}</div>
    <Link to="/shop">Quay lại cửa hàng</Link>
  </section>;

  // US-35-TC03: chỉ bấm thêm được khi còn hàng.
  const canBuy = product.availability === 'IN_STOCK';
  // US-35-F05: chỉ Guest và Member thấy nút mua; vai trò khác có màn nghiệp vụ riêng. Đang kiểm phiên thì chưa hiện.
  const showBuy = auth.status !== 'checking' && (!auth.user || auth.user.roleCode === 'MEMBER');

  return <section className="auth-card">
    <p><Link to="/shop">Quay lại cửa hàng</Link></p>
    <h1>{product.name}</h1>
    <ShopImage url={product.imageUrl} name={product.name} size={240} />
    <p>Mã: {product.sku}</p>
    <p>Danh mục: {product.category.name}</p>
    {/* US-35-TC12: giá "0" hiện "0 ₫". */}
    <p><strong>{formatVnd(product.price)}</strong></p>
    <p>{AVAILABILITY_TEXT[product.availability]}</p>
    {/* US-35-TC04: mô tả hiện bằng {} nên là chữ nguyên văn, không chèn HTML. */}
    {product.description && <p className="shop-description">{product.description}</p>}
    <p>Cập nhật lúc {formatTime(product.asOf)}. Giá và tồn có thể đổi khi thêm vào giỏ.</p>

    {showBuy && <div className="toolbar">
      <label>Số lượng
        <input type="number" min={1} max={MAX_QUANTITY} step={1} value={quantity} disabled={!canBuy}
          onChange={event => setQuantity(Math.min(MAX_QUANTITY, Math.max(1, Math.trunc(Number(event.target.value)) || 1)))} />
      </label>
      <button type="button" disabled={!canBuy} onClick={addToCart}>Thêm vào giỏ</button>
    </div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
