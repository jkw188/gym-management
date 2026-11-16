import { apiClient } from '../../api/client';
export interface PosProduct { id: string; sku: string; name: string; price: string; productVersion: number; available: number }
export interface PosInput {
  memberId?: string; buyerName?: string; recipientPhone?: string; preferredPaymentMethod: 'CASH' | 'TRANSFER';
  items: { productId: string; quantity: number }[];
}
export interface PosQuote {
  quoteToken: string; quoteExpiresAt: string; pickupLocation: string; total: string;
  buyer: { name: string; phone: string };
  items: { productId: string; sku: string; name: string; quantity: number; unitPrice: string; lineTotal: string }[];
}
export interface PosCreated { id: string; code: string; channel: 'POS'; status: 'CONFIRMED'; total: string; transactionId: string; transactionStatus: string; version: number }
const post = <T,>(path: string, input: unknown, key?: string) => apiClient.request<T>(path, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(input) });
export const posApi = {
  products(q: string, page = 1, signal?: AbortSignal) { return apiClient.request<{ items: PosProduct[]; page: number; totalPages: number; total: number }>(`/pos/products?${new URLSearchParams({ q, page: String(page), limit: '20' })}`, { signal }); },
  preview(input: PosInput) { return post<PosQuote>('/pos/orders/preview', input); },
  create(input: PosInput & { quoteToken: string }, key: string) { return post<PosCreated>('/pos/orders', input, key); },
  lookup(key: string) { return apiClient.request<{ status: 'COMMITTED'; responseBody: PosCreated }>(`/operations/ORDER_CREATE_POS/${encodeURIComponent(key)}`); },
};
