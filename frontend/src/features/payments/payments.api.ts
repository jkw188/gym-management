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
export interface SettlementResult {
  transactionId: string; transactionCode: string; status: 'SETTLED'; paymentId: string; invoiceId: string; invoiceNo: string;
  saleId: string; membershipId: string; startDate: string; endDate: string; notificationState: 'STORED' | 'NO_LINKED_ACCOUNT';
}
export interface InvoiceDetail {
  id: string; invoiceNo: string; issuedAt: string; totalAmount: string; buyerSnapshot: string; transactionId: string; transactionCode: string;
  serviceLine: { saleId: string; planId: string; kind: 'GYM' | 'PT'; planName: string; benefits: string; policySnapshot: string;
    listPrice: string; creditAmount: string; sessions: number; startDate: string; endDate: string } | null;
  payment?: { id: string; method: string; reference: string; amount: string; paidAt?: string; verifiedAt?: string };
}

export const paymentsApi = {
  list(filters: TransactionFilters) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== '') query.set(key, String(value));
    return apiClient.request<TransactionPage>(`/transactions?${query}`);
  },
  detail(id: string) { return apiClient.request<TransactionDetail>(`/transactions/${id}`); },
  preview(id: string, input: PaymentReviewInput) {
    return apiClient.request<PaymentReview>(`/transactions/${id}/payment-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  },
  confirm(id: string, input: PaymentReviewInput, key: string) {
    return apiClient.request<SettlementResult>(`/transactions/${id}/confirm-payment`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) });
  },
  operation(key: string) {
    return apiClient.request<{ status: 'COMMITTED'; responseStatus: number; responseBody: SettlementResult }>(`/operations/PAYMENT_CONFIRM/${key}`);
  },
  invoice(id: string) { return apiClient.request<InvoiceDetail>(`/invoices/${id}`); },
};
