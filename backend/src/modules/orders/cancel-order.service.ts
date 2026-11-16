import { Injectable } from '@nestjs/common';
import { ClientSession, Int32 } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { validateObjectId } from '../../common/utils/normalization';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { InventoryWriter } from '../inventory/inventory-writer';
import { NotificationsService } from '../notifications/notifications.service';
import { IdempotencyService } from '../operations/idempotency.service';
import { Payment } from '../payments/schemas/payment.schema';
import { RefundSchema } from '../refunds/refund.schema';
import { RefundsService } from '../refunds/refunds.service';
import { CancelOrderDto } from './order-cancellation.dto';
import { Order } from './order.schema';
import { assertOrderIntegrity, orderConflict, orderIntegrityError } from './order.policy';
import { OrdersRepository } from './orders.repository';

@Injectable()
export class CancelOrderService {
  constructor(private readonly repository: OrdersRepository, private readonly guards: DataGuardsService,
    private readonly inventory: InventoryWriter, private readonly idempotency: IdempotencyService,
    private readonly refunds: RefundsService, private readonly notifications: NotificationsService,
    private readonly transactions: TransactionRunner, private readonly clock: ServerClock) {}

  async cancel(actorId: string, id: string, input: CancelOrderDto, key: string, own = false) {
    const target = new Types.ObjectId(validateObjectId(id)), reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 500) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Lý do phải dài từ 10 đến 500 ký tự');
    // Ownership is checked even on replay. The same relation is checked again under the member gate.
    if (own) await this.repository.assertOwner(actorId, target);
    return this.idempotency.execute({ actorId, operation: own ? 'ORDER_CANCEL_OWN' : 'ORDER_CANCEL_SUPPORT', clientKey: key,
      targetId: String(target), payload: { version: input.version, reason, channel: own ? 'OWN' : 'SUPPORT' } }, session =>
      this.withinSession(target, session, { actorId, reason, version: input.version, own }));
  }
  async expire(id: string) {
    const target = new Types.ObjectId(validateObjectId(id));
    return this.transactions.run(session => this.withinSession(target, session, { reason: 'Hết hạn giữ hàng 24 giờ', expired: true }));
  }
  private async withinSession(target: Types.ObjectId, session: ClientSession,
    command: { actorId?: string; reason: string; version?: number; own?: boolean; expired?: boolean }) {
    await this.repository.assertFulfillmentReady([RefundSchema]);
    const route = await this.repository.order(target, session);
    if (!route) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');
    if (!(route.transaction_id instanceof Types.ObjectId) || route.channel === 'WEBSITE' && !route.member_id) throw orderIntegrityError();
    const routingItems = await this.repository.lines(target, session);
    if (routingItems.some(item => !(item.product_id instanceof Types.ObjectId))) throw orderIntegrityError();
    try {
      await this.guards.acquire(session, { members: route.member_id ? [route.member_id] : [] });
      // Terminal replays need no stock write, including when catalog/inventory has since changed.
      const balances = route.status === 'CANCELLED' || route.status === 'COMPLETED' ? null : await this.inventory.lock(routingItems.map(item => String(item.product_id)), session);
      await this.guards.acquire(session, { transactions: [route.transaction_id], orders: [target] });
      if (command.own) await this.repository.assertOwner(command.actorId!, target, session);
      const row = await this.repository.order(target, session);
      if (!row) throw orderIntegrityError();
      const transaction = await this.repository.transaction(row.transaction_id, session), items = await this.repository.lines(target, session);
      const now = this.clock.now();
      if (row.status === 'COMPLETED') throw new ApplicationError(409, 'ORDER_ALREADY_COMPLETED', 'Đơn đã bàn giao; cần quy trình trả hàng');
      assertOrderIntegrity(row, transaction, items);
      if (row.status === 'CANCELLED') {
        if (row.reservation_state !== 'RELEASED' || !row.cancelled_at || !['CANCELLED', 'SETTLED'].includes(transaction.status)) throw orderIntegrityError();
        return { status: 200, body: await this.result(row, transaction.status, session), resultIds: { orderId: target }, changed: false };
      }
      if (!['PENDING', 'CONFIRMED'].includes(row.status) || row.reservation_state !== 'HELD' || !['PENDING', 'SETTLED'].includes(transaction.status) || !balances) {
        throw new ApplicationError(409, 'INVALID_ORDER_STATE', 'Trạng thái đơn không cho phép hủy');
      }
      if (command.expired && now < row.reservation_expires_at) throw new ApplicationError(409, 'RESERVATION_NOT_EXPIRED', 'Đơn chưa hết hạn giữ hàng');
      if ((!command.expired && row.version !== command.version) || row.version >= 2147483647) throw orderConflict();
      await this.repository.assertPaymentIntegrity(transaction, session);
      await this.repository.assertReservations(items, balances, session);
      for (const item of items) this.inventory.check(balances.get(String(item.product_id))!, 0, -item.quantity);
      const actor = command.actorId ? new Types.ObjectId(command.actorId) : undefined;
      for (const item of items) await this.inventory.apply(balances.get(String(item.product_id))!, {
        product_id: item.product_id, order_item_id: item._id, source_id: target, source_type: 'ORDER', source_code: row.code,
        event_key: `ORDER_RELEASE:${item._id}`, kind: 'ORDER_RELEASE', actor_type: actor ? 'USER' : 'SYSTEM', ...(actor ? { actor_id: actor } : {}),
        on_hand_delta: 0, reserved_delta: -item.quantity, sku_snapshot: item.sku_snapshot, name_snapshot: item.name_snapshot, created_at: now,
      }, session);
      if (transaction.status === 'PENDING') {
        if (!Number.isSafeInteger(transaction.version) || transaction.version < 0 || transaction.version >= 2147483647) throw orderIntegrityError();
        const changed = await this.repository.connection.db!.collection('transactions').updateOne({ _id: transaction._id, status: 'PENDING', version: transaction.version },
          { $set: { status: 'CANCELLED', cancelled_at: now, cancel_reason: command.reason, ...(actor ? { cancelled_by: actor } : {}) }, $inc: { version: new Int32(1) } }, { session });
        if (changed.modifiedCount !== 1) throw orderConflict();
      } else {
        const payments = await this.repository.connection.db!.collection<Payment>('payments').find({ transaction_id: transaction._id, status: 'SUCCEEDED' }, { session }).toArray();
        for (const payment of payments) await this.refunds.cancellation(target, payment, now, actor, session);
      }
      const updated = await this.repository.orders.findOneAndUpdate({ _id: target, status: row.status, reservation_state: 'HELD', version: row.version },
        { $set: { status: 'CANCELLED', reservation_state: 'RELEASED', cancelled_at: now, cancellation_reason: command.reason,
          cancellation_source: command.expired ? 'EXPIRED' : 'USER', ...(actor ? { cancelled_by: actor } : {}), updated_at: now },
          $inc: { version: 1 }, $unset: { expiry_retry_at: '', expiry_attempts: '' } }, { session, returnDocument: 'after', runValidators: true }).lean().exec();
      if (!updated) throw orderConflict();
      const eventKey = `ORDER_CANCELLED:${target}`;
      await this.repository.events.create([{ order_id: target, action: 'CANCELLED', actor_type: actor ? 'USER' : 'SYSTEM', ...(actor ? { actor_id: actor } : {}),
        occurred_at: now, before: { status: row.status, version: row.version }, after: { status: 'CANCELLED', version: updated.version }, event_key: eventKey, reason: command.reason }], { session });
      const notification = await this.notifications.persistBusinessEvent(session, { eventKey, title: 'Đơn hàng đã hủy',
        body: `Đơn ${row.code} đã hủy và giải phóng hàng giữ. Khoản đã thu được ghi nghĩa vụ chờ hoàn để đối soát, chưa phải tiền đã hoàn.`,
        memberId: row.member_id ? String(row.member_id) : undefined, transactionId: String(row.transaction_id), createdBy: command.actorId }, await this.repository.recipient(row.member_id, session));
      return { status: 200, body: await this.result(updated, transaction.status === 'PENDING' ? 'CANCELLED' : transaction.status, session, notification.notificationState), resultIds: { orderId: target }, changed: true };
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'DATA_GUARD_NOT_READY') throw orderIntegrityError();
      throw error;
    }
  }
  private async result(row: Order, transactionStatus: string, session: ClientSession, notificationState?: string) {
    const refunds = await this.repository.refunds(row._id, session);
    const amount = refunds.reduce((sum, refund) => sum + BigInt(fromVndDecimal(refund.amount)), 0n);
    const state = refunds.some(refund => refund.status === 'PENDING') ? 'PENDING' : refunds.some(refund => refund.status === 'FAILED') ? 'FAILED' : refunds.length ? 'SUCCEEDED' : 'NONE';
    if (!notificationState) {
      const notification = await this.repository.connection.db!.collection('notifications').findOne({ event_key: `ORDER_CANCELLED:${row._id}` }, { session });
      const recipients = notification ? await this.repository.connection.db!.collection('notification_recipients').countDocuments({ notification_id: notification._id }, { session }) : 0;
      notificationState = recipients ? 'STORED' : 'NO_LINKED_ACCOUNT';
    }
    return { id: String(row._id), code: row.code, status: 'CANCELLED', version: row.version, reservationState: 'RELEASED', cancelledAt: row.cancelled_at!.toISOString(),
      transactionStatus, refundState: state, refundAmount: String(amount), ...(refunds.length === 1 ? { refundId: String(refunds[0]._id) } : {}), notificationState };
  }
}
