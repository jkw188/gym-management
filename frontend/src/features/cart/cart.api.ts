// Tầng giao diện – gọi API (US-40 bước 3): giỏ hàng của Member – xem, thêm, đặt số lượng, xóa dòng.
// Tất cả qua apiClient (có access token). Không gửi memberId, giá hay tổng: server tự xác định chủ giỏ và tính tiền (US-40-F01, F04).
import { ApiError, apiClient } from '../../api/client';

export type CartLineReason = 'PRODUCT_UNAVAILABLE' | 'INVENTORY_UNAVAILABLE' | 'INSUFFICIENT_STOCK';

// Một dòng giỏ đúng như GET /api/me/cart trả (US-40 mục 3). name/giá null khi sản phẩm không còn tồn tại.
export interface CartItem {
  productId: string;
  sku: string | null;
  name: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPrice: string | null;
  lineTotal: string | null;
  availableQuantity: number | null;
  productVersion: number | null;
  lineState: 'OK' | 'BLOCKED';
  reasons: CartLineReason[];
}

export interface Cart {
  memberLinked: boolean;
  reason?: string;
  version: number;
  items: CartItem[];
  subtotal: string | null;
  totalsState: 'OK' | 'UNAVAILABLE' | 'OVER_LIMIT';
  readyForOrder: boolean;
  canCheckout: false;
  asOf: string;
}

// Một lệnh ghi giỏ. key (Idempotency-Key) do trang tạo và GIỮ cho tới khi biết kết quả,
// để "Thử lại" gửi đúng key + body cũ (US-40-TC10).
export type CartCommand =
  | { kind: 'ADD'; key: string; body: { version: number; productId: string; quantity: number } }
  | { kind: 'SET'; key: string; productId: string; body: { version: number; quantity: number } }
  | { kind: 'REMOVE'; key: string; productId: string; version: number };

// Lỗi mạng hoặc 5xx: chưa biết lệnh đã ghi hay chưa → giữ lệnh để "Thử lại" cùng key (US-40-TC10, TC13).
// Lỗi 4xx/409 là kết quả rõ ràng → bỏ lệnh, người dùng thao tác lại sẽ có key mới.
export function isOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === undefined || error.status >= 500;
}

export const cartApi = {
  get(signal?: AbortSignal) {
    return apiClient.request<Cart>('/me/cart', { signal });
  },

  // Gửi một lệnh ghi; thành công thì trang tự GET lại giỏ để thấy tổng và trạng thái dòng mới.
  send(command: CartCommand) {
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': command.key };
    if (command.kind === 'ADD') {
      return apiClient.request<unknown>('/me/cart/items', { method: 'POST', headers, body: JSON.stringify(command.body) });
    }
    const path = `/me/cart/items/${encodeURIComponent(command.productId)}`;
    if (command.kind === 'SET') {
      return apiClient.request<unknown>(path, { method: 'PUT', headers, body: JSON.stringify(command.body) });
    }
    // DELETE: version trên query, không có body (US-40 mục 3).
    return apiClient.request<unknown>(`${path}?version=${command.version}`, { method: 'DELETE', headers: { 'Idempotency-Key': command.key } });
  },
};
