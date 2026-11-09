// Tầng kiểu dữ liệu (US-17 bước 1): dữ liệu API cá nhân /api/me/* trả cho Member (camelCase, tiền là chuỗi VND).
// Chỉ gồm field Member được xem; không có request_key, created_by, reference, verified_by (US-17-F04).
import { SaleOperation } from './schemas/service-sale.schema';
import { MembershipStatus } from './schemas/membership.schema';
import { PaymentMethod } from '../payments/schemas/payment.schema';
import { TransactionKind, TransactionStatus } from '../payments/schemas/transaction.schema';

// Một kỳ gói của Member, hiển thị theo snapshot của sale (US-17-F02).
export interface MeMembershipDto {
  id: string;
  serviceSaleId: string;
  transactionId: string;
  previousSaleId?: string;
  operation: SaleOperation;
  storedStatus: MembershipStatus;
  planName: string;
  benefits: string;
  startDate: string;
  endDate: string;
  sessionsQuota: number;
  sessionsUsed: number;
  // Bước 2 (US-17-F02, F03): các giá trị service tính thêm, xem MeMembershipState.
  kind?: TransactionKind;
  timeState: TimeState;
  sessionsReserved: number;
  sessionsAvailable: number;
}

// Phần service tính cho một kỳ gói; mapper chỉ chép sang MeMembershipDto, không tự tính.
export interface MeMembershipState {
  kind?: TransactionKind;          // GYM/PT lấy từ transaction của sale; thiếu nếu dữ liệu lệch chủ
  timeState: TimeState;
  sessionsReserved: number;
  sessionsAvailable: number;
}

// Một lần mua gói của Member; status lấy từ transaction của sale.
export interface MeServiceSaleDto {
  id: string;
  transactionId: string;
  previousSaleId?: string;
  membershipId?: string;
  operation: SaleOperation;
  status?: TransactionStatus;
  planName: string;
  benefits: string;
  policy: string;
  startDate: string;
  endDate: string;
  listPrice: string;
  creditAmount: string;
  amountDue?: string;
  sessionsQuota: number;
}

// Khoản thu của chính Member: chỉ method, amount, paidAt (US-17-F04).
export interface MePaymentDto {
  method: PaymentMethod;
  amount: string;
  paidAt?: string;
}

export interface MeTransactionDto {
  id: string;
  code: string;
  kind: TransactionKind;
  status: TransactionStatus;
  amountDue: string;
  createdAt: string;
  payment?: MePaymentDto;
  invoiceId?: string;
  membershipId?: string;
}

export interface MeInvoiceDto {
  id: string;
  invoiceNo: string;
  transactionId: string;
  issuedAt: string;
  totalAmount: string;
  buyer: string;
}

// Một trang danh sách. memberLinked=false khi account chưa được liên kết hồ sơ (US-17-TC03).
export interface MeListPage<T> {
  memberLinked: boolean;
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  asOf: string;
}

export interface MeListQuery {
  page: number;
  limit: number;
}

// Gói tập chỉ có loại GYM hoặc PT (RETAIL là bán lẻ, không cấp gói).
export const MEMBERSHIP_KINDS = ['GYM', 'PT'] as const;
export type MembershipKind = (typeof MEMBERSHIP_KINDS)[number];

// US-17-F02: CURRENT đang trong kỳ, SCHEDULED chưa tới ngày bắt đầu, EXPIRED đã qua ngày cuối (theo ngày VN).
export const TIME_STATES = ['CURRENT', 'SCHEDULED', 'EXPIRED'] as const;
export type TimeState = (typeof TIME_STATES)[number];

export interface MeMembershipsQuery extends MeListQuery {
  kind?: MembershipKind;
  storedStatus?: MembershipStatus;
  timeState?: TimeState;
}
