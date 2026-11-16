import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Model, Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { ReceivingAccountPolicy } from '../../common/utils/receiving-account';
import { assertPaymentAmount, fromVndDecimal, toVndDecimal } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentReviewDto } from '../payments/payment-review.dto';
import { normalizePaymentReview, paymentReviewResult } from '../payments/payment-review.policy';
import { Invoice } from '../payments/schemas/invoice.schema';
import { Payment } from '../payments/schemas/payment.schema';
import { Transaction } from '../payments/schemas/transaction.schema';
import { assertOrderIntegrity, orderConflict, orderIntegrityError } from './order.policy';
import { Order } from './order.schema';
import { OrdersRepository } from './orders.repository';

type RetailPaymentReview = ReturnType<typeof paymentReviewResult> & {
  kind: 'RETAIL'; orderId: string; orderCode: string; orderStatus: string; reservationExpiresAt: string;
};

@Injectable()
export class RetailSettlementService {
  constructor(private readonly repository: OrdersRepository, private readonly guards: DataGuardsService,
    private readonly transactions: TransactionRunner, private readonly accounts: ReceivingAccountPolicy,
    private readonly notifications: NotificationsService, private readonly clock: ServerClock,
    @InjectModel('Payment') private readonly payments: Model<Payment>, @InjectModel('Invoice') private readonly invoices: Model<Invoice>,
    @InjectModel('Transaction') private readonly transactionModel: Model<Transaction>) {}
  async review(id: Types.ObjectId, input: PaymentReviewDto, session?: ClientSession): Promise<RetailPaymentReview> {
    if (!session) return this.transactions.run(current => this.review(id, input, current));
    const transaction = await this.repository.transaction(id, session);
    const order = await this.repository.connection.db!.collection<Order>('orders').findOne({ transaction_id: id }, { session });
    if (!transaction || !order) throw orderIntegrityError();
    const now = this.clock.now(), normalized = normalizePaymentReview(input, transaction.created_at, now);
    if (normalized.receivingAccountCode) this.accounts.assertTransferAllowed(normalized.receivingAccountCode);
    assertOrderIntegrity(order, transaction, await this.repository.lines(order._id, session));
    const blockers: string[] = [];
    if (!['PENDING', 'CONFIRMED'].includes(order.status) || order.reservation_state !== 'HELD') blockers.push('INVALID_ORDER_STATE');
    if (now >= order.reservation_expires_at) blockers.push('RESERVATION_EXPIRED');
    if (transaction.status !== 'PENDING') blockers.push(transaction.status === 'SETTLED' ? 'TRANSACTION_ALREADY_SETTLED' : 'INVALID_TRANSACTION_STATE');
    const amountDue = fromVndDecimal(transaction.amount_due);
    if (amountDue === '0') blockers.push('ZERO_PAYMENT_NOT_REQUIRED');
    if (await this.payments.exists({ transaction_id: id, status: 'SUCCEEDED' }).session(session)) blockers.push('PAYMENT_ALREADY_SUCCEEDED');
    if (normalized.reference && await this.payments.exists({ reference: normalized.reference }).session(session)) blockers.push('PAYMENT_REFERENCE_USED');
    return { ...paymentReviewResult(amountDue, normalized, blockers, now), kind: 'RETAIL', orderId: String(order._id), orderCode: order.code,
      orderStatus: order.status, reservationExpiresAt: order.reservation_expires_at.toISOString() };
  }
  // Called by US-22 inside PAYMENT_CONFIRM's transaction, after the replay check.
  async confirmWithinSession(session: ClientSession, actorId: string, id: Types.ObjectId, input: PaymentReviewDto) {
    await this.repository.assertFulfillmentReady();
    const route = await this.repository.connection.db!.collection<Order>('orders').findOne({ transaction_id: id }, { session });
    if (!route) throw orderIntegrityError();
    await this.guards.acquire(session, { members: route.member_id ? [route.member_id] : [], transactions: [id], orders: [route._id] });
    const order = await this.repository.order(route._id, session), transaction = await this.repository.transaction(id, session);
    if (!order || !transaction) throw orderIntegrityError();
    const result = await this.review(id, input, session);
    if (!result.canConfirm) throw new ApplicationError(409, result.blockingCodes[0], 'Không thể thu tiền; cần kiểm tra trạng thái, hạn giữ và căn cứ');
    await this.repository.assertPaymentIntegrity(transaction, session);
    const now = this.clock.now();
    // A second clock at the actual decision also covers slow evidence checks.
    if (now >= order.reservation_expires_at) throw new ApplicationError(409, 'RESERVATION_EXPIRED', 'Đã hết hạn giữ hàng');
    const normalized = normalizePaymentReview(input, transaction.created_at, now), amount = assertPaymentAmount(normalized.amount, result.amountDue);
    const actor = new Types.ObjectId(actorId), paymentId = new Types.ObjectId();
    await this.payments.create([{ _id: paymentId, id: paymentId, transaction_id: id, method: normalized.method,
      reference: normalized.reference ?? `CASH:${paymentId}`, amount: toVndDecimal(amount), status: 'SUCCEEDED',
      verified_by: actor, verified_at: now, paid_at: normalized.receivedAt ?? now, evidence_note: normalized.evidenceNote,
      ...(normalized.method === 'TRANSFER' ? { receiving_account_code: normalized.receivingAccountCode, bank_reference: normalized.bankReference } : {}), created_at: now }], { session });
    const invoice = await this.completeWithinSession(session, order, transaction, now);
    const changed = await this.repository.orders.updateOne({ _id: order._id, version: order.version, status: order.status, reservation_state: 'HELD' },
      { $set: { updated_at: now }, $inc: { version: 1 } }, { session });
    if (changed.modifiedCount !== 1 || order.version >= 2147483647) throw orderConflict();
    const eventKey = `ORDER_PAYMENT_SETTLED:${order._id}`;
    await this.repository.events.create([{ order_id: order._id, action: 'PAYMENT_SETTLED', actor_type: 'USER', actor_id: actor, occurred_at: now,
      before: { status: order.status, version: order.version }, after: { status: order.status, version: order.version + 1 }, event_key: eventKey }], { session });
    const notification = await this.notifications.persistBusinessEvent(session, { eventKey, title: 'Đã xác nhận thanh toán đơn hàng',
      body: `Đơn ${order.code} đã thanh toán ${amount} VND. Bàn giao được xác nhận riêng, hạn giữ hàng không thay đổi.`,
      memberId: order.member_id ? String(order.member_id) : undefined, transactionId: String(id), createdBy: actorId }, await this.repository.recipient(order.member_id, session));
    return { status: 200, body: { kind: 'RETAIL', transactionId: String(id), transactionCode: transaction.code, status: 'SETTLED',
      orderId: String(order._id), orderCode: order.code, paymentId: String(paymentId), invoiceId: invoice.id, invoiceNo: invoice.invoiceNo,
      notificationState: notification.notificationState }, resultIds: { transactionId: id, orderId: order._id, paymentId, invoiceId: invoice.id } };
  }
  // Shared positive/zero RETAIL completion. Zero creates an invoice without a payment or membership.
  async completeWithinSession(session: ClientSession, order: Order, transaction: Transaction, now: Date) {
    if (!session.inTransaction() || transaction.status !== 'PENDING' || transaction.kind !== 'RETAIL') throw orderIntegrityError();
    const id = new Types.ObjectId(), invoiceNo = `INV-${id}`;
    await this.invoices.create([{ _id: id, id, transaction_id: transaction._id, invoice_no: invoiceNo, issued_at: now,
      total_amount: transaction.amount_due, buyer_snapshot: JSON.stringify({ fullName: order.recipient_name, phone: order.recipient_phone }) }], { session });
    const changed = await this.transactionModel.updateOne({ _id: transaction._id, status: 'PENDING', version: transaction.version },
      { $set: { status: 'SETTLED', settled_at: now }, $inc: { version: 1 } }, { session });
    if (changed.modifiedCount !== 1) throw orderIntegrityError();
    return { id: String(id), invoiceNo };
  }
}
