// Tầng giao diện – trang (US-40 bước 3): /member/cart – Member xem giỏ, tăng/giảm/nhập số lượng, xóa dòng và xem tạm tính.
// Mọi số tiền, trạng thái dòng và tổng do server tính; trang chỉ hiển thị. Không có nút thanh toán ở Sprint 5 (US-40-F05).
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { formatVnd } from '../../utils/money';
import { useAuth } from '../auth/AuthProvider';
import { cartApi, isOutcomeUnknown, type Cart, type CartCommand, type CartItem, type CartLineReason } from './cart.api';

// US-40-F02: mỗi dòng 1–999.
const MIN_QUANTITY = 1;
const MAX_QUANTITY = 999;

// US-40-TC08: sản phẩm không còn tồn tại thì server trả name null.
const MISSING_NAME = 'Sản phẩm không còn tồn tại';

// US-40-TC05: chữ hiển thị cho lý do dòng bị chặn.
function reasonText(reason: CartLineReason, item: CartItem): string {
  if (reason === 'PRODUCT_UNAVAILABLE') return 'Sản phẩm ngừng bán';
  if (reason === 'INVENTORY_UNAVAILABLE') return 'Chưa có thông tin tồn kho';
  return `Chỉ còn ${item.availableQuantity ?? 0}`;
}

// US-40-TC08: tạm tính null thì nói rõ vì sao, không hiện số giả.
function subtotalText(cart: Cart): string {
  if (cart.subtotal !== null) return formatVnd(cart.subtotal);
  if (cart.totalsState === 'OVER_LIMIT') return 'Tổng tiền vượt mức cho phép';
  return 'Chưa tính được tạm tính';
}

