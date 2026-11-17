// Tầng giao diện – gọi API (US-19 bước 3): Member tự gia hạn – xem trước, tạo kỳ gia hạn, hướng dẫn thanh toán.
// Tất cả qua ApiClient. Không gửi memberId/accountId/channel/endDate/amountDue: server tính hết (US-19-F01, F02).
import { apiClient } from '../../api/client';
import type { PaymentInstructions, PaymentMethod } from '../service-registrations/service-registrations.api';

// Body xem trước/tạo: ĐÚNG 3 field (US-19 mục 2). previousSaleId và planVersion lấy từ field renewal của server.
export interface RenewalInput {
  previousSaleId: string;
  planVersion: number;
  preferredPaymentMethod: PaymentMethod;
}

// 200 của POST /api/me/service-renewals/preview (quote US-15, giống quầy).
export interface RenewalQuote {
  previousSaleId: string;
  sourceEndDate: string;
  amountDue: string;
  expectedStartDate: string;   // YYYY-MM-DD
  expectedEndDate: string;     // YYYY-MM-DD
  planVersion: number;
  asOf: string;
  canProceed: boolean;
  blockingCode?: string;
}

// 201 của POST /api/me/service-renewals (SaleResult), chỉ các field trang dùng.
export interface RenewalResult {
  saleId: string;
  transactionId: string;
  transactionCode: string;
  transactionStatus: 'PENDING' | 'SETTLED' | 'CANCELLED';
  amountDue: string;
  membershipId?: string;
}

export const renewalsApi = {
  // Chỉ báo giá và ngày dự kiến, không tạo gì nên không cần Idempotency-Key.
  preview(input: RenewalInput) {
    return apiClient.request<RenewalQuote>('/me/service-renewals/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  // US-19-TC09, TC12: cùng body + Idempotency-Key do trang giữ; mất phản hồi thì gửi lại ĐÚNG key cũ.
  create(input: RenewalInput, idempotencyKey: string) {
    return apiClient.request<RenewalResult>('/me/service-renewals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
  },

  // Dùng lại endpoint US-18: hướng dẫn trả tiền của giao dịch đang chờ của chính mình.
  paymentInstructions(transactionId: string) {
    return apiClient.request<PaymentInstructions>(`/me/transactions/${encodeURIComponent(transactionId)}/payment-instructions`);
  },
};
