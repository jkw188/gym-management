import { apiClient } from '../../api/client';

export type CashKind = 'ALL' | 'GYM' | 'PT' | 'RETAIL';
export type CashMethod = 'ALL' | 'CASH' | 'TRANSFER';
export interface CashFlowFilter {
  fromDate: string; toDate: string; kind: CashKind; paymentMethod: CashMethod; payoutMethod: CashMethod;
  eventType: 'ALL' | 'RECEIPT' | 'REFUND'; q: string; page: number;
}
export interface CashTotals { grossReceipts: string | null; refundPaid: string | null; netCash: string | null }
export interface CashMetrics { totals: CashTotals; knownTotals: CashTotals & { label: 'COMPLETE' | 'PARTIAL' } }
export interface CashEvent {
  eventId: string; id: string; eventType: 'RECEIPT' | 'REFUND'; occurredAt: string | null; amount: string | null;
  kind: Exclude<CashKind, 'ALL'> | 'UNKNOWN'; method: Exclude<CashMethod, 'ALL'> | 'UNKNOWN'; status: string;
  paymentId: string | null; refundId: string | null; transactionId: string | null; transactionCode: string | null;
  orderId: string | null; orderCode: string | null; returnId: string | null; invoiceId: string | null; invoiceCode: string | null;
  lateReceipt: boolean; warningCodes: string[];
}
export interface CashFlowSummary extends CashMetrics {
  range: { fromDate: string; toDate: string; timezone: string; start: string; endExclusive: string; effectiveTo: string; isOngoing: boolean };
  observedAt: string; metricVersion: string; dataQuality: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  invalidRecordCount: number; warningCodes: string[];
  filter: { kind: CashKind; paymentMethod: CashMethod; payoutMethod: CashMethod; paymentMethodScope: string; payoutMethodScope: string };
  byKind: Record<'GYM' | 'PT' | 'RETAIL' | 'UNKNOWN', CashMetrics>;
  byDate: (CashMetrics & { date: string; isComplete: boolean })[];
  byMethod: { receipts: Record<'CASH' | 'TRANSFER' | 'UNKNOWN', CashMetrics>; refunds: Record<'CASH' | 'TRANSFER' | 'UNKNOWN', CashMetrics> };
  currentOutstandingRefunds: { scope: string; dateFilterApplied: boolean; methodFiltersApplied: boolean; kind: CashKind;
    observedAt: string; outstandingRefundAmount: string | null; count: number | null; knownAmount: string; knownCount: number; dataQuality: string };
}
export interface CashFlowPage extends CashFlowSummary {
  items: CashEvent[]; page: number; limit: number; total: number; totalPages: number;
  eventFilter: { eventType: CashFlowFilter['eventType']; q: string };
}
export interface CashFlowDetail extends CashFlowSummary { event: CashEvent }
function params(filter: CashFlowFilter, list: boolean) {
  const query = new URLSearchParams({ kind: filter.kind, paymentMethod: filter.paymentMethod, payoutMethod: filter.payoutMethod });
  if (filter.fromDate) query.set('fromDate', filter.fromDate);
  if (filter.toDate) query.set('toDate', filter.toDate);
  if (list) { query.set('eventType', filter.eventType); query.set('q', filter.q); query.set('page', String(filter.page)); query.set('limit', '20'); }
  return query;
}
export const cashFlowApi = {
  events(filter: CashFlowFilter, signal?: AbortSignal) {
    return apiClient.request<CashFlowPage>(`/reports/cash-flow/events?${params(filter, true)}`, { signal });
  },
  detail(event: CashEvent, filter: CashFlowFilter, signal?: AbortSignal) {
    return apiClient.request<CashFlowDetail>(`/reports/cash-flow/events/${event.eventType}/${event.id}?${params(filter, false)}`, { signal });
  },
};
