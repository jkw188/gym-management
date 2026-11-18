// Process races use scripts/en05-app.cjs and dist, like the existing EN-05 harness. Run npm run build first.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Int32, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { configureHttp } from '../src/common/http/configure-http';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { ensureRetailCatalogIntegrity } from '../src/modules/catalog/retail-catalog.migration';
import { InventoryWriter } from '../src/modules/inventory/inventory-writer';
import { OperationRequestsRepository } from '../src/modules/operations/operation-requests.repository';
import { StockRepository } from '../src/modules/stock/stock.repository';
import { UsersRepository } from '../src/modules/users/users.repository';
import { AppProcess } from './helpers/en05-fixture';

type Actor = { id: string; token: string };
const base = '/api/stock-adjustments', origin = 'http://localhost:5173';
describe('US-39 AC01–03: real replica set, HTTP, rollback, two processes and ledger reconciliation', () => {
  let mongo: MongoMemoryReplSet, connection: Connection, admin: Actor, staff: Actor;
  let products: string[], categoryId: string, sequence = 0;
  const apps: INestApplication[] = [], processes: AppProcess[] = [], saved = { ...process.env };
  const db = () => connection.db!, http = (index = 0) => request(apps[index].getHttpServer());
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_test_us39', FRONTEND_ORIGIN: origin,
      EN05_NOW: new Date().toISOString(), JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      RETAIL_QUOTE_SECRET: randomBytes(32).toString('base64url'), PICKUP_LOCATION: 'Quầy kiểm thử US39',
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'no-reply@gym.test' });
    const { AppModule } = await import('../src/app.module');
    for (let i = 0; i < 2; i++) {
      const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
      apps.push(app); configureHttp(app); await app.init();
      await Promise.all(Object.values(app.get<Connection>(getConnectionToken()).models).map(model => model.init()));
    }
    connection = apps[0].get<Connection>(getConnectionToken());
    for (let i = 0; i < 2; i++) { const process = new AppProcess(); processes.push(process); await process.start(); }
    expect(new Set(processes.map(app => app.child.pid)).size).toBe(2);
  }, 600000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const app of apps) { const limiter = new LoginLimiter(); jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter)); }
    for (const collection of await db().collections()) if (collection.collectionName !== 'roles') await collection.deleteMany({});
    await ensureRetailCatalogIntegrity(connection);
    admin = await login('ADMIN'); staff = await login('STAFF');
    categoryId = (await catalog('categories', { name: 'US39 hàng thực nhận', status: 'ACTIVE' })).body.id as string;
    products = [];
    for (let i = 0; i < 2; i++) products.push((await catalog('products', { categoryId, sku: `SKU_${i}`, name: `Hàng ${i}`, status: 'ACTIVE', price: '9000' })).body.id as string);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { for (const app of processes) await app.close(); for (const app of apps) await app.close(); await mongo?.stop(); process.env = saved; });
  async function login(code: 'ADMIN' | 'STAFF' | 'MEMBER' | 'TRAINER'): Promise<Actor> {
    const users = apps[0].get(UsersRepository), role = await users.ensureRole(code, code), password = 'US39 test password 123';
    const account = await users.createAccount({ roleId: String(role.id), fullName: `US39 ${code}`, phone: `093360${String(++sequence).padStart(4, '0')}`,
      passwordHash: await apps[0].get(PasswordService).hash(password) });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
    return { id: String(account._id), token: response.body.accessToken as string };
  }
  const catalog = (kind: string, input: object) => http().post(`/api/admin/${kind}`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send(input).expect(201);
  const input = () => ({ reason: ' Kiểm kê thực tế theo biên bản ', sourceReference: ' SOURCE_39 ',
    items: products.map((productId, i) => ({ productId, countedQuantity: i ? 12 : 8, expectedInventoryVersion: 1, unitCost: i ? '0' : '005000' })) });
  const create = (body: object = input(), key: string = randomUUID(), actor = admin) => http().post(base).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send(body);
  const get = (path = '', actor = admin) => http().get(`${base}${path}`).set('Authorization', `Bearer ${actor.token}`);
  const update = (id: string, body: object, key = randomUUID(), index = 0) => http(index).patch(`${base}/${id}`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', key).send(body);
  const post = (id: string, version = 0, key = randomUUID(), index = 0) => http(index).post(`${base}/${id}/post`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', key).send({ version });
  const balance = (id: string) => db().collection('inventory').findOne({ product_id: new ObjectId(id) });
  async function processPost(index: number, id: string, key = randomUUID()) {
    return request(processes[index].url).post(`${base}/${id}/post`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', key).send({ version: 0 });
  }
  async function countStock() {
    const result: Record<string, number> = {};
    for (const name of ['stock_documents', 'stock_document_items', 'stock_document_events', 'stock_movements', 'operation_requests']) result[name] = await db().collection(name).countDocuments();
    return result;
  }

  async function receive(quantity = 10) {
    const result = await http().post('/api/stock-receipts').set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID())
      .send({ reason: 'Nhập hàng kiểm thử US39, không phải hàng thật', items: products.map(productId => ({ productId, quantity, unitCost: '1000' })) }).expect(201);
    await http().post(`/api/stock-receipts/${result.body.id}/post`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0 }).expect(200);
    return result.body.id as string;
  }
  async function posIntent(quantity: number) {
    const intent = { preferredPaymentMethod: 'CASH', items: [{ productId: products[0], quantity }] };
    const preview = await http().post('/api/pos/orders/preview').set('Authorization', `Bearer ${admin.token}`).send(intent).expect(200);
    return { ...intent, quoteToken: preview.body.quoteToken as string };
  }
  async function oracle() {
    const { inspectInventoryLedger } = await import('../src/modules/inventory/inventory-reconciliation');
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        for (const productId of products) {
          const row = (await balance(productId))!;
          expect(await inspectInventoryLedger(db(), { product_id: new ObjectId(productId), on_hand: row.on_hand as number, reserved: row.reserved as number, version: row.version as number }, session)).toEqual([]);
        }
      });
    } finally { await session.endSession(); }
  }

  it('TC01/04/12: server snapshot, signed preview, full replacement, exact costs, inactive picker and audit; GET never rebases', async () => {
    await receive();
    await db().collection('products').updateOne({ _id: new ObjectId(products[0]) }, { $set: { status: 'INACTIVE' } });
    const before = [await balance(products[0]), await balance(products[1])], movements = await db().collection('stock_movements').countDocuments();
    const body = { ...input(), items: [{ ...input().items[0], countedQuantity: 12 }] };
    const row = (await create(body).expect(201)).body;
    expect(row).toMatchObject({ code: `ADJ-${row.id}`, version: 0, status: 'DRAFT', totalCost: '10000', stale: false });
    expect(row.items[0]).toMatchObject({ baseOnHand: 10, baseInventoryVersion: 1, countedQuantity: 12, quantityDelta: 2, currentReserved: 0, inactiveWarning: true });
    expect(new Date(row.items[0].countedAt).toISOString()).toBe(row.createdAt);
    const updated = (await update(row.id, { ...body, version: 0, items: [{ ...body.items[0], countedQuantity: 9 }] }).expect(200)).body;
    expect(updated).toMatchObject({ version: 1, totalCost: '5000' }); expect(updated.items[0].quantityDelta).toBe(-1);
    const detail = (await get(`/${row.id}`).expect(200)).body;
    expect(detail.audit).toHaveLength(2); expect(detail.audit[1]).toMatchObject({ action: 'UPDATED', before: { version: 0 }, after: { version: 1 } });
    const after = [await balance(products[0]), await balance(products[1])];
    for (let i = 0; i < 2; i++) expect(after[i]).toMatchObject({ on_hand: before[i]!.on_hand, reserved: 0, version: 1, updated_at: before[i]!.updated_at });
    expect(await db().collection('stock_movements').countDocuments()).toBe(movements);
    expect((await get('?q=SOURCE_39').expect(200)).body.total).toBe(1);
    const [types] = await db().collection('stock_document_items').aggregate([{ $match: { document_id: new ObjectId(row.id) } },
      { $project: { count: { $type: '$counted_quantity' }, base: { $type: '$base_on_hand' }, version: { $type: '$base_inventory_version' }, cost: { $type: '$unit_cost' } } }]).toArray();
    expect(types).toMatchObject({ count: 'int', base: 'int', version: 'int', cost: 'decimal' });
    const picker = await http().get('/api/inventory/product-options').set('Authorization', `Bearer ${admin.token}`).expect(200);
    expect(picker.body.items.find((item: { id: string }) => item.id === products[0])).toMatchObject({ effectiveActive: false, inventoryState: 'VALID' });
    await http().get(`/api/stock-issues/${row.id}`).set('Authorization', `Bearer ${admin.token}`).expect(404);
  });

  it('TC02: current auth on read/write/replay/lookup, all non-admin roles, revoked session', async () => {
    await receive(); await http().get(base).expect(401);
    const key = randomUUID(), row = (await create(input(), key).expect(201)).body;
    for (const actor of [staff, await login('TRAINER'), await login('MEMBER')]) {
      await get('', actor).expect(403); await get(`/${row.id}`, actor).expect(403); await create(input(), key, actor).expect(403);
      await http().patch(`${base}/${row.id}`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', randomUUID()).send({ ...input(), version: 0 }).expect(403);
      await http().post(`${base}/${row.id}/post`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0 }).expect(403);
      await http().get(`/api/operations/STOCK_ADJUST_CREATE/${key}`).set('Authorization', `Bearer ${actor.token}`).expect(403);
    }
    const role = await apps[0].get(UsersRepository).ensureRole('STAFF', 'STAFF');
    await db().collection('accounts').updateOne({ _id: new ObjectId(admin.id) }, { $set: { role_id: role._id } });
    await create(input(), key).expect(403);
    await db().collection('accounts').updateOne({ _id: new ObjectId(admin.id) }, { $inc: { auth_version: 1 } });
    await create(input(), key).expect(401);
  });

  it('TC02: strict Int32 counts/versions, distinct SKU, money, IDs, filters and OpenAPI', async () => {
    await receive(); const before = await countStock();
    for (const countedQuantity of [-1, 1.5, 2147483648, '1', null]) await create({ ...input(), items: [{ ...input().items[0], countedQuantity }] }).expect(400);
    for (const expectedInventoryVersion of [-1, 0.5, 2147483648, '1', null, undefined]) await create({ ...input(), items: [{ ...input().items[0], expectedInventoryVersion }] }).expect(400);
    for (const unitCost of ['-1', '1.5', '1e3', '1000000000000', 1]) await create({ ...input(), items: [{ ...input().items[0], unitCost }] }).expect(400);
    for (const change of [{ reason: 'short' }, { items: [] }, { items: [input().items[0], input().items[0]] }, { postedAt: new Date().toISOString() },
      { items: [{ ...input().items[0], baseOnHand: 10 }] }, { items: Array.from({ length: 101 }, () => input().items[0]) }]) await create({ ...input(), ...change }).expect(400);
    await create({ ...input(), items: [{ ...input().items[0], countedQuantity: 12, unitCost: '999999999999' }] }).expect(400);
    await create(input(), 'invalid').expect(400);
    for (const query of ['?status=BAD', '?page=1.5', '?limit=101', '?fromDate=2026-02-30', '?fromDate=2024-01-01&toDate=2026-01-01', '?ownerId=x']) await get(query).expect(400);
    await get('/bad').expect(400); await get(`/${new ObjectId()}`).expect(404);
    expect(await countStock()).toEqual(before);
    const schema = (await http().get('/api/docs-json').expect(200)).body;
    expect(schema.paths[`${base}/{id}`].patch).toBeDefined();
    expect(schema.components.schemas.AdjustmentItemDto.properties.countedQuantity).toMatchObject({ minimum: 0, maximum: 2147483647 });
  });

  it('TC03/04: reserved-only movement stales draft; explicit recount verifies new version, preserves reservations and commits signed delta', async () => {
    await receive(); const row = (await create().expect(201)).body;
    const intent = await posIntent(3);
    await http().post('/api/pos/orders').set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send(intent).expect(201);
    const counts = await countStock(), balances = [await balance(products[0]), await balance(products[1])];
    expect((await post(row.id).expect(409)).body.error.code).toBe('COUNT_SNAPSHOT_STALE');
    const detail = (await get(`/${row.id}`).expect(200)).body;
    expect(detail).toMatchObject({ stale: true, version: 0 });
    expect(detail.items[0]).toMatchObject({ baseOnHand: 10, baseInventoryVersion: 1, countedQuantity: 8, currentOnHand: 10, currentReserved: 3, currentInventoryVersion: 2, stale: true });
    expect(await countStock()).toEqual(counts); expect([await balance(products[0]), await balance(products[1])]).toEqual(balances);
    expect((await update(row.id, { ...input(), version: 0 }).expect(409)).body.error.code).toBe('COUNT_SNAPSHOT_STALE');
    await update(row.id, { ...input(), version: 0, items: [{ ...input().items[0], expectedInventoryVersion: 2 }] }).expect(200);
    await post(row.id, 1).expect(200);
    expect(await balance(products[0])).toMatchObject({ on_hand: 8, reserved: 3, version: 3 }); await oracle();
  });

  it('TC03: receipt and fulfillment movements invalidate old snapshots even if reserved is released', async () => {
    await receive(); const row = (await create().expect(201)).body; await receive(1);
    expect((await post(row.id).expect(409)).body.error.code).toBe('COUNT_SNAPSHOT_STALE');
    const intent = await posIntent(2);
    const order = (await http().post('/api/pos/orders').set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send(intent).expect(201)).body;
    const version = (await balance(products[0]))!.version as number;
    const counted = (await create({ ...input(), items: [{ ...input().items[0], expectedInventoryVersion: version }] }).expect(201)).body;
    await http().post(`/api/transactions/${order.transactionId}/confirm-payment`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ method: 'CASH', amount: '18000', evidenceNote: 'Cash counted for US39 fixture' }).expect(200);
    const orderVersion = (await http().get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${admin.token}`).expect(200)).body.version as number;
    await http().post(`/api/pos/orders/${order.id}/fulfill`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ version: orderVersion }).expect(200);
    expect((await post(counted.id).expect(409)).body.error.code).toBe('COUNT_SNAPSHOT_STALE'); await oracle();
  });

  it('TC05/06: count below reserved is rejected, valid negative adjustment never changes orders or reserved', async () => {
    await receive(); const intent = await posIntent(3);
    const order = (await http().post('/api/pos/orders').set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send(intent).expect(201)).body;
    const row = (await create({ ...input(), items: [{ ...input().items[0], expectedInventoryVersion: 2, countedQuantity: 2 }] }).expect(201)).body;
    const before = await countStock(), oldOrder = await db().collection('orders').findOne({ _id: new ObjectId(order.id) });
    expect((await post(row.id).expect(409)).body.error.code).toBe('COUNT_BELOW_RESERVED'); expect(await countStock()).toEqual(before);
    await update(row.id, { ...input(), version: 0, items: [{ ...input().items[0], expectedInventoryVersion: 2, countedQuantity: 8 }] }).expect(200);
    const posted = (await post(row.id, 1).expect(200)).body;
    expect(posted.movementIds).toHaveLength(1); expect(await balance(products[0])).toMatchObject({ on_hand: 8, reserved: 3, version: 3 });
    expect(await db().collection('orders').findOne({ _id: new ObjectId(order.id) })).toEqual(oldOrder); await oracle();
  });

  it('TC07/12: zero balance and zero delta are valid; zero lines do not create movements/version; history source verified', async () => {
    await receive();
    const row = (await create({ ...input(), items: input().items.map((item, index) => ({ ...item, countedQuantity: index ? 10 : 0 })) }).expect(201)).body;
    const result = (await post(row.id).expect(200)).body;
    expect(result.movementIds).toHaveLength(1); expect(await balance(products[0])).toMatchObject({ on_hand: 0, reserved: 0, version: 2 });
    expect(await balance(products[1])).toMatchObject({ on_hand: 10, reserved: 0, version: 1 });
    const history = (await http().get(`/api/inventory/${products[0]}/movements?kind=ADJUSTMENT_POST`).set('Authorization', `Bearer ${staff.token}`).expect(200)).body;
    expect(history.items[0]).toMatchObject({ sourceType: 'STOCK_ADJUST', sourcePath: `/stock-adjustments/${row.id}`, sourceCode: row.code, onHandDelta: -10, reservedDelta: 0 });
    expect(JSON.stringify(history)).not.toMatch(/unitCost|totalCost/);
    const zero = (await create({ ...input(), items: [{ ...input().items[1], countedQuantity: 10 }] }).expect(201)).body;
    expect((await post(zero.id).expect(200)).body.movementIds).toEqual([]);
    expect(await balance(products[1])).toMatchObject({ on_hand: 10, version: 1 });
    expect((await get(`/${zero.id}`).expect(200)).body).toMatchObject({ status: 'POSTED', stale: false, movementIds: [] }); await oracle();
    await db().collection('stock_document_items').updateOne({ _id: new ObjectId(row.items[0].id) }, { $set: { base_inventory_version: new Int32(0) } });
    expect((await create({ ...input(), items: [{ ...input().items[0], expectedInventoryVersion: 2 }] }).expect(409)).body.error.code).toBe('INVENTORY_INTEGRITY_ERROR');
  });

  it('TC08: last-line stale, movement, audit and key failure roll back whole document, inventory guards and ledger', async () => {
    await receive(); const row = (await create().expect(201)).body;
    const repo = apps[0].get(StockRepository), writer = apps[0].get(InventoryWriter), operations = apps[0].get(OperationRequestsRepository);
    const before = await countStock(), detail = (await get(`/${row.id}`).expect(200)).body, balances = [await balance(products[0]), await balance(products[1])];
    for (const point of ['line2', 'audit', 'operation'] as const) {
      const originalMove = writer.insertMovement.bind(writer), originalAudit = repo.insertEvent.bind(repo), originalKey = operations.insert.bind(operations); let line = 0;
      const spy = point === 'line2' ? jest.spyOn(writer, 'insertMovement').mockImplementation(async (...args) => {
        const result = await originalMove(...args); if (++line === 2) throw new Error('FAIL_LINE2'); return result;
      }) : point === 'audit' ? jest.spyOn(repo, 'insertEvent').mockImplementation(async (...args) => { await originalAudit(...args); throw new Error('FAIL_AUDIT'); })
        : jest.spyOn(operations, 'insert').mockImplementation(async (...args) => { await originalKey(...args); throw new Error('FAIL_OPERATION'); });
      await post(row.id).expect(500); spy.mockRestore();
      expect(await countStock()).toEqual(before); expect([await balance(products[0]), await balance(products[1])]).toEqual(balances);
      expect((await get(`/${row.id}`).expect(200)).body).toEqual(detail);
    }
    const receipt = (await http().post('/api/stock-receipts').set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID())
      .send({ reason: 'Receipt on the final line only', items: [{ productId: products[1], quantity: 1, unitCost: '0' }] }).expect(201)).body;
    await http().post(`/api/stock-receipts/${receipt.id}/post`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0 }).expect(200);
    const afterReceipt = [await balance(products[0]), await balance(products[1])], counts = await countStock();
    expect((await post(row.id).expect(409)).body.error.code).toBe('COUNT_SNAPSHOT_STALE');
    expect([await balance(products[0]), await balance(products[1])]).toEqual(afterReceipt); expect(await countStock()).toEqual(counts); await oracle();
  });

  it('TC09: two independent processes post competing count snapshots; one commits, one becomes stale', async () => {
    await receive(); const a = (await create().expect(201)).body, b = (await create().expect(201)).body;
    const results = await Promise.all([processPost(0, a.id), processPost(1, b.id)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)!.body.error.code).toBe('COUNT_SNAPSHOT_STALE');
    expect(await balance(products[0])).toMatchObject({ on_hand: 8, reserved: 0, version: 2 }); await oracle();
  });

  it('TC09: checkout races with post across processes and respects a valid serial order', async () => {
    await receive(); const row = (await create().expect(201)).body, intent = await posIntent(3);
    const results = await Promise.all([processPost(0, row.id), request(processes[1].url).post('/api/pos/orders').set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send(intent)]);
    expect(results[1].status).toBe(201);
    if (results[0].status === 409) {
      expect(results[0].body.error.code).toBe('COUNT_SNAPSHOT_STALE'); expect(await balance(products[0])).toMatchObject({ on_hand: 10, reserved: 3, version: 2 });
    } else { expect(results[0].status).toBe(200); expect(await balance(products[0])).toMatchObject({ on_hand: 8, reserved: 3, version: 3 }); }
    await oracle();
  });

  it('TC10/11: exact replay before current version, changed payload conflict, new post key is harmless, lookup and immutable POSTED', async () => {
    await receive(); const key = randomUUID(), row = (await create(input(), key).expect(201)).body;
    const postKey = randomUUID(), posted = (await post(row.id, 0, postKey).expect(200)).body;
    const before = await countStock(), balanceBefore = await balance(products[0]);
    expect((await create(input(), key).expect(201)).body).toEqual(row);
    expect((await post(row.id, 0, postKey).expect(200)).body).toEqual(posted);
    expect((await post(row.id, 0).expect(200)).body).toEqual(posted);
    expect((await post(row.id, 1, postKey).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await update(row.id, { ...input(), version: 1 }).expect(409)).body.error.code).toBe('DOCUMENT_NOT_EDITABLE');
    const lookup = await http().get(`/api/operations/STOCK_ADJUST_POST/${postKey}`).set('Authorization', `Bearer ${admin.token}`).expect(200);
    expect(lookup.body.responseBody).toEqual(posted);
    const after = await countStock(); expect(after.stock_movements).toBe(before.stock_movements); expect(after.stock_document_events).toBe(before.stock_document_events);
    expect(await balance(products[0])).toEqual(balanceBefore);
    const detail = (await get(`/${row.id}`).expect(200)).body;
    expect(detail.audit.filter((event: { action: string }) => event.action === 'POSTED')).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({ id: row.items[0].id, countedAt: row.items[0].countedAt, skuSnapshot: row.items[0].skuSnapshot }); await oracle();
  });

  it('TC09/10: same-key posts across processes and concurrent edit/post never duplicate inventory or audit', async () => {
    await receive(); const row = (await create().expect(201)).body, key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => processPost(i % 2, row.id, key)));
    for (const result of results) { expect(result.status).toBe(200); expect(result.body).toEqual(results[0].body); }
    expect(await db().collection('stock_document_events').countDocuments({ document_id: new ObjectId(row.id), action: 'POSTED' })).toBe(1);
    expect(await db().collection('stock_movements').countDocuments({ source_id: new ObjectId(row.id) })).toBe(2);
    const nextInput = { ...input(), items: input().items.map(item => ({ ...item, expectedInventoryVersion: 2, countedQuantity: 9 })) };
    const next = (await create(nextInput).expect(201)).body;
    const race = await Promise.all([processPost(0, next.id), request(processes[1].url).patch(`${base}/${next.id}`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ ...nextInput, version: 0 })]);
    expect(race.map(result => result.status).sort()).toEqual([200, 409]);
    expect(['VERSION_CONFLICT', 'DOCUMENT_NOT_EDITABLE']).toContain(race.find(result => result.status === 409)!.body.error.code); await oracle();
  });

  it('TC07: full Int32 count range, exact zero-cost increase and decrease, canonical update replay', async () => {
    await receive(); const body = { ...input(), items: [{ ...input().items[0], countedQuantity: 2147483647, unitCost: '0' }] };
    const row = (await create(body).expect(201)).body;
    await post(row.id).expect(200); expect(await balance(products[0])).toMatchObject({ on_hand: 2147483647, version: 2 });
    const next = (await create({ ...body, items: [{ ...body.items[0], expectedInventoryVersion: 2 }] }).expect(201)).body;
    const updateKey = randomUUID(), newBody = { ...body, version: 0, items: [{ ...body.items[0], countedQuantity: 0, expectedInventoryVersion: 2 }] };
    const updated = (await update(next.id, newBody, updateKey).expect(200)).body;
    await post(next.id, 1).expect(200);
    expect((await update(next.id, newBody, updateKey).expect(200)).body).toEqual(updated);
    expect(await balance(products[0])).toMatchObject({ on_hand: 0, reserved: 0, version: 3 }); await oracle();
  });

  it('F01/S05-I01: missing/corrupt inventory is rejected; zero is not synthesized and SKU lines require a complete snapshot', async () => {
    await receive(); const before = await countStock();
    await db().collection('inventory').deleteOne({ product_id: new ObjectId(products[0]) });
    expect((await create().expect(409)).body.error.code).toBe('INVENTORY_INTEGRITY_ERROR'); expect(await countStock()).toEqual(before);
    const model = apps[0].get(StockRepository).items;
    const line = new model({ document_id: new ObjectId(), product_id: new ObjectId(products[1]), quantity_delta: 1, unit_cost: '0', line_total_cost: '0',
      sku_snapshot: 'A', name_snapshot: 'A', counted_quantity: 2 });
    await expect(line.validate()).rejects.toThrow('Invalid adjustment count snapshot');
  });
});

