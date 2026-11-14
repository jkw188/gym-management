import { apiClient } from '../../api/client';
import type { SaleDetail } from './sales.api';

export interface RenewalInput { memberId: string; previousSaleId: string; planVersion: number }
export interface RenewalPreview {
  previousSaleId: string; sourceEndDate: string; amountDue: string; expectedStartDate: string; expectedEndDate: string;
  planVersion: number; asOf: string; canProceed: boolean; blockingCode?: string;
}
export const renewalsApi = {
  preview: (input: RenewalInput) => apiClient.request<RenewalPreview>('/service-renewals/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }),
  create: (input: RenewalInput, key: string) => apiClient.requestOnce<SaleDetail>('/service-renewals', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input),
  }),
  operation: (key: string) => apiClient.request<{ status: 'COMMITTED'; responseStatus: number; responseBody: SaleDetail }>(`/operations/SALE_RENEW/${key}`),
};
