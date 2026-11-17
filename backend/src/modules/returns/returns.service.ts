import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Filter } from 'mongodb';
import { Model, Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock, addCalendarDays, assertBusinessDate } from '../../common/utils/business-date';
import { validateObjectId } from '../../common/utils/normalization';
import { fromVndDecimal, toVndDecimal } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { InventoryWriter } from '../inventory/inventory-writer';
import { NotificationsService } from '../notifications/notifications.service';
import { IdempotencyService, transactionRequestKey } from '../operations/idempotency.service';
import { OrdersRepository } from '../orders/orders.repository';
import { assertOrderIntegrity, orderConflict, orderIntegrityError } from '../orders/order.policy';
import { Payment } from '../payments/schemas/payment.schema';
import { Refund, RefundSchema } from '../refunds/refund.schema';
import { refundAmount, refundBudget, refundIntegrityError } from '../refunds/refund-integrity';
import { assertReturnWindow, returnDeadline } from './return.policy';
import { RETURN_MODELS, ReturnDocument, ReturnItem } from './return.schema';
import { ReceiveReturnDto, ReturnQueryDto } from './returns.dto';

@Injectable()
export class ReturnsService {
  constructor(private readonly repository: OrdersRepository, private readonly guards: DataGuardsService, private readonly inventory: InventoryWriter,
    private readonly transactions: TransactionRunner, private readonly idempotency: IdempotencyService, private readonly notifications: NotificationsService,
    private readonly clock: ServerClock, @InjectModel('Return') private readonly returns: Model<ReturnDocument>,
    @InjectModel('ReturnItem') private readonly items: Model<ReturnItem>, @InjectModel('Refund') private readonly refunds: Model<Refund>) {}

