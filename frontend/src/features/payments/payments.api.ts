import { apiClient } from '../../api/client';

export type TransactionStatus = 'PENDING' | 'SETTLED' | 'CANCELLED';
export interface TransactionItem {
  id: string; code: string; kind: 'GYM' | 'PT'; amountDue: string; status: TransactionStatus;
  createdAt: string; version: number; memberId?: string;
  member: { id: string; memberCode: string; fullName: string; phone: string } | null;
}
export interface TransactionPage { items: TransactionItem[]; page: number; limit: number; total: number; totalPages: number }
export interface TransactionFilters {
  kind: string; status: string; memberId: string; q: string; createdFrom: string; createdTo: string; page: number;
}
export interface TransactionDetail {
  transaction: TransactionItem;
  sale?: { id: string; planId: string; planName: string; benefits: string; listPrice: string; creditAmount: string;
    sessions: number; startDate: string; endDate: string; policySnapshot: string };
  payments: { id: string; method: string; reference: string; amount: string; status: string; paidAt?: string;
    verifiedAt?: string; evidenceNote?: string; receivingAccountCode?: string; bankReference?: string }[];
  invoice?: { id: string; invoiceNo: string; issuedAt: string; totalAmount: string; buyerSnapshot: string };
  membershipId?: string; asOf: string;
}
export interface PaymentReviewInput {
  method: 'CASH' | 'TRANSFER'; amount: string; evidenceNote: string;
  receivingAccountCode?: string; bankReference?: string; receivedAt?: string;
}
export interface PaymentReview {
  canConfirm: boolean; reviewState: 'READY' | 'NEEDS_REVIEW' | 'BLOCKED'; blockingCodes: string[];
  amountDue: string; normalizedReference?: string; asOf: string;
}

export const paymentsApi = {
  list(filters: TransactionFilters) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== '') query.set(key, String(value));
    return apiClient.request<TransactionPage>(`/transactions?${query}`);
  },
  detail(id: string) { return apiClient.request<TransactionDetail>(`/transactions/${id}`); },
  preview(id: string, input: PaymentReviewInput) {
    return apiClient.request<PaymentReview>(`/transactions/${id}/payment-preview`, { method: 'POST', body: JSON.stringify(input) });
  },
};
