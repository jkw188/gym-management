import { apiClient } from '../../api/client';
import type { Receipt, ReceiptInput, ReceiptSummary, PostedReceipt, ProductOption, StockPage } from './stock-receipts.api';
export type IssueOperation = 'STOCK_ISSUE_CREATE' | 'STOCK_ISSUE_UPDATE' | 'STOCK_ISSUE_POST';
export interface StockIssueAudit {
  id: string; action: 'CREATED' | 'UPDATED' | 'POSTED'; actorId: string; occurredAt: string;
  before: { version: number; reason: string } | null; after: { version: number; reason: string };
}
export interface StockIssue extends Receipt { audit?: StockIssueAudit[] }
const queryString = (query: object) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== '' && value !== undefined) params.set(key, String(value));
  return params.toString();
};
export const stockIssuesApi = {
  list(query: { q?: string; status?: string; fromDate?: string; toDate?: string; page: number; limit: number }, signal?: AbortSignal) {
    return apiClient.request<StockPage<ReceiptSummary>>(`/stock-issues?${queryString(query)}`, { signal });
  },
  detail(id: string, signal?: AbortSignal) { return apiClient.request<StockIssue>(`/stock-issues/${encodeURIComponent(id)}`, { signal }); },
  options(query: { q?: string; categoryId?: string; page: number; limit: number }, signal?: AbortSignal) {
    return apiClient.request<StockPage<ProductOption>>(`/inventory/product-options?${queryString(query)}`, { signal });
  },
  save(input: ReceiptInput, key: string, id?: string) {
    return apiClient.request<Receipt>(`/stock-issues${id ? `/${encodeURIComponent(id)}` : ''}`, {
      method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input),
    });
  },
  post(id: string, version: number, key: string) {
    return apiClient.request<PostedReceipt>(`/stock-issues/${encodeURIComponent(id)}/post`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ version }),
    });
  },
  lookup(operation: IssueOperation, key: string) {
    return apiClient.request<{ status: 'COMMITTED'; responseBody: Receipt | PostedReceipt }>(`/operations/${operation}/${encodeURIComponent(key)}`);
  },
};
