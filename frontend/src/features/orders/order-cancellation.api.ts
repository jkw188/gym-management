// Tầng giao diện – gọi API (US-45, dùng chung US-42): lệnh hủy đơn (Member/Staff), ghi khoản chuyển muộn và tra kết quả theo Idempotency-Key.
// Member ĐỌC đơn của mình qua my-orders.api.ts (US-42 bước 3).
import { apiClient } from '../../api/client';

export interface CancelResult {
  id: string; code: string; status: 'CANCELLED'; version: number; reservationState: 'RELEASED'; cancelledAt: string;
  transactionStatus: string; refundState: string; refundAmount: string; refundId?: string; notificationState: string;
}
export interface LateReceiptInput { method: 'TRANSFER'; amount: string; evidenceNote: string; receivingAccountCode: string; bankReference: string; receivedAt: string }
export interface LateReceiptResult { orderId: string; paymentId: string; refundId: string; refundState: 'PENDING'; transactionStatus: 'CANCELLED'; notificationState: string }
export type CancelOperation = 'ORDER_CANCEL_OWN' | 'ORDER_CANCEL_SUPPORT' | 'RETAIL_LATE_RECEIPT';
export type OrderCommand = { key: string; operation: CancelOperation; body: { version: number; reason: string } | LateReceiptInput };
export const cancellationApi = {
  send(id: string, command: OrderCommand) {
    const own = command.operation === 'ORDER_CANCEL_OWN', suffix = command.operation === 'RETAIL_LATE_RECEIPT' ? 'late-receipts' : 'cancel';
    return apiClient.request<CancelResult | LateReceiptResult>(`${own ? '/me' : ''}/orders/${encodeURIComponent(id)}/${suffix}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.key }, body: JSON.stringify(command.body),
    });
  },
  lookup(command: OrderCommand) { return apiClient.request<{ responseBody: CancelResult | LateReceiptResult }>(`/operations/${command.operation}/${encodeURIComponent(command.key)}`); },
};
