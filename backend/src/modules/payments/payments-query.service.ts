import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { addCalendarDays, assertBusinessDate, ServerClock } from '../../common/utils/business-date';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { Member } from '../members/schemas/member.schema';
import { TransactionQueryDto } from './payment-review.dto';
import { PaymentsQueryRepository } from './payments-query.repository';
import { Transaction } from './schemas/transaction.schema';

@Injectable()
export class PaymentsQueryService {
  constructor(private readonly repository: PaymentsQueryRepository, private readonly clock: ServerClock) {}

  async list(query: TransactionQueryDto) {
    if (query.kind === 'RETAIL') throw new ApplicationError(400, 'UNSUPPORTED_KIND', 'S02 chỉ hỗ trợ giao dịch GYM/PT');
    const filter: Record<string, unknown> = { kind: query.kind ?? { $in: ['GYM', 'PT'] } };
    if (query.status) filter.status = query.status;
    if (query.memberId) {
      filter.member_id = parseTransactionId(query.memberId);
      if (!await this.repository.member(filter.member_id as Types.ObjectId)) throw notFound('hội viên');
    }
    // Literal code search only. Escape every regex metacharacter rather than executing client regex.
    if (query.q) filter.code = { $regex: query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
    const from = query.createdFrom ? assertBusinessDate(query.createdFrom) : undefined;
    const to = query.createdTo ? assertBusinessDate(query.createdTo) : undefined;
    if (from && to && from > to) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc');
    if (from || to) filter.created_at = {
      ...(from ? { $gte: new Date(`${from}T00:00:00+07:00`) } : {}),
      ...(to ? { $lt: new Date(`${addCalendarDays(to, 1)}T00:00:00+07:00`) } : {}),
    };
    const { rows, total } = await this.repository.page(filter, query.page, query.limit);
    const members = await this.repository.memberRows(rows.flatMap(row => row.member_id ? [row.member_id] : []));
    return { items: rows.map(row => ({ ...transactionDto(row, members.find(member => member._id.equals(row.member_id))), saleId: row.sale_id?.toHexString() })),
      page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) };
  }

  async detail(id: string) {
    const asOf = this.clock.now();
    const transaction = await this.requireTransaction(id);
    const member = transaction.member_id ? await this.repository.member(transaction.member_id) : null;
    if (!member) throw notFound('hội viên');
    const sale = await this.repository.sale(transaction._id);
    const payments = await this.repository.paymentRows(transaction._id);
    const invoice = await this.repository.invoice(transaction._id);
    const membership = sale ? await this.repository.membership(sale._id) : null;
    return { transaction: transactionDto(transaction, member),
      ...(sale ? { sale: { id: sale._id.toHexString(), planId: sale.plan_id.toHexString(), memberId: sale.member_id.toHexString(),
        operation: sale.operation, planName: sale.plan_name_snapshot, benefits: sale.benefits_snapshot,
        listPrice: fromVndDecimal(sale.list_price_snapshot), creditAmount: fromVndDecimal(sale.credit_amount),
        sessions: Number(sale.sessions_snapshot), policySnapshot: sale.policy_snapshot, requestedStartDate: sale.requested_start_date,
        startDate: sale.start_date, endDate: sale.end_date } } : {}),
      payments: payments.map(payment => ({ id: payment._id.toHexString(), method: payment.method, reference: payment.reference,
        amount: fromVndDecimal(payment.amount), status: payment.status, paidAt: payment.paid_at?.toISOString(),
        verifiedBy: payment.verified_by?.toHexString(), verifiedAt: payment.verified_at?.toISOString(), evidenceNote: payment.evidence_note,
        receivingAccountCode: payment.receiving_account_code, bankReference: payment.bank_reference })),
      ...(invoice ? { invoice: { id: invoice._id.toHexString(), invoiceNo: invoice.invoice_no, issuedAt: invoice.issued_at.toISOString(),
        totalAmount: fromVndDecimal(invoice.total_amount), buyerSnapshot: invoice.buyer_snapshot } } : {}),
      ...(membership ? { membershipId: membership._id.toHexString() } : {}), asOf: asOf.toISOString() };
  }

  async requireTransaction(id: string) {
    const row = await this.repository.transaction(parseTransactionId(id));
    if (!row) throw notFound('giao dịch');
    if (row.kind === 'RETAIL') throw new ApplicationError(400, 'UNSUPPORTED_KIND', 'S02 chỉ hỗ trợ giao dịch GYM/PT');
    return row;
  }
}

function transactionDto(row: Transaction, member?: Member | null) {
  return { id: row._id.toHexString(), code: row.code, kind: row.kind, amountDue: fromVndDecimal(row.amount_due), status: row.status,
    memberId: row.member_id?.toHexString(), member: member ? { id: member._id.toHexString(), memberCode: member.member_code,
      fullName: member.full_name, phone: member.phone } : null,
    version: row.version ?? 0, createdAt: row.created_at.toISOString(), settledAt: row.settled_at?.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString(), cancelReason: row.cancel_reason };
}

export function parseTransactionId(id: string) {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new ApplicationError(400, 'INVALID_ID', 'ID phải là ObjectId 24 ký tự hex');
  return new Types.ObjectId(id);
}
function notFound(entity: string) { return new ApplicationError(404, 'NOT_FOUND', `Không tìm thấy ${entity}`); }
