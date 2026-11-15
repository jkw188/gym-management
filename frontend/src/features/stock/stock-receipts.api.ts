import { apiClient } from '../../api/client';

export interface StockPage<T> { items: T[]; page: number; limit: number; total: number; totalPages: number }
export interface ProductOption { id: string; sku: string; name: string; status: string; effectiveActive: boolean; inventoryState: string }
export interface ReceiptInput { reason: string; sourceReference?: string; items: { productId: string; quantity: number; unitCost: string }[]; version?: number }
export interface ReceiptSummary {
  id: string; code: string; status: 'DRAFT' | 'POSTED'; version: number; reason: string; sourceReference: string | null; totalCost: string;
  createdBy: string; updatedBy: string; postedBy: string | null; createdAt: string; updatedAt: string; postedAt: string | null;
}
export interface Receipt extends ReceiptSummary {
  items: { id: string; productId: string; quantity: number; unitCost: string; lineTotalCost: string; skuSnapshot: string; nameSnapshot: string; inactiveWarning: boolean }[];
  movementIds: string[];
  movements: ReceiptMovement[];
}
export interface ReceiptMovement {
  id: string; documentItemId: string; productId: string; sequence: number; skuSnapshot: string; nameSnapshot: string;
  onHandDelta: number; reservedDelta: number; beforeOnHand: number; beforeReserved: number; afterOnHand: number; afterReserved: number;
  createdAt: string; sourceId: string; sourceCode: string;
}
export interface PostedReceipt { id: string; code: string; status: 'POSTED'; version: number; postedAt: string; postedBy: string; totalCost: string; movementIds: string[] }
export type ReceiptOperation = 'STOCK_RECEIPT_CREATE' | 'STOCK_RECEIPT_UPDATE' | 'STOCK_RECEIPT_POST';
const queryString = (query: object) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== '' && value !== undefined) params.set(key, String(value));
  return params.toString();
};
export const stockReceiptsApi = {
  list(query: { q?: string; status?: string; fromDate?: string; toDate?: string; page: number; limit: number }, signal?: AbortSignal) {
    return apiClient.request<StockPage<ReceiptSummary>>(`/stock-receipts?${queryString(query)}`, { signal });
  },
  detail(id: string, signal?: AbortSignal) { return apiClient.request<Receipt>(`/stock-receipts/${encodeURIComponent(id)}`, { signal }); },
  options(query: { q?: string; categoryId?: string; page: number; limit: number }, signal?: AbortSignal) {
    return apiClient.request<StockPage<ProductOption>>(`/inventory/product-options?${queryString(query)}`, { signal });
  },
  save(input: ReceiptInput, key: string, id?: string) {
    return apiClient.request<Receipt>(`/stock-receipts${id ? `/${encodeURIComponent(id)}` : ''}`, {
      method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input),
    });
  },
  post(id: string, version: number, key: string) {
    return apiClient.request<PostedReceipt>(`/stock-receipts/${encodeURIComponent(id)}/post`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ version }),
    });
  },
  lookup(operation: ReceiptOperation, key: string) {
    return apiClient.request<{ status: 'COMMITTED'; responseBody: Receipt | PostedReceipt }>(`/operations/${operation}/${encodeURIComponent(key)}`);
  },
};
export const stockMoney = (value: string) => `${new Intl.NumberFormat('vi-VN').format(BigInt(value))} VND`;
export const stockDate = (value: string) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
