// Tầng kiểu dữ liệu (US-17 bước 1): đổi document gói/sale/giao dịch/chứng từ thành dữ liệu trả cho Member theo allowlist.
// Chỉ chép field được phép; field nội bộ (request_key, created_by, reference, verified_by, member_id) không bao giờ ra ngoài.
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { Invoice } from '../payments/schemas/invoice.schema';
import { Payment } from '../payments/schemas/payment.schema';
import { Transaction } from '../payments/schemas/transaction.schema';
import { MeInvoiceDto, MeMembershipDto, MeServiceSaleDto, MeTransactionDto } from './me-memberships.types';
import { Membership } from './schemas/membership.schema';
import { ServiceSale } from './schemas/service-sale.schema';

// US-17-F02: tên, quyền lợi, kỳ, quota lấy từ snapshot của sale, không đọc lại gói hiện tại.
export function toMeMembership(membership: Membership, sale: ServiceSale): MeMembershipDto {
  return {
    id: membership._id.toHexString(),
    serviceSaleId: sale._id.toHexString(),
    transactionId: sale.transaction_id.toHexString(),
    ...(sale.previous_sale_id ? { previousSaleId: sale.previous_sale_id.toHexString() } : {}),
    operation: sale.operation,
    storedStatus: membership.status,
    planName: sale.plan_name_snapshot,
    benefits: sale.benefits_snapshot,
    startDate: sale.start_date,
    endDate: sale.end_date,
    sessionsQuota: Number(sale.sessions_snapshot),
    sessionsUsed: Number(membership.sessions_used),
  };
}

// transaction có thể thiếu nếu dữ liệu hỏng (không cùng chủ): khi đó không trả status/amountDue thay vì đoán.
export function toMeServiceSale(sale: ServiceSale, transaction?: Transaction, membership?: Membership): MeServiceSaleDto {
  return {
    id: sale._id.toHexString(),
    transactionId: sale.transaction_id.toHexString(),
    ...(sale.previous_sale_id ? { previousSaleId: sale.previous_sale_id.toHexString() } : {}),
    ...(membership ? { membershipId: membership._id.toHexString() } : {}),
    operation: sale.operation,
    ...(transaction ? { status: transaction.status, amountDue: fromVndDecimal(transaction.amount_due) } : {}),
    planName: sale.plan_name_snapshot,
    benefits: sale.benefits_snapshot,
    policy: sale.policy_snapshot,
    startDate: sale.start_date,
    endDate: sale.end_date,
    listPrice: fromVndDecimal(sale.list_price_snapshot),
    creditAmount: fromVndDecimal(sale.credit_amount),
    sessionsQuota: Number(sale.sessions_snapshot),
  };
}

// US-17-F04: của khoản thu chỉ trả method, amount, paidAt.
export function toMeTransaction(transaction: Transaction, payment: Payment | null, invoice: Invoice | null,
  membership: Membership | null): MeTransactionDto {
  return {
    id: transaction._id.toHexString(),
    code: transaction.code,
    kind: transaction.kind,
    status: transaction.status,
    amountDue: fromVndDecimal(transaction.amount_due),
    createdAt: transaction.created_at.toISOString(),
    ...(payment ? { payment: {
      method: payment.method,
      amount: fromVndDecimal(payment.amount),
      ...(payment.paid_at ? { paidAt: payment.paid_at.toISOString() } : {}),
    } } : {}),
    ...(invoice ? { invoiceId: invoice._id.toHexString() } : {}),
    ...(membership ? { membershipId: membership._id.toHexString() } : {}),
  };
}

// US-17-F04: người mua lấy từ buyer_snapshot của chứng từ, không từ hồ sơ hiện tại.
export function toMeInvoice(invoice: Invoice): MeInvoiceDto {
  return {
    id: invoice._id.toHexString(),
    invoiceNo: invoice.invoice_no,
    transactionId: invoice.transaction_id.toHexString(),
    issuedAt: invoice.issued_at.toISOString(),
    totalAmount: fromVndDecimal(invoice.total_amount),
    buyer: invoice.buyer_snapshot,
  };
}
