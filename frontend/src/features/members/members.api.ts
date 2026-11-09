import { apiClient } from '../../api/client';

export interface Member {
  id: string; memberCode: string; fullName: string; phone: string; birthDate?: string; address?: string;
  accountId?: string; version: number; createdAt: string; updatedAt: string;
}
export interface MemberInput { fullName: string; phone: string; birthDate?: string; address?: string }
export interface LinkCandidate { id: string; fullName: string; phone: string; canLink: boolean }
export type VerificationMethod = 'IN_PERSON_ACCOUNT' | 'IN_PERSON_DOCUMENT';
export interface LinkInput {
  accountId: string; version: number;
  verificationMethod: VerificationMethod; verificationNote: string;
}
export interface LinkResult { member: Member; linked: boolean }
export type MemberOperation = 'MEMBER_CREATE' | 'MEMBER_LINK';
export interface MemberOperationResult { status: 'COMMITTED'; responseStatus: number; responseBody: Member | LinkResult }
const post = <T>(path: string, input: unknown, key: string) => apiClient.request<T>(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input),
});
export const membersApi = {
  create: (input: MemberInput, key: string) => post<Member>('/members', input, key),
  candidates: (phone: string) => apiClient.request<{ items: LinkCandidate[] }>(`/members/link-candidates?${new URLSearchParams({ phone })}`),
  link: (id: string, input: LinkInput, key: string) => post<LinkResult>(`/members/${encodeURIComponent(id)}/link`, input, key),
  lookup: (operation: MemberOperation, key: string) => apiClient.request<MemberOperationResult>(`/operations/${operation}/${encodeURIComponent(key)}`),
};
