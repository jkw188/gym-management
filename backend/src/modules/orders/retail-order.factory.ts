// Tầng nghiệp vụ (US-41/US-53): tạo đơn bán lẻ WEBSITE và POS trong một transaction (giữ tồn, snapshot, transaction RETAIL).
// createPos (US-53) cho Staff lập đơn tại quầy; createWebsite (US-41) cho Member đặt từ giỏ.
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { normalizePhone } from '../../common/utils/normalization';
import { CartRepository } from '../cart/cart.repository';
import { WebsiteCreateDto } from './website-order.dto';
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
    @InjectModel('Transaction') private readonly transactions: Model<Transaction>, @InjectModel('OrderItem') private readonly items: Model<OrderItem>,
    private readonly carts: CartRepository) {}

  // POST /api/me/orders – US-41-F03: Member tạo đơn WEBSITE từ giỏ đã xem giá, tất cả trong MỘT transaction:
  // transaction RETAIL PENDING + order PENDING/HELD + dòng snapshot + giữ tồn (movement) + xóa giỏ, cartVersion+1 + event/thông báo + key.
  // Lỗi ở bất kỳ bước nào → rollback hết, giỏ còn nguyên (US-41-TC05).
  async createWebsite(accountId: string, input: WebsiteCreateDto, key: string) {
    // US-41-TC02: chưa liên kết hồ sơ → 409, chưa ghi gì (kể cả operation_requests).
    const memberId = await this.quotes.memberOf(accountId);
    // US-41-F01: chuẩn hóa SĐT người nhận theo EN01-D01; sai định dạng → 400. Không sửa hồ sơ Member.
    const intent = { cartVersion: input.cartVersion, recipientName: input.recipientName, recipientPhone: normalizePhone(input.recipientPhone),
      preferredPaymentMethod: input.preferredPaymentMethod };
    // US-41-Q01: fingerprint gồm hash của quoteToken (không lưu token thô) và DTO đã chuẩn hóa.
    const quoteHash = createHash('sha256').update(input.quoteToken).digest('hex');
    // EN-02, US-41-TC13/TC14: cùng key + cùng payload đã commit → trả lại 201 gốc, kể cả khi giỏ đã trống; khác payload → 409.
    return this.idempotency.execute({ actorId: accountId, operation: 'ORDER_CREATE_WEBSITE', clientKey: key,
      payload: { ...intent, channel: 'WEBSITE', quoteHash }, targetId: memberId.toHexString() }, async session => {
      await this.repository.assertFulfillmentReady([TransactionSchema, RetailCategorySchema, RetailProductSchema]);
      const pickup = this.quotes.pickupLocation();

      // S06-O01: khóa theo thứ tự catalog_state → members → cart_states → inventory, rồi mới đọc điều kiện để quyết định.
      await this.guards.acquire(session, { catalog: true, members: [memberId] });
      const cart = await this.quotes.websiteCart(memberId, input.cartVersion, session);
      // Khóa cart_states bằng CAS version+1: hai checkout cùng cartVersion thì chỉ một lệnh thắng (US-41-TC07).
      if (!(await this.carts.increaseVersion(memberId, cart.version, session))) {
        throw retailConflict('CART_VERSION_CONFLICT', 'Giỏ hàng đã thay đổi, vui lòng tải lại');
      }
      const balances = await this.inventory.lock(cart.items.map(item => item.productId), session);

      // US-41-F02: tính lại giá sau khóa và so với quote; sản phẩm/tồn/giá đổi → 409, không tự thu theo giá mới.
      const priced = await this.quotes.price(cart.items, session);
      await this.quotes.verify(input.quoteToken, accountId, { channel: 'WEBSITE', memberId: memberId.toHexString(), cartVersion: cart.version }, priced);

      // S06-H01: hạn giữ = giờ server lúc tạo + 24 giờ, không tính từ lúc preview.
      const now = this.clock.now();
      const id = new Types.ObjectId(), transactionId = new Types.ObjectId(), actor = new Types.ObjectId(accountId);
      const [transaction] = await this.transactions.create([{ _id: transactionId, id: transactionId, member_id: memberId, created_by: actor,
        code: `TX-${transactionId}`, kind: 'RETAIL', amount_due: toVndDecimal(priced.total), status: 'PENDING',
        request_key: transactionRequestKey(accountId, 'ORDER_CREATE_WEBSITE', key), created_at: now, version: 0, guard_revision: 0n }], { session });
      // US-41-F05: snapshot người nhận và quầy nhận tại lúc tạo.
      const [order] = await this.repository.orders.create([{ _id: id, id, member_id: memberId, transaction_id: transactionId, code: `ORD-${id}`,
        channel: 'WEBSITE', status: 'PENDING', reservation_state: 'HELD', reservation_expires_at: new Date(now.getTime() + 86400000),
        preferred_payment_method: intent.preferredPaymentMethod, recipient_name: intent.recipientName, recipient_phone: intent.recipientPhone,
        pickup_location_snapshot: pickup, created_by: actor, created_at: now, updated_at: now, version: 0, guard_revision: 0n }], { session });

      for (const line of priced.items) {
        const itemId = new Types.ObjectId(), productId = new Types.ObjectId(line.productId), balance = balances.get(line.productId)!;
        // Đọc lại tồn đã khóa: không đủ → 409, cả lệnh rollback (US-41-TC07: không oversell).
        if (balance.on_hand - balance.reserved < line.quantity) throw retailConflict('INSUFFICIENT_STOCK', 'Không đủ tồn khả dụng');
        // US-41-TC06: dòng chụp SKU, tên, version sản phẩm, đơn giá và tổng dòng.
        await this.items.create([{ _id: itemId, id: itemId, order_id: id, product_id: productId, quantity: line.quantity,
          sku_snapshot: line.sku, name_snapshot: line.name, product_version_snapshot: line.productVersion,
          unit_price: toVndDecimal(line.unitPrice), line_total: toVndDecimal(line.lineTotal) }], { session });
        // S05-I01: ORDER_RESERVE delta(0, +q) – on_hand giữ nguyên, reserved tăng, kèm movement.
        await this.inventory.apply(balance, { product_id: productId, order_item_id: itemId, source_id: id, source_type: 'ORDER', source_code: order.code,
          kind: 'ORDER_RESERVE', event_key: `ORDER_RESERVE:${itemId}`, on_hand_delta: 0, reserved_delta: line.quantity,
          actor_id: actor, sku_snapshot: line.sku, name_snapshot: line.name, created_at: now }, session);
      }

      // US-41-F04: tổng 0 đồng → hoàn tất transaction (SETTLED + invoice 0, không có payment) ngay trong session này.
      // Chỉ transaction đổi; đơn vẫn PENDING + HELD, Staff vẫn phải xác nhận và bàn giao như đơn thường.
      const invoice = priced.total === '0'
        ? await this.settlement.completeWithinSession(session, order.toObject() as Order, transaction.toObject(), now)
        : null;

      // US-41-F03: xóa đúng toàn bộ giỏ đã xác nhận (version đã +1 ở trên).
      await this.carts.deleteAllLines(memberId, session);

      const eventKey = `ORDER_CREATED:${id}`;
      await this.repository.events.create([{ order_id: id, action: 'CREATED', actor_type: 'USER', actor_id: actor, occurred_at: now,
        before: null, after: { status: 'PENDING', version: 0 }, event_key: eventKey }], { session });
      // EN-03: thông báo cùng commit; người nhận là account đang liên kết với Member.
      const notification = await this.notifications.persistBusinessEvent(session, { eventKey, title: 'Đã tạo đơn hàng',
        body: `Đơn ${order.code} đã được tạo và giữ hàng 24 giờ tại quầy. Thanh toán và nhận hàng là các bước riêng.`,
        memberId: memberId.toHexString(), transactionId: String(transactionId), createdBy: accountId }, await this.repository.recipient(memberId, session));

      return { status: 201, body: { id: String(id), code: order.code, status: 'PENDING', transactionId: String(transactionId),
        transactionStatus: invoice ? 'SETTLED' : 'PENDING', total: priced.total, reservationExpiresAt: order.reservation_expires_at.toISOString(),
        reservationState: 'HELD', cartVersion: cart.version + 1, ...(invoice ? { invoiceId: invoice.id } : {}),
        notificationState: notification.notificationState },
      resultIds: { orderId: id, transactionId, ...(invoice ? { invoiceId: invoice.id } : {}) } };
    });
  }

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
      await this.quotes.verify(input.quoteToken, actorId, { channel: 'POS', memberId: intent.memberId }, priced);
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
