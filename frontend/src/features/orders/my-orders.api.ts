// Tầng giao diện – gọi API (US-42 bước 3): Member đọc danh sách/chi tiết đơn của mình và hướng dẫn thanh toán.
// Kiểu dữ liệu theo bảng tên field của spec US-42 1.0.1. Lệnh hủy dùng cancellationApi của US-45 (order-cancellation.api.ts).
import { apiClient } from '../../api/client';

export type OwnOrderStatus = 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
export type OwnTransactionStatus = 'PENDING' | 'SETTLED' | 'CANCELLED';
export type OwnRefundState = 'NONE' | 'PENDING' | 'FAILED' | 'SUCCEEDED';

export interface OwnOrderListItem {
  id: string; code: string; channel: 'WEBSITE' | 'POS'; status: OwnOrderStatus; transactionStatus: OwnTransactionStatus | null;
  total: string | null; reservationExpiresAt: string; refundState: OwnRefundState; createdAt: string;
}
export interface OwnOrderPage {
  memberLinked: boolean; items: OwnOrderListItem[]; page: number; limit: number; total: number; totalPages: number; asOf: string;
}
export interface OwnOrderDetail {
  id: string; code: string; channel: 'WEBSITE' | 'POS'; status: OwnOrderStatus; version: number;
  createdAt: string; confirmedAt: string | null; fulfilledAt: string | null; cancelledAt: string | null; cancellationReason: string | null;
  reservationState: 'HELD' | 'CONSUMED' | 'RELEASED'; reservationExpiresAt: string; expired: boolean; cancelAllowed: boolean; paymentAllowed: boolean;
  preferredPaymentMethod: 'CASH' | 'TRANSFER'; recipientName: string; recipientPhone: string | null; pickupLocation: string;
  items: { id: string; sku: string; name: string; unitPrice: string; quantity: number; lineTotal: string }[];
  total: string | null; transactionStatus: OwnTransactionStatus | null; refundState: OwnRefundState; refundAmount: string;
  invoiceId: string | null; asOf: string;
}
export interface OwnPaymentInstructions {
  transactionCode: string; amountDue: string; preferredPaymentMethod: 'CASH' | 'TRANSFER'; pickupLocation: string; cashInstructions: string;
  transferOptions?: { receivingAccountCode: string; bankName: string; accountNumber: string; accountName: string; transferContent: string }[];
}
// Bộ lọc danh sách; chuỗi rỗng nghĩa là không lọc.
export interface OwnOrderFilter { status: string; q: string; page: number }

export const myOrdersApi = {
  // GET /api/me/orders – US-42-TC06: q cắt khoảng trắng, trống thì không gửi (server trả 400 nếu q rỗng).
  list(filter: OwnOrderFilter, signal?: AbortSignal) {
    const params = new URLSearchParams({ page: String(filter.page), limit: '20' });
    if (filter.status) params.set('status', filter.status);
    const q = filter.q.trim();
    if (q) params.set('q', q);
    return apiClient.request<OwnOrderPage>(`/me/orders?${params}`, { signal });
  },
  detail(id: string, signal?: AbortSignal) {
    return apiClient.request<OwnOrderDetail>(`/me/orders/${encodeURIComponent(id)}`, { signal });
  },
  paymentInstructions(id: string, signal?: AbortSignal) {
    return apiClient.request<OwnPaymentInstructions>(`/me/orders/${encodeURIComponent(id)}/payment-instructions`, { signal });
  },
};