  async receive(actorId: string, id: string, input: ReceiveReturnDto, key: string) {
    const target = new Types.ObjectId(validateObjectId(id)), actor = new Types.ObjectId(actorId);
    if (new Set(input.items.map(item => item.orderItemId.toLowerCase())).size !== input.items.length) throw new ApplicationError(400, 'DUPLICATE_RETURN_ITEM', 'Mỗi dòng đơn chỉ xuất hiện một lần trong phiếu');
    return this.idempotency.execute({ actorId, operation: 'RETURN_RECEIVE', clientKey: key, targetId: String(target),
      payload: { version: input.version, reason: input.reason, items: input.items.map(item => ({ ...item, orderItemId: item.orderItemId.toLowerCase() })).sort((a, b) => a.orderItemId.localeCompare(b.orderItemId)) } }, async session => {
      await this.repository.assertFulfillmentReady([...RETURN_MODELS.map(model => model.schema), RefundSchema]);
      const route = await this.repository.order(target, session);
      if (!route) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');
      const routingItems = await this.repository.lines(target, session);
      await this.guards.acquire(session, { members: route.member_id ? [route.member_id] : [] });
      // Guard all involved inventory, even damaged lines: missing/inconsistent balances block receipt.
      const balances = await this.inventory.lock(routingItems.map(item => String(item.product_id)), session, true);
      await this.guards.acquire(session, { transactions: [route.transaction_id], orders: [target] });
      const row = await this.repository.order(target, session);
      if (!row) throw orderIntegrityError();
      const transaction = await this.repository.transaction(row.transaction_id, session), lines = await this.repository.lines(target, session), now = this.clock.now();
      assertOrderIntegrity(row, transaction, lines);
      if (!['WEBSITE', 'POS'].includes(row.channel) || row.status !== 'COMPLETED' || row.reservation_state !== 'CONSUMED' || transaction.status !== 'SETTLED') {
        throw new ApplicationError(409, 'ORDER_NOT_RETURNABLE', 'Chỉ nhận trả đơn đã bàn giao và tiêu thụ giữ hàng');
      }
      assertReturnWindow(row.fulfilled_at!, now);
      if (row.version !== input.version || row.version >= 2147483647) throw orderConflict();
      await this.repository.assertPaymentIntegrity(transaction, session);
      const fulfilled = await this.repository.fulfillmentMovements(target, session);
      for (const line of lines) {
        const movements = fulfilled.filter(movement => String(movement.order_item_id) === String(line._id));
        if (movements.length !== 1 || movements[0].event_key !== `ORDER_FULFILL:${line._id}` ||
          String(movements[0].product_id) !== String(line.product_id) || movements[0].on_hand_delta !== -line.quantity || movements[0].reserved_delta !== -line.quantity) throw orderIntegrityError();
      }
      const previous = await this.repository.connection.db!.collection<ReturnItem>('return_items').find({ order_item_id: { $in: lines.map(line => line._id) } }, { session }).toArray();
      const returnId = new Types.ObjectId(), received: Omit<ReturnItem, '_id'>[] = [];
      let amount = 0n;
      for (const item of input.items) {
        const line = lines.find(line => String(line._id) === item.orderItemId.toLowerCase());
        if (!line) throw new ApplicationError(400, 'INVALID_ORDER_ITEM', 'Dòng nhận trả không thuộc đơn gốc');
        const already = previous.filter(prior => prior.order_item_id.equals(line._id)).reduce((sum, prior) => sum + prior.quantity, 0);
        if (!Number.isInteger(already) || already < 0 || already + item.quantity > line.quantity) throw new ApplicationError(409, 'RETURN_QUANTITY_EXCEEDED', 'Số lượng vượt phần còn được trả');
        const value = BigInt(fromVndDecimal(line.unit_price)) * BigInt(item.quantity); amount += value;
        received.push({ return_id: returnId, order_item_id: line._id, product_id: line.product_id, quantity: item.quantity, restockable: item.restockable,
          condition_note: item.conditionNote, unit_price_snapshot: line.unit_price, line_refund_amount: toVndDecimal(String(value)), sku_snapshot: line.sku_snapshot, name_snapshot: line.name_snapshot });
      }
      const payments = await this.repository.connection.db!.collection<Payment>('payments').find({ transaction_id: row.transaction_id, status: 'SUCCEEDED' }, { session }).toArray();
      const payment = payments[0];
      if (amount > 0n) {
        if (payments.length !== 1) throw refundIntegrityError();
        const budget = await refundBudget(this.repository.connection, target, payment, session);
        if (budget.obligated + amount > refundAmount(payment.amount)) throw new ApplicationError(409, 'REFUND_BUDGET_EXCEEDED', 'Nghĩa vụ hoàn vượt tiền đã thu');
      }
      await this.returns.create([{ _id: returnId, order_id: target, created_by: actor, request_key: transactionRequestKey(actorId, 'RETURN_RECEIVE', key),
        reason: input.reason, created_at: now, amount_snapshot: toVndDecimal(String(amount)), order_channel_snapshot: row.channel }], { session });
      const movementIds: string[] = [];
      for (const item of received) {
        const [created] = await this.items.create([item], { session });
        if (item.restockable) movementIds.push(await this.inventory.apply(balances.get(String(item.product_id))!, {
          product_id: item.product_id, return_item_id: created._id, source_id: returnId, source_type: 'RETURN', source_code: `RET:${returnId}`,
          event_key: `RETURN_RECEIVE:${created._id}`, kind: 'RETURN_RECEIVE', actor_type: 'USER', actor_id: actor,
          on_hand_delta: item.quantity, reserved_delta: 0, sku_snapshot: item.sku_snapshot, name_snapshot: item.name_snapshot, created_at: now,
        }, session));
      }
      let refundId: Types.ObjectId | undefined;
      if (amount > 0n) {
        refundId = new Types.ObjectId();
        await this.refunds.create([{ _id: refundId, id: refundId, return_id: returnId, order_id: target, payment_id: payment._id, reason: 'RETURN',
          reference: `RF:${refundId}`, obligation_key: `RETURN:${returnId}:${payment._id}`, amount: toVndDecimal(String(amount)), status: 'PENDING', version: 0,
          actor_type: 'USER', created_by: actor, created_at: now }], { session });
      }
      const updated = await this.repository.orders.findOneAndUpdate({ _id: target, status: 'COMPLETED', reservation_state: 'CONSUMED', version: input.version },
        { $inc: { version: 1 }, $set: { updated_at: now } }, { session, returnDocument: 'after' }).lean().exec();
      if (!updated) throw orderConflict();
      const eventKey = `RETURN_RECEIVED:${returnId}`;
      await this.repository.events.create([{ order_id: target, action: 'RETURN_RECEIVED', actor_type: 'USER', actor_id: actor, occurred_at: now,
        before: { status: row.status, version: row.version }, after: { status: updated.status, version: updated.version }, event_key: eventKey, reason: input.reason }], { session });
      await this.notifications.persistBusinessEvent(session, { eventKey, title: 'Đã nhận hàng trả', body: `Đơn ${row.code} đã được tiếp nhận hàng trả. Khoản hoàn được đối soát riêng.`,
        memberId: row.member_id ? String(row.member_id) : undefined, transactionId: String(row.transaction_id), createdBy: actorId }, await this.repository.recipient(row.member_id, session));
      return { status: 201, body: { returnId: String(returnId), ...(refundId ? { refundId: String(refundId) } : {}), refundState: refundId ? 'PENDING' : 'NONE',
        amount: String(amount), movementIds, orderVersion: updated.version }, resultIds: { orderId: target, returnId, ...(refundId ? { refundId } : {}) } };
    });
  }

