import { apiClient } from '../../api/client';
import type { PublicSession } from './classes.api';

export type ClassStatus = 'DRAFT' | 'PUBLISHED' | 'CANCELLED';
export interface AdminClass extends Omit<PublicSession, 'status'> {
  status: ClassStatus; version: number; createdAt: string; updatedAt: string;
  createdBy: string; updatedBy: string; publishedAt?: string; cancelledAt?: string; cancellationReason?: string;
}
export interface ClassInput { title: string; trainerId: string; subjectCode: string; location: string; startAt: string; endAt: string }
export interface ClassQuery { fromDate: string; toDate: string; trainerId?: string; subjectCode?: string; status?: string; page: number }
export interface AdminClassPage { items: AdminClass[]; total: number; totalPages: number; page: number; limit: number }
export type ClassCommand =
  | { operation: 'PUBLIC_SESSION_CREATE'; input: ClassInput }
  | { operation: 'PUBLIC_SESSION_UPDATE'; id: string; input: ClassInput & { version: number } }
  | { operation: 'PUBLIC_SESSION_PUBLISH'; id: string; input: { version: number } }
  | { operation: 'PUBLIC_SESSION_CANCEL'; id: string; input: { version: number; reason: string } };
const base = '/admin/public-sessions';
export const adminClassesApi = {
  list(query: ClassQuery, signal?: AbortSignal) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => { if (value !== '') params.set(key, String(value)); });
    return apiClient.request<AdminClassPage>(`${base}?${params}`, { signal });
  },
  detail: (id: string) => apiClient.request<AdminClass>(`${base}/${encodeURIComponent(id)}`),
  preview: (input: ClassInput & { sessionId?: string }) => apiClient.request<{ startAt: string; endAt: string; conflictCodes: string[] }>(`${base}/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }),
  send(command: ClassCommand, key: string) {
    const suffix = command.operation === 'PUBLIC_SESSION_CREATE' ? '' : `/${encodeURIComponent(command.id)}` +
      (command.operation === 'PUBLIC_SESSION_PUBLISH' ? '/publish' : command.operation === 'PUBLIC_SESSION_CANCEL' ? '/cancel' : '');
    return apiClient.request<AdminClass>(`${base}${suffix}`, { method: command.operation === 'PUBLIC_SESSION_UPDATE' ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(command.input) });
  },
  lookup: (operation: ClassCommand['operation'], key: string) => apiClient.request<{ responseBody: AdminClass }>(`/operations/${operation}/${key}`),
};
