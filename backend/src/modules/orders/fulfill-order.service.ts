import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { isDuplicateKey } from '../../common/http/http-error.filter';
import { ServerClock } from '../../common/utils/business-date';
import { validateObjectId } from '../../common/utils/normalization';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { InventoryWriter, inventoryIntegrityError } from '../inventory/inventory-writer';
import { NotificationsService } from '../notifications/notifications.service';
import { IdempotencyService } from '../operations/idempotency.service';
import { assertOrderIntegrity, fulfillBlockedReason, orderConflict, orderIntegrityError } from './order.policy';
import { FulfillOrderDto } from './orders.dto';
import { OrdersRepository } from './orders.repository';

@Injectable()
export class FulfillOrderService {
  constructor(private readonly repository: OrdersRepository, private readonly guards: DataGuardsService,
    private readonly inventory: InventoryWriter, private readonly idempotency: IdempotencyService,
    private readonly notifications: NotificationsService, private readonly clock: ServerClock) {}

  // US-53 can reuse this command with the POS policy; only the WEBSITE adapter is exposed by US-44.
  async fulfill(actorId: string, id: string, input: FulfillOrderDto, key: string, channel: 'WEBSITE' | 'POS' = 'WEBSITE') {
    const target = new Types.ObjectId(validateObjectId(id)), actor = new Types.ObjectId(validateObjectId(actorId));
    return this.idempotency.execute({ actorId, operation: channel === 'WEBSITE' ? 'ORDER_FULFILL_WEBSITE' : 'ORDER_FULFILL_POS',
      clientKey: key, payload: { version: input.version, channel }, targetId: String(target) }, async session => {
      await this.repository.assertFulfillmentReady();
      // Before the gates only immutable routing IDs are used. No eligibility decision uses this read.
      const route = await this.repository.order(target, session);
      if (!route) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');
      if (!(route.transaction_id instanceof Types.ObjectId) || route.member_id !== undefined && !(route.member_id instanceof Types.ObjectId) ||
        route.channel === 'WEBSITE' && !route.member_id) throw orderIntegrityError();
      const routingItems = await this.repository.lines(target, session);
      if (routingItems.some(item => !(item.product_id instanceof Types.ObjectId))) throw orderIntegrityError();
      try {
        await this.guards.acquire(session, { members: route.member_id ? [route.member_id] : [] });
        const balances = await this.inventory.lock(routingItems.map(item => String(item.product_id)), session);
        await this.guards.acquire(session, { transactions: [route.transaction_id], orders: [target] });
        const row = await this.repository.order(target, session);
        if (!row) throw orderIntegrityError();
        const transaction = await this.repository.transaction(row.transaction_id, session), items = await this.repository.lines(target, session);
        const now = this.clock.now(); // H01: after all locks, refreshed on every transaction retry.
        if (row.channel !== channel) throw new ApplicationError(409, 'ORDER_CHANNEL_MISMATCH', 'Kênh đơn hàng không phù hợp với thao tác bàn giao');
        if (row.status === 'COMPLETED') {
          const movements = await this.repository.fulfillmentMovements(target, session);
          throw new ApplicationError(409, 'ORDER_ALREADY_COMPLETED', 'Đơn đã bàn giao. Không giao hàng lần nữa; hãy kiểm tra kết quả hiện có', [
            { field: 'id', message: String(target) }, { field: 'version', message: String(row.version) },
            { field: 'fulfilledAt', message: row.fulfilled_at?.toISOString() ?? '' }, { field: 'fulfilledBy', message: String(row.fulfilled_by ?? '') },
            { field: 'movementIds', message: JSON.stringify(movements.map(movement => String(movement._id))) },
          ]);
        }
        assertOrderIntegrity(row, transaction, items);
        const blocked = fulfillBlockedReason(row, transaction, now, channel);
        if (blocked) throw new ApplicationError(409, blocked, blocked === 'RESERVATION_EXPIRED'
          ? 'Đã hết hạn giữ hàng; cần xử lý hủy/đối soát trước khi tiếp tục' : 'Đơn chưa đủ điều kiện bàn giao');
        if (row.version !== input.version || row.version >= 2147483647) throw orderConflict();
        await this.repository.assertPaymentIntegrity(transaction, session);
        await this.repository.assertReservations(items, balances, session);
        // Validate every line before writing any line; any later failure still aborts the entire transaction.
        for (const item of items) {
          const balance = balances.get(String(item.product_id));
          if (!balance || balance.reserved < item.quantity) throw inventoryIntegrityError();
          this.inventory.check(balance, -item.quantity, -item.quantity);
        }
        const movementIds: string[] = [];
        for (const item of items) movementIds.push(await this.inventory.apply(balances.get(String(item.product_id))!, {
          product_id: item.product_id, order_item_id: item._id, source_id: target, source_type: 'ORDER', source_code: row.code,
          event_key: `ORDER_FULFILL:${item._id}`, kind: 'ORDER_FULFILL', actor_id: actor,
          on_hand_delta: -item.quantity, reserved_delta: -item.quantity, sku_snapshot: item.sku_snapshot, name_snapshot: item.name_snapshot, created_at: now,
        }, session));
        const updated = await this.repository.orders.findOneAndUpdate({ _id: target, channel, status: 'CONFIRMED', reservation_state: 'HELD', version: input.version },
          { $set: { status: 'COMPLETED', reservation_state: 'CONSUMED', fulfilled_at: now, fulfilled_by: actor, updated_at: now }, $inc: { version: 1 } },
          { session, returnDocument: 'after', runValidators: true }).lean().exec();
        if (!updated) throw orderConflict();
        const eventKey = `ORDER_COMPLETED:${target}`;
        await this.repository.events.create([{ order_id: target, action: 'FULFILLED', actor_type: 'USER', actor_id: actor, occurred_at: now,
          before: { status: row.status, version: row.version }, after: { status: updated.status, version: updated.version }, event_key: eventKey }], { session });
        const notification = await this.notifications.persistBusinessEvent(session, { eventKey, title: 'Đơn hàng đã được bàn giao',
          body: `Đơn ${row.code} đã được bàn giao đủ sản phẩm tại quầy.`, memberId: row.member_id ? String(row.member_id) : undefined,
          transactionId: String(row.transaction_id), createdBy: actorId }, await this.repository.recipient(row.member_id, session));
        return { status: 200, body: { id: String(target), code: row.code, status: 'COMPLETED', reservationState: 'CONSUMED', version: updated.version,
          fulfilledAt: now.toISOString(), fulfilledBy: actorId, movementIds, notificationState: notification.notificationState },
          resultIds: { orderId: target } };
      } catch (failure) {
        if (failure instanceof ApplicationError && failure.code === 'DATA_GUARD_NOT_READY') throw orderIntegrityError();
        throw failure;
      }
    }).catch(failure => { if (isDuplicateKey(failure)) throw orderIntegrityError(); throw failure; });
  }
}
