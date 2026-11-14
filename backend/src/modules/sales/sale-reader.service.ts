import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { SalesRepository } from './sales.repository';

// Shared response contract for REGISTER/RENEW and idempotency results, read from one snapshot.
@Injectable()
export class SaleReader {
  constructor(private readonly repository: SalesRepository, private readonly transactions: TransactionRunner) {}

  async detail(id: string, session?: ClientSession): Promise<Record<string, unknown>> {
    if (!/^[a-f\d]{24}$/i.test(id)) throw new ApplicationError(400, 'VALIDATION_ERROR', 'ID phải là ObjectId hợp lệ');
    if (!session) return this.transactions.run(current => this.detail(id, current));
    const sale = await this.repository.sales.findById(new Types.ObjectId(id)).session(session).lean().exec();
    if (!sale) throw new ApplicationError(404, 'SALE_NOT_FOUND', 'Không tìm thấy lần bán gói');
    const transaction = await this.repository.transactions.findById(sale.transaction_id).session(session).lean().exec();
    if (!transaction) throw new ApplicationError(503, 'SALE_DATA_NOT_READY', 'Dữ liệu giao dịch chưa đầy đủ');
    const membership = await this.repository.memberships.findOne({ service_sale_id: sale._id }).session(session).lean().exec();
    const invoice = await this.repository.invoices.findOne({ transaction_id: transaction._id }).session(session).lean().exec();
    const payment = await this.repository.payments.findOne({ transaction_id: transaction._id, status: 'SUCCEEDED' }).session(session).lean().exec();
    const notificationState = await this.repository.notificationState(id.toLowerCase(), session);
    return { saleId: sale._id.toHexString(), memberId: sale.member_id.toHexString(), planId: sale.plan_id.toHexString(),
      transactionId: transaction._id.toHexString(), transactionCode: transaction.code, transactionStatus: transaction.status,
      transactionVersion: transaction.version ?? 0, amountDue: fromVndDecimal(transaction.amount_due),
      kind: sale.kind_snapshot ?? transaction.kind, operation: sale.operation, planName: sale.plan_name_snapshot,
      channel: sale.channel ?? 'COUNTER',
      ...(sale.previous_sale_id ? { previousSaleId: sale.previous_sale_id.toHexString() } : {}),
      ...(sale.preferred_payment_method ? { preferredPaymentMethod: sale.preferred_payment_method } : {}),
      benefits: sale.benefits_snapshot, sessions: sale.sessions_snapshot, listPrice: fromVndDecimal(sale.list_price_snapshot),
      creditAmount: fromVndDecimal(sale.credit_amount), policySnapshot: sale.policy_snapshot,
      requestedStartDate: sale.requested_start_date ?? sale.start_date, startDate: sale.start_date, endDate: sale.end_date,
      ...(sale.duration_days_snapshot === undefined ? {} : { durationDays: sale.duration_days_snapshot }),
      ...(sale.plan_version_snapshot === undefined ? {} : { planVersion: sale.plan_version_snapshot }),
      ...(membership ? { membershipId: membership._id.toHexString() } : {}),
      ...(invoice ? { invoiceId: invoice._id.toHexString(), invoiceNumber: invoice.invoice_no } : {}),
      ...(payment ? { paymentId: payment._id.toHexString() } : {}), notificationState,
      ...(transaction.cancel_reason ? { cancelReason: transaction.cancel_reason } : {}) };
  }
}
