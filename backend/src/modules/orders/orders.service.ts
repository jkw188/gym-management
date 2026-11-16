import { Injectable } from '@nestjs/common';
import { Filter, ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { isDuplicateKey } from '../../common/http/http-error.filter';
import { addCalendarDays, assertBusinessDate, ServerClock } from '../../common/utils/business-date';
import { validateObjectId } from '../../common/utils/normalization';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { IdempotencyService } from '../operations/idempotency.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Order } from './order.schema';
import { assertOrderIntegrity, fulfillBlockedReason, orderConflict, orderIntegrityError, prepareBlockedReason } from './order.policy';
import { OrderQueryDto, PrepareOrderDto } from './orders.dto';
import { OrdersRepository } from './orders.repository';

const idOf = (id: string) => new Types.ObjectId(validateObjectId(id));
const missing = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');
@Injectable()
export class OrdersService {
  constructor(private readonly repository: OrdersRepository, private readonly transactions: TransactionRunner,
    private readonly guards: DataGuardsService, private readonly idempotency: IdempotencyService,
    private readonly notifications: NotificationsService, private readonly clock: ServerClock) {}
  async list(query: OrderQueryDto) {
    const to = assertBusinessDate(query.toDate ?? this.clock.today()), from = assertBusinessDate(query.fromDate ?? addCalendarDays(to, -29));
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1 || days > 366) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Khoảng ngày phải từ 1 đến 366 ngày');
    const filter: Filter<Order> = { created_at: { $gte: new Date(`${from}T00:00:00+07:00`), $lt: new Date(`${addCalendarDays(to, 1)}T00:00:00+07:00`) } };
    if (query.channel) filter.channel = query.channel;
    if (query.status) filter.status = query.status;
    if (query.memberId) filter.member_id = idOf(query.memberId);
    if (query.q) filter.code = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return this.transactions.run(async session => {
      const asOf = this.clock.now(), page = await this.repository.page(filter, query.transactionStatus, query.page, query.limit, session);
      const items = [];
      for (const row of page.items) items.push(await this.summary(row, session, asOf));
      return { ...page, items, asOf: asOf.toISOString() };
    });
  }
  async detail(id: string) {
    const target = idOf(id);
    return this.transactions.run(async session => {
      const row = await this.repository.order(target, session); if (!row) throw missing();
      const asOf = this.clock.now(), summary = await this.summary(row, session, asOf);
      const invoice = await this.repository.invoice(row.transaction_id, session), refunds = await this.repository.refunds(target, session);
      return { ...summary, recipient: { name: row.recipient_name, phone: row.recipient_phone }, pickupLocation: row.pickup_location_snapshot,
        confirmedAt: row.confirmed_at?.toISOString() ?? null, confirmedBy: row.confirmed_by ? String(row.confirmed_by) : null,
        fulfilledAt: row.fulfilled_at?.toISOString() ?? null, fulfilledBy: row.fulfilled_by ? String(row.fulfilled_by) : null,
        cancelledAt: row.cancelled_at?.toISOString() ?? null, cancellationReason: row.cancellation_reason ?? null, cancellationSource: row.cancellation_source ?? null,
        movementIds: (await this.repository.fulfillmentMovements(target, session)).map(movement => String(movement._id)),
        items: (await this.repository.lines(target, session)).map(line => ({ id: String(line._id), productId: String(line.product_id),
          skuSnapshot: line.sku_snapshot, nameSnapshot: line.name_snapshot, quantity: line.quantity,
          unitPrice: fromVndDecimal(line.unit_price), lineTotal: fromVndDecimal(line.line_total) })),
        invoice: invoice ? { id: String(invoice._id), invoiceNo: invoice.invoice_no, totalAmount: fromVndDecimal(invoice.total_amount), issuedAt: invoice.issued_at.toISOString() } : null,
        refunds: refunds.map(refund => ({ id: String(refund._id), status: refund.status, amount: fromVndDecimal(refund.amount) })), asOf: asOf.toISOString() };
    });
  }
  private async summary(row: Order, session: ClientSession, asOf: Date) {
    const transaction = await this.repository.transaction(row.transaction_id, session), lines = await this.repository.lines(row._id, session);
    let reason: string | null = null, fulfillReason: string | null = null;
    try { assertOrderIntegrity(row, transaction, lines); await this.repository.assertPaymentIntegrity(transaction, session);
      reason = prepareBlockedReason(row, transaction, asOf); fulfillReason = fulfillBlockedReason(row, transaction, asOf, row.channel); }
    catch { reason = 'ORDER_INTEGRITY_ERROR'; fulfillReason = 'ORDER_INTEGRITY_ERROR'; }
    return { id: String(row._id), code: row.code, channel: row.channel, status: row.status, version: row.version,
      memberId: row.member_id ? String(row.member_id) : null, transactionId: String(row.transaction_id), transactionStatus: transaction?.status ?? null,
      total: transaction ? fromVndDecimal(transaction.amount_due) : null, reservationState: row.reservation_state,
      reservationExpiresAt: row.reservation_expires_at.toISOString(), expired: asOf.getTime() >= row.reservation_expires_at.getTime(),
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      permittedActions: { prepare: reason === null, prepareBlockedReason: reason, fulfill: fulfillReason === null, fulfillBlockedReason: fulfillReason } };
  }
  async prepare(actorId: string, id: string, input: PrepareOrderDto, key: string) {
    const target = idOf(id);
    await this.repository.assertWriterReady();
    return this.idempotency.execute({ actorId, operation: 'ORDER_PREPARE', clientKey: key,
      payload: { version: input.version, channel: 'WEBSITE' }, targetId: String(target) }, async session => {
      // Before locks, read only immutable routing IDs. Every decision is made again after the gates.
      const route = await this.repository.order(target, session); if (!route) throw missing();
      if (!route.transaction_id || route.channel === 'WEBSITE' && !route.member_id) throw orderIntegrityError();
      if (!await this.repository.transaction(route.transaction_id, session)) throw orderIntegrityError();
      try { await this.guards.acquire(session, { members: route.member_id ? [route.member_id] : [], transactions: [route.transaction_id], orders: [target] }); }
      catch (failure) { if (failure instanceof ApplicationError && failure.code === 'DATA_GUARD_NOT_READY') throw orderIntegrityError(); throw failure; }
      const row = await this.repository.order(target, session); if (!row) throw missing();
      const transaction = await this.repository.transaction(row.transaction_id, session), items = await this.repository.lines(target, session);
      const now = this.clock.now(); // H01: refresh on every transaction retry, after acquiring all gates.
      if (row.channel !== 'WEBSITE') throw new ApplicationError(409, 'ORDER_CHANNEL_MISMATCH', 'Chỉ chuẩn bị đơn website');
      if (row.status === 'CONFIRMED') throw new ApplicationError(409, 'ORDER_ALREADY_CONFIRMED', 'Đơn đã được chuẩn bị', [{ field: 'id', message: String(row._id) }, { field: 'version', message: String(row.version) }]);
      assertOrderIntegrity(row, transaction, items);
      await this.repository.assertPaymentIntegrity(transaction, session);
      const blocked = prepareBlockedReason(row, transaction, now);
      if (blocked) throw new ApplicationError(409, blocked, blocked === 'RESERVATION_EXPIRED' ? 'Đã hết hạn giữ hàng; chờ xử lý hủy' : 'Trạng thái đơn không cho phép chuẩn bị');
      if (row.version !== input.version || row.version >= 2147483647) throw orderConflict();
      const actor = idOf(actorId);
      const updated = await this.repository.orders.findOneAndUpdate({ _id: target, channel: 'WEBSITE', status: 'PENDING', reservation_state: 'HELD', version: input.version },
        { $set: { status: 'CONFIRMED', confirmed_at: now, confirmed_by: actor, updated_at: now }, $inc: { version: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean().exec();
      if (!updated) throw orderConflict();
      const eventKey = `ORDER_CONFIRMED:${target}`;
      await this.repository.events.create([{ order_id: target, action: 'PREPARED', actor_type: 'USER', actor_id: actor, occurred_at: now,
        before: { status: row.status, version: row.version }, after: { status: updated.status, version: updated.version }, event_key: eventKey }], { session });
      const notification = await this.notifications.persistBusinessEvent(session, { eventKey, title: 'Đơn hàng đã được chuẩn bị',
        body: `Đơn ${row.code} đã được chuẩn bị. Bạn có thể đến quầy trong hạn giữ hàng. Thanh toán và bàn giao được xác nhận riêng.`,
        memberId: row.member_id ? String(row.member_id) : undefined, transactionId: String(row.transaction_id), createdBy: actorId }, await this.repository.recipient(row.member_id, session));
      return { status: 200, body: { id: String(target), code: row.code, status: 'CONFIRMED', version: updated.version, confirmedAt: now.toISOString(),
        confirmedBy: actorId, reservationExpiresAt: row.reservation_expires_at.toISOString(), notificationState: notification.notificationState }, resultIds: { orderId: target } };
    }).catch(failure => { if (isDuplicateKey(failure)) throw orderIntegrityError(); throw failure; });
  }
}
