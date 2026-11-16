// US-41 order/reserve/normal RETAIL settlement are snapshot fixtures; cancel/expiry/late/fulfill are real commands.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Int32, Long, ObjectId, MongoServerError } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { ApplicationError } from '../src/common/errors/application-error';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { ensureFinancialIntegrity } from '../src/infrastructure/transaction/financial-integrity';
import { ensureRetailCatalogIntegrity } from '../src/modules/catalog/retail-catalog.migration';
import { InventoryWriter } from '../src/modules/inventory/inventory-writer';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import { OperationRequestsRepository } from '../src/modules/operations/operation-requests.repository';
import { OrdersRepository } from '../src/modules/orders/orders.repository';
import { FulfillOrderService } from '../src/modules/orders/fulfill-order.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { En06Process as AppProcess } from './helpers/en06-fixture';
import { OrderExpiryWorker } from '../src/modules/orders/order-expiry.worker';
import { CancelOrderService } from '../src/modules/orders/cancel-order.service';
import { DataGuardsService } from '../src/infrastructure/transaction/data-guards.service';
import { ensureRefundsIntegrity } from '../src/modules/refunds/refunds-migration';
import { COLLECTIONS, Rows, assertCommittedRows } from './helpers/en06-oracle';

const NOW = '2035-11-14T17:00:00.000Z', origin = 'http://localhost:5173';
type Actor = { id: string; token: string };
describe('US-45: cancellation, expiry, late receipts and refund obligations on real replica set and two processes', () => {
  let mongo: MongoMemoryReplSet, app: INestApplication, connection: Connection, staff: Actor, admin: Actor, member: Actor, trainer: Actor;
  const children: AppProcess[] = [], saved = { ...process.env }, clock = new ServerClock();
  let now = NOW, sequence = 0;
  clock.now = () => new Date(now);
  const db = () => connection.db!, http = () => request(app.getHttpServer());
  const fulfill = (id: string, version = 0, key: string = randomUUID(), actor = staff, child?: number) =>
    (child === undefined ? http() : request(children[child].url)).post(`/api/orders/${id}/fulfill`)
      .set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send({ version });
  const cancel = (id: string, version = 0, key: string = randomUUID(), actor = staff, own = false, child?: number, reason = 'Hủy đơn theo yêu cầu khách hàng') =>
    (child === undefined ? http() : request(children[child].url)).post(`/api${own ? '/me' : ''}/orders/${id}/cancel`)
      .set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send({ version, reason });
  const lateBody = () => ({ method: 'TRANSFER', amount: '50000', evidenceNote: 'Đối soát chứng từ ngân hàng thật của fixture', receivingAccountCode: 'GYM_MAIN', bankReference: `US45-${randomUUID()}`, receivedAt: NOW });
  const late = (id: string, body = lateBody(), key: string = randomUUID(), actor = staff, child?: number) =>
    (child === undefined ? http() : request(children[child].url)).post(`/api/orders/${id}/late-receipts`)
      .set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send(body);
  const get = (id: string) => http().get(`/api/orders/${id}`).set('Authorization', `Bearer ${staff.token}`);
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: `gym_test_us45_${randomBytes(4).toString('hex')}`,
      EN06_NOW: NOW, RECEIVING_ACCOUNTS: '["GYM_MAIN"]', FRONTEND_ORIGIN: origin, JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '' });
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false }); configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    await ensureFinancialIntegrity(connection); await ensureRetailCatalogIntegrity(connection);
    for (let i = 0; i < 2; i++) { const child = new AppProcess(); children.push(child); await child.start(); }
    expect(new Set(children.map(child => child.child.pid)).size).toBe(2);
    staff = await login('STAFF'); admin = await login('ADMIN'); member = await login('MEMBER'); trainer = await login('TRAINER');
  }, 600000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined); now = NOW;
    for (const child of children) { await child.rpc('clear'); await child.rpc('clock', NOW); }
    for (const name of [...COLLECTIONS, 'members', 'categories', 'catalog_events', 'notification_counters']) await db().collection(name).deleteMany({});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { for (const child of children) await child.close(); await app?.close(); await mongo?.stop(); process.env = saved; });
  async function login(code: 'STAFF' | 'ADMIN' | 'MEMBER' | 'TRAINER'): Promise<Actor> {
    const users = app.get(UsersRepository), role = await users.ensureRole(code, code), password = 'US45 fixture password 123';
    const account = await users.createAccount({ roleId: String(role.id), fullName: `US45 ${code}`, phone: `094400${String(++sequence).padStart(4, '0')}`,
      passwordHash: await app.get(PasswordService).hash(password) });
    const result = await http().post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
    return { id: String(account._id), token: result.body.accessToken as string };
  }
  async function create(path: string, body: object, actor = admin) {
    return (await http().post(`/api${path}`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', randomUUID()).send(body).expect(201)).body as { id: string };
  }
  async function fixture(options: { paid?: boolean; free?: boolean; linked?: boolean; channel?: string; status?: string; count?: number } = {}) {
    const linked = options.linked === false ? null : await db().collection('members').findOne({ account_id: new ObjectId(member.id) });
    const orderId = new ObjectId(), transactionId = new ObjectId(), memberId = linked?._id ?? new ObjectId(), created = new Date(NOW), expires = new Date(created.getTime() + 86400000);
    const count = options.count ?? 2, total = options.free ? '0' : String(25000 * count), paid = options.paid !== false || options.free;
    if (!linked) await db().collection('members').insertOne({ _id: memberId, id: memberId, member_code: `HV-${memberId}`, service_revision: Long.ZERO, phone: `+84944${String(++sequence).padStart(6, '0')}`,
      ...(options.linked === false ? {} : { account_id: new ObjectId(member.id) }) });
    await db().collection('transactions').insertOne({ _id: transactionId, id: transactionId, member_id: memberId, created_by: new ObjectId(member.id), code: `TX-${transactionId}`,
      kind: 'RETAIL', status: paid ? 'SETTLED' : 'PENDING', amount_due: Decimal128.fromString(total), request_key: createHash('sha256').update(String(transactionId)).digest('hex'),
      created_at: created, guard_revision: Long.ZERO, version: new Int32(0), ...(paid ? { settled_at: created } : {}) });
    await db().collection('orders').insertOne({ _id: orderId, id: orderId, transaction_id: transactionId, member_id: memberId, code: `ORD-${orderId}`, channel: options.channel ?? 'WEBSITE',
      status: options.status ?? 'CONFIRMED', reservation_state: 'HELD', reservation_expires_at: expires, preferred_payment_method: 'CASH', recipient_name: 'Người nhận snapshot',
      recipient_phone: '+84901234567', pickup_location_snapshot: 'Quầy fixture US45', created_by: new ObjectId(member.id), created_at: created, updated_at: created,
      confirmed_at: created, confirmed_by: new ObjectId(staff.id), version: new Int32(0), guard_revision: Long.ZERO });
    // Catalog and stock receipts use their real HTTP writers. Only the missing US-41 reserve/create/settle is a persisted fixture.
    const category = await create('/admin/categories', { name: `US45 ${++sequence}`, status: 'ACTIVE' });
    const items: { itemId: ObjectId; productId: ObjectId; sku: string }[] = [];
    for (let i = 0; i < count; i++) {
      const sku = `US45_${++sequence}`, product = await create('/admin/products', { categoryId: category.id, sku, name: 'Tên snapshot', price: options.free ? '0' : '25000', status: 'ACTIVE' });
      items.push({ itemId: new ObjectId(), productId: new ObjectId(product.id), sku });
    }
    const receipt = await create('/stock-receipts', { reason: 'US45 FIXTURE nhập hàng kiểm thử, không hàng thật', items: items.map(item => ({ productId: String(item.productId), quantity: 3, unitCost: '1000' })) }, staff);
    await http().post(`/api/stock-receipts/${receipt.id}/post`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0 }).expect(200);
    for (const item of items) {
      await db().collection('order_items').insertOne({ _id: item.itemId, id: item.itemId, order_id: orderId, product_id: item.productId, sku_snapshot: item.sku, name_snapshot: 'Tên snapshot',
        product_version_snapshot: new Int32(0), unit_price: Decimal128.fromString(options.free ? '0' : '25000'), line_total: Decimal128.fromString(options.free ? '0' : '25000'), quantity: new Int32(1) });
      await db().collection('inventory').updateOne({ product_id: item.productId }, { $set: { reserved: new Int32(1), version: new Int32(2) } });
      await db().collection('stock_movements').insertOne({ product_id: item.productId, order_item_id: item.itemId, source_id: orderId, source_type: 'ORDER', source_code: `ORD-${orderId}`,
        event_key: `ORDER_RESERVE:${item.itemId}`, kind: 'ORDER_RESERVE', actor_id: new ObjectId(member.id), sequence: new Int32(2),
        on_hand_delta: new Int32(0), reserved_delta: new Int32(1), before_on_hand: new Int32(3), before_reserved: new Int32(0), after_on_hand: new Int32(3), after_reserved: new Int32(1),
        sku_snapshot: item.sku, name_snapshot: 'Tên snapshot', created_at: created });
    }
    if (paid) {
      const invoiceId = new ObjectId();
      await db().collection('invoices').insertOne({ _id: invoiceId, id: invoiceId, transaction_id: transactionId, invoice_no: `INV-${orderId}`, total_amount: Decimal128.fromString(total), issued_at: created, buyer_snapshot: 'Snapshot buyer' });
      if (!options.free) { const paymentId = new ObjectId(); await db().collection('payments').insertOne({ _id: paymentId, id: paymentId, transaction_id: transactionId, method: 'CASH', status: 'SUCCEEDED', amount: Decimal128.fromString(total), reference: `FIXTURE:${orderId}`,
        verified_by: new ObjectId(staff.id), paid_at: created, evidence_note: 'US45 fixture evidence, not a real receipt', bank_reference: 'SECRET_TEST_REFERENCE' }); }
    }
    return { id: String(orderId), orderId, transactionId, memberId, items, expires };
  }
  async function snapshot() {
    const rows: Record<string, unknown[]> = {};
    for (const name of [...COLLECTIONS, 'members', 'notification_counters']) rows[name] = await db().collection(name).find().sort({ _id: 1 }).toArray();
    return rows;
  }
  async function oracle() {
    const rows = {} as Rows;
    for (const name of COLLECTIONS) rows[name] = await db().collection(name).find().toArray();
    assertCommittedRows(rows);
  }
  async function setTime(value: string) { now = value; for (const child of children) await child.rpc('clock', value); }
  it('TC05/06: batch50 leaves the 51st overdue order for the next scan and preserves deterministic order', async () => {
    const orders = [];
    for (let i = 0; i < 51; i++) orders.push(await fixture({ paid: false, count: 1, status: 'PENDING' }));
    await setTime(new Date(orders[0].expires.getTime() + 3600000).toISOString());
    const worker = app.get(OrderExpiryWorker), first = await worker.runOnce(); expect(first.attempted).toBe(50);
    expect(await db().collection('orders').countDocuments({ status: 'CANCELLED' })).toBe(50);
    expect((await db().collection('orders').findOne({ _id: orders[50].orderId }))!.status).toBe('PENDING');
    expect((await worker.runOnce()).attempted).toBe(1);
    expect(await db().collection('orders').countDocuments({ status: 'CANCELLED' })).toBe(51); await oracle();
  }, 180000);
  it('TC05/08: expiry eligibility is rechecked after gates and after a driver transient retry', async () => {
    const row = await fixture({ paid: false, status: 'PENDING' }), cancellation = app.get(CancelOrderService);
    await expect(cancellation.expire(row.id)).rejects.toMatchObject({ code: 'RESERVATION_NOT_EXPIRED' });
    const guards = app.get(DataGuardsService), original = guards.acquire.bind(guards);
    let retried = false;
    jest.spyOn(guards, 'acquire').mockImplementation(async (session, targets) => {
      await original(session, targets);
      if (!retried) {
        retried = true; now = row.expires.toISOString();
        const error = new MongoServerError({ message: 'Fixture transient retry', code: 112 }); error.addErrorLabel('TransientTransactionError'); throw error;
      }
    });
    expect((await cancellation.expire(row.id)).body).toMatchObject({ status: 'CANCELLED', cancelledAt: row.expires.toISOString() });
    expect(await db().collection('order_events').countDocuments({ order_id: row.orderId })).toBe(1);
    jest.restoreAllMocks(); jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const pending = await fixture({ paid: false, status: 'PENDING' }); const before = await snapshot();
    expect((await http().post(`/api/orders/${pending.id}/prepare`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0 }).expect(409)).body.error.code).toBe('RESERVATION_EXPIRED');
    expect(await snapshot()).toEqual(before);
  });
  it('TC07: invalid prior refund amounts block cancellation and roll back all inventory writes', async () => {
    const row = await fixture(), payment = await db().collection('payments').findOne({ transaction_id: row.transactionId }), refundId = new ObjectId();
    await db().collection('refunds').insertOne({ _id: refundId, id: refundId, order_id: row.orderId, payment_id: payment!._id, reason: 'RETURN', reference: `RF:${refundId}`,
      obligation_key: `RETURN:${refundId}`, amount: Decimal128.fromString('50001'), status: 'PENDING', created_at: new Date(NOW), actor_type: 'USER' });
    const before = await snapshot(); expect((await cancel(row.id).expect(409)).body.error.code).toBe('REFUND_INTEGRITY_ERROR'); expect(await snapshot()).toEqual(before);
    await expect(ensureRefundsIntegrity(connection)).rejects.toThrow('REFUNDS_EXCEED_PAYMENT');
  });
  it('TC01/03/04/07: own/support cancel, unpaid/paid/free and WEBSITE/POS release all SKU, keep money history', async () => {
    for (const options of [{ paid: false }, {}, { free: true }, { channel: 'POS' }]) {
      const row = await fixture(options), before = await snapshot(), own = options.channel === 'POS';
      const result = await cancel(row.id, 0, randomUUID(), own ? member : staff, own).expect(200);
      expect(result.body).toMatchObject({ id: row.id, status: 'CANCELLED', version: 1, reservationState: 'RELEASED', cancelledAt: NOW,
        transactionStatus: options.paid === false ? 'CANCELLED' : 'SETTLED', refundState: options.paid === false || options.free ? 'NONE' : 'PENDING',
        refundAmount: options.paid === false || options.free ? '0' : '50000' });
      for (const item of row.items) {
        expect(await db().collection('inventory').findOne({ product_id: item.productId })).toMatchObject({ on_hand: 3, reserved: 0, version: 3 });
        expect(await db().collection('stock_movements').findOne({ event_key: `ORDER_RELEASE:${item.itemId}` })).toMatchObject({ on_hand_delta: 0, reserved_delta: -1, kind: 'ORDER_RELEASE' });
      }
      const after = await snapshot();
      for (const name of ['payments', 'invoices', 'order_items', 'cart_items', 'cart_states']) expect(after[name]).toEqual(before[name]);
      expect(await db().collection('order_events').countDocuments({ event_key: `ORDER_CANCELLED:${row.id}` })).toBe(1);
      const refund = await db().collection('refunds').findOne({ order_id: row.orderId });
      if (result.body.refundState === 'PENDING') { expect(refund).toMatchObject({ status: 'PENDING', reason: 'CANCELLATION', actor_type: 'USER' }); expect(refund!.refunded_at).toBeUndefined(); }
      else expect(refund).toBeNull();
      await oracle();
    }
  });
  it('TC02/16: foreign owner, roles, revoked session, invalid DTO/ID and completed order leave DB intact', async () => {
    const row = await fixture(), foreign = await login('MEMBER'), before = await snapshot();
    await cancel(row.id, 0, randomUUID(), foreign, true).expect(404);
    for (const actor of [member, trainer]) { await cancel(row.id, 0, randomUUID(), actor).expect(403); await late(row.id, lateBody(), randomUUID(), actor).expect(403); }
    for (const actor of [staff, admin, trainer]) await cancel(row.id, 0, randomUUID(), actor, true).expect(403);
    await cancel('invalid').expect(400); await cancel(String(new ObjectId())).expect(404); await cancel(row.id, 0, 'invalid').expect(400);
    await cancel(row.id, 0, randomUUID(), staff, false, undefined, '  short  ').expect(400);
    for (const body of [{}, { version: -1, reason: 'Lý do hợp lệ để hủy' }, { version: '0', reason: 'Lý do hợp lệ để hủy' }, { version: 0, reason: 'Lý do hợp lệ để hủy', actorType: 'SYSTEM' }]) {
      await http().post(`/api/orders/${row.id}/cancel`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID()).send(body).expect(400);
    }
    expect(await snapshot()).toEqual(before);
    await fulfill(row.id).expect(200); const completed = await snapshot();
    expect((await cancel(row.id).expect(409)).body.error.code).toBe('ORDER_ALREADY_COMPLETED'); expect(await snapshot()).toEqual(completed);
    const temp = await login('STAFF'), target = await fixture(), key = randomUUID(); await cancel(target.id, 0, key, temp).expect(200);
    await http().post('/api/auth/logout').set('Authorization', `Bearer ${temp.token}`).set('Origin', origin).send({}).expect(204);
    await cancel(target.id, 0, key, temp).expect(401);
    await http().get(`/api/operations/ORDER_CANCEL_SUPPORT/${key}`).set('Authorization', `Bearer ${temp.token}`).expect(401);
  });
  it('TC02: mismatched reservation ledger or missing transaction cannot release stock or create refund', async () => {
    for (const problem of ['balance', 'movement', 'transaction', 'state']) {
      const row = await fixture();
      if (problem === 'balance') await db().collection('inventory').updateOne({ product_id: row.items[1].productId }, { $set: { reserved: new Int32(0) } });
      if (problem === 'movement') await db().collection('stock_movements').deleteOne({ event_key: `ORDER_RESERVE:${row.items[1].itemId}` });
      if (problem === 'transaction') await db().collection('transactions').deleteOne({ _id: row.transactionId });
      if (problem === 'state') await db().collection('orders').updateOne({ _id: row.orderId }, { $set: { reservation_state: 'CONSUMED' } });
      const before = await snapshot(); await cancel(row.id).expect(409); expect(await snapshot()).toEqual(before);
    }
  });
  it('TC01/02/16: anonymous POS has no member gate/recipient; own reads are scoped and reject injected memberId', async () => {
    const pos = await fixture({ paid: false, linked: false, channel: 'POS' });
    await db().collection('orders').updateOne({ _id: pos.orderId }, { $unset: { member_id: '' } });
    await db().collection('transactions').updateOne({ _id: pos.transactionId }, { $unset: { member_id: '' } });
    expect((await cancel(pos.id, 0, randomUUID(), admin).expect(200)).body.notificationState).toBe('NO_LINKED_ACCOUNT');
    const row = await fixture(), other = await login('MEMBER');
    const list = await http().get('/api/me/orders').set('Authorization', `Bearer ${member.token}`).expect(200);
    expect(list.body).toMatchObject({ memberLinked: true, total: 1, items: [{ id: row.id }] });
    await http().get(`/api/me/orders/${row.id}`).set('Authorization', `Bearer ${other.token}`).expect(404);
    await http().get(`/api/me/orders?memberId=${row.memberId}`).set('Authorization', `Bearer ${member.token}`).expect(400);
    await oracle();
  });
  it('TC07: malformed legacy refund amount is a reconciliation conflict, never a partial stock release', async () => {
    const row = await fixture(), payment = await db().collection('payments').findOne({ transaction_id: row.transactionId }), refundId = new ObjectId();
    await db().collection('refunds').insertOne({ _id: refundId, id: refundId, order_id: row.orderId, payment_id: payment!._id, reason: 'RETURN', reference: `RF:${refundId}`,
      obligation_key: `RETURN:${refundId}`, amount: 100, status: 'PENDING', created_at: new Date(NOW), actor_type: 'USER' });
    const before = await snapshot(); expect((await cancel(row.id).expect(409)).body.error.code).toBe('REFUND_INTEGRITY_ERROR'); expect(await snapshot()).toEqual(before);
  });
  it('TC05/06/08: two real workers cancel paid/unpaid at exact expiry, catch up, isolate failure with capped retry', async () => {
    const paid = await fixture(), unpaid = await fixture({ paid: false }), bad = await fixture();
    await db().collection('inventory').updateOne({ product_id: bad.items[0].productId }, { $set: { reserved: new Int32(0) } });
    await setTime(new Date(paid.expires.getTime() - 1).toISOString());
    expect((await children[0].rpc('expiryWorker') as { attempted: number }).attempted).toBe(0);
    await setTime(paid.expires.toISOString());
    const before = await snapshot();
    expect((await fulfill(paid.id).expect(409)).body.error.code).toBe('RESERVATION_EXPIRED');
    expect((await http().post(`/api/orders/${unpaid.id}/prepare`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0 }).expect(409)).body.error.code).toBe('ORDER_ALREADY_CONFIRMED');
    expect(await snapshot()).toEqual(before);
    await Promise.all(children.map(child => child.rpc('expiryWorker')));
    for (const row of [paid, unpaid]) {
      expect(await db().collection('orders').findOne({ _id: row.orderId })).toMatchObject({ status: 'CANCELLED', reservation_state: 'RELEASED', cancellation_source: 'EXPIRED' });
      const event = await db().collection('order_events').findOne({ event_key: `ORDER_CANCELLED:${row.id}` });
      expect(event!.actor_type).toBe('SYSTEM'); expect(event!.actor_id).toBeUndefined();
      for (const item of row.items) { const movement = await db().collection('stock_movements').findOne({ event_key: `ORDER_RELEASE:${item.itemId}` }); expect(movement!.actor_type).toBe('SYSTEM'); expect(movement!.actor_id).toBeUndefined(); }
    }
    const failed = await db().collection('orders').findOne({ _id: bad.orderId });
    expect(failed!.status).toBe('CONFIRMED'); expect(failed!.expiry_retry_at.getTime()).toBeLessThanOrEqual(Date.parse(now) + 60000);
    await db().collection('inventory').updateOne({ product_id: bad.items[0].productId }, { $set: { reserved: new Int32(1) } });
    // A fresh worker instance has no process memory; persisted retry and catch-up still work.
    await setTime(new Date(paid.expires.getTime() + 4 * 3600000).toISOString());
    const restarted = new OrderExpiryWorker(app.get(OrdersRepository), app.get(CancelOrderService), clock);
    await restarted.runOnce(); expect(await db().collection('orders').findOne({ _id: bad.orderId })).toMatchObject({ status: 'CANCELLED' });
    expect(await db().collection('order_events').countDocuments({ action: 'CANCELLED' })).toBe(3); await oracle();
  });
  it('TC09/10: late full TRANSFER creates payment+obligation, preserves cancelled transaction and released inventory', async () => {
    for (const afterCancel of [false, true]) {
      const row = await fixture({ paid: false }), body = lateBody();
      await setTime(new Date(Date.parse(NOW) + 60000).toISOString()); await cancel(row.id).expect(200);
      if (afterCancel) { await setTime(new Date(Date.parse(now) + 60000).toISOString()); body.receivedAt = now; }
      const before = await snapshot(), key = randomUUID(), response = await late(row.id, body, key).expect(200);
      expect(response.body).toMatchObject({ orderId: row.id, transactionStatus: 'CANCELLED', refundState: 'PENDING' });
      const payment = await db().collection('payments').findOne({ _id: new ObjectId(response.body.paymentId) });
      expect(payment).toMatchObject({ receipt_purpose: 'LATE_CANCELLED_ORDER', status: 'SUCCEEDED', paid_at: new Date(body.receivedAt), verified_at: new Date(now) });
      const after = await snapshot(); for (const name of ['orders', 'transactions', 'inventory', 'stock_movements', 'invoices']) {
        if (name === 'orders' || name === 'transactions') for (const record of before[name] as { _id: ObjectId; guard_revision: number }[]) {
          if (record._id.equals(name === 'orders' ? row.orderId : row.transactionId)) record.guard_revision++;
        }
        expect(after[name]).toEqual(before[name]);
      }
      expect((await late(row.id, body, key).expect(200)).body).toEqual(response.body);
      const duplicate = await late(row.id, body).expect(409); expect(duplicate.body.error.code).toBe('PAYMENT_REFERENCE_USED'); expect(duplicate.body.error.details).toContainEqual({ field: 'refundId', message: response.body.refundId });
      expect((await late(row.id).expect(409)).body.error.code).toBe('EXTRA_RECEIPT_REQUIRES_RECONCILIATION');
      await oracle();
    }
  });
  it('TC10: insufficient/excess/zero, invalid account/time, CASH or second receipt never fabricate money', async () => {
    const row = await fixture({ paid: false }); await cancel(row.id).expect(200);
    for (const amount of ['0', '1', '50001']) expect((await late(row.id, { ...lateBody(), amount }).expect(409)).body.error.code).toBe('AMOUNT_MISMATCH');
    await late(row.id, { ...lateBody(), method: 'CASH' }).expect(400);
    await late(row.id, { ...lateBody(), receivingAccountCode: 'UNKNOWN' }).expect(400);
    for (const receivedAt of ['2035-11-14T16:59:59.999Z', '2035-11-14T17:00:00.001Z', '2035-11-14', 'invalid']) await late(row.id, { ...lateBody(), receivedAt }).expect(400);
    expect(await db().collection('payments').countDocuments()).toBe(0); expect(await db().collection('refunds').countDocuments()).toBe(0);
    const paid = await fixture(); await cancel(paid.id).expect(200);
    expect((await late(paid.id).expect(409)).body.error.code).toBe('EXTRA_RECEIPT_REQUIRES_RECONCILIATION');
  });
  it('TC11/14: 20 concurrent cancels across two processes replay one result; stale new key returns terminal without replacing reason', async () => {
    for (let round = 0; round < 10; round++) {
      const row = await fixture(), key = randomUUID();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => cancel(row.id, 0, key, staff, false, i % 2)));
      expect(results.map(result => result.status)).toEqual(Array(20).fill(200)); for (const result of results) expect(result.body).toEqual(results[0].body);
      const newKey = await cancel(row.id, 0, randomUUID(), staff, false, undefined, 'Lý do mới không ghi đè lý do gốc').expect(200);
      expect(newKey.body).toEqual(results[0].body);
      expect((await cancel(row.id, 1, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await db().collection('refunds').countDocuments({ order_id: row.orderId })).toBe(1);
      expect(await db().collection('order_events').countDocuments({ order_id: row.orderId })).toBe(1);
      expect((await db().collection('orders').findOne({ _id: row.orderId }))!.cancellation_reason).toBe('Hủy đơn theo yêu cầu khách hàng');
    }
  }, 180000);
  it('TC11: 20 concurrent late receipts replay one payment/refund and conflicting payload is rejected', async () => {
    for (let round = 0; round < 10; round++) {
      const row = await fixture({ paid: false }); await cancel(row.id).expect(200); const key = randomUUID(), body = lateBody();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => late(row.id, body, key, staff, i % 2)));
      expect(results.map(result => result.status)).toEqual(Array(20).fill(200)); for (const result of results) expect(result.body).toEqual(results[0].body);
      expect((await late(row.id, { ...body, amount: '1' }, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await db().collection('payments').countDocuments({ transaction_id: row.transactionId })).toBe(1);
      expect(await db().collection('refunds').countDocuments({ order_id: row.orderId })).toBe(1); await oracle();
    }
  }, 180000);
  it('TC11: different late keys race on the same bank reference and different cancel keys remain terminal', async () => {
    const row = await fixture({ paid: false }), cancels = await Promise.all(Array.from({ length: 20 }, (_, i) => cancel(row.id, 0, randomUUID(), staff, false, i % 2)));
    expect(cancels.map(result => result.status)).toEqual(Array(20).fill(200));
    const body = lateBody(), receipts = await Promise.all(Array.from({ length: 20 }, (_, i) => late(row.id, body, randomUUID(), staff, i % 2)));
    expect(receipts.filter(result => result.status === 200)).toHaveLength(1);
    for (const response of receipts.filter(result => result.status !== 200)) expect(response.body.error.code).toBe('PAYMENT_REFERENCE_USED');
    await oracle();
  });
  it('TC12: cancellation versus real fulfillment yields one operational outcome with matching stock/refund', async () => {
    for (let round = 0; round < 10; round++) {
      const row = await fixture();
      const responses = await Promise.all([cancel(row.id, 0, randomUUID(), staff, false, round % 2), fulfill(row.id, 0, randomUUID(), staff, (round + 1) % 2)]);
      expect(responses.map(result => result.status).sort()).toEqual([200, 409]);
      const order = await db().collection('orders').findOne({ _id: row.orderId });
      expect(['CANCELLED', 'COMPLETED']).toContain(order!.status);
      expect(order!.reservation_state).toBe(order!.status === 'CANCELLED' ? 'RELEASED' : 'CONSUMED');
      expect(await db().collection('refunds').countDocuments({ order_id: row.orderId })).toBe(order!.status === 'CANCELLED' ? 1 : 0); await oracle();
    }
  }, 180000);
  it.each(['movement', 'refund', 'orderAudit', 'recipient', 'outbox', 'operation'])('TC13 cancel fault after %s rolls back every collection', async point => {
    const row = await fixture(), before = await snapshot(); await children[0].arm(point, 'rollback');
    await cancel(row.id, 0, randomUUID(), staff, false, 0).expect(503); expect(await snapshot()).toEqual(before);
  });
  it.each(['latePayment', 'refund', 'orderAudit', 'recipient', 'outbox', 'operation'])('TC13 late receipt fault after %s rolls back payment+obligation+audit/key', async point => {
    const row = await fixture({ paid: false }); await cancel(row.id).expect(200); const before = await snapshot(); await children[0].arm(point, 'rollback');
    await late(row.id, lateBody(), randomUUID(), staff, 0).expect(503); expect(await snapshot()).toEqual(before);
  });
  it('TC14: lost responses resolve with the original key; own replay/lookup recheck owner', async () => {
    const row = await fixture(), key = randomUUID(); await children[0].arm('response');
    await cancel(row.id, 0, key, member, true, 0).then(() => { throw new Error('Expected lost response'); }, () => undefined);
    const lookup = await http().get(`/api/operations/ORDER_CANCEL_OWN/${key}`).set('Authorization', `Bearer ${member.token}`).expect(200);
    expect((await cancel(row.id, 0, key, member, true).expect(200)).body).toEqual(lookup.body.responseBody);
    const own = await http().get(`/api/me/orders/${row.id}`).set('Authorization', `Bearer ${member.token}`).expect(200);
    expect(JSON.stringify(own.body)).not.toMatch(/SECRET_TEST_REFERENCE|reference|verified_by|guard_revision|evidence_note/);
    await db().collection('members').updateOne({ _id: row.memberId }, { $unset: { account_id: '' } });
    await cancel(row.id, 0, key, member, true).expect(404);
    await http().get(`/api/operations/ORDER_CANCEL_OWN/${key}`).set('Authorization', `Bearer ${member.token}`).expect(404);
    const lateRow = await fixture({ paid: false }); await cancel(lateRow.id).expect(200); const body = lateBody(), lateKey = randomUUID(); await children[0].arm('response');
    await late(lateRow.id, body, lateKey, staff, 0).then(() => { throw new Error('Expected lost response'); }, () => undefined);
    const resolved = await http().get(`/api/operations/RETAIL_LATE_RECEIPT/${lateKey}`).set('Authorization', `Bearer ${staff.token}`).expect(200);
    expect((await late(lateRow.id, body, lateKey).expect(200)).body).toEqual(resolved.body.responseBody);
  });
  it('TC07/15/16: read-only queue, VN dates, permission checks and cash oracle includes cancelled late payment', async () => {
    const row = await fixture({ paid: false }); await cancel(row.id).expect(200); const response = await late(row.id).expect(200);
    const queue = () => http().get('/api/refunds?status=PENDING&fromDate=2035-11-15&toDate=2035-11-15').set('Authorization', `Bearer ${staff.token}`);
    expect((await queue().expect(200)).body).toMatchObject({ total: 1, items: [{ id: response.body.refundId, amount: '50000', status: 'PENDING', refundedAt: null, source: 'CANCELLATION' }] });
    for (const actor of [member, trainer]) { await http().get('/api/refunds').set('Authorization', `Bearer ${actor.token}`).expect(403); await http().get(`/api/refunds/${response.body.refundId}`).set('Authorization', `Bearer ${actor.token}`).expect(403); }
    const detail = await http().get(`/api/refunds/${response.body.refundId}`).set('Authorization', `Bearer ${admin.token}`).expect(200);
    expect(detail.body).toMatchObject({ reference: `RF:${response.body.refundId}`, payment: { receiptPurpose: 'LATE_CANCELLED_ORDER', status: 'SUCCEEDED' } });
    await http().patch(`/api/refunds/${response.body.refundId}`).set('Authorization', `Bearer ${staff.token}`).send({ status: 'SUCCEEDED' }).expect(404);
    await http().get('/api/refunds?fromDate=2035-02-30').set('Authorization', `Bearer ${staff.token}`).expect(400);
    await db().collection('refunds').updateOne({ _id: new ObjectId(response.body.refundId) }, { $set: { status: 'FAILED' } });
    const terminal = await cancel(row.id).expect(200); expect(terminal.body).toMatchObject({ refundState: 'FAILED', refundId: response.body.refundId, refundAmount: '50000' });
    expect(await db().collection('refunds').countDocuments({ payment_id: new ObjectId(response.body.paymentId) })).toBe(1);
    const rows = {} as Rows; for (const name of COLLECTIONS) rows[name] = await db().collection(name).find().toArray();
    expect(assertCommittedRows(rows)).toMatchObject({ gross: '50000', paidRefunds: '0', cash: '50000' });
    await ensureRefundsIntegrity(connection);
    // S07 payout is not implemented: persisted SUCCEEDED fixture only verifies cash accounting oracle.
    await db().collection('refunds').updateOne({ _id: new ObjectId(response.body.refundId) }, { $set: { status: 'SUCCEEDED', refunded_at: new Date(NOW) } });
    rows.refunds = await db().collection('refunds').find().toArray(); expect(assertCommittedRows(rows)).toMatchObject({ gross: '50000', paidRefunds: '50000', cash: '0' });
  });
});
