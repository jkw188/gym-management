import { apiClient } from '../../api/client';

export interface CancelResult {
  id: string; code: string; status: 'CANCELLED'; version: number; reservationState: 'RELEASED'; cancelledAt: string;
  transactionStatus: string; refundState: string; refundAmount: string; refundId?: string; notificationState: string;
}
export interface LateReceiptInput { method: 'TRANSFER'; amount: string; evidenceNote: string; receivingAccountCode: string; bankReference: string; receivedAt: string }
export interface LateReceiptResult { orderId: string; paymentId: string; refundId: string; refundState: 'PENDING'; transactionStatus: 'CANCELLED'; notificationState: string }
export type CancelOperation = 'ORDER_CANCEL_OWN' | 'ORDER_CANCEL_SUPPORT' | 'RETAIL_LATE_RECEIPT';
export type OrderCommand = { key: string; operation: CancelOperation; body: { version: number; reason: string } | LateReceiptInput };
export interface OwnOrder {
  id: string; code: string; channel: string; status: 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED'; version: number;
  reservationState: string; reservationExpiresAt: string; expired: boolean; asOf: string; total: string | null; transactionStatus: 'PENDING' | 'SETTLED' | 'CANCELLED' | null;
  cancellationReason: string | null; cancelledAt: string | null;
  items: { id: string; name: string; quantity: number; lineTotal: string }[]; refunds: { id: string; status: string; amount: string }[];
}
export const cancellationApi = {
  send(id: string, command: OrderCommand) {
    const own = command.operation === 'ORDER_CANCEL_OWN', suffix = command.operation === 'RETAIL_LATE_RECEIPT' ? 'late-receipts' : 'cancel';
    return apiClient.request<CancelResult | LateReceiptResult>(`${own ? '/me' : ''}/orders/${encodeURIComponent(id)}/${suffix}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.key }, body: JSON.stringify(command.body),
    });
  },
  lookup(command: OrderCommand) { return apiClient.request<{ responseBody: CancelResult | LateReceiptResult }>(`/operations/${command.operation}/${encodeURIComponent(command.key)}`); },
  ownList(page: number, signal?: AbortSignal) { return apiClient.request<{ items: OwnOrder[]; memberLinked: boolean; totalPages: number; total: number }>(`/me/orders?page=${page}&limit=20`, { signal }); },
  ownDetail(id: string) { return apiClient.request<OwnOrder>(`/me/orders/${encodeURIComponent(id)}`); },
};
