import { apiClient } from '../../api/client';

export interface SalePlan {
  id: string; name: string; kind: 'GYM' | 'PT'; planVersion: number; durationDays: number;
  sessions: number; price: string; benefits: string;
}
export interface SaleInput { memberId: string; planId: string; planVersion: number; startDate: string }
export interface SalePreview {
  planVersion: number; amountDue: string; kind: 'GYM' | 'PT'; requestedStartDate: string;
  expectedEndDate: string; canProceed: boolean; blockingCode?: string;
}
export interface SaleDetail {
  operation?: 'REGISTER' | 'RENEW' | 'UPGRADE'; previousSaleId?: string; planId?: string; channel?: 'COUNTER' | 'SELF_SERVICE';
  saleId: string; transactionId: string; transactionCode: string; transactionStatus: 'PENDING' | 'SETTLED' | 'CANCELLED';
  transactionVersion: number; amountDue: string; planName: string; benefits: string; sessions: number;
  requestedStartDate: string; startDate: string; endDate: string; membershipId?: string; invoiceId?: string; invoiceNumber?: string;
  notificationState: 'NOT_CREATED' | 'STORED' | 'NO_LINKED_ACCOUNT'; cancelReason?: string;
}
export interface PendingSales {
  items: { saleId: string; transactionCode: string; kind: string }[]; page: number; total: number;
}
const post = <T>(path: string, input: unknown, key?: string) => apiClient.request<T>(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(input),
});
export const salesApi = {
  catalog: () => apiClient.request<{ items: SalePlan[] }>('/service-sales/plans'),
  pending: (memberId: string, page = 1) => apiClient.request<PendingSales>(`/service-sales?${new URLSearchParams({ memberId, page: String(page) })}`),
  preview: (input: SaleInput) => post<SalePreview>('/service-sales/preview', input),
  create: (input: SaleInput, key: string) => post<SaleDetail>('/service-sales', input, key),
  detail: (id: string) => apiClient.request<SaleDetail>(`/service-sales/${encodeURIComponent(id)}`),
  cancel: (id: string, input: { version: number; reason: string }, key: string) =>
    post<{ saleId: string; transactionId: string; status: 'CANCELLED' }>(`/service-sales/${encodeURIComponent(id)}/cancel`, input, key),
};
