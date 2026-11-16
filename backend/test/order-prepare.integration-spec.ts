// US-41 has no create writer yet: explicit persisted snapshot fixtures below do not prove checkout/reservation correctness.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Int32, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { ApplicationError } from '../src/common/errors/application-error';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { UsersRepository } from '../src/modules/users/users.repository';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import { OperationRequestsRepository } from '../src/modules/operations/operation-requests.repository';
import { OrdersRepository } from '../src/modules/orders/orders.repository';
import { ensureOrdersIntegrity } from '../src/modules/orders/orders-migration';
import { AppProcess } from './helpers/en05-fixture';

const NOW = '2035-11-14T17:00:00.000Z', origin = 'http://localhost:5173', base = '/api/orders';
type Actor = { id: string; token: string };
describe('US-43: real MongoDB, HTTP guards, two processes, snapshot fixtures and atomic prepare', () => {
  let mongo: MongoMemoryReplSet, app: INestApplication, connection: Connection, staff: Actor, admin: Actor, member: Actor, trainer: Actor;
  const children: AppProcess[] = [], saved = { ...process.env };
  const clock = new ServerClock(); let now = NOW, sequence = 0;
  clock.now = () => new Date(now);
  const db = () => connection.db!, http = () => request(app.getHttpServer());
  const get = (path = '', actor = staff) => http().get(`${base}${path}`).set('Authorization', `Bearer ${actor.token}`);
  const prepare = (id: string, version = 0, key: string = randomUUID(), actor = staff, child?: number) =>
    (child === undefined ? http() : request(children[child].url)).post(`${base}/${id}/prepare`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send({ version });
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: `gym_test_us43_${randomBytes(4).toString('hex')}`,
      EN05_NOW: NOW, FRONTEND_ORIGIN: origin, JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '' });
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false }); configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    for (let i = 0; i < 2; i++) { const child = new AppProcess(); children.push(child); await child.start(); }
    expect(new Set(children.map(child => child.child.pid)).size).toBe(2);
    staff = await login('STAFF'); admin = await login('ADMIN'); member = await login('MEMBER'); trainer = await login('TRAINER');
  }, 600000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    now = NOW;
    for (const child of children) { await child.rpc('clear'); await child.rpc('clock', NOW); }
    for (const name of ['orders', 'order_items', 'order_events', 'transactions', 'members', 'payments', 'invoices', 'refunds', 'inventory', 'stock_movements',
      'operation_requests', 'notifications', 'notification_recipients', 'notification_outbox']) await db().collection(name).deleteMany({});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { for (const child of children) await child.close(); await app?.close(); await mongo?.stop(); process.env = saved; });
  async function login(code: 'STAFF' | 'ADMIN' | 'MEMBER' | 'TRAINER'): Promise<Actor> {
    const users = app.get(UsersRepository), role = await users.ensureRole(code, code), password = 'US43 fixture password 123';
    const account = await users.createAccount({ roleId: String(role.id), fullName: `US43 ${code}`, phone: `094300${String(++sequence).padStart(4, '0')}`,
      passwordHash: await app.get(PasswordService).hash(password) });
    const result = await http().post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
    return { id: String(account._id), token: result.body.accessToken as string };
  }
  async function fixture(options: { channel?: string; status?: string; paid?: boolean; free?: boolean; linked?: boolean; expires?: string } = {}) {
    const linked = options.linked === false ? null : await db().collection('members').findOne({ account_id: new ObjectId(member.id) });
    const orderId = new ObjectId(), transactionId = new ObjectId(), memberId = linked?._id ?? new ObjectId(), productId = new ObjectId(), itemId = new ObjectId();
    const expires = new Date(options.expires ?? '2035-11-15T17:00:00.000Z'), created = new Date(expires.getTime() - 86400000), amount = options.free ? '0' : '25000';
    if (!linked) await db().collection('members').insertOne({ _id: memberId, id: memberId, member_code: `HV-${memberId}`, phone: `+84943${String(++sequence).padStart(6, '0')}`,
      service_revision: Long.ZERO, ...(options.linked === false ? {} : { account_id: new ObjectId(member.id) }) });
    await db().collection('transactions').insertOne({ _id: transactionId, id: transactionId, member_id: memberId, created_by: new ObjectId(member.id), code: `TX-${transactionId}`,
      kind: 'RETAIL', status: options.paid || options.free ? 'SETTLED' : 'PENDING', amount_due: Decimal128.fromString(amount), request_key: createHash('sha256').update(String(transactionId)).digest('hex'),
      created_at: created, guard_revision: Long.ZERO, version: 0, ...(options.paid || options.free ? { settled_at: created } : {}) });
    await db().collection('orders').insertOne({ _id: orderId, id: orderId, transaction_id: transactionId, member_id: memberId, code: `ORD-${orderId}`, channel: options.channel ?? 'WEBSITE',
      status: options.status ?? 'PENDING', reservation_state: 'HELD', reservation_expires_at: expires, preferred_payment_method: 'CASH', recipient_name: 'Người nhận snapshot',
      recipient_phone: '+84901234567', pickup_location_snapshot: 'Quầy fixture US43', created_by: new ObjectId(member.id), created_at: created, updated_at: created, version: new Int32(0), guard_revision: Long.ZERO });
    await db().collection('order_items').insertOne({ _id: itemId, id: itemId, order_id: orderId, product_id: productId, sku_snapshot: 'OLD-SKU', name_snapshot: 'Tên snapshot',
      product_version_snapshot: new Int32(0), unit_price: Decimal128.fromString(amount), line_total: Decimal128.fromString(amount), quantity: new Int32(1) });
    await db().collection('inventory').insertOne({ product_id: productId, on_hand: new Int32(2), reserved: new Int32(1), version: new Int32(1), guard_revision: Long.ZERO });
    if (options.paid || options.free) {
      await db().collection('invoices').insertOne({ transaction_id: transactionId, invoice_no: `INV-${orderId}`, total_amount: Decimal128.fromString(amount), issued_at: created, buyer_snapshot: 'Snapshot buyer' });
      if (!options.free) await db().collection('payments').insertOne({ transaction_id: transactionId, status: 'SUCCEEDED', amount: Decimal128.fromString(amount), reference: `FIXTURE:${orderId}`,
        verified_by: new ObjectId(staff.id), paid_at: created, evidence_note: 'US43 fixture evidence, not a real receipt', bank_reference: 'SECRET_TEST_REFERENCE' });
    }
    return { id: String(orderId), orderId, transactionId, memberId, productId, itemId, expires };
  }
  async function snapshot(names = ['orders', 'members', 'transactions', 'order_items', 'order_events', 'inventory', 'stock_movements', 'payments', 'invoices', 'operation_requests', 'notifications', 'notification_recipients', 'notification_outbox']) {
    const rows: Record<string, unknown> = {};
    for (const name of names) rows[name] = await db().collection(name).find().sort({ _id: 1 }).toArray();
    return rows;
  }
  it('TC01/04/05/08: unpaid, settled and free can prepare; only order operational fields change, catalog is never joined', async () => {
    for (const options of [{}, { paid: true }, { free: true }]) {
      const row = await fixture(options), before = await snapshot(['inventory', 'stock_movements', 'payments', 'invoices', 'order_items', 'transactions']);
      await db().collection('products').updateOne({ _id: row.productId }, { $set: { sku: `NEW-${row.productId}`, name: 'Giá/tên mới', price: Decimal128.fromString('999'), status: 'INACTIVE' } }, { upsert: true });
      const result = await prepare(row.id, 0, randomUUID(), options.paid ? admin : staff).expect(200);
      expect(result.body).toMatchObject({ id: row.id, status: 'CONFIRMED', version: 1, confirmedAt: NOW, confirmedBy: options.paid ? admin.id : staff.id, reservationExpiresAt: row.expires.toISOString(), notificationState: 'STORED' });
      const after = await snapshot(Object.keys(before));
      // Guard revisions change to serialize; monetary and business transaction fields stay intact.
      for (const tx of before.transactions as { _id: ObjectId; guard_revision: number }[]) if (tx._id.equals(row.transactionId)) tx.guard_revision++;
      expect(after).toEqual(before);
      const event = await db().collection('order_events').findOne({ order_id: row.orderId });
      expect(event).toMatchObject({ action: 'PREPARED', actor_type: 'USER', before: { status: 'PENDING', version: 0 }, after: { status: 'CONFIRMED', version: 1 }, event_key: `ORDER_CONFIRMED:${row.id}` });
      const detail = await get(`/${row.id}`).expect(200);
      expect(detail.body).toMatchObject({ status: 'CONFIRMED', transactionStatus: options.paid || options.free ? 'SETTLED' : 'PENDING', items: [{ nameSnapshot: 'Tên snapshot', skuSnapshot: 'OLD-SKU' }] });
      expect(JSON.stringify(detail.body)).not.toMatch(/SECRET_TEST_REFERENCE|evidence_note|bank_reference|request_key|guard_revision/);
    }
  });
  it('TC02: Member/PT forbidden, revoked session unauthorized, ID/DTO/query allowlists enforced', async () => {
    const row = await fixture(), before = await snapshot();
    for (const actor of [member, trainer]) { await prepare(row.id, 0, randomUUID(), actor).expect(403); await get('', actor).expect(403); await get(`/${row.id}`, actor).expect(403); }
    await http().get(base).expect(401);
    await get('/invalid').expect(400); await get(`/${new ObjectId()}`).expect(404);
    await prepare(row.id, 0, 'invalid').expect(400);
    for (const body of [{}, { version: -1 }, { version: '0' }, { version: 0, status: 'COMPLETED' }, { version: 0, recipientName: 'Fake' }]) {
      await http().post(`${base}/${row.id}/prepare`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID()).send(body).expect(400);
    }
    for (const query of ['?extra=x', '?limit=101', '?page=1.5', '?memberId=x', '?q=' + 'a'.repeat(121), '?status=X', '?transactionStatus=X', '?fromDate=2026-02-30', '?fromDate=2025-01-01&toDate=2026-01-02', '?fromDate=2035-11-16&toDate=2035-11-15']) await get(query).expect(400);
    const temp = await login('STAFF');
    await http().post('/api/auth/logout').set('Authorization', `Bearer ${temp.token}`).set('Origin', origin).send({}).expect(204);
    await prepare(row.id, 0, randomUUID(), temp).expect(401);
    expect(await snapshot()).toEqual(before);
  });
  it('TC03: POS, terminal, missing transaction/item, wrong totals and invalid SETTLED fail without writing', async () => {
    for (const status of ['CANCELLED', 'COMPLETED']) { const row = await fixture({ status }); expect((await prepare(row.id).expect(409)).body.error.code).toBe('INVALID_ORDER_STATE'); }
    const pos = await fixture({ channel: 'POS' }); expect((await prepare(pos.id).expect(409)).body.error.code).toBe('ORDER_CHANNEL_MISMATCH');
    for (const kind of ['transaction', 'items', 'total', 'settled', 'revision', 'event']) {
      const row = await fixture({ paid: kind === 'settled' });
      if (kind === 'transaction') await db().collection('transactions').deleteOne({ _id: row.transactionId });
      if (kind === 'items') await db().collection('order_items').deleteMany({ order_id: row.orderId });
      if (kind === 'total') await db().collection('order_items').updateOne({ _id: row.itemId }, { $set: { line_total: Decimal128.fromString('999') } });
      if (kind === 'settled') await db().collection('invoices').deleteOne({ transaction_id: row.transactionId });
      if (kind === 'revision') await db().collection('orders').updateOne({ _id: row.orderId }, { $unset: { guard_revision: '' } });
      if (kind === 'event') await db().collection('order_events').insertOne({ order_id: row.orderId, event_key: `ORDER_CONFIRMED:${row.id}`, action: 'PREPARED' });
      const before = await snapshot(); expect((await prepare(row.id).expect(409)).body.error.code).toBe('ORDER_INTEGRITY_ERROR'); expect(await snapshot()).toEqual(before);
    }
  });
  it('TC04/EN06-TC13 subset: deadline −1 ms accepted, exact/+1 ms blocked; expired GET never cancels or releases', async () => {
    for (const offset of [-1, 0, 1]) {
      const row = await fixture(); now = new Date(row.expires.getTime() + offset).toISOString();
      const before = await snapshot();
      const read = await get(`/${row.id}`).expect(200); expect(read.body.expired).toBe(offset >= 0); expect(read.body.status).toBe('PENDING'); expect(await snapshot()).toEqual(before);
      const result = await prepare(row.id).expect(offset < 0 ? 200 : 409);
      if (offset >= 0) { expect(result.body.error.code).toBe('RESERVATION_EXPIRED'); expect(await snapshot()).toEqual(before); }
    }
  });
  it.each(['event', 'recipient', 'outbox', 'key'])('TC06: failure at/after %s insert aborts status, guards, source event and all outbox/key rows', async point => {
    const row = await fixture(), before = await snapshot();
    if (point === 'event') jest.spyOn(app.get(OrdersRepository).events, 'create').mockRejectedValueOnce(new ApplicationError(503, 'TEST_ROLLBACK', 'Fixture fault') as never);
    else {
      const target = point === 'key' ? app.get(OperationRequestsRepository) : app.get(NotificationsRepository);
      const method = point === 'key' ? 'insert' : point === 'recipient' ? 'insertRecipients' : 'insertOutbox';
      // Test-only wrapper preserves real writes/session and throws before commit.
      const original = (target as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method].bind(target);
      jest.spyOn(target as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>, method).mockImplementation(async (...args: unknown[]) => { await original(...args); throw new ApplicationError(503, 'TEST_ROLLBACK', 'Fixture fault'); });
    }
    await prepare(row.id).expect(503); expect(await snapshot()).toEqual(before);
  });
  it('TC07: unlinked member persists source event and zero recipients; linked offline member can REST sync once', async () => {
    const unlinked = await fixture({ linked: false }), linked = await fixture();
    expect((await prepare(unlinked.id).expect(200)).body.notificationState).toBe('NO_LINKED_ACCOUNT'); await prepare(linked.id).expect(200);
    expect(await db().collection('notifications').countDocuments()).toBe(2); expect(await db().collection('notification_recipients').countDocuments()).toBe(1);
    const response = await http().get('/api/notifications/sync').set('Authorization', `Bearer ${member.token}`).expect(200);
    expect(response.body.items).toHaveLength(1); expect(response.body.items[0].eventKey).toBe(`ORDER_CONFIRMED:${linked.id}`);
    expect(JSON.stringify(response.body)).not.toMatch(/84901234567|Người nhận snapshot|SECRET_TEST_REFERENCE/);
  });
  it('TC10: 10 rounds × 20 identical keys over two processes replay exactly one committed prepare/event', async () => {
    for (let round = 0; round < 10; round++) {
      const row = await fixture(), key = randomUUID();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => prepare(row.id, 0, key, staff, (i + round) % 2)));
      expect(results.map(result => result.status)).toEqual(Array(20).fill(200));
      for (const result of results) expect(result.body).toEqual(results[0].body);
      expect(await db().collection('order_events').countDocuments({ order_id: row.orderId })).toBe(1);
      expect(await db().collection('operation_requests').countDocuments({ client_key: key })).toBe(1);
    }
  }, 180000);
  it('TC10: 10 rounds, two different keys yield one success and ORDER_ALREADY_CONFIRMED with current ID/version', async () => {
    for (let round = 0; round < 10; round++) {
      const row = await fixture();
      const results = await Promise.all([prepare(row.id, 0, randomUUID(), staff, round % 2), prepare(row.id, 0, randomUUID(), staff, (round + 1) % 2)]);
      expect(results.map(result => result.status).sort()).toEqual([200, 409]);
      expect(results.find(result => result.status === 409)!.body.error).toMatchObject({ code: 'ORDER_ALREADY_CONFIRMED', details: [{ field: 'id', message: row.id }, { field: 'version', message: '1' }] });
      expect(await db().collection('order_events').countDocuments({ order_id: row.orderId })).toBe(1);
    }
  }, 180000);
  it('TC09 subset: paused prepare rechecks concurrent fixture cancellation/version change and lock-time clock; no fake cancel/payment writer', async () => {
    for (const change of ['cancel', 'version', 'deadline', 'retry']) {
      const row = await fixture(); await children[0].arm('guard', change === 'retry' ? 'retry' : 'pause', row.expires.toISOString());
      const pending = prepare(row.id, 0, randomUUID(), staff, 0).then(result => result);
      await children[0].hit('guard');
      if (change === 'deadline') await children[0].rpc('clock', row.expires.toISOString());
      else if (change !== 'retry') await db().collection('orders').updateOne({ _id: row.orderId }, { $set: change === 'cancel' ? { status: 'CANCELLED', reservation_state: 'RELEASED' } : {}, $inc: { guard_revision: Long.ONE, version: 1 } });
      await children[0].rpc('release');
      const result = await pending; expect(result.status).toBe(409);
      expect(result.body.error.code).toBe(change === 'cancel' ? 'INVALID_ORDER_STATE' : change === 'version' ? 'VERSION_CONFLICT' : 'RESERVATION_EXPIRED');
      expect(await db().collection('order_events').countDocuments({ order_id: row.orderId })).toBe(0);
      await children[0].rpc('clock', NOW);
    }
  });
  it('TC11: lost response resolves by actor key; changed version/target conflicts; revoked replay/lookup denied', async () => {
    const row = await fixture(), key = randomUUID(); await children[0].arm('response');
    await prepare(row.id, 0, key, staff, 0).then(() => { throw new Error('Response should be lost'); }, () => undefined);
    const lookup = await http().get(`/api/operations/ORDER_PREPARE/${key}`).set('Authorization', `Bearer ${staff.token}`).expect(200);
    expect((await prepare(row.id, 0, key).expect(200)).body).toEqual(lookup.body.responseBody);
    expect((await prepare(row.id, 1, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const other = await fixture(); expect((await prepare(other.id, 0, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    await http().get(`/api/operations/ORDER_PREPARE/${key}`).set('Authorization', `Bearer ${admin.token}`).expect(404);
    const temp = await login('STAFF'), tempKey = randomUUID(); await prepare(other.id, 0, tempKey, temp).expect(200);
    await http().post('/api/auth/logout').set('Authorization', `Bearer ${temp.token}`).set('Origin', origin).send({}).expect(204);
    await prepare(other.id, 0, tempKey, temp).expect(401); await http().get(`/api/operations/ORDER_PREPARE/${tempKey}`).set('Authorization', `Bearer ${temp.token}`).expect(401);
  });
  it('TC12: VN inclusive dates, stable ID ordering, transaction filter, literal q, pagination and empty totalPages', async () => {
    const a = await fixture({ paid: true }), b = await fixture();
    const result = await get('?fromDate=2035-11-15&toDate=2035-11-15&channel=WEBSITE&status=PENDING&limit=1').expect(200);
    expect(result.body).toMatchObject({ total: 2, page: 1, limit: 1, totalPages: 2 }); expect(result.body.items[0].id).toBe(b.id);
    expect((await get('?transactionStatus=SETTLED').expect(200)).body.items.map((row: { id: string }) => row.id)).toEqual([a.id]);
    expect((await get(`?memberId=${a.memberId}`).expect(200)).body.total).toBe(2);
    expect((await get(`?memberId=${new ObjectId()}`).expect(200)).body.total).toBe(0);
    expect((await get('?q=.*').expect(200)).body).toMatchObject({ items: [], total: 0, totalPages: 0 });
    expect((await get('?fromDate=2035-11-14&toDate=2035-11-14').expect(200)).body.total).toBe(0);
  });
  it('schema/index preflight preserves historical values and rejects invalid revision/orphan without repair', async () => {
    const row = await fixture(), before = await snapshot(); await ensureOrdersIntegrity(connection); expect(await snapshot()).toEqual(before);
    await db().collection('orders').updateOne({ _id: row.orderId }, { $unset: { guard_revision: '' } });
    await expect(ensureOrdersIntegrity(connection)).rejects.toThrow('ORDERS_REVISION_RECONCILIATION_REQUIRED');
    await db().collection('orders').deleteOne({ _id: row.orderId }); await expect(ensureOrdersIntegrity(connection)).rejects.toThrow('ORDER_ITEMS_ORPHAN_RECONCILIATION_REQUIRED');
  });
});
