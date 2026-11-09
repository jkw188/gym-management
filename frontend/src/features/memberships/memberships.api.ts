// Tầng giao diện – gọi API (US-17 bước 3): Member đọc gói, lần mua, giao dịch, chứng từ của chính mình qua ApiClient.
// CHỈ có lệnh GET (US-17-F05, TC11); không gửi memberId/accountId vì server lấy chủ thể từ phiên đăng nhập (US-17-F01).
import { apiClient } from '../../api/client';

export type MembershipKind = 'GYM' | 'PT';
export type StoredStatus = 'ACTIVE' | 'SUPERSEDED' | 'CANCELLED';
export type TimeState = 'CURRENT' | 'SCHEDULED' | 'EXPIRED';
export type SaleOperation = 'REGISTER' | 'RENEW' | 'UPGRADE';
export type TransactionStatus = 'PENDING' | 'SETTLED' | 'CANCELLED';

// Một kỳ gói; timeState và các số buổi do server tính (không tự tính ngày/quota ở React).
export interface MyMembership {
  id: string;
  serviceSaleId: string;
  transactionId: string;
  previousSaleId?: string;
  operation: SaleOperation;
  storedStatus: StoredStatus;
  timeState: TimeState;
  kind?: MembershipKind;
  planName: string;
  benefits: string;
  startDate: string;   // YYYY-MM-DD
  endDate: string;     // YYYY-MM-DD, ngày cuối vẫn được dùng
  sessionsQuota: number;
  sessionsUsed: number;
  sessionsReserved: number;
  sessionsAvailable: number;
}

export interface MyServiceSale {
  id: string;
  transactionId: string;
  membershipId?: string;
  operation: SaleOperation;
  status?: TransactionStatus;
  planName: string;
  startDate: string;
  endDate: string;
  amountDue?: string;  // tiền là chuỗi số nguyên VND
}

export interface MyTransaction {
  id: string;
  code: string;
  status: TransactionStatus;
  amountDue: string;
  createdAt: string;
  payment?: { method: 'CASH' | 'TRANSFER'; amount: string; paidAt?: string };
  invoiceId?: string;
}

export interface MyInvoice {
  id: string;
  invoiceNo: string;
  issuedAt: string;
  totalAmount: string;
  buyer: string;       // người mua theo snapshot của chứng từ
}

export interface MyListPage<T> {
  memberLinked: boolean;
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  asOf: string;
}

// Trang hiện tải một lần tối đa 100 bản ghi (limit lớn nhất server cho phép).
const LIST_QUERY = 'page=1&limit=100';

export const membershipsApi = {
  listMemberships() {
    return apiClient.request<MyListPage<MyMembership>>(`/me/memberships?${LIST_QUERY}`);
  },
  listServiceSales() {
    return apiClient.request<MyListPage<MyServiceSale>>(`/me/service-sales?${LIST_QUERY}`);
  },
  transaction(id: string) {
    return apiClient.request<MyTransaction>(`/me/transactions/${encodeURIComponent(id)}`);
  },
  invoice(id: string) {
    return apiClient.request<MyInvoice>(`/me/invoices/${encodeURIComponent(id)}`);
  },
};
