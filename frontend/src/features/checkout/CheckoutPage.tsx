// Tầng giao diện – trang (US-41 bước 4): /member/checkout – Member xem giá và quầy nhận, nhập người nhận/cách trả, xác nhận đặt hàng một lần.
// Giá, tổng và trạng thái do server quyết định; trang chỉ hiển thị. Không có nút "tôi đã trả" (US-41-F04).
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { formatVnd } from '../../utils/money';
import { cartApi, isOutcomeUnknown, type Cart } from '../cart/cart.api';
import { checkoutApi, type CreatedOrder, type CreateOrderCommand, type OrderPreview, type PaymentMethod } from './checkout.api';

// US-41-F01: tên người nhận sau trim từ 2 đến 120 ký tự.
const NAME_MIN = 2;
const NAME_MAX = 120;

// US-41-TC18: giá/giỏ đổi → tải lại và yêu cầu xác nhận giá mới.
const CHANGED_CODES = ['QUOTE_STALE', 'QUOTE_EXPIRED', 'CART_VERSION_CONFLICT'];

// Hạn giữ hàng hiển thị theo giờ Việt Nam, dạng dd/mm/yyyy, HH:mm.
function vietnamTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

// US-41-F04: trạng thái đơn và trạng thái tiền là hai thứ riêng.
function orderStatusText(status: string): string {
  if (status === 'PENDING') return 'Chờ xác nhận';
  if (status === 'CONFIRMED') return 'Đã xác nhận';
  return status;
}
function paymentStatusText(status: string): string {
  return status === 'SETTLED' ? 'Đã thanh toán' : 'Chưa thanh toán';
}

