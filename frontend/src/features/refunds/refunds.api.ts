import { apiClient } from '../../api/client';
export interface RefundSummary { id: string; orderId: string; paymentId: string; returnId: string | null; source: string; reference: string; amount: string; status: string; createdAt: string; refundedAt: string | null }
export interface RefundDetail extends RefundSummary {
  createdBy: string | null; actorType: string; orderCode: string | null; cancellationReason: string | null; cancelledAt: string | null;
  payment: { id: string; transactionId: string; method: string; amount: string; status: string; reference: string; receiptPurpose: string; paidAt: string | null; verifiedAt: string | null; evidenceNote: string | null } | null;
}
export interface RefundQuery { status: string; orderId: string; fromDate: string; toDate: string; page: number; limit: number }
export const refundsApi = {
  list(query: RefundQuery, signal?: AbortSignal) {
    const params = new URLSearchParams(); for (const [key, value] of Object.entries(query)) if (value !== '') params.set(key, String(value));
    return apiClient.request<{ items: RefundSummary[]; total: number; totalPages: number }>(`/refunds?${params}`, { signal });
  },
  detail(id: string) { return apiClient.request<RefundDetail>(`/refunds/${encodeURIComponent(id)}`); },
};
