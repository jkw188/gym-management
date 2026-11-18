import { apiClient } from '../../api/client';
export interface ReturnInput { version: number; reason: string; items: { orderItemId: string; quantity: number; restockable: boolean; conditionNote: string }[] }
export interface ReturnResult { returnId: string; refundId?: string; refundState: string; amount: string; movementIds: string[]; orderVersion: number }
export interface ReturnSummary { id: string; orderId: string; channel: string; reason: string; receivedAt: string; createdBy: string; amount: string; refundAmount: string; refundedAmount: string; outstandingRefundAmount: string; refunds: { id: string; status: string; amount: string }[] }
export interface ReturnDetail extends ReturnSummary { items: { id: string; orderItemId: string; name: string; sku: string; quantity: number; restockable: boolean; conditionNote: string; unitPrice: string; amount: string }[] }
export interface Eligibility { id: string; code: string; channel: string; status: string; version: number; fulfilledAt: string | null; returnDeadline: string | null; eligible: boolean; items: { id: string; name: string; sku: string; quantity: number; remaining: number; unitPrice: string }[] }
export const returnsApi = {
  eligibility(id: string) { return apiClient.request<Eligibility>(`/orders/${encodeURIComponent(id)}/return-eligibility`); },
  list(query: { orderId: string; fromDate: string; toDate: string; page: number }, signal?: AbortSignal) {
    const params = new URLSearchParams({ limit: '20' });
    for (const [key, value] of Object.entries(query)) if (value !== '') params.set(key, String(value));
    return apiClient.request<{ items: ReturnSummary[]; total: number; totalPages: number }>(`/returns?${params}`, { signal });
  },
  detail(id: string) { return apiClient.request<ReturnDetail>(`/returns/${encodeURIComponent(id)}`); },
};
