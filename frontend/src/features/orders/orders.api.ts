import { apiClient } from '../../api/client';

export interface OrderSummary {
  id: string; code: string; channel: 'WEBSITE' | 'POS'; status: 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED'; version: number;
  transactionId: string; transactionStatus: 'PENDING' | 'SETTLED' | 'CANCELLED' | null; memberId: string | null; total: string | null;
  reservationState: string; reservationExpiresAt: string; expired: boolean; createdAt: string; updatedAt: string;
  // Tên hàng tóm tắt do server ghép từ snapshot lúc đặt, ví dụ "Găng tay tập gym ×1, Whey 1kg ×2".
  itemsSummary?: string;
  permittedActions: { prepare: boolean; prepareBlockedReason: string | null; fulfill: boolean; fulfillBlockedReason: string | null };
}
export interface OrderDetail extends OrderSummary {
  cancelledAt?: string | null; cancellationReason?: string | null; cancellationSource?: string | null;
  recipient: { name: string; phone: string }; pickupLocation: string; asOf: string; confirmedAt: string | null; confirmedBy: string | null;
  fulfilledAt: string | null; fulfilledBy: string | null; movementIds: string[];
  items: { id: string; productId: string; skuSnapshot: string; nameSnapshot: string; quantity: number; unitPrice: string; lineTotal: string }[];
  invoice: { id: string; invoiceNo: string; totalAmount: string; issuedAt: string } | null;
  refunds: { id: string; status: string; amount: string }[];
}
export interface OrderQuery { channel: string; status: string; transactionStatus: string; q: string; memberId: string; fromDate: string; toDate: string; page: number; limit: number }
export interface PreparedOrder { id: string; code: string; status: 'CONFIRMED'; version: number; confirmedAt: string; confirmedBy: string; reservationExpiresAt: string; notificationState: string }
export interface FulfilledOrder { id: string; code: string; status: 'COMPLETED'; reservationState: 'CONSUMED'; version: number; fulfilledAt: string; fulfilledBy: string; movementIds: string[]; notificationState: string }
export const ordersApi = {
  list(query: OrderQuery, signal?: AbortSignal) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== '') params.set(key, String(value));
    return apiClient.request<{ items: OrderSummary[]; total: number; totalPages: number; page: number; limit: number }>(`/orders?${params}`, { signal });
  },
  detail(id: string, signal?: AbortSignal) { return apiClient.request<OrderDetail>(`/orders/${encodeURIComponent(id)}`, { signal }); },
  prepare(id: string, version: number, key: string) {
    return apiClient.request<PreparedOrder>(`/orders/${encodeURIComponent(id)}/prepare`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ version }) });
  },
  lookup(key: string) { return apiClient.request<{ status: 'COMMITTED'; responseBody: PreparedOrder }>(`/operations/ORDER_PREPARE/${encodeURIComponent(key)}`); },
  fulfill(id: string, version: number, key: string, channel: 'WEBSITE' | 'POS' = 'WEBSITE') {
    return apiClient.request<FulfilledOrder>(`${channel === 'POS' ? '/pos' : ''}/orders/${encodeURIComponent(id)}/fulfill`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ version }) });
  },
  lookupFulfillment(key: string, channel: 'WEBSITE' | 'POS' = 'WEBSITE') { return apiClient.request<{ status: 'COMMITTED'; responseBody: FulfilledOrder }>(`/operations/ORDER_FULFILL_${channel}/${encodeURIComponent(key)}`); },
};
export const orderDate = (value: string) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
export const orderMoney = (value: string) => `${new Intl.NumberFormat('vi-VN').format(BigInt(value))} VND`;
export const orderStatus = { PENDING: 'Chờ chuẩn bị', CONFIRMED: 'Đã chuẩn bị', COMPLETED: 'Đã bàn giao', CANCELLED: 'Đã hủy' };
export const transactionStatus = { PENDING: 'Chưa xác nhận thanh toán', SETTLED: 'Đã thanh toán', CANCELLED: 'Giao dịch đã hủy' };
