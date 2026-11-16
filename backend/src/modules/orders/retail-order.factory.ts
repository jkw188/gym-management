import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { ServerClock } from '../../common/utils/business-date';
import { toVndDecimal } from '../../common/utils/vnd-money';
import { InventoryWriter } from '../inventory/inventory-writer';
import { NotificationsService } from '../notifications/notifications.service';
import { IdempotencyService, transactionRequestKey } from '../operations/idempotency.service';
import { Transaction, TransactionSchema } from '../payments/schemas/transaction.schema';
import { RetailCategorySchema, RetailProductSchema } from '../catalog/retail-catalog.schema';
import { Order, OrderItem } from './order.schema';
import { OrdersRepository } from './orders.repository';
import { PosCreateDto } from './pos.dto';
import { normalizePos, retailConflict, RetailQuoteService } from './retail-quote.service';
import { RetailSettlementService } from './retail-settlement.service';

@Injectable()
export class RetailOrderFactory {
  constructor(private readonly repository: OrdersRepository, private readonly guards: DataGuardsService,
    private readonly inventory: InventoryWriter, private readonly quotes: RetailQuoteService, private readonly settlement: RetailSettlementService,
    private readonly idempotency: IdempotencyService, private readonly notifications: NotificationsService, private readonly clock: ServerClock,
    @InjectModel('Transaction') private readonly transactions: Model<Transaction>, @InjectModel('OrderItem') private readonly items: Model<OrderItem>) {}
  createPos(actorId: string, input: PosCreateDto, key: string) {
    const intent = normalizePos(input);
    return this.idempotency.execute({ actorId, operation: 'ORDER_CREATE_POS', clientKey: key,
      payload: { ...intent, channel: 'POS', quoteHash: createHash('sha256').update(input.quoteToken).digest('hex') } }, async session => {
      await this.repository.assertFulfillmentReady([TransactionSchema, RetailCategorySchema, RetailProductSchema]);
      const pickup = this.quotes.pickupLocation();
      await this.guards.acquire(session, { catalog: true });
      // No phone lookup and no cart gate/clear: POS selects a member explicitly, or stays anonymous.
      if (intent.memberId) {
        await this.quotes.buyer(intent, session); // Distinguish missing member before taking its revision.
        await this.guards.acquire(session, { members: [new Types.ObjectId(intent.memberId)] });
      }
      const balances = await this.inventory.lock(intent.items.map(item => item.productId), session);
      const priced = await this.quotes.price(intent.items, session);
      await this.quotes.verify(input.quoteToken, actorId, intent, priced);
      const buyer = await this.quotes.buyer(intent, session), now = this.clock.now();
      const id = new Types.ObjectId(), transactionId = new Types.ObjectId(), actor = new Types.ObjectId(actorId);
      const member = intent.memberId ? { member_id: new Types.ObjectId(intent.memberId) } : {};
      const [transaction] = await this.transactions.create([{ _id: transactionId, id: transactionId, ...member, created_by: actor,
        code: `TX-${transactionId}`, kind: 'RETAIL', amount_due: toVndDecimal(priced.total), status: 'PENDING',
        request_key: transactionRequestKey(actorId, 'ORDER_CREATE_POS', key), created_at: now, version: 0, guard_revision: 0n }], { session });
      const [order] = await this.repository.orders.create([{ _id: id, id, ...member, transaction_id: transactionId, code: `ORD-${id}`,
        channel: 'POS', status: 'CONFIRMED', reservation_state: 'HELD', reservation_expires_at: new Date(now.getTime() + 86400000),
        preferred_payment_method: intent.preferredPaymentMethod, recipient_name: buyer.name, recipient_phone: buyer.phone, pickup_location_snapshot: pickup,
        created_by: actor, created_at: now, updated_at: now, confirmed_by: actor, confirmed_at: now, version: 0, guard_revision: 0n }], { session });
      for (const line of priced.items) {
        const itemId = new Types.ObjectId(), productId = new Types.ObjectId(line.productId), balance = balances.get(line.productId)!;
        if (balance.on_hand - balance.reserved < line.quantity) throw retailConflict('INSUFFICIENT_STOCK', 'Không đủ tồn khả dụng');
        await this.items.create([{ _id: itemId, id: itemId, order_id: id, product_id: productId, quantity: line.quantity,
          sku_snapshot: line.sku, name_snapshot: line.name, product_version_snapshot: line.productVersion,
          unit_price: toVndDecimal(line.unitPrice), line_total: toVndDecimal(line.lineTotal) }], { session });
        await this.inventory.apply(balance, { product_id: productId, order_item_id: itemId, source_id: id, source_type: 'ORDER', source_code: order.code,
          kind: 'ORDER_RESERVE', event_key: `ORDER_RESERVE:${itemId}`, on_hand_delta: 0, reserved_delta: line.quantity,
          actor_id: actor, sku_snapshot: line.sku, name_snapshot: line.name, created_at: now }, session);
      }
      const invoice = priced.total === '0' ? await this.settlement.completeWithinSession(session, order.toObject() as Order, transaction.toObject(), now) : null;
      const eventKey = `ORDER_CREATED:${id}`;
      await this.repository.events.create([{ order_id: id, action: 'CREATED', actor_type: 'USER', actor_id: actor, occurred_at: now,
        before: null, after: { status: 'CONFIRMED', version: 0 }, event_key: eventKey }], { session });
      const notification = await this.notifications.persistBusinessEvent(session, { eventKey, title: 'Đã lập đơn tại quầy',
        body: `Đơn ${order.code} đã được lập và giữ hàng tại quầy. Thanh toán và bàn giao là các bước riêng.`,
        memberId: intent.memberId, transactionId: String(transactionId), createdBy: actorId }, await this.repository.recipient(order.member_id, session));
      return { status: 201, body: { id: String(id), code: order.code, channel: 'POS', status: 'CONFIRMED', reservationState: 'HELD',
        transactionId: String(transactionId), transactionStatus: invoice ? 'SETTLED' : 'PENDING', total: priced.total,
        reservationExpiresAt: order.reservation_expires_at.toISOString(), version: 0, ...(invoice ? { invoiceId: invoice.id } : {}), notificationState: notification.notificationState },
        resultIds: { orderId: id, transactionId, ...(invoice ? { invoiceId: invoice.id } : {}) } };
    });
  }
}