  async eligibility(id: string) {
    const target = new Types.ObjectId(validateObjectId(id));
    return this.transactions.run(async session => {
      const row = await this.repository.order(target, session);
      if (!row) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');
      const lines = await this.repository.lines(target, session);
      const prior = await this.repository.connection.db!.collection<ReturnItem>('return_items').find({ order_item_id: { $in: lines.map(line => line._id) } }, { session }).toArray();
      const now = this.clock.now(), deadline = row.fulfilled_at ? returnDeadline(row.fulfilled_at) : null;
      return { id, code: row.code, channel: row.channel, status: row.status, version: row.version, fulfilledAt: row.fulfilled_at?.toISOString() ?? null,
        returnDeadline: deadline?.toISOString() ?? null, eligible: row.status === 'COMPLETED' && row.reservation_state === 'CONSUMED' && Boolean(deadline && now < deadline && now >= row.fulfilled_at!),
        items: lines.map(line => ({ id: String(line._id), name: line.name_snapshot, sku: line.sku_snapshot, quantity: line.quantity, unitPrice: fromVndDecimal(line.unit_price),
          remaining: line.quantity - prior.filter(item => item.order_item_id.equals(line._id)).reduce((sum, item) => sum + item.quantity, 0) })), asOf: now.toISOString() };
    });
  }
  async list(query: ReturnQueryDto) {
    const to = assertBusinessDate(query.toDate ?? this.clock.today()), from = assertBusinessDate(query.fromDate ?? addCalendarDays(to, -29));
    const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
    if (days < 1 || days > 366) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Khoảng ngày phải từ 1 đến 366 ngày');
    const filter: Filter<ReturnDocument> = { created_at: { $gte: new Date(`${from}T00:00:00+07:00`), $lt: new Date(`${addCalendarDays(to, 1)}T00:00:00+07:00`) } };
    if (query.orderId) filter.order_id = new Types.ObjectId(validateObjectId(query.orderId));
    return this.transactions.run(async session => {
      const collection = this.repository.connection.db!.collection<ReturnDocument>('returns'), total = await collection.countDocuments(filter, { session });
      const rows = await collection.find(filter, { session }).sort({ created_at: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).toArray();
      const items = [];
      for (const row of rows) items.push(await this.map(row, session));
      return { items, page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit), asOf: this.clock.now().toISOString() };
    });
  }
  async detail(id: string) {
    const target = new Types.ObjectId(validateObjectId(id));
    return this.transactions.run(async session => {
      const row = await this.repository.connection.db!.collection<ReturnDocument>('returns').findOne({ _id: target }, { session });
      if (!row) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy phiếu trả');
      const items = await this.repository.connection.db!.collection<ReturnItem>('return_items').find({ return_id: target }, { session }).sort({ _id: 1 }).toArray();
      return { ...await this.map(row, session), items: items.map(item => ({ id: String(item._id), orderItemId: String(item.order_item_id), name: item.name_snapshot, sku: item.sku_snapshot,
        quantity: item.quantity, restockable: item.restockable, conditionNote: item.condition_note, unitPrice: fromVndDecimal(item.unit_price_snapshot), amount: fromVndDecimal(item.line_refund_amount) })), asOf: this.clock.now().toISOString() };
    });
  }
  private async map(row: ReturnDocument, session: ClientSession) {
    const refunds = await this.repository.connection.db!.collection<Refund>('refunds').find({ return_id: row._id }, { session }).toArray();
    const refundAmount = refunds.reduce((sum, refund) => sum + BigInt(fromVndDecimal(refund.amount)), 0n), refunded = refunds.filter(refund => refund.status === 'SUCCEEDED').reduce((sum, refund) => sum + BigInt(fromVndDecimal(refund.amount)), 0n);
    return { id: String(row._id), orderId: String(row.order_id), channel: row.order_channel_snapshot, reason: row.reason, receivedAt: row.created_at.toISOString(), createdBy: String(row.created_by),
      amount: fromVndDecimal(row.amount_snapshot), refundAmount: String(refundAmount), refundedAmount: String(refunded), outstandingRefundAmount: String(refundAmount - refunded),
      refunds: refunds.map(refund => ({ id: String(refund._id), status: refund.status, amount: fromVndDecimal(refund.amount) })) };
  }
}
