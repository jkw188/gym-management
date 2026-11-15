import { apiClient } from '../../api/client';

export type RetailStatus = 'ACTIVE' | 'INACTIVE';
export type CatalogKind = 'categories' | 'products';
export interface Category { id: string; name: string; status: RetailStatus; version: number; affectedActiveProductCount: number; createdAt: string; updatedAt: string }
export interface Product extends Omit<Category, 'affectedActiveProductCount'> {
  categoryId: string; categoryName: string; categoryStatus: RetailStatus; sku: string; description: string | null;
  imageUrl: string | null; price: string; effectiveActive: boolean;
}
export interface RetailPage<T> { items: T[]; page: number; limit: number; total: number; totalPages: number }
export interface RetailQuery { page: number; limit: number; q?: string; status?: string; categoryId?: string }
export interface CategoryInput { name?: string; status?: RetailStatus; version?: number }
export interface ProductInput extends CategoryInput { categoryId?: string; sku?: string; description?: string | null; imageUrl?: string | null; price?: string }
export const retailApi = {
  list<T extends Category | Product>(kind: CatalogKind, query: RetailQuery, signal?: AbortSignal) {
    const params = new URLSearchParams();
    for (const [field, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(field, String(value));
    return apiClient.request<RetailPage<T>>(`/admin/${kind}?${params}`, { signal });
  },
  detail<T extends Category | Product>(kind: CatalogKind, id: string, signal?: AbortSignal) {
    return apiClient.request<T>(`/admin/${kind}/${encodeURIComponent(id)}`, { signal });
  },
  save(kind: CatalogKind, input: ProductInput, key: string, id?: string) {
    return apiClient.request<Category | Product>(`/admin/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`, {
      method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input),
    });
  },
  lookup(kind: CatalogKind, key: string, update: boolean) {
    const operation = `${kind === 'categories' ? 'CATEGORY' : 'PRODUCT'}_${update ? 'UPDATE' : 'CREATE'}`;
    return apiClient.request<{ status: 'COMMITTED'; responseBody: Category | Product }>(`/operations/${operation}/${encodeURIComponent(key)}`);
  },
};
