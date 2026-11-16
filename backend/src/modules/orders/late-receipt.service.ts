import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, MongoServerError } from 'mongodb';
import { Model, Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { validateObjectId } from '../../common/utils/normalization';
import { ReceivingAccountPolicy } from '../../common/utils/receiving-account';
import { assertPaymentAmount, fromVndDecimal, toVndDecimal } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { NotificationsService } from '../notifications/notifications.service';
import { IdempotencyService } from '../operations/idempotency.service';
import { normalizePaymentIntent, normalizePaymentReview } from '../payments/payment-review.policy';
import { Payment, PaymentSchema } from '../payments/schemas/payment.schema';
import { RefundSchema } from '../refunds/refund.schema';
import { RefundsService } from '../refunds/refunds.service';
import { LateReceiptDto } from './order-cancellation.dto';
import { assertOrderIntegrity, orderIntegrityError } from './order.policy';
import { OrdersRepository } from './orders.repository';

@Injectable()
export class LateReceiptService {
  constructor(private readonly repository: OrdersRepository, private readonly guards: DataGuardsService,
    private readonly idempotency: IdempotencyService, private readonly accounts: ReceivingAccountPolicy,
    @InjectModel('Payment') private readonly payments: Model<Payment>, private readonly refunds: RefundsService,
    private readonly notifications: NotificationsService, private readonly clock: ServerClock) {}
  async record(actorId: string, id: string, input: LateReceiptDto, key: string) {
    const target = new Types.ObjectId(validateObjectId(id)), intent = normalizePaymentIntent(input);
    try {
      return await this.idempotency.execute({ actorId, operation: 'RETAIL_LATE_RECEIPT', clientKey: key,
        targetId: String(target), payload: { ...intent, channel: 'LATE_CANCELLED_ORDER' } }, async session => {
        await this.repository.assertFulfillmentReady([RefundSchema, PaymentSchema]);
        const route = await this.repository.order(target, session);
        if (!route) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');
        await this.guards.acquire(session, { members: route.member_id ? [route.member_id] : [], transactions: [route.transaction_id], orders: [target] });
        const row = await this.repository.order(target, session);
        if (!row) throw orderIntegrityError();
        const transaction = await this.repository.transaction(row.transaction_id, session), items = await this.repository.lines(target, session), now = this.clock.now();
        assertOrderIntegrity(row, transaction, items);
        if (row.status !== 'CANCELLED' || row.reservation_state !== 'RELEASED') throw new ApplicationError(409, 'INVALID_ORDER_STATE', 'Chỉ ghi khoản muộn cho đơn đã hủy và giải phóng hàng');
        // Check reference first so a second key for the same real receipt points to the existing record.
        const used = await this.payments.findOne({ reference: intent.reference }).session(session).lean().exec();
        if (used) throw await this.referenceUsed(used, target, session);
        const existing = await this.payments.findOne({ transaction_id: transaction._id, status: 'SUCCEEDED' }).session(session).lean().exec();
        if (existing || transaction.status === 'SETTLED') throw new ApplicationError(409, 'EXTRA_RECEIPT_REQUIRES_RECONCILIATION',
          'Đã có khoản thu; khoản chuyển thêm cần đối soát tại quầy, không đổi tham chiếu để ghi lại', existing ? [{ field: 'paymentId', message: String(existing._id) }] : undefined);
        if (transaction.status !== 'CANCELLED' || await this.repository.invoice(transaction._id, session)) throw orderIntegrityError();
        const normalized = normalizePaymentReview(input, transaction.created_at, now);
        this.accounts.assertTransferAllowed(input.receivingAccountCode);
        if (fromVndDecimal(transaction.amount_due) === '0') throw new ApplicationError(409, 'AMOUNT_MISMATCH', 'Đơn không có nghĩa vụ thu; khoản chuyển cần đối soát riêng');
        if (normalized.amount !== fromVndDecimal(transaction.amount_due)) throw new ApplicationError(409, 'AMOUNT_MISMATCH', 'Khoản chuyển không bằng toàn bộ số tiền phải trả; cần đối soát riêng');
        const amount = assertPaymentAmount(normalized.amount, fromVndDecimal(transaction.amount_due));
        const paymentId = new Types.ObjectId(), actor = new Types.ObjectId(actorId);
        const [payment] = await this.payments.create([{ _id: paymentId, id: paymentId, transaction_id: transaction._id, method: 'TRANSFER',
          reference: normalized.reference!, bank_reference: normalized.bankReference, receiving_account_code: normalized.receivingAccountCode,
          amount: toVndDecimal(amount), status: 'SUCCEEDED', paid_at: normalized.receivedAt!, verified_at: now, verified_by: actor,
          evidence_note: normalized.evidenceNote, receipt_purpose: 'LATE_CANCELLED_ORDER', created_at: now }], { session });
        const refund = await this.refunds.cancellation(target, payment.toObject(), now, actor, session);
        if (!refund) throw orderIntegrityError();
        const eventKey = `ORDER_LATE_RECEIPT:${target}`;
        await this.repository.events.create([{ order_id: target, action: 'LATE_RECEIPT', actor_type: 'USER', actor_id: actor, occurred_at: now,
          before: { status: row.status, version: row.version }, after: { status: row.status, version: row.version }, event_key: eventKey, reason: normalized.evidenceNote }], { session });
        const notification = await this.notifications.persistBusinessEvent(session, { eventKey, title: 'Ghi nhận khoản thu cho đơn đã hủy',
          body: `Đã đối soát khoản thu ${amount} VND của đơn ${row.code}. Nghĩa vụ đang chờ hoàn; đơn vẫn hủy, chưa thực chi hoàn tiền.`,
          memberId: row.member_id ? String(row.member_id) : undefined, transactionId: String(transaction._id), createdBy: actorId }, await this.repository.recipient(row.member_id, session));
        return { status: 200, body: { orderId: String(target), paymentId: String(paymentId), refundId: String(refund._id), refundState: 'PENDING',
          transactionStatus: 'CANCELLED', notificationState: notification.notificationState }, resultIds: { orderId: target, paymentId, refundId: refund._id } };
      });
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'DATA_GUARD_NOT_READY') throw orderIntegrityError();
      if (error instanceof MongoServerError && error.code === 11000 && error.keyPattern?.reference === 1) {
        const used = await this.payments.findOne({ reference: intent.reference }).lean().exec();
        if (used) throw await this.referenceUsed(used, target);
        throw new ApplicationError(409, 'PAYMENT_REFERENCE_USED', 'Tham chiếu đã được ghi nhận; đối soát khoản gốc, không đổi mã để thử lại');
      }
      throw error;
    }
  }
  private async referenceUsed(payment: Payment, target: Types.ObjectId, session?: ClientSession) {
    const order = await this.repository.connection.db!.collection('orders').findOne({ transaction_id: payment.transaction_id }, { session });
    const refund = await this.refunds.refunds.findOne({ payment_id: payment._id, reason: 'CANCELLATION' }).session(session ?? null).lean().exec();
    return new ApplicationError(409, 'PAYMENT_REFERENCE_USED', 'Tham chiếu đã dùng; tra cứu khoản thu và nghĩa vụ hoàn hiện có',
      [{ field: 'paymentId', message: String(payment._id) }, ...(order ? [{ field: 'orderId', message: String(order._id) }] : []),
        ...(order?._id.equals(target) && refund ? [{ field: 'refundId', message: String(refund._id) }] : [])]);
  }
}
