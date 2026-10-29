import { apiClient } from '../../api/client';
import type { RoleCode } from '../auth/auth.types';

export interface Profile {
  id: string; fullName: string; phone: string; email?: string; birthDate?: string; address?: string;
  roleCode: RoleCode; status: 'ACTIVE' | 'LOCKED'; version: number; createdAt: string; updatedAt: string;
}
export interface UpdateProfileInput {
  version: number; fullName?: string; phone?: string; email?: string | null; birthDate?: string | null; address?: string | null;
}
export interface UpdateProfileResult { profile: Profile; reauthenticationRequired: boolean }

export const profileApi = {
  get(signal?: AbortSignal) { return apiClient.request<Profile>('/profile/me', { signal }); },
  update(input: UpdateProfileInput) {
    return apiClient.request<UpdateProfileResult>('/profile/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  },
};
