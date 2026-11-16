import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Int32, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { REQUIRED_ROLES } from '../src/modules/auth/auth.decorators';
import { ensureRetailCatalogIntegrity } from '../src/modules/catalog/retail-catalog.migration';
import { InventoryWriter } from '../src/modules/inventory/inventory-writer';
import { reconcileInventory } from '../src/modules/inventory/inventory-reconciliation';
import { StockReceiptsController } from '../src/modules/stock/stock-receipts.controller';
import { UsersRepository } from '../src/modules/users/users.repository';

type Actor = { id: string; token: string };
describe('US-37 AC01–03: snapshot queries, source permissions, S05-I01 and reconciliation on a real replica set', () => {
  let app: INestApplication, mongo: MongoMemoryReplSet, connection: Connection, admin: Actor, staff: Actor;
  let product: string, category: string, counter = 0;
  const saved = { ...process.env }, origin = 'http://localhost:5173';
  const db = () => connection.db!, http = () => request(app.getHttpServer());
  const get = (path: string, actor = staff) => http().get(`/api${path}`).set('Authorization', `Bearer ${actor.token}`);
  const cli = () => promisify(execFile)(process.execPath, ['scripts/admin.cjs', 'reconcile-inventory'], { cwd: process.cwd(), env: process.env, timeout: 20000 });
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_test_us37', FRONTEND_ORIGIN: origin,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'no-reply@gym.test' });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false }); configureHttp(app); await app.init();
    connection = app.get(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = new LoginLimiter(); jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await db().collections()) if (collection.collectionName !== 'roles') await collection.deleteMany({});
    await ensureRetailCatalogIntegrity(connection);
    admin = await login('ADMIN'); staff = await login('STAFF');
    category = (await http().post('/api/admin/categories').set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID())
      .send({ name: 'Nước', status: 'ACTIVE' }).expect(201)).body.id as string;
    product = (await http().post('/api/admin/products').set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID())
      .send({ categoryId: category, sku: 'WATER', name: 'Nước lọc', status: 'ACTIVE', price: '9000' }).expect(201)).body.id as string;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = saved; });
  async function login(code: 'STAFF' | 'ADMIN' | 'MEMBER' | 'TRAINER'): Promise<Actor> {
    const users = app.get(UsersRepository), role = await users.ensureRole(code, code), password = 'US37 test password 123';
    const account = await users.createAccount({ roleId: String(role.id), fullName: `US37 ${code}`, phone: `093370${String(++counter).padStart(4, '0')}`,
      passwordHash: await app.get(PasswordService).hash(password) });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
    return { id: String(account._id), token: response.body.accessToken as string };
  }
  const balance = () => db().collection('inventory').findOne({ product_id: new ObjectId(product) });
  async function receipt(quantity = 10) {
    return (await http().post('/api/stock-receipts').set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID())
      .send({ reason: 'Nhập hàng theo chứng từ nguồn', items: [{ productId: product, quantity, unitCost: '5000' }] }).expect(201)).body as { id: string; code: string; items: { id: string }[] };
  }
  const post = (id: string) => http().post(`/api/stock-receipts/${id}/post`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0 });
  async function fixture(kind: string, handDelta: number, reservedDelta: number, eventKey?: string) {
    return app.get(TransactionRunner).run(async session => {
      const writer = app.get(InventoryWriter), locked = await writer.lock([product], session), item = new Types.ObjectId();
      return writer.apply(locked.get(product)!, { product_id: new Types.ObjectId(product), order_item_id: item, source_id: item, source_type: 'ORDER', source_code: 'FIXTURE_ORDER',
        actor_id: new Types.ObjectId(staff.id), event_key: eventKey ?? `${kind}:${item}`, kind, on_hand_delta: handDelta, reserved_delta: reservedDelta,
        sku_snapshot: 'WATER', name_snapshot: 'Nước lọc', created_at: app.get(ServerClock).now() }, session);
    });
  }
  it('TC01/02: reads real reserved, ignores carts, includes inactive SKU/category and never exposes costs/guards', async () => {
    await post((await receipt()).id).expect(200); await fixture('ORDER_RESERVE', 0, 3);
    await db().collection('carts').insertOne({ product_id: new ObjectId(product), quantity: 7 });
    await db().collection('categories').updateOne({ _id: new ObjectId(category) }, { $set: { status: 'INACTIVE' } });
    await db().collection('products').updateOne({ _id: new ObjectId(product) }, { $set: { status: 'INACTIVE' } });
    const result = await get(`/inventory?productStatus=INACTIVE&categoryId=${category}&stockState=IN_STOCK`).expect(200);
    expect(result.body).toMatchObject({ total: 1, items: [{ productId: product, productStatus: 'INACTIVE', effectiveActive: false, onHand: 10, reserved: 3, available: 7, version: 2 }] });
    expect(JSON.stringify(result.body)).not.toMatch(/cost|price|guard|unit_cost/i);
    const detail = await get(`/inventory/${product}`, admin).expect(200); expect(detail.body.available).toBe(7);
  });
  it('TC03: rejects anonymous/Member/PT, stale sessions and changed roles on every read route', async () => {
    const movementId = new ObjectId();
    for (const path of ['/inventory', `/inventory/${product}`, `/inventory/${product}/movements`, `/stock-movements/${movementId}`, '/inventory/product-options']) {
      await http().get(`/api${path}`).expect(401);
      for (const role of ['MEMBER', 'TRAINER'] as const) await get(path, await login(role)).expect(403);
    }
    await db().collection('accounts').updateOne({ _id: new ObjectId(staff.id) }, { $inc: { auth_version: 1 } });
    await get('/inventory').expect(401);
    const actor = await login('STAFF'), memberRole = await app.get(UsersRepository).ensureRole('MEMBER', 'Member');
    await db().collection('accounts').updateOne({ _id: new ObjectId(actor.id) }, { $set: { role_id: memberRole._id } });
    await get('/inventory', actor).expect(403);
  });
  it('TC04/10: missing/invalid balances stay visible as errors, null available; GET never repairs data', async () => {
    await db().collection('inventory').deleteOne({ product_id: new ObjectId(product) });
    expect((await get(`/inventory/${product}`).expect(200)).body).toMatchObject({ inventoryState: 'MISSING', onHand: null, reserved: null, available: null, version: null });
    expect((await get('/inventory?stockState=ERROR').expect(200)).body.total).toBe(1);
    expect((await get('/inventory?stockState=OUT_OF_STOCK').expect(200)).body.total).toBe(0);
    const before = await db().collection('inventory').countDocuments(); await get('/inventory').expect(200); expect(await db().collection('inventory').countDocuments()).toBe(before);
    const good = { product_id: new ObjectId(product), on_hand: new Int32(1), reserved: new Int32(2), version: new Int32(0) };
    for (const bad of [good, { ...good, on_hand: new Int32(-1) }, { ...good, reserved: -0.5 }, { ...good, reserved: 'wrong' }]) {
      await db().collection('inventory').deleteMany({}); await db().collection('inventory').insertOne(bad);
      const stored = await balance();
      expect((await get(`/inventory/${product}`).expect(200)).body).toMatchObject({ inventoryState: 'INCONSISTENT', available: null });
      expect((await get('/inventory?stockState=ERROR').expect(200)).body.total).toBe(1);
      expect(await balance()).toEqual(stored);
    }
    await get(`/inventory/${new ObjectId()}`).expect(404); await get(`/inventory/${new ObjectId()}/movements`).expect(404);
  });
  it('TC05/06/10: no fabricated opening or draft movements, immutable snapshots and allowlisted POSTED source', async () => {
    const row = await receipt();
    expect((await get(`/inventory/${product}/movements`).expect(200)).body).toMatchObject({ items: [], total: 0, totalPages: 0 });
    await post(row.id).expect(200);
    await db().collection('products').updateOne({ _id: new ObjectId(product) }, { $set: { name: 'Tên mới' } });
    const result = (await get(`/inventory/${product}/movements`).expect(200)).body;
    expect(result.items).toHaveLength(1); expect(result.items[0]).toMatchObject({ sequence: 1, nameSnapshot: 'Nước lọc', sourceType: 'STOCK_RECEIPT', sourceId: row.id, sourceCode: row.code, sourcePath: `/stock-receipts/${row.id}`, beforeOnHand: 0, afterOnHand: 10 });
    const detail = await get(`/stock-movements/${result.items[0].id}`).expect(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/cost|price|actor|event_key|guard/i);
    await get(`/stock-movements/${new ObjectId()}`).expect(404);
    await db().collection('stock_document_items').deleteMany({});
    expect((await get(`/stock-movements/${result.items[0].id}`).expect(200)).body.sourcePath).toBeNull();
  });
  it('TC07/13: two concurrent receipts serialize continuous sequence, sum and final balance; report is read-only', async () => {
    const first = await receipt(10), second = await receipt(5);
    const results = await Promise.all([post(first.id), post(second.id)]); results.forEach(result => expect(result.status).toBe(200));
    const rows = (await get(`/inventory/${product}/movements`).expect(200)).body.items;
    expect(rows.map((row: { sequence: number }) => row.sequence)).toEqual([1, 2]);
    expect(rows[1].beforeOnHand).toBe(rows[0].afterOnHand); expect(rows[1].afterOnHand).toBe(15);
    const before = await balance(), report = await reconcileInventory(connection, app.get(TransactionRunner));
    expect(report).toEqual({ checked: 1, consistent: true, issues: [] }); expect(await balance()).toEqual(before);
    const result = await cli(); expect(result.stdout).toContain('"consistent":true'); expect(result.stdout).not.toMatch(/password|secret|mongodb:\/\//i);
    expect(await balance()).toEqual(before);
  });
  it('TC08: inventory-only policy fixture sees warehouse metadata while the source endpoint still denies costs', async () => {
    const row = await receipt(); await post(row.id).expect(200);
    // Repository uses fixed RBAC. Simulate stockReceipts.manage limited to ADMIN, independently of inventory.read.
    const previous = Reflect.getMetadata(REQUIRED_ROLES, StockReceiptsController) as unknown;
    Reflect.defineMetadata(REQUIRED_ROLES, ['ADMIN'], StockReceiptsController);
    try {
      expect((await get(`/inventory/${product}/movements`).expect(200)).body.items[0].sourceCode).toBe(row.code);
      await get(`/stock-receipts/${row.id}`).expect(403);
      await get(`/stock-receipts/${row.id}`, admin).expect(200);
    } finally { Reflect.defineMetadata(REQUIRED_ROLES, previous, StockReceiptsController); }
  });
  it('TC09: Vietnam half-open boundaries, historical range, kind filter and page2 preserve stored before balances', async () => {
    for (const quantity of [2, 3, 4, 5]) await post((await receipt(quantity)).id).expect(200);
    const rows = await db().collection('stock_movements').find({}).sort({ sequence: 1 }).toArray();
    const times = ['2026-10-31T16:59:59.999Z', '2026-10-31T17:00:00Z', '2026-11-01T16:59:59.999Z', '2026-11-01T17:00:00Z'];
    for (let i = 0; i < 4; i++) await db().collection('stock_movements').updateOne({ _id: rows[i]._id }, { $set: { created_at: new Date(times[i]) } });
    const page = (await get(`/inventory/${product}/movements?fromDate=2026-11-01&toDate=2026-11-01&limit=1&page=2&kind=RECEIPT_POST`).expect(200)).body;
    expect(page).toMatchObject({ total: 2, totalPages: 2, range: { fromDate: '2026-11-01', toDate: '2026-11-01' }, items: [{ sequence: 3, beforeOnHand: 5, afterOnHand: 9 }] });
    expect((await get(`/inventory/${product}`).expect(200)).body.onHand).toBe(14);
    const empty = await get(`/inventory/${product}/movements?fromDate=2020-01-01&toDate=2020-01-30`).expect(200); expect(empty.body.totalPages).toBe(0);
    jest.spyOn(ServerClock.prototype, 'today').mockReturnValue('2026-11-15');
    expect((await get(`/inventory/${product}/movements`).expect(200)).body.range).toMatchObject({ fromDate: '2026-10-17', toDate: '2026-11-15' });
  });
  it('TC11: a receipt committed between count/items still returns one snapshot for history and source lookups', async () => {
    await post((await receipt()).id).expect(200); const row = await receipt(5);
    let injected = false;
    // Hook the session's first history read, then commit a real write outside that read transaction.
    const dbOriginal = connection.db!.collection.bind(connection.db!);
    const spy = jest.spyOn(connection.db!, 'collection').mockImplementation((...args: Parameters<typeof dbOriginal>) => {
      const collection = dbOriginal(...args);
      if (args[0] === 'stock_movements') {
        const count = collection.countDocuments.bind(collection);
        collection.countDocuments = (async (...countArgs: Parameters<typeof count>) => {
          const total = await count(...countArgs);
          if (!injected && countArgs[1]?.session) { injected = true; await post(row.id).expect(200); }
          return total;
        }) as typeof collection.countDocuments;
      }
      return collection;
    });
    try {
      const result = (await get(`/inventory/${product}/movements`).expect(200)).body;
      expect(injected).toBe(true); expect(result.total).toBe(1); expect(result.items).toHaveLength(1); expect(result.items[0].afterOnHand).toBe(10);
    } finally { spy.mockRestore(); }
    expect((await get(`/inventory/${product}`).expect(200)).body).toMatchObject({ onHand: 15, version: 2 });
  });
  it('TC12: future reserve/handover/cancel fixtures use real writer; duplicate event/failure roll back balance, version, guard and ledger', async () => {
    await post((await receipt()).id).expect(200);
    await fixture('ORDER_RESERVE', 0, 5); await fixture('ORDER_HANDOVER', -2, -2); await fixture('ORDER_CANCEL', 0, -3);
    expect((await get(`/inventory/${product}`).expect(200)).body).toMatchObject({ onHand: 8, reserved: 0, available: 8, version: 4 });
    const before = await balance(), count = await db().collection('stock_movements').countDocuments();
    const writer = app.get(InventoryWriter), insert = writer.insertMovement.bind(writer);
    const spy = jest.spyOn(writer, 'insertMovement').mockImplementation(async (...args) => { await insert(...args); throw new Error('FAIL_LEDGER'); });
    await expect(fixture('ORDER_RESERVE', 0, 1)).rejects.toThrow('FAIL_LEDGER'); spy.mockRestore();
    expect(await balance()).toEqual(before); expect(await db().collection('stock_movements').countDocuments()).toBe(count);
    await expect(fixture('ORDER_CANCEL', 0, -1)).rejects.toMatchObject({ code: 'INVENTORY_INTEGRITY_ERROR' });
    await expect(fixture('NO_CHANGE', 0, 0)).rejects.toMatchObject({ code: 'INVENTORY_INTEGRITY_ERROR' });
    expect(await balance()).toEqual(before);
    const existing = await db().collection('stock_movements').findOne({ kind: 'ORDER_RESERVE' });
    await expect(fixture('ORDER_RESERVE', 0, 1, existing!.event_key as string)).rejects.toMatchObject({ code: 11000 });
    expect(await balance()).toEqual(before); expect(await db().collection('stock_movements').countDocuments()).toBe(count);
    await db().collection('inventory').updateOne({ product_id: new ObjectId(product) }, { $set: { version: new Int32(2147483647) } });
    expect((await post((await receipt(1)).id).expect(409)).body.error.code).toBe('STOCK_LIMIT_EXCEEDED');
  });
  it('TC13: legacy nonzero stock and broken chains block writes without fabricated backfill; reconciled evidence reopens writer', async () => {
    await db().collection('inventory').updateOne({ product_id: new ObjectId(product) }, { $set: { on_hand: new Int32(4) } });
    const row = await receipt(), before = await balance();
    expect((await reconcileInventory(connection, app.get(TransactionRunner))).issues[0].codes).toContain('BALANCE_LEDGER_MISMATCH');
    await post(row.id).expect(409); expect(await balance()).toEqual(before); expect(await db().collection('stock_movements').countDocuments()).toBe(0);
    await expect(cli()).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('BALANCE_LEDGER_MISMATCH') });
    // Explicit fixture restoration, not an automated production backfill or a fake receipt.
    await db().collection('inventory').updateOne({ product_id: new ObjectId(product) }, { $set: { on_hand: new Int32(0) } });
    await post(row.id).expect(200);
    await db().collection('stock_movements').updateOne({}, { $set: { before_on_hand: new Int32(1) } });
    const next = await receipt(1); await post(next.id).expect(409);
    expect((await reconcileInventory(connection, app.get(TransactionRunner))).issues[0].codes).toContain('BROKEN_CHAIN');
  });
  it('I01/TC12: balances locked in an earlier transaction cannot bypass the lock in a reused session', async () => {
    await post((await receipt()).id).expect(200);
    const writer = app.get(InventoryWriter), session = await connection.startSession();
    try {
      await expect(writer.lock([product], session)).rejects.toThrow('INVENTORY_TRANSACTION_REQUIRED');
      session.startTransaction();
      const locked = (await writer.lock([product], session)).get(product)!;
      await session.commitTransaction();
      const before = await balance(), item = new Types.ObjectId();
      session.startTransaction();
      await expect(writer.apply(locked, { product_id: new Types.ObjectId(product), source_id: item, order_item_id: item,
        actor_id: new Types.ObjectId(staff.id), event_key: `ORDER_RESERVE:${item}`, kind: 'ORDER_RESERVE', on_hand_delta: 0, reserved_delta: 1,
        sku_snapshot: 'WATER', name_snapshot: 'Nước lọc', created_at: new Date() }, session)).rejects.toMatchObject({ code: 'INVENTORY_INTEGRITY_ERROR' });
      await session.abortTransaction();
      expect(await balance()).toEqual(before); expect(await db().collection('stock_movements').countDocuments()).toBe(1);
    } finally { if (session.inTransaction()) await session.abortTransaction(); await session.endSession(); }
  });
  it('TC14: static picker precedes product id, strict query validation and literal search; stable empty/pagination contracts', async () => {
    await get('/inventory/product-options').expect(200);
    expect((await get('/inventory?q=.%2A').expect(200)).body).toMatchObject({ items: [], total: 0, totalPages: 0 });
    expect((await get('/inventory?stockState=OUT_OF_STOCK').expect(200)).body.total).toBe(1);
    expect((await get('/inventory?page=2&limit=1').expect(200)).body).toMatchObject({ items: [], total: 1, totalPages: 1 });
    for (const query of ['foo=bar', 'page=0', 'page=1.5', 'limit=101', 'categoryId=wrong', 'productStatus=BAD', 'stockState=BAD', `q=${'a'.repeat(121)}`]) await get(`/inventory?${query}`).expect(400);
    for (const query of ['q=notAllowed', 'fromDate=2026-02-30', 'fromDate=2024-01-01&toDate=2026-01-01', 'fromDate=2026-02-02&toDate=2026-01-01', 'kind=bad-kind', 'sort=createdAt']) await get(`/inventory/${product}/movements?${query}`).expect(400);
    await get(`/inventory/${product}?ignored=1`).expect(400); await get('/inventory/not-an-id').expect(400);
  });
});
