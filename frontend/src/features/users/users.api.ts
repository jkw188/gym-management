import { apiClient } from '../../api/client';
import type { RoleCode } from '../auth/auth.types';

export interface UserAccount {
  id: string; fullName: string; phone: string; email?: string;
  roleCode: RoleCode; roleName: string; status: 'ACTIVE' | 'LOCKED';
  version: number; createdAt: string; updatedAt: string;
}
export interface UserRole { code: RoleCode; name: string }
export interface UsersPage { items: UserAccount[]; page: number; limit: number; total: number; totalPages: number }
export interface UsersQuery { page: number; limit: number; q?: string; roleCode?: string; status?: string }
export interface CreateUserInput { fullName: string; phone: string; email?: string; password: string; roleCode: RoleCode }
export interface UpdateUserInput { fullName?: string; phone?: string; email?: string | null; version: number }

export const usersApi = {
  list(query: UsersQuery, signal?: AbortSignal) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
    return apiClient.request<UsersPage>(`/users?${params}`, { signal });
  },
  roles(signal?: AbortSignal) { return apiClient.request<{ items: UserRole[] }>('/users/roles', { signal }); },
  detail(id: string, signal?: AbortSignal) { return apiClient.request<UserAccount>(`/users/${encodeURIComponent(id)}`, { signal }); },
  create(input: CreateUserInput) {
    return apiClient.request<UserAccount>('/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  },
  update(id: string, input: UpdateUserInput) {
    return apiClient.request<UserAccount>(`/users/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  },
};
