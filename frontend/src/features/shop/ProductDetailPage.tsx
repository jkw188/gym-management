// Tầng giao diện – trang (US-35 bước 3): /shop/:id – xem chi tiết sản phẩm, chọn số lượng và nút "Thêm vào giỏ".
// Guest bấm thêm thì sang đăng nhập kèm returnTo; PT/Staff/Admin không có nút mua (US-35-F05, TC11).
// US-40 bước 3: Member bấm thêm → GET giỏ lấy version → POST /me/cart/items có Idempotency-Key.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { useAuth } from '../auth/AuthProvider';
import { cartApi, isOutcomeUnknown, type CartCommand } from '../cart/cart.api';
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
  // Giữ đúng chữ người dùng gõ (không tự sửa giữa chừng); kiểm 1–999 khi bấm thêm.
  const [quantityText, setQuantityText] = useState('1');
  // US-40: trạng thái nút thêm giỏ của Member.
  // adding: để khóa nút trên màn hình. addingRef: chặn gửi lệnh thứ hai một cách chắc chắn, vì ref đổi ngay khi gán
  // và không phụ thuộc lúc React vẽ lại (US-40-TC10, giống busyRef của CartPage).
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const [added, setAdded] = useState(false);
  const [addError, setAddError] = useState('');
  // Lệnh thêm chưa biết kết quả (lỗi mạng/5xx): "Thử lại" gửi đúng key và body cũ (US-40-TC10).
  const [pendingAdd, setPendingAdd] = useState<CartCommand | null>(null);

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
    void addForMember();
  }

  // US-40-TC01: lấy version giỏ hiện tại rồi gửi lệnh thêm với key mới.
  async function addForMember() {
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    setAdded(false);
    setAddError('');
    // US-40-TC04: số lượng phải là số nguyên 1–999, sai thì báo và không gọi API.
    const quantity = Number(quantityText);
    if (!/^\d+$/.test(quantityText.trim()) || quantity < 1 || quantity > MAX_QUANTITY) {
      setAddError(`Số lượng từ 1 đến ${MAX_QUANTITY}`);
      addingRef.current = false;
      setAdding(false);
      return;
    }
    try {
      const cart = await cartApi.get();
      // US-40-TC03: chưa liên kết hồ sơ → báo, không gửi POST.
      if (!cart.memberLinked) {
        setAddError('Tài khoản của bạn chưa được liên kết hồ sơ hội viên. Vui lòng liên hệ quầy lễ tân.');
        return;
      }
      await sendAdd({ kind: 'ADD', key: crypto.randomUUID(), body: { version: cart.version, productId: id, quantity } });
    } catch (failure) {
      setAddError(failure instanceof ApiError ? failure.message : 'Không kết nối được máy chủ.');
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  }

  // Gửi (hoặc gửi lại) lệnh thêm. Lỗi 409 nghiệp vụ chỉ báo, không tự gửi lại (US-40-TC05).
  async function sendAdd(command: CartCommand) {
    setAddError('');
    try {
      await cartApi.send(command);
      setPendingAdd(null);
      setAdded(true);
    } catch (failure) {
      setPendingAdd(isOutcomeUnknown(failure) ? command : null);
      setAddError(failure instanceof ApiError ? failure.message : 'Không kết nối được máy chủ.');
    }
  }

  async function retryAdd() {
    if (!pendingAdd || addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    await sendAdd(pendingAdd);
    addingRef.current = false;
    setAdding(false);
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

  // Bố cục 2 cột: ảnh bên trái, thông tin và nút mua bên phải (màn hẹp thì xếp chồng).
  return <section className="auth-card product-detail">
    <Link className="product-back" to="/shop"><span aria-hidden="true">← </span>Quay lại cửa hàng</Link>
    <div className="product-detail-grid">
      <div className="product-detail-media">
        <ShopImage url={product.imageUrl} name={product.name} size={560} />
      </div>

      <div className="product-detail-info">
        <h1>{product.name}</h1>
        {/* US-35-TC12: giá "0" hiện "0 ₫". */}
        <p className="product-detail-price">{formatVnd(product.price)}</p>
        <span className={canBuy ? 'product-stock in-stock' : 'product-stock out-of-stock'}>{AVAILABILITY_TEXT[product.availability]}</span>
        {/* US-35-TC04: mô tả hiện bằng {} nên là chữ nguyên văn, không chèn HTML. */}
        {product.description && <p className="shop-description">{product.description}</p>}

        <dl className="product-detail-meta">
          <dt>Mã</dt><dd>{product.sku}</dd>
          <dt>Danh mục</dt><dd>{product.category.name}</dd>
        </dl>

        {showBuy && <div className="product-buy">
          <label>Số lượng
            <input type="number" min={1} max={MAX_QUANTITY} step={1} value={quantityText} disabled={!canBuy}
              onChange={event => setQuantityText(event.target.value)} />
          </label>
          <button type="button" disabled={!canBuy || adding} onClick={addToCart}>Thêm vào giỏ</button>
        </div>}
        {added && <p role="status">Đã thêm vào giỏ. <Link to="/member/cart">Xem giỏ hàng</Link></p>}
        {addError && <div className="form-error" role="alert"><p>{addError}</p>
          {pendingAdd && <button type="button" disabled={adding} onClick={() => void retryAdd()}><Icon name="retry" label="Thử lại" /></button>}</div>}

        <p className="hint">Cập nhật lúc {formatTime(product.asOf)}. Giá và tồn có thể đổi khi thêm vào giỏ.</p>
      </div>
    </div>
  </section>;
}
