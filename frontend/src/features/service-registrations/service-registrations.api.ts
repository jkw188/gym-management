// Tầng giao diện – gọi API (US-18 bước 3): Member tự đăng ký gói – danh mục gói, lịch sử mua, xem trước, tạo yêu cầu,
// hướng dẫn thanh toán và tự hủy. Tất cả qua ApiClient. Không gửi memberId/accountId/channel vì server lấy chủ thể từ phiên.
import { apiClient } from '../../api/client';
import type { MyListPage } from '../memberships/memberships.api';
import type { PublicPlanPage } from '../services/services.api';

export type PaymentMethod = 'CASH' | 'TRANSFER';
export type SaleStatus = 'PENDING' | 'SETTLED' | 'CANCELLED';

// Body xem trước/tạo: ĐÚNG 4 field (US-18 mục 2); giá, ngày kết thúc, quota do server tính.
export interface RegistrationInput {
  planId: string;
  planVersion: number;
  startDate: string;              // YYYY-MM-DD
  preferredPaymentMethod: PaymentMethod;
}

// 200 của POST /api/me/service-registrations/preview (quote giống quầy US-14).
export interface RegistrationQuote {
  planVersion: number;
  amountDue: string;
  kind: 'GYM' | 'PT';
  requestedStartDate: string;
  expectedEndDate: string;
  canProceed: boolean;
  blockingCode?: string;
}

// 201 của POST /api/me/service-registrations (SaleResult của US-14), chỉ các field trang dùng.
export interface RegistrationResult {
  saleId: string;
  transactionId: string;
  transactionCode: string;
  transactionStatus: SaleStatus;
  amountDue: string;
  startDate: string;
  endDate: string;
  membershipId?: string;
  invoiceId?: string;
}

// Một tài khoản nhận chuyển khoản; transferContent = mã giao dịch.
export interface TransferOption {
  receivingAccountCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  transferContent: string;
}

// 200 của GET /api/me/transactions/:id/payment-instructions.
export interface PaymentInstructions {
  transactionCode: string;
  amountDue: string;
  preferredPaymentMethod?: PaymentMethod;
  cashInstruction: string;
  transferOptions?: TransferOption[];
}

// Một lần mua trong lịch sử (GET /api/me/service-sales). canCancel và transactionVersion do server tính (US-18-TC11).
export interface MySale {
  id: string;
  transactionId: string;
  status?: SaleStatus;
  planName: string;
  startDate: string;
  endDate: string;
  amountDue?: string;
  channel: 'COUNTER' | 'SELF_SERVICE';
  canCancel: boolean;
  transactionVersion?: number;
}

// Body hủy: CHỈ {version, reason}.
export interface CancelInput {
  version: number;
  reason: string;
}

// US-18 mục 2: lý do hủy sau khi bỏ khoảng trắng hai đầu dài 10–500 ký tự (server kiểm lại).
export function isValidCancelReason(reason: string) {
  const length = reason.trim().length;
  return length >= 10 && length <= 500;
}

// Gửi một lệnh POST JSON kèm Idempotency-Key do trang giữ (mất phản hồi thì gửi lại ĐÚNG key cũ).
function postWithKey<T>(path: string, body: unknown, idempotencyKey: string) {
  return apiClient.request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
}

export const serviceRegistrationsApi = {
  // GET /api/catalog/plans (US-13, công khai): tải tối đa 100 gói đang bán, lấy id + version.
  listPlans() {
    return apiClient.publicGet<PublicPlanPage>('/catalog/plans?page=1&limit=100');
  },

  // GET /api/me/service-sales (US-17): lịch sử mua của chính mình; memberLinked=false nếu chưa liên kết hồ sơ.
  listMySales() {
    return apiClient.request<MyListPage<MySale>>('/me/service-sales?page=1&limit=100');
  },

  // POST /api/me/service-registrations/preview: chỉ báo giá, không tạo gì nên không cần key.
  preview(input: RegistrationInput) {
    return apiClient.request<RegistrationQuote>('/me/service-registrations/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  // POST /api/me/service-registrations (US-18-TC09): cùng body + Idempotency-Key.
  create(input: RegistrationInput, idempotencyKey: string) {
    return postWithKey<RegistrationResult>('/me/service-registrations', input, idempotencyKey);
  },

  // GET /api/me/transactions/:id/payment-instructions (US-18-TC07).
  paymentInstructions(transactionId: string) {
    return apiClient.request<PaymentInstructions>(`/me/transactions/${encodeURIComponent(transactionId)}/payment-instructions`);
  },

  // POST /api/me/service-sales/:id/cancel (US-18-TC11): body {version, reason} + Idempotency-Key.
  cancel(saleId: string, input: CancelInput, idempotencyKey: string) {
    return postWithKey<{ saleId: string; transactionId: string; status: 'CANCELLED' }>(
      `/me/service-sales/${encodeURIComponent(saleId)}/cancel`, input, idempotencyKey);
  },
};
