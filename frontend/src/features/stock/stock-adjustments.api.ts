import { apiClient } from '../../api/client';
import { stockReceiptsApi, type Receipt, type ReceiptSummary, type PostedReceipt, type StockPage } from './stock-receipts.api';
import type { StockIssueAudit } from './stock-issues.api';
export type AdjustmentOperation = 'STOCK_ADJUST_CREATE' | 'STOCK_ADJUST_UPDATE' | 'STOCK_ADJUST_POST';
export interface AdjustmentItem extends Omit<Receipt['items'][number], 'quantity'> {
  countedQuantity: number; baseOnHand: number; baseInventoryVersion: number; countedAt: string; quantityDelta: number;
  currentOnHand: number | null; currentReserved: number | null; currentInventoryVersion: number | null;
  inventoryState: string; stale: boolean;
}
export interface Adjustment extends Omit<Receipt, 'items'> { items: AdjustmentItem[]; stale: boolean; audit?: StockIssueAudit[] }
export interface AdjustmentInput {
  reason: string; sourceReference?: string; version?: number;
  items: { productId: string; countedQuantity: number; expectedInventoryVersion: number; unitCost: string }[];
}
export const stockAdjustmentsApi = {
  options: stockReceiptsApi.options,
  list(query: { q?: string; status?: string; fromDate?: string; toDate?: string; page: number; limit: number }, signal?: AbortSignal) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== '' && value !== undefined) params.set(key, String(value));
    return apiClient.request<StockPage<ReceiptSummary>>(`/stock-adjustments?${params}`, { signal });
  },
  detail(id: string, signal?: AbortSignal) { return apiClient.request<Adjustment>(`/stock-adjustments/${encodeURIComponent(id)}`, { signal }); },
  save(input: AdjustmentInput, key: string, id?: string) {
    return apiClient.request<Adjustment>(`/stock-adjustments${id ? `/${encodeURIComponent(id)}` : ''}`, {
      method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input),
    });
  },
  post(id: string, version: number, key: string) {
    return apiClient.request<PostedReceipt>(`/stock-adjustments/${encodeURIComponent(id)}/post`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ version }),
    });
  },
  lookup(operation: AdjustmentOperation, key: string) {
    return apiClient.request<{ status: 'COMMITTED'; responseBody: Adjustment | PostedReceipt }>(`/operations/${operation}/${encodeURIComponent(key)}`);
  },
};
