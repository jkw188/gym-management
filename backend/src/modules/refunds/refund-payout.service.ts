import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { isDuplicateKey } from '../../common/http/http-error.filter';
import { ServerClock } from '../../common/utils/business-date';
import { validateObjectId } from '../../common/utils/normalization';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationSchema } from '../notifications/schemas/notification.schema';
import { NotificationRecipientSchema } from '../notifications/schemas/notification-recipient.schema';
import { NotificationOutboxSchema } from '../notifications/schemas/notification-outbox.schema';
import { IdempotencyService, transactionRequestKey } from '../operations/idempotency.service';
import { OperationRequestSchema } from '../operations/schemas/operation-request.schema';
import { Order } from '../orders/order.schema';
import { Payment } from '../payments/schemas/payment.schema';
import { Refund, RefundSchema } from './refund.schema';
import { RefundAttempt, RefundAttemptSchema } from './refund-attempt.schema';
import { assertRefundIndexes, refundAmount, refundBudget, refundIntegrityError } from './refund-integrity';
import { ConfirmRefundDto, FailRefundDto } from './refunds.dto';

export function payoutReference(input: ConfirmRefundDto): string {
  const normalize = (value: string) => value.normalize('NFKC').trim().toUpperCase();
  if (input.method === 'TRANSFER') {
    if (!input.payoutAccountCode || !input.bankReference || input.cashVoucherReference !== undefined) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Chuyển khoản cần tài khoản chi và mã ngân hàng, không dùng phiếu tiền mặt');
    if (/^RF:/i.test(input.bankReference)) throw new ApplicationError(400, 'VALIDATION_ERROR', 'RF là mã nội bộ, cần chứng từ thực chi');
    return JSON.stringify(['TRANSFER', normalize(input.payoutAccountCode), normalize(input.bankReference)]);
  }
  if (!input.cashVoucherReference || input.bankReference !== undefined || input.payoutAccountCode !== undefined || /^RF:/i.test(input.cashVoucherReference)) {
    throw new ApplicationError(400, 'VALIDATION_ERROR', 'Tiền mặt cần số phiếu chi thực tế');
  }
  return JSON.stringify(['CASH', normalize(input.cashVoucherReference)]);
}

@Injectable()
export class RefundPayoutService {
  constructor(@InjectConnection() private readonly connection: Connection, @InjectModel('Refund') private readonly refunds: Model<Refund>,
    @InjectModel('RefundAttempt') private readonly attempts: Model<RefundAttempt>, private readonly guards: DataGuardsService,
    private readonly idempotency: IdempotencyService, private readonly notifications: NotificationsService,
    private readonly clock: ServerClock, private readonly config: ConfigService) {}

