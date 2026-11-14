import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { ReceivingAccountPolicy } from '../../common/utils/receiving-account';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { SalesRepository } from '../sales/sales.repository';
import { PaymentReviewDto } from './payment-review.dto';
import { normalizePaymentReview, paymentReviewResult } from './payment-review.policy';
import { PaymentsQueryRepository } from './payments-query.repository';
import { parseTransactionId } from './payments-query.service';

@Injectable()
export class PaymentReviewService {
  constructor(private readonly repository: PaymentsQueryRepository, private readonly sales: SalesRepository,
    private readonly accounts: ReceivingAccountPolicy, private readonly clock: ServerClock) {}

  // US-22 can repeat the same review inside its existing session after acquiring member/transaction guards.
  // This method only reads: no lock, reservation, operation record, payment or event is created.
  async review(id: string, input: PaymentReviewDto, session?: ClientSession) {
    const asOf = this.clock.now();
    const transaction = await this.repository.transaction(parseTransactionId(id), session);
    if (!transaction) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy giao dịch');
    if (transaction.kind === 'RETAIL') throw new ApplicationError(400, 'UNSUPPORTED_KIND', 'S02 chỉ hỗ trợ giao dịch GYM/PT');
    const normalized = normalizePaymentReview(input, transaction.created_at, asOf);
    if (normalized.receivingAccountCode) this.accounts.assertTransferAllowed(normalized.receivingAccountCode);
    const member = transaction.member_id ? await this.repository.member(transaction.member_id, session) : null;
    if (!member) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy hội viên');
    const amountDue = fromVndDecimal(transaction.amount_due);
    const blockers: string[] = [];
    if (amountDue === '0') blockers.push('ZERO_PAYMENT_NOT_REQUIRED');
    if (transaction.status !== 'PENDING') blockers.push(transaction.status === 'SETTLED' ? 'TRANSACTION_ALREADY_SETTLED' : 'INVALID_TRANSACTION_STATE');
    const sale = await this.repository.sale(transaction._id, session);
    if (!sale) blockers.push('SALE_NOT_FOUND');
    else {
      // Same frozen snapshot requirements as the US-14 activation handler. Never substitute current plan prices.
      if (!sale.member_id.equals(member._id) || sale.operation !== 'REGISTER' || !sale.requested_start_date ||
        !sale.duration_days_snapshot || sale.kind_snapshot !== transaction.kind ||
        fromVndDecimal(sale.credit_amount) !== '0' || fromVndDecimal(sale.list_price_snapshot) !== amountDue) {
        blockers.push('INVALID_SALE_STATE');
      }
      if (await this.repository.membership(sale._id, session)) blockers.push('MEMBERSHIP_ALREADY_EXISTS');
      const blocked = await this.sales.blockingCode(member._id, transaction.kind, this.clock.today(), session, transaction._id);
      if (blocked) blockers.push(blocked);
    }
    if ((await this.repository.paymentRows(transaction._id, session)).some(row => row.status === 'SUCCEEDED')) blockers.push('PAYMENT_ALREADY_SUCCEEDED');
    if (normalized.reference && await this.repository.referenceUsed(normalized.reference, session)) blockers.push('PAYMENT_REFERENCE_USED');
    return paymentReviewResult(amountDue, normalized, blockers, asOf);
  }
}
