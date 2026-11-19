// Tầng giao diện – gọi API (US-41 bước 4): Member xem giá đơn website và tạo đơn từ giỏ của mình.
// Tất cả qua apiClient (có access token). Không gửi memberId, giá hay tổng: server tự xác định Member và tính tiền (US-41 mục 5).
import { apiClient } from '../../api/client';

// Một dòng trong kết quả xem giá (POST /api/me/orders/preview).
export interface PreviewItem {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  productVersion: number;
  unitPrice: string;
  lineTotal: string;
}

export interface OrderPreview {
  items: PreviewItem[];
  total: string;
  // US-41-Q01: chỉ giữ trong bộ nhớ của trang, không lưu localStorage/sessionStorage hay URL.
  quoteToken: string;
  quoteExpiresAt: string;
  pickupLocation: string;
  asOf: string;
}

export type PaymentMethod = 'CASH' | 'TRANSFER';

// Body của POST /api/me/orders – đúng các field spec cho phép.
export interface CreateOrderBody {
  cartVersion: number;
  quoteToken: string;
  recipientName: string;
  recipientPhone: string;
  preferredPaymentMethod: PaymentMethod;
}

// Lệnh tạo đơn: key (Idempotency-Key) do trang tạo và GIỮ cho tới khi biết kết quả,
// để "Thử lại" gửi đúng key + body cũ (US-41-TC14, TC18).
export interface CreateOrderCommand {
  key: string;
  body: CreateOrderBody;
}

// Kết quả 201 của POST /api/me/orders.
export interface CreatedOrder {
  id: string;
  code: string;
  status: string;
  transactionId: string;
  transactionStatus: 'PENDING' | 'SETTLED';
  total: string;
  reservationExpiresAt: string;
  reservationState: string;
  cartVersion: number;
  invoiceId?: string;
  notificationState: string;
}

export const checkoutApi = {
  preview(cartVersion: number) {
    return apiClient.request<OrderPreview>('/me/orders/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cartVersion }),
    });
  },

  create(command: CreateOrderCommand) {
    return apiClient.request<CreatedOrder>('/me/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.key },
      body: JSON.stringify(command.body),
    });
  },
};