  async execute(actorId: string, id: string, input: ConfirmRefundDto | FailRefundDto, key: string, confirm: boolean) {
    const target = new Types.ObjectId(validateObjectId(id)), actor = new Types.ObjectId(actorId), operation = confirm ? 'REFUND_CONFIRM' : 'REFUND_FAIL';
    return this.idempotency.execute({ actorId, operation, clientKey: key, targetId: String(target), payload: { ...input } }, async session => {
      await assertRefundIndexes(this.connection, [RefundSchema, RefundAttemptSchema, OperationRequestSchema, NotificationSchema, NotificationRecipientSchema, NotificationOutboxSchema]);
      const db = this.connection.db!, route = await db.collection<Refund>('refunds').findOne({ _id: target }, { session });
      if (!route) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy nghĩa vụ hoàn');
      const orderRoute = await db.collection<Order>('orders').findOne({ _id: route.order_id }, { session });
      if (!orderRoute) throw refundIntegrityError();
      await this.guards.acquire(session, { members: orderRoute.member_id ? [orderRoute.member_id] : [], transactions: [orderRoute.transaction_id], orders: [orderRoute._id] });
      const now = this.clock.now(), row = await db.collection<Refund>('refunds').findOne({ _id: target }, { session });
      const order = await db.collection<Order>('orders').findOne({ _id: orderRoute._id }, { session });
      const payment = row && await db.collection<Payment>('payments').findOne({ _id: row.payment_id }, { session });
      const transaction = order && await db.collection('transactions').findOne({ _id: order.transaction_id }, { session });
      if (!row || !order || !payment || !transaction || transaction.kind !== 'RETAIL' || !payment.transaction_id.equals(order.transaction_id) ||
        !row.order_id.equals(order._id) || !row.id?.equals(row._id) || payment.status !== 'SUCCEEDED') throw refundIntegrityError();
      if (row.reason === 'CANCELLATION') {
        if (order.status !== 'CANCELLED' || order.reservation_state !== 'RELEASED' || row.return_id || row.obligation_key !== `CANCELLATION:${payment._id}`) throw refundIntegrityError();
      } else {
        const source = row.return_id && await db.collection('returns').findOne({ _id: row.return_id, order_id: order._id }, { session });
        if (!source || order.status !== 'COMPLETED' || order.reservation_state !== 'CONSUMED' || row.obligation_key !== `RETURN:${row.return_id}:${payment._id}` ||
          fromVndDecimal(source.amount_snapshot) !== fromVndDecimal(row.amount)) throw refundIntegrityError();
      }
      const budget = await refundBudget(this.connection, order._id, payment, session);
      if (row.status === 'SUCCEEDED') throw new ApplicationError(409, 'REFUND_ALREADY_SUCCEEDED', 'Khoản hoàn đã được thực chi', [{ field: 'status', message: row.status }]);
      if (!Number.isInteger(row.version) || row.version !== input.version || row.version >= 2147483647) throw new ApplicationError(409, 'VERSION_CONFLICT', 'Nghĩa vụ đã thay đổi hoặc cần migration, hãy tải lại');
      const set: Partial<Refund> = { status: confirm ? 'SUCCEEDED' : 'FAILED' };
      let evidence: Refund['payout_evidence'];
      if (confirm) {
        const data = input as ConfirmRefundDto, reference = payoutReference(data), paidOutAt = new Date(data.paidOutAt);
        if (data.method === 'TRANSFER') {
          const codes = this.config.get<string[]>('payoutAccounts') ?? [];
          if (!codes.length) throw new ApplicationError(503, 'PAYOUT_ACCOUNTS_NOT_CONFIGURED', 'Chưa cấu hình tài khoản chi');
          if (!codes.includes(data.payoutAccountCode!)) throw new ApplicationError(400, 'PAYOUT_ACCOUNT_INVALID', 'Tài khoản chi không hợp lệ');
        }
        if (BigInt(data.amount) !== refundAmount(row.amount)) throw new ApplicationError(409, 'AMOUNT_MISMATCH', 'Phải chi đủ số tiền nghĩa vụ');
        if (!Number.isFinite(paidOutAt.getTime()) || paidOutAt > now || paidOutAt < row.created_at) throw new ApplicationError(400, 'INVALID_PAYOUT_TIME', 'Thời điểm chi phải từ lúc tạo nghĩa vụ đến hiện tại');
        if (budget.refunded + refundAmount(row.amount) > refundAmount(payment.amount)) throw refundIntegrityError();
        if (await db.collection<Refund>('refunds').findOne({ payout_reference_key: reference }, { session })) throw new ApplicationError(409, 'PAYOUT_REFERENCE_USED', 'Chứng từ thực chi đã được dùng');
        evidence = { evidenceNote: data.evidenceNote, ...(data.method === 'TRANSFER' ? { payoutAccountCode: data.payoutAccountCode, bankReference: data.bankReference } : { cashVoucherReference: data.cashVoucherReference }) };
        Object.assign(set, { method: data.method, payout_reference_key: reference, payout_evidence: evidence, refunded_at: paidOutAt, verified_at: now, verified_by: actor });
      } else set.failure_code = (input as FailRefundDto).failureReason;
      const updated = await this.refunds.findOneAndUpdate({ _id: target, version: input.version, status: { $in: ['PENDING', 'FAILED'] } },
        { $set: set, $inc: { version: 1 }, ...(confirm ? { $unset: { failure_code: 1 } } : {}) }, { session, returnDocument: 'after', runValidators: true }).lean().exec();
      if (!updated) throw new ApplicationError(409, 'VERSION_CONFLICT', 'Nghĩa vụ đã thay đổi');
      await this.attempts.create([{ refund_id: target, operation_id: transactionRequestKey(actorId, operation, key), status_before: row.status,
        status_after: updated.status, actor_id: actor, occurred_at: now, evidence_note: input.evidenceNote,
        ...(confirm ? { method: updated.method, payout_evidence: evidence, paid_out_at: updated.refunded_at } : { failure_reason: (input as FailRefundDto).failureReason }) }], { session });
      if (confirm) {
        const member = order.member_id ? await db.collection('members').findOne({ _id: order.member_id }, { session }) : null;
        await this.notifications.persistBusinessEvent(session, { eventKey: `REFUND_SUCCEEDED:${target}`, title: 'Đã hoàn tiền',
          body: `Khoản hoàn của đơn ${order.code} đã được xác minh thực chi.`, memberId: order.member_id ? String(order.member_id) : undefined,
          transactionId: String(order.transaction_id), createdBy: actorId }, member?.account_id ? [String(member.account_id)] : []);
      }
      return { status: 200, body: { id, orderId: String(row.order_id), status: updated.status, version: updated.version, amount: fromVndDecimal(row.amount),
        refundedAt: updated.refunded_at?.toISOString() ?? null, verifiedAt: updated.verified_at?.toISOString() ?? null }, resultIds: { refundId: target, orderId: row.order_id } };
    }).catch(error => { if (isDuplicateKey(error)) throw new ApplicationError(409, 'PAYOUT_REFERENCE_USED', 'Chứng từ thực chi đã được dùng'); throw error; });
  }
}
