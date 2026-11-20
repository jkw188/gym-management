// Tầng giao diện – trang (US-42 bước 3): /member/orders – Member lọc lịch sử đơn → xem chi tiết → làm theo hướng dẫn thanh toán
// hoặc hủy có lý do → tải lại. Ba lớp trạng thái (đơn, tiền, hoàn) hiển thị riêng; mọi cờ và số liệu lấy từ server.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatVnd } from '../../utils/money';
import { notificationFeed } from '../notifications/notification-feed';
import { myOrdersApi, type OwnOrderDetail, type OwnOrderFilter, type OwnOrderPage, type OwnPaymentInstructions } from './my-orders.api';
import { OrderCancellation } from './OrderCancellation';
import { orderDate } from './orders.api';

// US-42-F02, TC05: nhãn riêng cho từng lớp trạng thái để không nhầm "đã trả" với "đã nhận hàng".
const ORDER_LABEL: Record<string, string> = { PENDING: 'Chờ xác nhận', CONFIRMED: 'Đã chuẩn bị', COMPLETED: 'Đã nhận hàng', CANCELLED: 'Đã hủy' };
const TRANSACTION_LABEL: Record<string, string> = { PENDING: 'Chưa thanh toán', SETTLED: 'Đã thanh toán', CANCELLED: 'Không thu' };
// NONE không có nhãn; "Đã hoàn" chỉ khi server báo SUCCEEDED (đã thực chi).
const REFUND_LABEL: Record<string, string> = { PENDING: 'Chờ hoàn', FAILED: 'Hoàn thất bại', SUCCEEDED: 'Đã hoàn' };
// Lựa chọn của bộ lọc dùng chung ORDER_LABEL để một trạng thái chỉ có một tên trên cả trang; giá trị gửi lên là mã trạng thái của spec.
const STATUS_OPTIONS = Object.entries(ORDER_LABEL);

const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : 'Không tải được đơn hàng';
const moneyOrUnknown = (value: string | null) => value === null ? 'Cần đối chiếu' : formatVnd(value);
const transactionLabel = (value: string | null) => value ? TRANSACTION_LABEL[value] : 'Cần đối chiếu';

