import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Int32, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
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
import { OrderExpiryWorker } from '../src/modules/orders/order-expiry.worker';
import { OrdersRepository } from '../src/modules/orders/orders.repository';
import { UsersRepository } from '../src/modules/users/users.repository';
import { ACCOUNT_ADMINISTRATION } from '../src/modules/users/schemas/security-state.schema';
import { AppProcess } from './helpers/en05-fixture';
import { COLLECTIONS, Rows, assertCommittedRows } from './helpers/en06-oracle';

const NOW = '2035-11-14T17:00:00.000Z', origin = 'http://localhost:5173';
type Actor = { id: string; token: string };
type Intent = { memberId?: string; buyerName?: string; recipientPhone?: string; preferredPaymentMethod: string; items: { productId: string; quantity: number }[]; quoteToken?: string };
describe('US-53 POS: real HTTP writers, replica set and two independent processes', () => {
  const saved = { ...process.env }, clock = new ServerClock(); let now = NOW, sequence = 0;
  let mongo: MongoMemoryReplSet, app: INestApplication, connection: Connection, staff: Actor, admin: Actor, member: Actor, trainer: Actor;
  const children: AppProcess[] = [];
  const db = () => connection.db!, http = () => request(app.getHttpServer());
  clock.now = () => new Date(now);
  const post = (path: string, body: object, key: string = randomUUID(), actor = staff, child?: number) =>
    (child === undefined ? http() : request(children[child].url)).post(`/api${path}`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send(body);
  const get = (path: string, actor = staff) => http().get(`/api${path}`).set('Authorization', `Bearer ${actor.token}`);
  const cash = (amount = '25000') => ({ method: 'CASH', amount, evidenceNote: 'Đã đếm đủ tiền mặt thực nhận tại quầy' });
  const fulfill = (id: string, version: number, key: string = randomUUID()) => post(`/pos/orders/${id}/fulfill`, { version }, key);
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: `gym_test_us53_${randomBytes(4).toString('hex')}`,
      EN05_NOW: NOW, FRONTEND_ORIGIN: origin, JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RETAIL_QUOTE_SECRET: randomBytes(32).toString('base64url'),
      PICKUP_LOCATION: 'Quầy kiểm thử US53', RECEIVING_ACCOUNTS: '["GYM_MAIN"]', RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '' });
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false }); configureHttp(app); await app.init();
    connection = app.get(getConnectionToken()); await Promise.all(Object.values(connection.models).map(model => model.init()));
    await ensureFinancialIntegrity(connection); await ensureRetailCatalogIntegrity(connection);
    await db().collection<{ _id: string; revision: Long }>('security_state').insertOne({ _id: ACCOUNT_ADMINISTRATION, revision: Long.ZERO });
    for (let i = 0; i < 2; i++) { const child = new AppProcess(); children.push(child); await child.start(); }
    expect(new Set(children.map(child => child.child.pid)).size).toBe(2);
    staff = await login('STAFF'); admin = await login('ADMIN'); member = await login('MEMBER'); trainer = await login('TRAINER');
  }, 600000);
  beforeEach(async () => {
    now = NOW; jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const child of children) { await child.rpc('clear'); await child.rpc('clock', NOW); }
    for (const name of [...COLLECTIONS, 'members', 'categories', 'catalog_events', 'notification_counters', 'cart_states', 'cart_items']) await db().collection(name).deleteMany({});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { for (const child of children) await child.close(); await app?.close(); await mongo?.stop(); process.env = saved; });
  async function login(code: 'STAFF' | 'ADMIN' | 'MEMBER' | 'TRAINER') {
    const users = app.get(UsersRepository), role = await users.ensureRole(code, code), password = 'US53 integration password 123';
    const account = await users.createAccount({ roleId: String(role.id), fullName: `US53 ${code}`, phone: `095300${String(++sequence).padStart(4, '0')}`,
      passwordHash: await app.get(PasswordService).hash(password) });
    const result = await http().post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
    return { id: String(account._id), token: result.body.accessToken as string };
  }
  async function catalog(price = '25000', stock = 3, count = 1): Promise<Intent> {
    const category = await post('/admin/categories', { name: `US53 ${++sequence}`, status: 'ACTIVE' }, randomUUID(), admin).expect(201);
    const items = [];
    for (let i = 0; i < count; i++) {
      const product = await post('/admin/products', { categoryId: category.body.id, sku: `US53_${++sequence}`, name: 'Sản phẩm snapshot', price, status: 'ACTIVE' }, randomUUID(), admin).expect(201);
      items.push({ productId: product.body.id as string, quantity: 1 });
    }
    const receipt = await post('/stock-receipts', { reason: 'Nhập hàng kiểm thử US53, không phải hàng thật', items: items.map(item => ({ productId: item.productId, quantity: stock, unitCost: '1000' })) }).expect(201);
    await post(`/stock-receipts/${receipt.body.id}/post`, { version: 0 }).expect(200);
    return { preferredPaymentMethod: 'CASH', items };
  }
  async function quote(intent: Intent, actor = staff) {
    const result = await post('/pos/orders/preview', intent, randomUUID(), actor).expect(200);
    return { ...intent, quoteToken: result.body.quoteToken as string };
  }
  async function create(intent: Intent) { return (await post('/pos/orders', await quote(intent)).expect(201)).body as { id: string; transactionId: string; version: number; invoiceId?: string }; }
  async function snapshot() {
    const rows: Record<string, unknown[]> = {};
    for (const name of [...COLLECTIONS, 'members', 'notification_counters', 'cart_states', 'cart_items']) rows[name] = await db().collection(name).find().sort({ _id: 1 }).toArray();
    return rows;
  }
  async function oracle() { const rows = {} as Rows; for (const name of COLLECTIONS) rows[name] = await db().collection(name).find().toArray(); assertCommittedRows(rows); }
  async function linkedMember() {
    const result = await post('/members', { fullName: 'Hội viên snapshot', phone: `09653${String(++sequence).padStart(5, '0')}` }).expect(201);
    await db().collection('members').updateOne({ _id: new ObjectId(result.body.id) }, { $set: { account_id: new ObjectId(member.id) } });
    return result.body.id as string;
  }
  it('TC01/04/13: linked or anonymous snapshots; no phone auto-link, no fake accounts, cart untouched', async () => {
    const intent = await catalog(), memberId = await linkedMember();
    const buyer = await db().collection('members').findOne({ _id: new ObjectId(memberId) });
    const cart = { member_id: new ObjectId(memberId), revision: Long.ZERO, version: new Int32(7) };
    await db().collection('cart_states').insertOne(cart);
    const cartSnapshot = await db().collection('cart_states').findOne({}, { promoteValues: false });
    const accountCount = await db().collection('accounts').countDocuments();
    const linked = await create({ ...intent, memberId }), anonymous = await create({ ...intent, recipientPhone: buyer!.phone });
    expect((await get(`/orders/${linked.id}`).expect(200)).body).toMatchObject({ channel: 'POS', status: 'CONFIRMED', reservationState: 'HELD', confirmedBy: staff.id,
      recipient: { name: 'Hội viên snapshot', phone: buyer!.phone }, reservationExpiresAt: new Date(Date.parse(NOW) + 86400000).toISOString() });
    await db().collection('members').updateOne({ _id: buyer!._id }, { $set: { full_name: 'Tên mới' } });
    const paid = await post(`/transactions/${linked.transactionId}/confirm-payment`, cash()).expect(200);
    expect((await get(`/invoices/${paid.body.invoiceId}`).expect(200)).body.buyerSnapshot).toContain('Hội viên snapshot');
    const own = await get('/me/orders', member).expect(200); expect(own.body.items.map((row: { id: string }) => row.id)).toEqual([linked.id]);
    await get(`/me/orders/${anonymous.id}`, member).expect(404);
    expect(await db().collection('members').countDocuments()).toBe(1); expect(await db().collection('accounts').countDocuments()).toBe(accountCount);
    expect(await db().collection('cart_states').findOne({}, { promoteValues: false })).toEqual(cartSnapshot); await oracle();
  });
  it('TC02/03: RBAC, strict DTO, quote signature/actor/expiry/staleness, and effectiveActive picker', async () => {
    const intent = await catalog(), quoted = await quote(intent), before = await snapshot();
    for (const actor of [member, trainer]) {
      await get('/pos/products', actor).expect(403); await post('/pos/orders/preview', intent, randomUUID(), actor).expect(403); await post('/pos/orders', quoted, randomUUID(), actor).expect(403);
      await post(`/pos/orders/${new ObjectId()}/fulfill`, { version: 0 }, randomUUID(), actor).expect(403);
    }
    await http().post('/api/pos/orders').send(quoted).expect(401);
    for (const body of [{ ...intent, unitPrice: '1' }, { ...intent, memberId: null }, { ...intent, items: [] }, { ...intent, items: [...intent.items, ...intent.items] },
      { ...intent, items: [{ ...intent.items[0], quantity: '1' }] }, { ...intent, items: [{ ...intent.items[0], quantity: 1000 }] }]) await post('/pos/orders/preview', body).expect(400);
    await post('/pos/orders', { ...quoted, quoteToken: 'forged' }).expect(400);
    await post('/pos/orders', quoted, randomUUID(), admin).expect(403);
    now = new Date(Date.parse(NOW) + 600000).toISOString(); expect((await post('/pos/orders', quoted).expect(409)).body.error.code).toBe('QUOTE_EXPIRED'); now = NOW;
    expect(await snapshot()).toEqual(before);
    const product = intent.items[0].productId;
    await http().patch(`/api/admin/products/${product}`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0, price: '26000' }).expect(200);
    expect((await post('/pos/orders', quoted).expect(409)).body.error.code).toBe('QUOTE_STALE');
    await http().patch(`/api/admin/products/${product}`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ version: 1, status: 'INACTIVE' }).expect(200);
    expect((await get('/pos/products').expect(200)).body.items).toEqual([]); await post('/pos/orders/preview', intent).expect(409);
  });
  it('TC05/06/08/10: CASH and TRANSFER use PAYMENT_CONFIRM, immutable snapshots, one payment/invoice/fulfill', async () => {
    for (const method of ['CASH', 'TRANSFER']) {
      const intent = await catalog(), row = await create(intent), payKey = randomUUID(), fulfillKey = randomUUID();
      const input = method === 'CASH' ? cash() : { method, amount: '25000', evidenceNote: 'Đã kiểm tra báo có thực tế tại ngân hàng', receivingAccountCode: 'GYM_MAIN', bankReference: `US53-${++sequence}`, receivedAt: NOW };
      await fulfill(row.id, 0).expect(409); await post(`/orders/${row.id}/prepare`, { version: 0 }).expect(409); await post(`/orders/${row.id}/fulfill`, { version: 0 }).expect(409);
      expect((await post(`/transactions/${row.transactionId}/payment-preview`, input).expect(200)).body.canConfirm).toBe(true);
      const paid = await post(`/transactions/${row.transactionId}/confirm-payment`, input, payKey).expect(200);
      expect(paid.body).toMatchObject({ kind: 'RETAIL', orderId: row.id, status: 'SETTLED' }); expect(paid.body).not.toHaveProperty('membershipId');
      expect((await post(`/transactions/${row.transactionId}/confirm-payment`, input, payKey).expect(200)).body).toEqual(paid.body);
      const detail = (await get(`/orders/${row.id}`).expect(200)).body; expect(detail).toMatchObject({ status: 'CONFIRMED', version: 1, reservationState: 'HELD' });
      expect((await get(`/invoices/${paid.body.invoiceId}`).expect(200)).body).toMatchObject({ buyerSnapshot: JSON.stringify({ fullName: 'Khách lẻ', phone: '' }), retailLines: [{ sku: expect.any(String), name: 'Sản phẩm snapshot', quantity: 1, unitPrice: '25000', lineTotal: '25000', productId: intent.items[0].productId }] });
      const result = await fulfill(row.id, 1, fulfillKey).expect(200);
      expect((await fulfill(row.id, 1, fulfillKey).expect(200)).body).toEqual(result.body);
      expect(await db().collection('stock_movements').countDocuments({ source_id: new ObjectId(row.id), kind: 'ORDER_FULFILL' })).toBe(1);
      expect(await db().collection('payments').countDocuments({ transaction_id: new ObjectId(row.transactionId) })).toBe(1);
      expect(await db().collection('inventory').findOne({ product_id: new ObjectId(intent.items[0].productId) })).toMatchObject({ on_hand: 2, reserved: 0, version: 3 });
      await oracle();
    }
  });
  it('TC06: anonymous zero total creates invoice0 without payment, then can hand over', async () => {
    const row = await create(await catalog('0'));
    expect(row.invoiceId).toBeDefined(); expect(await db().collection('payments').countDocuments()).toBe(0);
    expect((await get(`/orders/${row.id}`).expect(200)).body).toMatchObject({ transactionStatus: 'SETTLED', status: 'CONFIRMED', reservationState: 'HELD' });
    await fulfill(row.id, 0).expect(200); await oracle();
  });
  it('TC06/07: deadline equality blocks normal payment/handover; shared cancel/expiry release or create refund', async () => {
    const unpaid = await create(await catalog()), paid = await create(await catalog());
    await post(`/transactions/${paid.transactionId}/confirm-payment`, cash()).expect(200);
    now = new Date(Date.parse(NOW) + 86400000).toISOString();
    expect((await post(`/transactions/${unpaid.transactionId}/confirm-payment`, cash()).expect(409)).body.error.code).toBe('RESERVATION_EXPIRED');
    expect((await fulfill(paid.id, 1).expect(409)).body.error.code).toBe('RESERVATION_EXPIRED');
    expect((await get(`/orders/${paid.id}`).expect(200)).body).toMatchObject({ expired: true, reservationState: 'HELD' });
    await app.get(OrderExpiryWorker).runOnce();
    expect((await get(`/orders/${unpaid.id}`).expect(200)).body).toMatchObject({ status: 'CANCELLED', reservationState: 'RELEASED', transactionStatus: 'CANCELLED' });
    expect((await get(`/orders/${paid.id}`).expect(200)).body).toMatchObject({ status: 'CANCELLED', transactionStatus: 'SETTLED', refunds: [{ id: expect.any(String), status: 'PENDING', amount: '25000' }] });
    await oracle();
  });
  it('TC09/10 EN06 subset: ten rounds, 20 creates across two processes replay once; distinct keys cannot oversell', async () => {
    for (let round = 0; round < 10; round++) {
      const intent = await quote(await catalog('25000', 1)), key = randomUUID();
      const results = await Promise.all(Array.from({ length: 20 }, (_, index) => post('/pos/orders', intent, key, staff, index % 2)));
      expect(results.map(result => result.status)).toEqual(Array(20).fill(201)); results.forEach(result => expect(result.body).toEqual(results[0].body));
      expect(await db().collection('orders').countDocuments({ _id: new ObjectId(results[0].body.id) })).toBe(1);
      expect(await db().collection('stock_movements').countDocuments({ source_id: new ObjectId(results[0].body.id), kind: 'ORDER_RESERVE' })).toBe(1);
      const lookup = await get(`/operations/ORDER_CREATE_POS/${key}`).expect(200); expect(lookup.body.responseBody).toEqual(results[0].body);
      const changed = { ...intent, buyerName: 'Khác payload' }; expect((await post('/pos/orders', changed, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      const other = await quote(await catalog('25000', 1));
      const race = await Promise.all([post('/pos/orders', other, randomUUID(), staff, 0), post('/pos/orders', other, randomUUID(), staff, 1)]);
      expect(race.map(result => result.status).sort()).toEqual([201, 409]); await oracle();
    }
  }, 180000);
  it('TC10: response loss on create/payment/fulfill resolves using each original key', async () => {
    const intent = await quote(await catalog()), createKey = randomUUID();
    await children[0].arm('response'); await post('/pos/orders', intent, createKey, staff, 0).then(() => { throw new Error('Expected response loss'); }, () => undefined);
    const created = (await get(`/operations/ORDER_CREATE_POS/${createKey}`).expect(200)).body.responseBody;
    now = new Date(Date.parse(NOW) + 600000).toISOString(); // Replay is resolved before expired quote validation.
    expect((await post('/pos/orders', intent, createKey).expect(201)).body).toEqual(created);
    now = NOW;
    for (const step of ['PAYMENT_CONFIRM', 'ORDER_FULFILL_POS']) {
      const key = randomUUID(), path = step === 'PAYMENT_CONFIRM' ? `/transactions/${created.transactionId}/confirm-payment` : `/pos/orders/${created.id}/fulfill`, body = step === 'PAYMENT_CONFIRM' ? cash() : { version: 1 };
      await children[0].arm('response'); await post(path, body, key, staff, 0).then(() => { throw new Error('Expected response loss'); }, () => undefined);
      const lookup = await get(`/operations/${step}/${key}`).expect(200); expect((await post(path, body, key).expect(200)).body).toEqual(lookup.body.responseBody);
    }
    await oracle();
  });
  it('TC11: second reserve/audit/outbox/key failure rolls back the entire POS creation', async () => {
    const memberId = await linkedMember(), intent = await quote({ ...await catalog('25000', 3, 2), memberId });
    const writer = app.get(InventoryWriter), orders = app.get(OrdersRepository), notifications = app.get(NotificationsRepository);
    const faults = [
      () => { const original = writer.apply.bind(writer); let count = 0; jest.spyOn(writer, 'apply').mockImplementation(async (...args) => { const result = await original(...args); if (++count === 2) throw new ApplicationError(503, 'TEST_FAILURE', 'Line2'); return result; }); },
      () => { jest.spyOn(orders.events, 'create').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Audit')); },
      () => { jest.spyOn(notifications, 'insertOutbox').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Outbox')); },
      () => { jest.spyOn(app.get(OperationRequestsRepository), 'insert').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Key')); },
    ];
    for (const fault of faults) { const before = await snapshot(); fault(); await post('/pos/orders', intent).expect(503); expect(await snapshot()).toEqual(before); jest.restoreAllMocks(); jest.spyOn(console, 'error').mockImplementation(() => undefined); }
    await post('/pos/orders', intent).expect(201); await oracle();
  });
  it('TC12: duplicate bank reference across actors and revoked session cannot bypass US-22 or replay authorization', async () => {
    const intent = await catalog(), a = await create(intent), b = await create(intent), key = randomUUID();
    const transfer = { method: 'TRANSFER', amount: '25000', evidenceNote: 'Đã kiểm tra báo có ngân hàng thực tế', receivingAccountCode: 'GYM_MAIN', bankReference: 'US53_DUPLICATE', receivedAt: NOW };
    await post(`/transactions/${a.transactionId}/confirm-payment`, transfer, key).expect(200);
    expect((await post(`/transactions/${b.transactionId}/confirm-payment`, transfer, randomUUID(), admin).expect(409)).body.error.code).toBe('PAYMENT_REFERENCE_USED');
    await post(`/transactions/${b.transactionId}/confirm-payment`, cash(), randomUUID(), member).expect(403);
    const temp = await login('STAFF'), quoted = await quote(intent, temp), createKey = randomUUID(); await post('/pos/orders', quoted, createKey, temp).expect(201);
    await http().post('/api/auth/logout').set('Authorization', `Bearer ${temp.token}`).set('Origin', origin).send({}).expect(204);
    await post('/pos/orders', quoted, createKey, temp).expect(401); await get(`/operations/ORDER_CREATE_POS/${createKey}`, temp).expect(401); await oracle();
  });
  it('TC11: positive settlement and zero invoice failures roll back money, state, audit and operation', async () => {
    const memberId = await linkedMember(), row = await create({ ...await catalog(), memberId });
    const notifications = app.get(NotificationsRepository), operations = app.get(OperationRequestsRepository), invoices = connection.models.Invoice;
    for (const fault of [
      () => { jest.spyOn(invoices, 'create').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Invoice')); },
      () => { jest.spyOn(notifications, 'insertOutbox').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Outbox')); },
      () => { jest.spyOn(operations, 'insert').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Key')); },
    ]) {
      const before = await snapshot(); fault(); await post(`/transactions/${row.transactionId}/confirm-payment`, cash()).expect(503);
      expect(await snapshot()).toEqual(before); jest.restoreAllMocks(); jest.spyOn(console, 'error').mockImplementation(() => undefined);
    }
    const free = await quote(await catalog('0')), before = await snapshot();
    jest.spyOn(invoices, 'create').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Zero invoice'));
    await post('/pos/orders', free).expect(503); expect(await snapshot()).toEqual(before); jest.restoreAllMocks();
    await post('/pos/orders', free).expect(201); await oracle();
  });
  it('TC07 EN06 subset: real POS payment/cancel and paid fulfill/cancel races preserve one terminal outcome', async () => {
    for (let round = 0; round < 10; round++) {
      const unpaid = await create(await catalog());
      const pair = await Promise.all([
        post(`/transactions/${unpaid.transactionId}/confirm-payment`, cash(), randomUUID(), staff, 0),
        post(`/orders/${unpaid.id}/cancel`, { version: 0, reason: 'Khách thay đổi ý định tại quầy' }, randomUUID(), staff, 1),
      ]);
      expect(pair.map(result => result.status).sort()).toEqual([200, 409]);
      const state = (await get(`/orders/${unpaid.id}`).expect(200)).body;
      if (state.status !== 'CANCELLED') await post(`/orders/${unpaid.id}/cancel`, { version: state.version, reason: 'Khách thay đổi ý định tại quầy' }).expect(200);
      const paid = await create(await catalog()); await post(`/transactions/${paid.transactionId}/confirm-payment`, cash()).expect(200);
      const terminal = await Promise.all([
        post(`/pos/orders/${paid.id}/fulfill`, { version: 1 }, randomUUID(), staff, 0),
        post(`/orders/${paid.id}/cancel`, { version: 1, reason: 'Khách yêu cầu hủy trước bàn giao' }, randomUUID(), staff, 1),
      ]);
      expect(terminal.map(result => result.status).sort()).toEqual([200, 409]);
      const order = await db().collection('orders').findOne({ _id: new ObjectId(paid.id) });
      expect(['COMPLETED', 'CANCELLED']).toContain(order!.status);
      const movements = await db().collection('stock_movements').find({ source_id: order!._id, kind: { $in: ['ORDER_FULFILL', 'ORDER_RELEASE'] } }).toArray();
      expect(movements).toHaveLength(1); await oracle();
    }
  }, 180000);
});
