// US-41/45 writers are absent: order/reservation/payment fixtures below do not establish cross-story acceptance.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Int32, Long, ObjectId } from 'mongodb';
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
import { AppProcess } from './helpers/en05-fixture';
import { COLLECTIONS, Rows, assertCommittedRows } from './helpers/en06-oracle';

const NOW = '2035-11-14T17:00:00.000Z', origin = 'http://localhost:5173';
type Actor = { id: string; token: string };
describe('US-44: real replica set, HTTP guards, two processes and atomic handover', () => {
  let mongo: MongoMemoryReplSet, app: INestApplication, connection: Connection, staff: Actor, admin: Actor, member: Actor, trainer: Actor;
  const children: AppProcess[] = [], saved = { ...process.env }, clock = new ServerClock();
  let now = NOW, sequence = 0;
  clock.now = () => new Date(now);
  const db = () => connection.db!, http = () => request(app.getHttpServer());
  const fulfill = (id: string, version = 0, key: string = randomUUID(), actor = staff, child?: number) =>
    (child === undefined ? http() : request(children[child].url)).post(`/api/orders/${id}/fulfill`)
      .set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send({ version });
  const get = (id: string) => http().get(`/api/orders/${id}`).set('Authorization', `Bearer ${staff.token}`);
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: `gym_test_us44_${randomBytes(4).toString('hex')}`,
      EN05_NOW: NOW, FRONTEND_ORIGIN: origin, JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '' });
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
    for (const name of [...COLLECTIONS, 'members', 'categories', 'catalog_events']) await db().collection(name).deleteMany({});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { for (const child of children) await child.close(); await app?.close(); await mongo?.stop(); process.env = saved; });
  async function login(code: 'STAFF' | 'ADMIN' | 'MEMBER' | 'TRAINER'): Promise<Actor> {
    const users = app.get(UsersRepository), role = await users.ensureRole(code, code), password = 'US44 fixture password 123';
    const account = await users.createAccount({ roleId: String(role.id), fullName: `US44 ${code}`, phone: `094400${String(++sequence).padStart(4, '0')}`,
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
      recipient_phone: '+84901234567', pickup_location_snapshot: 'Quầy fixture US44', created_by: new ObjectId(member.id), created_at: created, updated_at: created,
      confirmed_at: created, confirmed_by: new ObjectId(staff.id), version: new Int32(0), guard_revision: Long.ZERO });
    // Catalog and stock receipts use their real HTTP writers. Only the missing US-41 reserve/create/settle is a persisted fixture.
    const category = await create('/admin/categories', { name: `US44 ${++sequence}`, status: 'ACTIVE' });
    const items: { itemId: ObjectId; productId: ObjectId; sku: string }[] = [];
    for (let i = 0; i < count; i++) {
      const sku = `US44_${++sequence}`, product = await create('/admin/products', { categoryId: category.id, sku, name: 'Tên snapshot', price: options.free ? '0' : '25000', status: 'ACTIVE' });
      items.push({ itemId: new ObjectId(), productId: new ObjectId(product.id), sku });
    }
    const receipt = await create('/stock-receipts', { reason: 'US44 FIXTURE nhập hàng kiểm thử, không hàng thật', items: items.map(item => ({ productId: String(item.productId), quantity: 3, unitCost: '1000' })) }, staff);
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
        verified_by: new ObjectId(staff.id), paid_at: created, evidence_note: 'US44 fixture evidence, not a real receipt', bank_reference: 'SECRET_TEST_REFERENCE' }); }
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
  it('TC01/04/05/06: paid/free, all SKU deltas, sequence, snapshots and audit; no second settlement or ISSUE', async () => {
    for (const free of [false, true]) {
      const row = await fixture({ free });
      await oracle();
      const money = await snapshot();
      for (const item of row.items) await http().patch(`/api/admin/products/${item.productId}`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID())
        .send({ version: 0, status: 'INACTIVE', price: '999999', name: 'Tên hiện tại' }).expect(200);
      const result = await fulfill(row.id, 0, randomUUID(), free ? admin : staff).expect(200);
      expect(result.body).toMatchObject({ id: row.id, code: `ORD-${row.id}`, status: 'COMPLETED', reservationState: 'CONSUMED', version: 1, fulfilledAt: NOW, fulfilledBy: free ? admin.id : staff.id, notificationState: 'STORED' });
      expect(result.body.movementIds).toHaveLength(2);
      for (const item of row.items) {
        expect(await db().collection('inventory').findOne({ product_id: item.productId })).toMatchObject({ on_hand: 2, reserved: 0, version: 3 });
        expect(await db().collection('stock_movements').findOne({ event_key: `ORDER_FULFILL:${item.itemId}` })).toMatchObject({ kind: 'ORDER_FULFILL', on_hand_delta: -1, reserved_delta: -1,
          before_on_hand: 3, before_reserved: 1, after_on_hand: 2, after_reserved: 0, sequence: 3, name_snapshot: 'Tên snapshot', sku_snapshot: item.sku });
      }
      const after = await snapshot();
      for (const name of ['payments', 'invoices', 'stock_documents', 'stock_document_items']) expect(after[name]).toEqual(money[name]);
      expect(await db().collection('order_events').findOne({ order_id: row.orderId })).toMatchObject({ action: 'FULFILLED', event_key: `ORDER_COMPLETED:${row.id}`,
        before: { status: 'CONFIRMED', version: 0 }, after: { status: 'COMPLETED', version: 1 }, actor_id: new ObjectId(free ? admin.id : staff.id) });
      const detail = await get(row.id).expect(200);
      expect(detail.body).toMatchObject({ fulfilledAt: NOW, fulfilledBy: free ? admin.id : staff.id, movementIds: result.body.movementIds, permittedActions: { fulfill: false } });
      expect(JSON.stringify(detail.body)).not.toMatch(/SECRET_TEST_REFERENCE|evidence_note|bank_reference|request_key|guard_revision/);
      await oracle();
    }
  });
  it('TC02: JWT/session/role, channel, missing ID and strict DTO; rejected requests leave DB intact', async () => {
    const row = await fixture(), pos = await fixture({ channel: 'POS' }), before = await snapshot();
    for (const actor of [member, trainer]) await fulfill(row.id, 0, randomUUID(), actor).expect(403);
    await http().post(`/api/orders/${row.id}/fulfill`).send({ version: 0 }).expect(401);
    expect((await fulfill(pos.id).expect(409)).body.error.code).toBe('ORDER_CHANNEL_MISMATCH');
    await fulfill('invalid').expect(400); await fulfill(String(new ObjectId())).expect(404); await fulfill(row.id, 0, 'invalid').expect(400);
    for (const body of [{}, { version: -1 }, { version: '0' }, { version: 2147483648 }, { version: 0, status: 'COMPLETED' }, { version: 0, fulfilledBy: admin.id }]) {
      await http().post(`/api/orders/${row.id}/fulfill`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID()).send(body).expect(400);
    }
    const temp = await login('STAFF');
    await http().post('/api/auth/logout').set('Authorization', `Bearer ${temp.token}`).set('Origin', origin).send({}).expect(204);
    await fulfill(row.id, 0, randomUUID(), temp).expect(401);
    expect(await snapshot()).toEqual(before);
  });
  it('TC03: pending/cancelled/unpaid/wrong reservation/version block; expired reads never release stock', async () => {
    for (const [options, code] of [[{ status: 'PENDING' }, 'ORDER_NOT_PREPARED'], [{ status: 'CANCELLED' }, 'ORDER_NOT_PREPARED'], [{ paid: false }, 'ORDER_NOT_SETTLED']] as const) {
      const row = await fixture(options), before = await snapshot(); expect((await fulfill(row.id).expect(409)).body.error.code).toBe(code); expect(await snapshot()).toEqual(before);
    }
    const row = await fixture();
    await db().collection('orders').updateOne({ _id: row.orderId }, { $set: { reservation_state: 'RELEASED' } });
    expect((await fulfill(row.id).expect(409)).body.error.code).toBe('INVALID_RESERVATION_STATE');
    await db().collection('orders').updateOne({ _id: row.orderId }, { $set: { reservation_state: 'HELD' } });
    expect((await fulfill(row.id, 1).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
    for (const offset of [0, 1]) {
      now = new Date(row.expires.getTime() + offset).toISOString(); const before = await snapshot();
      expect((await get(row.id).expect(200)).body).toMatchObject({ status: 'CONFIRMED', expired: true, reservationState: 'HELD', permittedActions: { fulfill: false } });
      expect((await fulfill(row.id).expect(409)).body.error.code).toBe('RESERVATION_EXPIRED'); expect(await snapshot()).toEqual(before);
    }
    now = new Date(row.expires.getTime() - 1).toISOString(); await fulfill(row.id).expect(200);
  });
  it('TC04: missing/wrong invoice/payment or zero-payment anomaly blocks handover without stock writes', async () => {
    for (const kind of ['invoice', 'invoiceAmount', 'payment', 'paymentAmount', 'zeroPayment', 'pendingZeroPayment', 'settledAt']) {
      const row = await fixture({ free: ['zeroPayment', 'pendingZeroPayment'].includes(kind) });
      if (kind === 'invoice') await db().collection('invoices').deleteOne({ transaction_id: row.transactionId });
      if (kind === 'invoiceAmount') await db().collection('invoices').updateOne({ transaction_id: row.transactionId }, { $set: { total_amount: Decimal128.fromString('1') } });
      if (kind === 'payment') await db().collection('payments').deleteOne({ transaction_id: row.transactionId });
      if (kind === 'paymentAmount') await db().collection('payments').updateOne({ transaction_id: row.transactionId }, { $set: { amount: Decimal128.fromString('1') } });
      if (kind === 'zeroPayment') await db().collection('payments').insertOne({ transaction_id: row.transactionId, status: 'SUCCEEDED', reference: `FIXTURE:ZERO:${row.id}`, amount: Decimal128.fromString('0') });
      if (kind === 'pendingZeroPayment') await db().collection('payments').insertOne({ transaction_id: row.transactionId, status: 'PENDING', reference: `FIXTURE:ZERO:${row.id}`, amount: Decimal128.fromString('0') });
      if (kind === 'settledAt') await db().collection('transactions').updateOne({ _id: row.transactionId }, { $unset: { settled_at: '' } });
      const before = await snapshot(); expect((await fulfill(row.id).expect(409)).body.error.code).toBe('ORDER_INTEGRITY_ERROR'); expect(await snapshot()).toEqual(before);
    }
  });
  it('TC07: second SKU, order CAS, event/audit, notification, outbox and key failures roll back every write including guards', async () => {
    const row = await fixture(), writer = app.get(InventoryWriter), repository = app.get(OrdersRepository), notifications = app.get(NotificationsRepository);
    const faults: (() => void)[] = [
      () => { const original = writer.apply.bind(writer); let calls = 0; jest.spyOn(writer, 'apply').mockImplementation(async (...args) => { const result = await original(...args); if (++calls === 2) throw new ApplicationError(503, 'TEST_FAILURE', 'Second SKU'); return result; }); },
      () => { jest.spyOn(repository.orders, 'findOneAndUpdate').mockImplementation(() => { throw new ApplicationError(503, 'TEST_FAILURE', 'Order CAS'); }); },
      () => { jest.spyOn(repository.events, 'create').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Order audit')); },
      () => { jest.spyOn(notifications, 'insertNotification').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Notification')); },
      () => { jest.spyOn(notifications, 'insertRecipients').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Recipient')); },
      () => { jest.spyOn(notifications, 'insertOutbox').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Outbox')); },
      () => { jest.spyOn(app.get(OperationRequestsRepository), 'insert').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Key')); },
    ];
    for (const inject of faults) {
      const before = await snapshot(); inject(); await fulfill(row.id).expect(503); expect(await snapshot()).toEqual(before); jest.restoreAllMocks();
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
    }
    await fulfill(row.id).expect(200); await oracle();
  });
  it('TC08: missing inventory/reserve, insufficient reserved, reserved>onHand, false provenance and broken ledger reject with no repair', async () => {
    for (const kind of ['missing', 'reserve', 'insufficient', 'overflow', 'provenance', 'ledger']) {
      const row = await fixture(), item = row.items[1];
      if (kind === 'missing') await db().collection('inventory').deleteOne({ product_id: item.productId });
      if (kind === 'reserve') await db().collection('stock_movements').deleteOne({ order_item_id: item.itemId });
      if (kind === 'insufficient') await db().collection('inventory').updateOne({ product_id: item.productId }, { $set: { reserved: new Int32(0) } });
      if (kind === 'overflow') await db().collection('inventory').updateOne({ product_id: item.productId }, { $set: { reserved: new Int32(4) } });
      if (kind === 'provenance') await db().collection('stock_movements').updateOne({ order_item_id: item.itemId }, { $set: { source_id: new ObjectId() } });
      if (kind === 'ledger') await db().collection('stock_movements').updateOne({ order_item_id: item.itemId }, { $set: { after_on_hand: new Int32(99) } });
      const before = await snapshot(); expect((await fulfill(row.id).expect(409)).body.error.code).toBe('INVENTORY_INTEGRITY_ERROR'); expect(await snapshot()).toEqual(before);
    }
  });
  it('TC09: 10 rounds × 20 requests with the same key across two processes produce one complete result and movement set', async () => {
    for (let round = 0; round < 10; round++) {
      const row = await fixture(), key = randomUUID();
      await Promise.all(children.map(child => child.arm('guard')));
      const pending = Promise.all(Array.from({ length: 20 }, (_, i) => fulfill(row.id, 0, key, staff, (i + round) % 2)));
      await Promise.all(children.map(child => child.hit('guard'))); await Promise.all(children.map(child => child.rpc('release')));
      const results = await pending; expect(results.map(result => result.status)).toEqual(Array(20).fill(200));
      results.forEach(result => expect(result.body).toEqual(results[0].body));
      expect(await db().collection('order_events').countDocuments({ order_id: row.orderId })).toBe(1);
      expect(await db().collection('stock_movements').countDocuments({ source_id: row.orderId, kind: 'ORDER_FULFILL' })).toBe(2);
      expect(await db().collection('operation_requests').countDocuments({ client_key: key })).toBe(1); await oracle();
    }
  }, 180000);
  it('TC09: 10 rounds with different keys allow one handover, returning original terminal metadata on the loser', async () => {
    for (let round = 0; round < 10; round++) {
      const row = await fixture();
      await Promise.all(children.map(child => child.arm('guard')));
      const pending = Promise.all([fulfill(row.id, 0, randomUUID(), staff, round % 2), fulfill(row.id, 0, randomUUID(), staff, (round + 1) % 2)]);
      await Promise.all(children.map(child => child.hit('guard'))); await Promise.all(children.map(child => child.rpc('release')));
      const results = await pending; expect(results.map(result => result.status).sort()).toEqual([200, 409]);
      expect(results.find(result => result.status === 409)!.body.error).toMatchObject({ code: 'ORDER_ALREADY_COMPLETED', details: expect.arrayContaining([
        { field: 'id', message: row.id }, { field: 'version', message: '1' }, { field: 'fulfilledAt', message: NOW }, { field: 'fulfilledBy', message: staff.id },
      ]) }); await oracle();
    }
  }, 180000);
  it('TC10/11 subset: after a paused request, fixture cancellation/version/payment changes are rechecked; deadline clock refreshes on retry', async () => {
    // These fixture transitions are NOT the missing US-45 cancel/expiry or US-41 payment commands.
    for (const change of ['cancel', 'version', 'unsettled', 'deadline', 'retry']) {
      const row = await fixture(); await children[0].arm('guard', change === 'retry' ? 'retry' : 'pause', row.expires.toISOString());
      const pending = fulfill(row.id, 0, randomUUID(), staff, 0).then(result => result); await children[0].hit('guard');
      if (change === 'deadline') await children[0].rpc('clock', row.expires.toISOString());
      else if (change === 'unsettled') await db().collection('transactions').updateOne({ _id: row.transactionId }, { $set: { status: 'PENDING' }, $inc: { guard_revision: Long.ONE } });
      else if (change !== 'retry') await db().collection('orders').updateOne({ _id: row.orderId }, { $set: change === 'cancel' ? { status: 'CANCELLED', reservation_state: 'RELEASED' } : {}, $inc: { version: 1, guard_revision: Long.ONE } });
      await children[0].rpc('release'); const result = await pending;
      expect(result.status).toBe(409); expect(result.body.error.code).toBe(change === 'cancel' ? 'ORDER_NOT_PREPARED' : change === 'version' ? 'VERSION_CONFLICT' : change === 'unsettled' ? 'ORDER_NOT_SETTLED' : 'RESERVATION_EXPIRED');
      expect(await db().collection('stock_movements').countDocuments({ source_id: row.orderId, kind: 'ORDER_FULFILL' })).toBe(0);
      await children[0].rpc('clock', NOW);
    }
  });
  it('TC12: lost response and offline transport resolve by original key; replay precedes stale version and revoked auth is still enforced', async () => {
    const row = await fixture(), key = randomUUID(); await children[0].arm('response');
    await fulfill(row.id, 0, key, staff, 0).then(() => { throw new Error('Response should be lost'); }, () => undefined);
    const lookup = await http().get(`/api/operations/ORDER_FULFILL_WEBSITE/${key}`).set('Authorization', `Bearer ${staff.token}`).expect(200);
    expect((await fulfill(row.id, 0, key).expect(200)).body).toEqual(lookup.body.responseBody);
    expect((await fulfill(row.id, 1, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const other = await fixture(); expect((await fulfill(other.id, 0, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    await http().get(`/api/operations/ORDER_FULFILL_WEBSITE/${key}`).set('Authorization', `Bearer ${admin.token}`).expect(404);
    await http().get(`/api/operations/ORDER_FULFILL_WEBSITE/${key}`).set('Authorization', `Bearer ${member.token}`).expect(403);
    const inbox = await http().get('/api/notifications/sync').set('Authorization', `Bearer ${member.token}`).expect(200);
    expect(inbox.body.items.some((item: { eventKey: string }) => item.eventKey === `ORDER_COMPLETED:${row.id}`)).toBe(true);
    expect(JSON.stringify(inbox.body)).not.toMatch(/SECRET_TEST_REFERENCE|84901234567|Người nhận snapshot/);
    const temp = await login('STAFF'), tempKey = randomUUID(); await fulfill(other.id, 0, tempKey, temp).expect(200);
    await http().post('/api/auth/logout').set('Authorization', `Bearer ${temp.token}`).set('Origin', origin).send({}).expect(204);
    await fulfill(other.id, 0, tempKey, temp).expect(401);
    await http().get(`/api/operations/ORDER_FULFILL_WEBSITE/${tempKey}`).set('Authorization', `Bearer ${temp.token}`).expect(401); await oracle();
  });
  it('TC12: no linked account still commits audit/source/outbox and returns NO_LINKED_ACCOUNT', async () => {
    const row = await fixture({ linked: false }); expect((await fulfill(row.id).expect(200)).body.notificationState).toBe('NO_LINKED_ACCOUNT');
    expect(await db().collection('notification_recipients').countDocuments()).toBe(0);
    expect(await db().collection('notification_outbox').countDocuments({ event_key: `ORDER_COMPLETED:${row.id}` })).toBe(1); await oracle();
  });
  it('missing movement unique index blocks new writes but committed replay still returns the original result', async () => {
    const completed = await fixture(), key = randomUUID(), original = await fulfill(completed.id, 0, key).expect(200), other = await fixture();
    await db().collection('stock_movements').dropIndex('stock_movements_event_key_unique');
    try {
      const before = await snapshot(); expect((await fulfill(other.id).expect(503)).body.error.code).toBe('ORDERS_NOT_READY');
      expect((await fulfill(completed.id, 0, key).expect(200)).body).toEqual(original.body); expect(await snapshot()).toEqual(before);
    } finally { await connection.models.StockMovement.createIndexes(); }
  });
  it('H01: eligibility clock is taken after inventory locks, not at request entry', async () => {
    const row = await fixture(), writer = app.get(InventoryWriter), lock = writer.lock.bind(writer);
    jest.spyOn(writer, 'lock').mockImplementation(async (...args) => { const result = await lock(...args); now = row.expires.toISOString(); return result; });
    const before = await snapshot(); expect((await fulfill(row.id).expect(409)).body.error.code).toBe('RESERVATION_EXPIRED'); expect(await snapshot()).toEqual(before);
  });
  it('shared service accepts an anonymous POS policy with separate operation namespace; no POS HTTP adapter is exposed yet', async () => {
    const row = await fixture({ channel: 'POS', linked: false });
    await db().collection('orders').updateOne({ _id: row.orderId }, { $unset: { member_id: '' } });
    await db().collection('transactions').updateOne({ _id: row.transactionId }, { $unset: { member_id: '' } });
    const key = randomUUID(), result = await app.get(FulfillOrderService).fulfill(staff.id, row.id, { version: 0 }, key, 'POS');
    expect(result.body).toMatchObject({ status: 'COMPLETED', reservationState: 'CONSUMED', notificationState: 'NO_LINKED_ACCOUNT' });
    expect(await db().collection('operation_requests').countDocuments({ operation: 'ORDER_FULFILL_POS', client_key: key })).toBe(1);
    expect((await fulfill(row.id).expect(409)).body.error.code).toBe('ORDER_CHANNEL_MISMATCH'); await oracle();
  });
});
