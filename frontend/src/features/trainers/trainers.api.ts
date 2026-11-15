import { apiClient } from '../../api/client';

export type TrainerStatus = 'ACTIVE' | 'INACTIVE';
export interface TrainerSummary { id: string; accountId: string; fullName: string; specialty: string; status: TrainerStatus; version: number }
export interface Trainer extends TrainerSummary { phone: string; email?: string; accountStatus: string | null; roleCode: string | null; createdAt: string | null; updatedAt: string | null }
export interface TrainerPage<T> { items: T[]; page: number; limit: number; total: number; totalPages: number }
export interface TrainerQuery { page: number; limit: number; q?: string; status?: string }
export type BlockerKind = 'BOOKING' | 'SHIFT' | 'PUBLIC_SESSION';
export interface TrainerBlocker { id: string; kind: BlockerKind; startAt: string; endAt: string; status: string; managementUrl?: string }
export interface BlockerPage extends TrainerPage<TrainerBlocker> { counts: Record<BlockerKind, number>; asOf: string }
export interface CreateTrainerInput { accountId: string; specialty: string; status: TrainerStatus }
export interface UpdateTrainerInput { version: number; specialty?: string; status?: TrainerStatus }
const path = (id: string) => `/trainers/${encodeURIComponent(id)}`;
export const trainersApi = {
  list(query: TrainerQuery, signal?: AbortSignal) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
    return apiClient.request<TrainerPage<TrainerSummary>>(`/trainers?${params}`, { signal });
  },
  detail: (id: string, signal?: AbortSignal) => apiClient.request<Trainer>(path(id), { signal }),
  blockers(id: string, page = 1, kind = '', signal?: AbortSignal) {
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (kind) params.set('kind', kind);
    return apiClient.request<BlockerPage>(`${path(id)}/deactivation-blockers?${params}`, { signal });
  },
  create(input: CreateTrainerInput, key: string) {
    return apiClient.request<Trainer>('/trainers', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) });
  },
  update(id: string, input: UpdateTrainerInput, key: string) {
    return apiClient.request<Trainer>(path(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) });
  },
  lookup(operation: 'TRAINER_CREATE' | 'TRAINER_UPDATE', key: string) {
    return apiClient.request<{ status: 'COMMITTED'; responseBody: Trainer }>(`/operations/${operation}/${encodeURIComponent(key)}`);
  },
};
