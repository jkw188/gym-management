import { apiClient } from '../../api/client';
import type { StockPage } from '../stock/stock-receipts.api';

export interface InventoryBalance {
  productId: string; categoryId: string; sku: string; name: string; productStatus: string; effectiveActive: boolean;
  inventoryState: 'VALID' | 'MISSING' | 'INCONSISTENT'; onHand: number | null; reserved: number | null; available: number | null; version: number | null; asOf: string;
}
export interface Movement {
  id: string; productId: string; sequence: number; kind: string; skuSnapshot: string; nameSnapshot: string;
  onHandDelta: number; reservedDelta: number; beforeOnHand: number; beforeReserved: number; afterOnHand: number; afterReserved: number;
  createdAt: string; sourceType: string; sourceId: string; sourceCode: string | null; sourcePath: string | null; asOf: string;
}
export interface InventoryQuery { q?: string; categoryId?: string; productStatus?: string; stockState?: string; page: number; limit: number }
export interface MovementQuery { fromDate?: string; toDate?: string; kind?: string; page: number; limit: number }
export interface MovementPage extends StockPage<Movement> { range: { fromDate: string; toDate: string; timeZone: string }; asOf: string }
const params = (query: object) => {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== '' && value !== undefined) result.set(key, String(value));
  return result.toString();
};
export const inventoryApi = {
  list(query: InventoryQuery, signal?: AbortSignal) { return apiClient.request<StockPage<InventoryBalance> & { asOf: string }>(`/inventory?${params(query)}`, { signal }); },
  detail(id: string, signal?: AbortSignal) { return apiClient.request<InventoryBalance>(`/inventory/${encodeURIComponent(id)}`, { signal }); },
  history(id: string, query: MovementQuery, signal?: AbortSignal) { return apiClient.request<MovementPage>(`/inventory/${encodeURIComponent(id)}/movements?${params(query)}`, { signal }); },
  movement(id: string, signal?: AbortSignal) { return apiClient.request<Movement>(`/stock-movements/${encodeURIComponent(id)}`, { signal }); },
};
export const inventoryNumber = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('vi-VN').format(value);
export const inventoryState = (value: InventoryBalance['inventoryState']) => ({ VALID: 'Hợp lệ', MISSING: 'Thiếu dữ liệu kho', INCONSISTENT: 'Số dư bất thường' })[value];
export const inventoryError = (failure: unknown) => failure instanceof Error ? failure.message : 'Không thể tải dữ liệu kho. Vui lòng thử lại.';
