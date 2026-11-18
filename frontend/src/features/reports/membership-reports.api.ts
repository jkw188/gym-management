import { apiClient } from '../../api/client';

export interface MembershipReportFilter {
  asOfAt: string; kind: 'ALL' | 'GYM' | 'PT'; activity: 'ALL' | 'ACTIVE' | 'INACTIVE'; q: string; page: number;
}
export interface MembershipReportSummary {
  asOfAt: string; observedAt: string; metricVersion: string; dataQuality: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  historyCoverageFrom?: string; totalMembers: number | null; activeMembers: number | null;
  inactiveMembers: number | null; activeRate: number | null; activeMemberships: number | null;
  byKind: Record<'GYM' | 'PT', { activeMembers: number | null; activeMemberships: number | null }>;
  invalidRecordCount: number; warningCodes: string[];
  knownTotals: { totalMembers: number; activeMembers: number; activeMemberships: number };
  filter: { kind: 'ALL' | 'GYM' | 'PT'; activity?: string; q?: string };
}
export interface ReportMember {
  memberId: string; code: string | null; displayName: string | null; linkedAccount: boolean;
  qualifyingMembershipCount: number | null; activity: 'ACTIVE' | 'INACTIVE' | 'UNKNOWN';
}
export interface MembershipReportPage extends MembershipReportSummary {
  items: ReportMember[]; page: number; limit: number; total: number; totalPages: number;
}
export interface MembershipReportDetail extends MembershipReportSummary {
  member: ReportMember;
  memberships: { membershipId: string | null; serviceSaleId: string | null; transactionId: string | null;
    kind: string | null; planId: string | null; planNameSnapshot: string | null;
    startDate: string | null; endDate: string | null; effectiveStart: string | null; effectiveEnd: string | null;
    currentStatus: string | null; currentTransactionStatus: string | null; qualifies: boolean | null; reasonCodes: string[] }[];
}
export const membershipReportsApi = {
  members: (filter: MembershipReportFilter, signal?: AbortSignal) => {
    const params = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== '').map(([key, value]) => [key, String(value)]));
    return apiClient.request<MembershipReportPage>(`/reports/memberships/members?${params}`, { signal });
  },
  detail: (id: string, asOfAt: string, signal?: AbortSignal) => {
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new Error('Mã hội viên không hợp lệ');
    return apiClient.request<MembershipReportDetail>(`/reports/memberships/members/${id}?${new URLSearchParams({ asOfAt })}`, { signal });
  },
};
