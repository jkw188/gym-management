import { apiClient } from '../../api/client';
import type { SaleDetail } from './sales.api';

export interface UpgradeInput {
  memberId: string; sourceMembershipId: string; sourceVersion: number; targetPlanId: string; targetPlanVersion: number; policyVersion: number;
}
export interface UpgradeQuote {
  baseValue: string; totalDays: number; remainingDays: number; rawCredit: string; appliedCredit: string; excessCredit: string; amountDue: string;
  asOfDate: string; quoteExpiresAt: string; sourceMembershipId: string; sourceVersion: number; previousSaleId: string;
  targetPlanId: string; targetPlanVersion: number; policyVersion: number; targetListPrice: string;
  quotaSummary: { used: number; reserved: number; requiredSessions: number; targetSessions: number };
}
export interface UpgradePreview extends UpgradeQuote { canProceed: boolean; blockingCode?: string }
export interface UpgradeTargets {
  source: { membershipId: string; version: number; planName: string; kind: 'GYM' | 'PT'; startDate: string; endDate: string;
    sessionsUsed: number; sessionsQuota: number; benefits: string };
  items: { planId: string; planVersion: number; policyVersion: number; name: string; kind: 'GYM' | 'PT'; price: string;
    durationDays: number; sessions: number; benefits: string }[]; asOf: string;
}
export const upgradesApi = {
  targets: (memberId: string, sourceMembershipId: string) => apiClient.request<UpgradeTargets>(`/service-upgrades/targets?${new URLSearchParams({ memberId, sourceMembershipId })}`),
  preview: (input: UpgradeInput) => apiClient.request<UpgradePreview>('/service-upgrades/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }),
  create: (input: UpgradeInput, key: string) => apiClient.requestOnce<SaleDetail>('/service-upgrades', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input),
  }),
  operation: (key: string) => apiClient.request<{ status: 'COMMITTED'; responseStatus: number; responseBody: SaleDetail }>(`/operations/SALE_UPGRADE/${key}`),
};
