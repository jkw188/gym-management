import { Injectable } from '@nestjs/common';
import { ClientSession, MongoServerError } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError, ErrorDetail } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { assertPaymentAmount, fromVndDecimal, toVndDecimal } from '../../common/utils/vnd-money';
import { NotificationsService } from '../notifications/notifications.service';
import { IdempotencyService } from '../operations/idempotency.service';
import { invalidState, SaleActivation } from '../sales/sale-activation.service';
import { PaymentReviewDto } from './payment-review.dto';
import { normalizePaymentIntent, normalizePaymentReview } from './payment-review.policy';
import { PaymentReviewService } from './payment-review.service';
import { PaymentsQueryRepository } from './payments-query.repository';
import { parseTransactionId } from './payments-query.service';
import { SettlementRepository } from './settlement.repository';

@Injectable()
export class SettlementService {
  constructor(private readonly commands: IdempotencyService, private readonly query: PaymentsQueryRepository,
    private readonly repository: SettlementRepository, private readonly review: PaymentReviewService,
    private readonly activation: SaleActivation, private readonly notifications: NotificationsService, private readonly clock: ServerClock) {}

  async confirm(actorId: string, id: string, input: PaymentReviewDto, key: string) {
    const transactionId = parseTransactionId(id);
    const intent = normalizePaymentIntent(input);
    try {
      return await this.commands.execute({ actorId, operation: 'PAYMENT_CONFIRM', clientKey: key,
        targetId: transactionId.toHexString(), payload: { ...intent } }, async session => {
        const transaction = await this.query.transaction(transactionId, session);
        if (!transaction) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy giao dịch');
        if (transaction.kind === 'RETAIL') throw new ApplicationError(400, 'UNSUPPORTED_KIND', 'S02 chỉ hỗ trợ GYM/PT');
        if (transaction.status === 'SETTLED') throw await this.alreadySettled(transactionId, session);
        if (transaction.status !== 'PENDING' || fromVndDecimal(transaction.amount_due) === '0') throw invalidState();
        const sale = await this.query.sale(transactionId, session);
        if (!sale || !transaction.member_id) throw invalidState();
        if (!await this.repository.member(transaction.member_id, session)) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy hội viên');
        const paymentId = new Types.ObjectId(), invoiceId = new Types.ObjectId();
        const invoiceNo = `INV-${invoiceId.toHexString()}`;
        let verifiedAt = this.clock.now();
        let recipientId: string | undefined;
        // US-14 owns member -> transaction locks. Its hook runs AFTER acquiring both locks,
        // in the caller's session. Errors from any following step abort payment/invoice too.
        const activated = await this.activation.activateSaleWithinSession(session,
          { saleId: sale._id, memberId: transaction.member_id, transactionId }, async () => {
            verifiedAt = this.clock.now();
            const review = await this.review.review(id, input, session);
            if (!review.canConfirm) {
              const code = review.blockingCodes[0] ?? 'INVALID_TRANSACTION_STATE';
              throw new ApplicationError(409, code, 'Không thể xác nhận khoản thu. Hãy kiểm tra lại giao dịch và căn cứ');
            }
            const normalized = normalizePaymentReview(input, transaction.created_at, verifiedAt);
            const amount = assertPaymentAmount(normalized.amount, review.amountDue);
            const buyer = await this.repository.member(transaction.member_id!, session);
            if (!buyer) throw invalidState();
            recipientId = buyer.account_id?.toHexString();
            await this.repository.insertPayment({ _id: paymentId, id: paymentId, transaction_id: transactionId,
              method: normalized.method, reference: normalized.reference ?? `CASH:${paymentId.toHexString()}`,
              amount: toVndDecimal(amount), status: 'SUCCEEDED', verified_by: new Types.ObjectId(actorId),
              verified_at: verifiedAt, paid_at: normalized.receivedAt ?? verifiedAt, evidence_note: normalized.evidenceNote,
              ...(normalized.method === 'TRANSFER' ? { receiving_account_code: normalized.receivingAccountCode, bank_reference: normalized.bankReference } : {}),
              created_at: verifiedAt }, session);
            await this.repository.insertInvoice({ _id: invoiceId, id: invoiceId, transaction_id: transactionId, invoice_no: invoiceNo,
              issued_at: verifiedAt, total_amount: toVndDecimal(review.amountDue),
              buyer_snapshot: JSON.stringify({ fullName: buyer.full_name, memberCode: buyer.member_code, phone: buyer.phone }) }, session);
          });
        const changed = await this.repository.settle(transactionId, transaction.version ?? 0, verifiedAt, session);
        if (changed.modifiedCount !== 1) throw invalidState();
        const event = await this.notifications.persistBusinessEvent(session, {
          eventKey: `SERVICE_SALE_SETTLED:${sale._id.toHexString()}`, title: 'Đăng ký gói thành công',
          body: `Gói ${sale.plan_name_snapshot}: ${activated.startDate} – ${activated.endDate}. Giao dịch ${transaction.code}.`,
          memberId: transaction.member_id.toHexString(), transactionId: id.toLowerCase(), createdBy: actorId,
        }, recipientId ? [recipientId] : []);
        const result = { transactionId: transactionId.toHexString(), transactionCode: transaction.code, status: 'SETTLED',
          paymentId: paymentId.toHexString(), invoiceId: invoiceId.toHexString(), invoiceNo, saleId: sale._id.toHexString(),
          ...activated, notificationState: event.notificationState };
        return { status: 200, body: result, resultIds: { transactionId, paymentId, invoiceId, saleId: sale._id, membershipId: activated.membershipId } };
      });
    } catch (error) {
      // Convert only the business reference constraint. Preserve driver transient/unknown-commit labels.
      if (error instanceof MongoServerError && error.code === 11000 && error.keyPattern?.reference === 1) {
        throw new ApplicationError(409, 'PAYMENT_REFERENCE_USED', 'Tham chiếu đã dùng. Đối chiếu khoản thu gốc, không đổi mã để vượt xung đột');
      }
      throw error;
    }
  }

  private async alreadySettled(id: Types.ObjectId, session: ClientSession) {
    const sale = await this.query.sale(id, session), payments = await this.query.paymentRows(id, session);
    const membership = sale ? await this.query.membership(sale._id, session) : null;
    const invoice = await this.repository.invoices.findOne({ transaction_id: id }, { _id: 1 }).session(session).lean().exec();
    const details: ErrorDetail[] = [{ field: 'transactionId', message: id.toHexString() }];
    for (const [field, value] of Object.entries({ saleId: sale?._id, paymentId: payments.find(row => row.status === 'SUCCEEDED')?._id,
      invoiceId: invoice?._id, membershipId: membership?._id })) if (value) details.push({ field, message: value.toHexString() });
    return new ApplicationError(409, 'TRANSACTION_ALREADY_SETTLED', 'Giao dịch đã hoàn tất. Không thu thêm tiền', details);
  }
}
