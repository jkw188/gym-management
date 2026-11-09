import { apiClient } from '../../api/client';

export type PlanKind = 'GYM' | 'PT';
export type CatalogStatus = 'ACTIVE' | 'INACTIVE';
export interface PlanInput {
  code: string; name: string; kind: PlanKind; durationDays: number; sessionsQuota: number; price: string; benefits: string;
}
export interface Plan extends PlanInput { id: string; status: CatalogStatus; version: number; createdAt: string; updatedAt: string }
export interface PolicyInput { fromPlanId: string; toPlanId: string; status: CatalogStatus; note?: string }
export interface PlanPolicy extends PolicyInput { id: string; ruleCode: string; version: number; createdAt: string; updatedAt: string }
export interface CatalogPage<T> { items: T[]; page: number; limit: number; total: number; totalPages: number }
export interface PlansQuery { page: number; limit: number; q?: string; kind?: string; status?: string }
const json = (method: string, input: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
function params(query: object) {
  const result = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => { if (value !== undefined && value !== '') result.set(key, String(value)); });
  return result;
}
export const plansApi = {
  list: (query: PlansQuery, signal?: AbortSignal) => apiClient.request<CatalogPage<Plan>>(`/admin/plans?${params(query)}`, { signal }),
  detail: (id: string) => apiClient.request<Plan>(`/admin/plans/${encodeURIComponent(id)}`),
  create: (input: PlanInput) => apiClient.requestOnce<Plan>('/admin/plans', json('POST', input)),
  update: (id: string, input: Partial<Omit<PlanInput, 'code' | 'kind'>> & { version: number; status?: CatalogStatus }) =>
    apiClient.requestOnce<{ plan: Plan; changed: boolean }>(`/admin/plans/${encodeURIComponent(id)}`, json('PATCH', input)),
  policies: (query: { page: number; limit: number; fromPlanId?: string }, signal?: AbortSignal) =>
    apiClient.request<CatalogPage<PlanPolicy>>(`/admin/plan-policies?${params(query)}`, { signal }),
  createPolicy: (input: PolicyInput) => apiClient.requestOnce<PlanPolicy>('/admin/plan-policies', json('POST', input)),
  updatePolicy: (id: string, input: { version: number; status: CatalogStatus; note?: string }) =>
    apiClient.requestOnce<{ policy: PlanPolicy; changed: boolean }>(`/admin/plan-policies/${encodeURIComponent(id)}`, json('PATCH', input)),
};
export const formatVnd = (price: string) => `${new Intl.NumberFormat('vi-VN').format(BigInt(price))} ₫`;

// Resolve uncertain POST responses by the unique business key before allowing another POST.
export async function findCreatedPlan(code: string) {
  const normalized = code.trim().toUpperCase();
  let page = 1;
  while (true) {
    const result = await plansApi.list({ page, limit: 100, q: normalized });
    const found = result.items.find(plan => plan.code === normalized);
    if (found) return found;
    if (page++ >= result.totalPages) return undefined;
  }
}
export async function findCreatedPolicy(fromPlanId: string, toPlanId: string) {
  let page = 1;
  while (true) {
    const result = await plansApi.policies({ page, limit: 100, fromPlanId });
    const found = result.items.find(policy => policy.toPlanId === toPlanId);
    if (found) return found;
    if (page++ >= result.totalPages) return undefined;
  }
}
