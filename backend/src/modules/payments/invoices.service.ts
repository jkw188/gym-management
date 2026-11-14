import { Injectable } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/application-error';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { PaymentsQueryRepository } from './payments-query.repository';
import { parseTransactionId } from './payments-query.service';
import { SettlementRepository } from './settlement.repository';

@Injectable()
export class InvoicesService {
  constructor(private readonly repository: SettlementRepository, private readonly query: PaymentsQueryRepository) {}
  async detail(id: string) {
    const invoice = await this.repository.invoice(parseTransactionId(id));
    if (!invoice) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy chứng từ');
    const transaction = await this.query.transaction(invoice.transaction_id);
    if (!transaction) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy giao dịch của chứng từ');
    if (transaction.kind === 'RETAIL') throw new ApplicationError(400, 'UNSUPPORTED_KIND', 'S02 chỉ hỗ trợ GYM/PT');
    const sale = await this.query.sale(transaction._id);
    const payment = (await this.query.paymentRows(transaction._id)).find(row => row.status === 'SUCCEEDED');
    return { id: invoice._id.toHexString(), invoiceNo: invoice.invoice_no, issuedAt: invoice.issued_at.toISOString(),
      totalAmount: fromVndDecimal(invoice.total_amount), buyerSnapshot: invoice.buyer_snapshot,
      transactionId: transaction._id.toHexString(), transactionCode: transaction.code,
      serviceLine: sale ? { saleId: sale._id.toHexString(), planId: sale.plan_id.toHexString(), kind: transaction.kind,
        planName: sale.plan_name_snapshot, benefits: sale.benefits_snapshot, policySnapshot: sale.policy_snapshot,
        listPrice: fromVndDecimal(sale.list_price_snapshot), creditAmount: fromVndDecimal(sale.credit_amount),
        sessions: Number(sale.sessions_snapshot), startDate: sale.start_date, endDate: sale.end_date } : null,
      ...(payment ? { payment: { id: payment._id.toHexString(), method: payment.method, reference: payment.reference,
        amount: fromVndDecimal(payment.amount), paidAt: payment.paid_at?.toISOString(), verifiedAt: payment.verified_at?.toISOString() } } : {}) };
  }
}