export function MyOrdersPage() {
  // filter = bộ lọc đang áp dụng; statusInput/qInput = giá trị đang gõ, chỉ áp dụng khi bấm "Lọc".
  const [filter, setFilter] = useState<OwnOrderFilter>({ status: '', q: '', page: 1 });
  const [statusInput, setStatusInput] = useState('');
  const [qInput, setQInput] = useState('');
  const [reloadCount, setReloadCount] = useState(0);
  const [data, setData] = useState<OwnOrderPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    myOrdersApi.list(filter, controller.signal)
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(cause => {
        if (controller.signal.aborted) return;
        // US-42-TC12: lỗi thì bỏ danh sách cũ, chỉ hiện lỗi và nút Thử lại.
        setData(null);
        setError(messageOf(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filter, reloadCount, selectedId]);

  // Spec mục 2: socket báo thông báo mới hoặc vừa kết nối lại chỉ là TÍN HIỆU tải lại REST; dữ liệu luôn thay bằng kết quả server nên không trùng.
  useEffect(() => notificationFeed.subscribe(() => setReloadCount(value => value + 1)), []);

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    setFilter({ status: statusInput, q: qInput, page: 1 });
  }

  if (selectedId) return <OwnOrderDetailView id={selectedId} onBack={() => setSelectedId(null)} />;

  return <section className="auth-card orders-page">
    <h1>Đơn hàng của tôi</h1>
    {/* US-42-TC06: lọc theo trạng thái và một phần mã đơn. */}
    <form onSubmit={applyFilter}>
      <label>Trạng thái đơn
        <select value={statusInput} onChange={event => setStatusInput(event.target.value)}>
          <option value="">Tất cả</option>
          {STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>Tìm mã đơn<input value={qInput} maxLength={120} onChange={event => setQInput(event.target.value)} /></label>
      <button type="submit" disabled={loading}>Lọc</button>
    </form>
    {loading && <p role="status">Đang tải đơn hàng…</p>}
    {error && <><p role="alert">{error}</p><button type="button" onClick={() => setReloadCount(value => value + 1)}>Thử lại</button></>}
    {/* US-42-TC03: tài khoản chưa liên kết hồ sơ – không tự liên kết, chỉ hướng dẫn. */}
    {!loading && data?.memberLinked === false && <p>Tài khoản chưa được liên kết hồ sơ hội viên. Hãy liên hệ quầy để liên kết.</p>}
    {!loading && data?.memberLinked && data.items.length === 0 && <p>Chưa có đơn hàng</p>}
    {data && data.items.length > 0 && <ul className="order-list">
      {data.items.map(item => <li key={item.id}>
        <strong>{item.code}</strong> · {orderDate(item.createdAt)} · {moneyOrUnknown(item.total)}
        {' · '}Đơn: {ORDER_LABEL[item.status]} · Tiền: {transactionLabel(item.transactionStatus)}
        {item.refundState !== 'NONE' && <> · Hoàn: {REFUND_LABEL[item.refundState]}</>}
        {' '}<button type="button" onClick={() => setSelectedId(item.id)}>Xem {item.code}</button>
      </li>)}
    </ul>}
    {data && data.totalPages > 1 && <p>
      <button type="button" disabled={loading || filter.page <= 1} onClick={() => setFilter({ ...filter, page: filter.page - 1 })}>Trang trước</button>
      <span> Trang {filter.page} / {data.totalPages} </span>
      <button type="button" disabled={loading || filter.page >= data.totalPages} onClick={() => setFilter({ ...filter, page: filter.page + 1 })}>Trang sau</button>
    </p>}
  </section>;
}

// Chi tiết một đơn: snapshot, ba lớp trạng thái, hướng dẫn thanh toán (nếu server cho phép) và form hủy dùng chung của US-45.
function OwnOrderDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [order, setOrder] = useState<OwnOrderDetail | null>(null);
  const [instructions, setInstructions] = useState<OwnPaymentInstructions | null>(null);
  const [instructionsError, setInstructionsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Đang có lệnh hủy chưa rõ kết quả thì khóa nút rời trang/tải lại để không mất khóa.
  const [locked, setLocked] = useState(false);

  // Tải lại chi tiết từ server; không ném lỗi ra ngoài, lỗi hiện ngay trên trang.
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await myOrdersApi.detail(id);
      setOrder(next);
      setInstructions(null);
      setInstructionsError('');
      // US-42-TC07, TC08: chỉ gọi hướng dẫn thanh toán khi server báo paymentAllowed.
      if (next.paymentAllowed) {
        try { setInstructions(await myOrdersApi.paymentInstructions(id)); }
        catch (cause) { setInstructionsError(messageOf(cause)); }
      }
    } catch (cause) {
      // US-42-TC12: tải lại lỗi thì bỏ dữ liệu cũ (có thể đã lỗi thời), chỉ hiện lỗi và nút Thử lại.
      // Lệnh hủy đang treo (nếu có) vẫn giữ khóa trong sessionStorage và được khôi phục khi tải lại thành công.
      setOrder(null);
      setInstructions(null);
      setInstructionsError('');
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  // Socket chỉ gợi ý tải lại chi tiết từ REST (vd. nhân viên vừa thu tiền/chuẩn bị đơn).
  useEffect(() => notificationFeed.subscribe(() => { void load(); }), [load]);

  return <section>
    <h1>Đơn hàng của tôi</h1>
    {loading && <p role="status">Đang tải chi tiết đơn…</p>}
    {error && <p role="alert">{error}</p>}
    {order && <>
      <h2>{order.code}</h2>
      {/* US-42-F02, TC05: ba lớp trạng thái hiển thị riêng. */}
      <p>Đơn: {ORDER_LABEL[order.status]} · Tiền: {transactionLabel(order.transactionStatus)}
        {order.refundState !== 'NONE' && <> · Hoàn: {REFUND_LABEL[order.refundState]} {formatVnd(order.refundAmount)}</>}</p>
      <p>Đặt lúc {orderDate(order.createdAt)} · Hạn giữ hàng đến {orderDate(order.reservationExpiresAt)}</p>
      {order.confirmedAt && <p>Chuẩn bị xong lúc {orderDate(order.confirmedAt)}</p>}
      {order.fulfilledAt && <p>Bàn giao lúc {orderDate(order.fulfilledAt)}</p>}
      {order.cancelledAt && <p>Hủy lúc {orderDate(order.cancelledAt)} · Lý do: {order.cancellationReason}</p>}
      {/* US-42-TC08: hết hạn theo server; trang không tự đổi trạng thái hay giải phóng hàng. */}
      {order.expired && (order.status === 'PENDING' || order.status === 'CONFIRMED') &&
        <p>Đã hết hạn giữ hàng. Đơn đang chờ hệ thống hủy; nếu bạn đã chuyển khoản, hãy liên hệ quầy để đối chiếu.</p>}
      {/* US-42-F03: snapshot lúc đặt – tên, giá, người nhận, quầy không đổi theo catalog/hồ sơ hiện tại. */}
      <ul>{order.items.map(item => <li key={item.id}>{item.name} ({item.sku}) · {formatVnd(item.unitPrice)} × {item.quantity} = {formatVnd(item.lineTotal)}</li>)}</ul>
      <p>Tổng: {moneyOrUnknown(order.total)}</p>
      <p>Người nhận: {order.recipientName}{order.recipientPhone && ` · ${order.recipientPhone}`}</p>
      <p>Quầy nhận hàng: {order.pickupLocation}</p>
      {/* US-42-F05: đã thu và còn hạn → chỉ nhắc đến quầy nhận hàng. */}
      {order.transactionStatus === 'SETTLED' && !order.expired && (order.status === 'PENDING' || order.status === 'CONFIRMED') &&
        <p>Đơn đã thanh toán. Mời bạn đến quầy nhận hàng trước {orderDate(order.reservationExpiresAt)}.</p>}
      {instructionsError && <p>Không tải được hướng dẫn thanh toán: {instructionsError}</p>}
      {instructions && <PaymentInstructionsView value={instructions} deadline={order.reservationExpiresAt} />}
      {/* US-42-F04, TC09–TC11: hủy qua component dùng chung của US-45 (khóa Idempotency-Key, gửi lại cùng key, tra kết quả).
          Form chỉ hiện khi server báo cancelAllowed; sau khi hủy, component vẫn giữ để hiện kết quả. */}
      <OrderCancellation key={order.id} own allowed={order.cancelAllowed} onLockedChange={setLocked} onChanged={load}
        order={{ id: order.id, status: order.status, version: order.version, total: order.total, transactionStatus: order.transactionStatus,
          reservationState: order.reservationState, refunds: [] }} />
      <p>
        <button type="button" disabled={locked || loading} onClick={() => void load()}>Tải lại đơn</button>
        {' '}<button type="button" disabled={locked} onClick={onBack}>Về danh sách</button>
      </p>
    </>}
    {!order && !loading && <p>
      {error && <><button type="button" onClick={() => void load()}>Thử lại</button>{' '}</>}
      <button type="button" onClick={onBack}>Về danh sách</button>
    </p>}
  </section>;
}

// US-42-TC07: hướng dẫn thanh toán – mã giao dịch, số tiền, quầy, tiền mặt và tài khoản nhận đã cấu hình (nếu có).
// Không có nút "Tôi đã chuyển khoản": chỉ nhân viên xác nhận khoản thu.
function PaymentInstructionsView({ value, deadline }: { value: OwnPaymentInstructions; deadline: string }) {
  return <section aria-label="Hướng dẫn thanh toán">
    <h3>Hướng dẫn thanh toán</h3>
    <p>Mã giao dịch: <strong>{value.transactionCode}</strong> · Số tiền: {formatVnd(value.amountDue)} · Hạn: {orderDate(deadline)}</p>
    <p>Quầy: {value.pickupLocation}</p>
    <p>{value.cashInstructions}</p>
    {value.transferOptions && value.transferOptions.length > 0 && <ul>
      {value.transferOptions.map(option => <li key={option.receivingAccountCode}>
        Chuyển khoản: {option.bankName} · Số tài khoản {option.accountNumber} · {option.accountName}
        {/* Nội dung chuyển khoản do server đặt; thường trùng mã giao dịch ở trên nên không in lặp lại. */}
        {' · '}Nội dung: {option.transferContent === value.transactionCode ? 'ghi đúng mã giao dịch ở trên' : option.transferContent}
      </li>)}
    </ul>}
  </section>;
}
