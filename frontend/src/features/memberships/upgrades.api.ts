// Tầng giao diện – gọi API (US-20 bước 3): Member tự nâng cấp – gói đích, báo giá, tạo đề nghị, hướng dẫn thanh toán.
// Tất cả qua ApiClient. Không gửi memberId/credit/amountDue/quota/channel: server tính hết (US-20-F01, F02).
import { apiClient } from '../../api/client';
import type { PaymentInstructions, PaymentMethod } from '../service-registrations/service-registrations.api';

// Một gói đích trong 200 của GET /api/me/memberships/:id/upgrade-options.
export interface UpgradeOption {
  targetPlanId: string;
  targetPlanVersion: number;
  policyVersion: number;
  name: string;
  price: string;            // chuỗi VND, ví dụ "600000"
  durationDays: number;
  sessionsQuota: number;
}

export interface UpgradeOptions {
  items: UpgradeOption[];
  sourceVersion: number;
  asOf: string;
}

// Body xem trước/tạo: ĐÚNG 6 field (US-20 mục 2). Các version lấy từ upgrade-options của server.
export interface UpgradeInput {
  sourceMembershipId: string;
  sourceVersion: number;
  targetPlanId: string;
  targetPlanVersion: number;
  policyVersion: number;
  preferredPaymentMethod: PaymentMethod;
}

// 200 của POST /api/me/service-upgrades/preview (báo giá UPGRADE_V1 của US-16), chỉ các field trang dùng.
export interface UpgradeQuote {
  totalDays: number;
  remainingDays: number;
  rawCredit: string;
  appliedCredit: string;
  excessCredit: string;
  amountDue: string;
  asOfDate: string;          // YYYY-MM-DD
  quoteExpiresAt: string;    // ISO
  targetListPrice: string;
  targetSessions: number;
  quotaSummary: { used: number; reserved: number; targetSessions: number; requiredSessions: number };
  canProceed: boolean;
  blockingCode?: string;
}

// 201 của POST /api/me/service-upgrades (SaleResult), chỉ các field trang dùng.
export interface UpgradeResult {
  saleId: string;
  transactionId: string;
  transactionCode: string;
  transactionStatus: 'PENDING' | 'SETTLED' | 'CANCELLED';
  amountDue: string;
  membershipId?: string;
}

export const upgradesApi = {
  // US-20-TC01: chỉ đích server cho phép tại thời điểm đọc; không giữ giá.
  options(membershipId: string) {
    return apiClient.request<UpgradeOptions>(`/me/memberships/${encodeURIComponent(membershipId)}/upgrade-options`);
  },

  // Chỉ báo giá, không tạo gì nên không cần Idempotency-Key.
  preview(input: UpgradeInput) {
    return apiClient.request<UpgradeQuote>('/me/service-upgrades/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  // US-20-TC13: cùng body + Idempotency-Key do trang giữ; mất phản hồi thì gửi lại ĐÚNG key cũ.
  create(input: UpgradeInput, idempotencyKey: string) {
    return apiClient.request<UpgradeResult>('/me/service-upgrades', {
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
