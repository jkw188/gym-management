import { apiClient } from '../../api/client';

export interface Member {
  id: string; memberCode: string; fullName: string; phone: string; birthDate?: string; address?: string;
  accountId?: string; version: number; createdAt: string; updatedAt: string;
}
export interface MemberInput { fullName: string; phone: string; birthDate?: string; address?: string }
export interface MemberUpdateInput { version: number; fullName?: string; phone?: string; birthDate?: string | null; address?: string | null }
export type ServiceKind = 'GYM' | 'PT';
export type MembershipState = 'CURRENT' | 'SCHEDULED' | 'EXPIRED' | 'NONE';
export type EntitlementSummary = Record<ServiceKind, MembershipState[]>;
export interface ReadTime { asOf: string; businessDate: string }
export interface MemberDetail extends ReadTime { member: Member; entitlementSummary: EntitlementSummary }
export interface MemberPage<T> extends ReadTime { items: T[]; page: number; limit: number; total: number; totalPages: number }
export interface MemberListItem {
  id: string; memberCode: string; fullName: string; phone: string; accountLinked: boolean; entitlementSummary: EntitlementSummary;
}
export interface MemberQuery { q?: string; kind?: ServiceKind | ''; membershipState?: MembershipState | ''; page?: number; limit?: number }
export interface MemberMembership {
  membershipId: string; saleId: string; kind: ServiceKind; planName: string; startDate: string; endDate: string;
  storedStatus: 'ACTIVE' | 'SUPERSEDED' | 'CANCELLED'; timeState: MembershipState; sessionsQuota: number; sessionsUsed: number;
  transactionStatus: 'PENDING' | 'SETTLED' | 'CANCELLED';
}
export interface MemberTransaction {
  id: string; code: string; kind: 'GYM' | 'PT' | 'RETAIL'; status: 'PENDING' | 'SETTLED' | 'CANCELLED';
  amountDue: string; createdAt: string; paymentId?: string; invoiceId?: string;
}
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
  list: (query: MemberQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
    return apiClient.request<MemberPage<MemberListItem>>(`/members?${params}`, { signal });
  },
  memberships: (id: string, page: number, signal?: AbortSignal) => apiClient.request<MemberPage<MemberMembership>>(
    `/members/${encodeURIComponent(id)}/memberships?${new URLSearchParams({ page: String(page), limit: '20' })}`, { signal }),
  transactions: (id: string, page: number, signal?: AbortSignal) => apiClient.request<MemberPage<MemberTransaction>>(
    `/members/${encodeURIComponent(id)}/transactions?${new URLSearchParams({ page: String(page), limit: '20' })}`, { signal }),
  detail: (id: string, signal?: AbortSignal) => apiClient.request<MemberDetail>(`/members/${encodeURIComponent(id)}`, { signal }),
  update: (id: string, input: MemberUpdateInput) => apiClient.requestOnce<{ member: Member; changed: boolean }>(`/members/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }),
  create: (input: MemberInput, key: string) => post<Member>('/members', input, key),
  candidates: (phone: string) => apiClient.request<{ items: LinkCandidate[] }>(`/members/link-candidates?${new URLSearchParams({ phone })}`),
  link: (id: string, input: LinkInput, key: string) => post<LinkResult>(`/members/${encodeURIComponent(id)}/link`, input, key),
  lookup: (operation: MemberOperation, key: string) => apiClient.request<MemberOperationResult>(`/operations/${operation}/${encodeURIComponent(key)}`),
};