export function CartPage() {
  const auth = useAuth();
  const userId = auth.user?.id;
  const [cart, setCart] = useState<Cart | null>(null);
  // Lỗi khi tải giỏ (chưa có dữ liệu để hiện).
  const [loadError, setLoadError] = useState('');
  // Lỗi của lệnh ghi; failedCommand còn giữ khi chưa biết kết quả để "Thử lại" cùng key.
  const [alert, setAlert] = useState('');
  const [failedCommand, setFailedCommand] = useState<CartCommand | null>(null);
  // Đang gửi lệnh hoặc đang tải lại sau lệnh → khóa mọi nút (US-40-TC10: bấm đúp chỉ một request).
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // Số đang gõ trong ô số lượng của từng dòng (theo productId), chưa gửi.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [inputError, setInputError] = useState('');
  // Chỉ nhận kết quả của lần tải mới nhất (bỏ kết quả cũ về muộn).
  const loadNo = useRef(0);
  // Giỏ đang hiện trên màn hình, để lần tải sau so đơn giá. Dùng ref vì loadCart không đọc lại state mới nhất.
  const shownCart = useRef<Cart | null>(null);
  // productId của các dòng có đơn giá khác lần hiển thị trước (spec mục 3: giá thay khi refresh phải cập nhật rõ).
  const [priceChanged, setPriceChanged] = useState<string[]>([]);

  // Tải giỏ từ server. Lần đầu (chưa có giỏ) hiện "Đang tải"; tải lại sau lệnh thì giữ giỏ cũ trên màn hình.
  const loadCart = useCallback(async () => {
    const myNo = ++loadNo.current;
    setLoadError('');
    try {
      const result = await cartApi.get();
      if (myNo !== loadNo.current) return;
      // US-40-TC16: dòng vẫn còn trong giỏ nhưng đơn giá khác lần trước → đánh dấu để báo "Giá đã thay đổi".
      // Lần tải đầu (chưa có giỏ cũ) thì không báo.
      const previous = shownCart.current;
      const changed = previous === null ? [] : result.items
        .filter(item => {
          const old = previous.items.find(oldItem => oldItem.productId === item.productId);
          return old !== undefined && old.unitPrice !== item.unitPrice;
        })
        .map(item => item.productId);
      shownCart.current = result;
      setPriceChanged(changed);
      setCart(result);
      setDrafts({});
    } catch (failure) {
      if (myNo !== loadNo.current) return;
      setLoadError(failure instanceof ApiError ? failure.message : 'Không tải được giỏ hàng.');
    }
  }, []);

  // US-40-TC16: đổi tài khoản thì bỏ giỏ, lỗi và lệnh đang giữ của tài khoản trước rồi tải giỏ mới.
  useEffect(() => {
    setCart(null);
    shownCart.current = null;
    setPriceChanged([]);
    setAlert('');
    setFailedCommand(null);
    void loadCart();
    return () => { loadNo.current++; };
  }, [userId, loadCart]);

  // Gửi một lệnh ghi rồi tải lại giỏ. Không tự gửi lại khi lỗi (US-40-TC09).
  async function run(command: CartCommand) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setAlert('');
    setInputError('');
    try {
      await cartApi.send(command);
      setFailedCommand(null);
    } catch (failure) {
      const message = failure instanceof ApiError ? failure.message : 'Không kết nối được máy chủ.';
      if (failure instanceof ApiError && failure.code === 'CART_VERSION_CONFLICT') {
        // US-40-TC09: giỏ đã đổi ở tab khác → báo và tải lại, KHÔNG gửi lại lệnh cũ.
        setAlert('Giỏ hàng đã thay đổi, vui lòng kiểm tra lại.');
        setFailedCommand(null);
      } else if (isOutcomeUnknown(failure)) {
        // US-40-TC10: chưa biết kết quả → giữ nguyên lệnh (cùng key, cùng body) cho nút "Thử lại".
        setAlert(message);
        setFailedCommand(command);
        busyRef.current = false;
        setBusy(false);
        return;
      } else {
        // Lỗi nghiệp vụ rõ ràng (ngừng bán, vượt tồn…): báo lý do của server rồi tải lại.
        setAlert(message);
        setFailedCommand(null);
      }
    }
    // Thành công hoặc lỗi rõ ràng: lấy lại giỏ để có version, giá, tồn và tổng mới nhất.
    await loadCart();
    busyRef.current = false;
    setBusy(false);
  }

  // Mỗi thao tác mới của người dùng có Idempotency-Key mới; chỉ "Thử lại" mới dùng lại key cũ.
  function setQuantity(item: CartItem, quantity: number) {
    if (!cart) return;
    void run({ kind: 'SET', key: crypto.randomUUID(), productId: item.productId, body: { version: cart.version, quantity } });
  }

  function remove(item: CartItem) {
    if (!cart) return;
    void run({ kind: 'REMOVE', key: crypto.randomUUID(), productId: item.productId, version: cart.version });
  }

  // US-40-TC01, TC04: nhập số rồi Enter → PUT số tuyệt đối; sai định dạng thì báo, không gửi.
  function onQuantityKey(event: KeyboardEvent<HTMLInputElement>, item: CartItem) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const text = (drafts[item.productId] ?? String(item.quantity)).trim();
    const value = Number(text);
    if (!/^\d+$/.test(text) || value < MIN_QUANTITY || value > MAX_QUANTITY) {
      setInputError(`Số lượng từ ${MIN_QUANTITY} đến ${MAX_QUANTITY}. Muốn bỏ sản phẩm hãy bấm Xóa.`);
      return;
    }
    setInputError('');
    if (value !== item.quantity) setQuantity(item, value);
  }

  // ---------- Hiển thị ----------

  if (!cart) {
    return <section className="auth-card">
      <h1>Giỏ hàng</h1>
      {loadError
        // US-40-TC16: lỗi mạng/503 có nút thử lại, không hiện giỏ giả.
        ? <div className="form-error" role="alert"><p>{loadError}</p>
          <button type="button" onClick={() => void loadCart()}><Icon name="retry" label="Thử lại" /></button></div>
        : <p>Đang tải giỏ hàng...</p>}
    </section>;
  }

  // US-40-F01, US-40-TC03: chưa liên kết hồ sơ → chỉ báo, không có danh sách hay nút sửa.
  if (!cart.memberLinked) {
    return <section className="auth-card">
      <h1>Giỏ hàng</h1>
      <p>Tài khoản của bạn chưa được liên kết hồ sơ hội viên. Vui lòng liên hệ quầy lễ tân để liên kết trước khi dùng giỏ hàng.</p>
    </section>;
  }

  return <section className="auth-card">
    <h1>Giỏ hàng</h1>

    {alert && <div className="form-error" role="alert"><p>{alert}</p>
      {failedCommand && <button type="button" disabled={busy} onClick={() => void run(failedCommand)}>
        <Icon name="retry" label="Thử lại" /></button>}</div>}
    {inputError && <p className="form-error">{inputError}</p>}
    {/* Tải lại sau thao tác bị lỗi: giữ giỏ đang hiện và báo để người dùng tải lại trang. */}
    {loadError && <p className="form-error">Chưa tải lại được giỏ hàng: {loadError}</p>}

    {/* US-40-TC16: giỏ trống, tạm tính 0, không có nút thanh toán. */}
    {cart.items.length === 0
      ? <p>Giỏ hàng trống</p>
      : <ul aria-label="Dòng giỏ hàng" className="cart-lines">
        {cart.items.map(item => {
          const name = item.name ?? MISSING_NAME;
          return <li key={item.productId}>
            <p><strong>{name}</strong>{item.sku && <> – Mã: {item.sku}</>}</p>
            <p>Đơn giá: {item.unitPrice !== null ? formatVnd(item.unitPrice) : 'Chưa có giá'}</p>
            <p>Thành tiền: {item.lineTotal !== null ? formatVnd(item.lineTotal) : 'Chưa tính được'}</p>
            {/* US-40-TC05: dòng bị chặn vẫn giữ trong giỏ và nói rõ lý do. */}
            {item.reasons.map(reason => <p key={reason} className="form-error">{reasonText(reason, item)}</p>)}
            {/* US-40-TC16: báo rõ giá mới, không giữ hay tự chốt giá cũ. */}
            {priceChanged.includes(item.productId) && <p role="status">Giá đã thay đổi, đơn giá trên là giá hiện tại.</p>}
            <div className="toolbar">
              {/* US-40-TC04, TC06: giảm khóa khi còn 1 (bỏ thì bấm Xóa); dòng bị chặn vẫn giảm được để dọn giỏ. */}
              <button type="button" aria-label={`Giảm ${name}`} disabled={busy || item.quantity <= MIN_QUANTITY}
                onClick={() => setQuantity(item, item.quantity - 1)}>−</button>
              <input type="number" aria-label={`Số lượng ${name}`} min={MIN_QUANTITY} max={MAX_QUANTITY} step={1} disabled={busy}
                value={drafts[item.productId] ?? String(item.quantity)}
                onChange={event => setDrafts(current => ({ ...current, [item.productId]: event.target.value }))}
                onKeyDown={event => onQuantityKey(event, item)} />
              {/* US-40-TC05: dòng bị chặn không được tăng; đủ 999 cũng khóa. */}
              <button type="button" aria-label={`Tăng ${name}`}
                disabled={busy || item.lineState === 'BLOCKED' || item.quantity >= MAX_QUANTITY}
                onClick={() => setQuantity(item, item.quantity + 1)}>+</button>
              <button type="button" aria-label={`Xóa ${name}`} disabled={busy} onClick={() => remove(item)}>Xóa</button>
            </div>
          </li>;
        })}
      </ul>}

    <p><strong>Tạm tính: {subtotalText(cart)}</strong></p>
    {/* US-40-F05: canCheckout luôn false ở Sprint 5 → không đặt nút thanh toán giả, chỉ hướng dẫn. */}
    <p>Chức năng đặt hàng sẽ có ở đợt cập nhật sau. Giá và tồn kho được kiểm lại khi đặt hàng.</p>
  </section>;
}