export function CheckoutPage() {
  const [cart, setCart] = useState<Cart | null>(null);
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [empty, setEmpty] = useState(false);
  // Lỗi khi tải giỏ/xem giá (chưa có giá để hiện).
  const [loadError, setLoadError] = useState('');

  // Thông tin người nhận: giữ nguyên khi tải lại giá (US-41-TC18).
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [nameError, setNameError] = useState('');

  // Lỗi của lệnh tạo đơn; failedCommand còn giữ khi chưa biết kết quả để "Thử lại" cùng key.
  const [alert, setAlert] = useState('');
  const [failedCommand, setFailedCommand] = useState<CreateOrderCommand | null>(null);
  // Đang gửi lệnh → khóa nút (US-41-TC18: bấm đúp chỉ một POST).
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [created, setCreated] = useState<CreatedOrder | null>(null);

  // Lấy giỏ hiện tại rồi xem giá theo đúng version giỏ đó. Không tự gửi lệnh tạo đơn.
  const load = useCallback(async () => {
    setLoadError('');
    try {
      const currentCart = await cartApi.get();
      setCart(currentCart);
      if (!currentCart.memberLinked || currentCart.items.length === 0) {
        setEmpty(currentCart.items.length === 0);
        return;
      }
      const result = await checkoutApi.preview(currentCart.version);
      setEmpty(false);
      setPreview(result);
    } catch (failure) {
      // US-41-TC18: server báo giỏ trống → không hiện form.
      if (failure instanceof ApiError && failure.code === 'CART_EMPTY') {
        setEmpty(true);
        setPreview(null);
        return;
      }
      setLoadError(failure instanceof ApiError ? failure.message : 'Không tải được giá đơn hàng.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Gửi lệnh tạo đơn. Không tự gửi lại khi lỗi.
  async function send(command: CreateOrderCommand) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setAlert('');
    try {
      const result = await checkoutApi.create(command);
      setFailedCommand(null);
      setCreated(result);
    } catch (failure) {
      if (isOutcomeUnknown(failure)) {
        // Lỗi mạng/503: chưa biết đơn đã tạo chưa → giữ đúng lệnh (cùng key, cùng body) cho nút "Thử lại".
        setFailedCommand(command);
        setAlert('Chưa rõ đơn đã được tạo hay chưa. Bấm "Thử lại" để kiểm tra, hệ thống không tạo đơn thứ hai.');
      } else {
        // Lỗi rõ ràng: bỏ lệnh cũ; tải lại giỏ + giá trước rồi mới báo, lần xác nhận sau là ý định mới với key mới.
        setFailedCommand(null);
        await load();
        const code = failure instanceof ApiError ? failure.code ?? '' : '';
        setAlert(CHANGED_CODES.includes(code)
          ? 'Giá hoặc giỏ hàng đã thay đổi. Vui lòng xem lại giá mới rồi xác nhận lại.'
          : (failure as ApiError).message);
      }
    }
    busyRef.current = false;
    setBusy(false);
  }

  // US-41-TC18: mỗi lần bấm "Xác nhận đặt hàng" là một ý định mới → Idempotency-Key mới.
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!cart || !preview || busyRef.current) return;
    const name = recipientName.trim();
    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      setNameError(`Tên người nhận từ ${NAME_MIN} đến ${NAME_MAX} ký tự`);
      return;
    }
    setNameError('');
    void send({ key: crypto.randomUUID(), body: {
      cartVersion: cart.version, quoteToken: preview.quoteToken, recipientName: name,
      recipientPhone: recipientPhone.trim(), preferredPaymentMethod: method,
    } });
  }

  // ---------- Hiển thị ----------

  // Tạo đơn xong: hiện mã đơn, trạng thái đơn và trạng thái tiền riêng. Chưa bàn giao (US-44).
  if (created) {
    return <section className="auth-card">
      <h1>Đặt hàng</h1>
      <p role="status"><strong>Đã tạo đơn {created.code}</strong></p>
      <p>Trạng thái đơn: {orderStatusText(created.status)}</p>
      <p>Thanh toán: {paymentStatusText(created.transactionStatus)}</p>
      <p>Tổng cộng: {formatVnd(created.total)}</p>
      <p>Giữ hàng tại quầy đến {vietnamTime(created.reservationExpiresAt)} (giờ Việt Nam).</p>
      <Link to="/member/orders">Xem đơn hàng của tôi</Link>
    </section>;
  }

  if (cart && !cart.memberLinked) {
    return <section className="auth-card">
      <h1>Đặt hàng</h1>
      <p>Tài khoản của bạn chưa được liên kết hồ sơ hội viên. Vui lòng liên hệ quầy lễ tân để liên kết trước khi đặt hàng.</p>
    </section>;
  }

  if (empty) {
    return <section className="auth-card">
      <h1>Đặt hàng</h1>
      <p>Giỏ hàng trống</p>
      <Link to="/member/cart">Quay lại giỏ hàng</Link>
    </section>;
  }

  if (!preview) {
    return <section className="auth-card">
      <h1>Đặt hàng</h1>
      {loadError
        ? <div className="form-error" role="alert"><p>{loadError}</p>
          <button type="button" onClick={() => void load()}><Icon name="retry" label="Thử lại" /></button></div>
        : <p>Đang tải giá đơn hàng...</p>}
    </section>;
  }

  return <section className="auth-card">
    <h1>Đặt hàng</h1>

    {alert && <div className="form-error" role="alert"><p>{alert}</p>
      {failedCommand && <button type="button" disabled={busy} onClick={() => void send(failedCommand)}>
        <Icon name="retry" label="Thử lại" /></button>}</div>}
    {loadError && <p className="form-error">Chưa tải lại được giá: {loadError}</p>}

    <ul aria-label="Dòng đơn hàng" className="cart-lines">
      {preview.items.map(item => <li key={item.productId}>
        <p><strong>{item.name}</strong> – Mã: {item.sku}</p>
        <p>Số lượng: {item.quantity} × {formatVnd(item.unitPrice)}</p>
        <p>Thành tiền: {formatVnd(item.lineTotal)}</p>
      </li>)}
    </ul>
    <p><strong>Tổng cộng: {formatVnd(preview.total)}</strong></p>
    <p>Nhận tại: {preview.pickupLocation}</p>

    <form onSubmit={submit} noValidate>
      <label>Tên người nhận
        <input value={recipientName} onChange={event => setRecipientName(event.target.value)} autoComplete="name" />
      </label>
      {nameError && <p className="form-error">{nameError}</p>}
      <label>Số điện thoại người nhận
        <input value={recipientPhone} onChange={event => setRecipientPhone(event.target.value)} autoComplete="tel" inputMode="tel" />
      </label>

      <fieldset>
        <legend>Cách thanh toán dự kiến</legend>
        <label><input type="radio" name="method" checked={method === 'CASH'} onChange={() => setMethod('CASH')} /> Tiền mặt</label>
        <label><input type="radio" name="method" checked={method === 'TRANSFER'} onChange={() => setMethod('TRANSFER')} /> Chuyển khoản</label>
      </fieldset>
      {/* US-41-F04: chuyển khoản chỉ là ý định; nhân viên xác minh mới ghi nhận đã trả. */}
      {method === 'TRANSFER' && <p>Đơn chuyển khoản phải chờ nhân viên xác minh khoản tiền trước khi ghi nhận thanh toán.</p>}

      <button type="submit" disabled={busy}>Xác nhận đặt hàng</button>
    </form>
  </section>;
}
