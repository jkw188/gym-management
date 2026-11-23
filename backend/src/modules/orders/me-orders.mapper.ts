// Tầng kiểu dữ liệu (US-42 bước 1): đổi document đơn/dòng hàng/chứng từ thành dữ liệu trả về cho Member.
// Chỉ chép các field công khai theo bảng tên field của spec 1.0.1; tiền là chuỗi VND, thời điểm ISO UTC, không có thì null.
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { Invoice } from '../payments/schemas/invoice.schema';
import { Payment } from '../payments/schemas/payment.schema';
import { Transaction } from '../payments/schemas/transaction.schema';
import { Order, OrderItem } from './order.schema';

// Ngày giờ → chuỗi ISO, thiếu thì null.
const isoOrNull = (value: Date | undefined) => value ? value.toISOString() : null;

// Tóm tắt hoàn tiền do service tính từ collection refunds.
export type RefundSummary = { refundState: 'NONE' | 'PENDING' | 'FAILED' | 'SUCCEEDED'; refundAmount: string };
// Các cờ gợi ý do service tính (lệnh ghi vẫn kiểm lại).
export type OwnOrderFlags = { expired: boolean; cancelAllowed: boolean; paymentAllowed: boolean };

// Tóm tắt tên hàng cho danh sách đơn: 2 sản phẩm đầu kèm số lượng, còn lại gom thành "+N sản phẩm khác".
// Ví dụ: "Găng tay tập gym ×1, Whey 1kg ×2 +1 sản phẩm khác". Dùng tên snapshot lúc đặt, không đọc catalog hiện tại.
const SUMMARY_SHOWN = 2;
function itemsSummary(lines: Pick<OrderItem, 'name_snapshot' | 'quantity'>[]) {
  const shown = lines.slice(0, SUMMARY_SHOWN).map(line => `${line.name_snapshot} ×${line.quantity}`).join(', ');
  const rest = lines.length - SUMMARY_SHOWN;
  return rest > 0 ? `${shown} +${rest} sản phẩm khác` : shown;
}

// US-42 list item: {id, code, channel, status, transactionStatus, total, reservationExpiresAt, refundState, createdAt},
// bổ sung itemsSummary (tên hàng) theo yêu cầu của nhóm ngày 24/11/2026 – không có trong bản spec gốc.
export function toOwnListItem(order: Order, transaction: Transaction | null, refund: RefundSummary,
  lines: Pick<OrderItem, 'name_snapshot' | 'quantity'>[]) {
  return {
    itemsSummary: itemsSummary(lines),
    id: String(order._id), code: order.code, channel: order.channel, status: order.status,
    transactionStatus: transaction?.status ?? null, total: transaction ? fromVndDecimal(transaction.amount_due) : null,
    reservationExpiresAt: order.reservation_expires_at.toISOString(), refundState: refund.refundState, createdAt: order.created_at.toISOString(),
  };
}

// US-42-F03: dòng hàng dùng snapshot lúc đặt (sku/tên/giá), không đọc catalog hiện tại.
function toOwnLine(item: OrderItem) {
  return { sku: item.sku_snapshot, name: item.name_snapshot, unitPrice: fromVndDecimal(item.unit_price),
    quantity: item.quantity, lineTotal: fromVndDecimal(item.line_total) };
}

// US-42 detail: snapshot người nhận/quầy/dòng hàng, ba lớp trạng thái (đơn, giao dịch, hoàn tiền) và các cờ gợi ý.
// Không có confirmedBy/fulfilledBy/cancelledBy, giá vốn hay dữ liệu đối soát (US-42-TC04).
export function toOwnDetail(order: Order, items: OrderItem[], transaction: Transaction | null, refund: RefundSummary,
  invoiceId: string | null, flags: OwnOrderFlags, asOf: Date) {
  return {
    id: String(order._id), code: order.code, channel: order.channel, status: order.status, version: order.version,
    createdAt: order.created_at.toISOString(), confirmedAt: isoOrNull(order.confirmed_at), fulfilledAt: isoOrNull(order.fulfilled_at),
    cancelledAt: isoOrNull(order.cancelled_at), cancellationReason: order.cancellation_reason ?? null,
    reservationState: order.reservation_state, reservationExpiresAt: order.reservation_expires_at.toISOString(),
    expired: flags.expired, cancelAllowed: flags.cancelAllowed, paymentAllowed: flags.paymentAllowed,
    preferredPaymentMethod: order.preferred_payment_method, recipientName: order.recipient_name,
    recipientPhone: order.recipient_phone || null, pickupLocation: order.pickup_location_snapshot,
    items: items.map(item => ({ id: String(item._id), ...toOwnLine(item) })),
    total: transaction ? fromVndDecimal(transaction.amount_due) : null, transactionStatus: transaction?.status ?? null,
    refundState: refund.refundState, refundAmount: refund.refundAmount, invoiceId, asOf: asOf.toISOString(),
  };
}

// US-42 invoice: chứng từ chỉ đọc, dòng bán lẻ lấy từ snapshot đơn; payment chỉ có method/amount/paidAt, null khi đơn 0 đồng.
export function toOwnInvoice(invoice: Invoice, items: OrderItem[], payment: Payment | null) {
  return {
    invoiceNo: invoice.invoice_no, issuedAt: invoice.issued_at.toISOString(), buyerSnapshot: invoice.buyer_snapshot,
    total: fromVndDecimal(invoice.total_amount), retailLines: items.map(toOwnLine),
    payment: payment ? { method: payment.method, amount: fromVndDecimal(payment.amount), paidAt: isoOrNull(payment.paid_at) } : null,
  };
}
