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
import { ApplicationError } from '../src/common/errors/application-error';
import { PasswordService } from '../src/common/security/password.service';
import { configureHttp } from '../src/common/http/configure-http';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { ensureRetailCatalogIntegrity } from '../src/modules/catalog/retail-catalog.migration';
import { InventoryWriter } from '../src/modules/inventory/inventory-writer';
import { OperationRequestsRepository } from '../src/modules/operations/operation-requests.repository';
import { StockRepository } from '../src/modules/stock/stock.repository';
import { StockIssuesService } from '../src/modules/stock/stock-issues.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { AppProcess } from './helpers/en05-fixture';

type Actor = { id: string; token: string };
const base = '/api/stock-issues', origin = 'http://localhost:5173';
describe('US-38 AC01–03: real replica set, HTTP, rollback, two processes and ledger reconciliation', () => {
  let mongo: MongoMemoryReplSet, connection: Connection, admin: Actor, staff: Actor;
  let products: string[], categoryId: string, sequence = 0;
  const apps: INestApplication[] = [], processes: AppProcess[] = [], saved = { ...process.env };
  const db = () => connection.db!, http = (index = 0) => request(apps[index].getHttpServer());
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_test_us38', FRONTEND_ORIGIN: origin,
      EN05_NOW: new Date().toISOString(), JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      RETAIL_QUOTE_SECRET: randomBytes(32).toString('base64url'), PICKUP_LOCATION: 'Quầy kiểm thử US38',
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
    categoryId = (await catalog('categories', { name: 'US38 hàng thực nhận', status: 'ACTIVE' })).body.id as string;
    products = [];
    for (let i = 0; i < 2; i++) products.push((await catalog('products', { categoryId, sku: `SKU_${i}`, name: `Hàng ${i}`, status: 'ACTIVE', price: '9000' })).body.id as string);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { for (const app of processes) await app.close(); for (const app of apps) await app.close(); await mongo?.stop(); process.env = saved; });
  async function login(code: 'ADMIN' | 'STAFF' | 'MEMBER' | 'TRAINER'): Promise<Actor> {
    const users = apps[0].get(UsersRepository), role = await users.ensureRole(code, code), password = 'US38 test password 123';
    const account = await users.createAccount({ roleId: String(role.id), fullName: `US38 ${code}`, phone: `093360${String(++sequence).padStart(4, '0')}`,
      passwordHash: await apps[0].get(PasswordService).hash(password) });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
    return { id: String(account._id), token: response.body.accessToken as string };
  }
  const catalog = (kind: string, input: object) => http().post(`/api/admin/${kind}`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send(input).expect(201);
  const input = () => ({ reason: ' Xuất sử dụng nội bộ theo chứng từ ', sourceReference: ' SOURCE_38 ',
    items: products.map((productId, i) => ({ productId, quantity: i ? 2 : 6, unitCost: i ? '0' : '005000' })) });
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
      .send({ reason: 'Nhập hàng kiểm thử US38, không phải hàng thật', items: products.map(productId => ({ productId, quantity, unitCost: '1000' })) }).expect(201);
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

  it('TC01/04: normalized full draft replacement, inactive SKU, audit and kind isolation; no stock change', async () => {
    const receiptId = await receive();
    await db().collection('products').updateOne({ _id: new ObjectId(products[0]) }, { $set: { status: 'INACTIVE' } });
    const before = await balance(products[0]), movements = await db().collection('stock_movements').countDocuments();
    const key = randomUUID(), created = await create(input(), key).expect(201), row = created.body;
    expect(row).toMatchObject({ code: `ISS-${row.id}`, status: 'DRAFT', version: 0, totalCost: '30000', sourceReference: 'SOURCE_38', createdBy: admin.id });
    expect(row.items[0]).toMatchObject({ quantity: 6, unitCost: '5000', inactiveWarning: true });
    expect((await create({ ...input(), reason: input().reason.trim() }, key).expect(201)).body).toEqual(row);
    const updated = await update(row.id, { ...input(), version: 0, reason: 'Xuất hàng hư hỏng có biên bản', items: [input().items[1]] }).expect(200);
    expect(updated.body).toMatchObject({ version: 1, totalCost: '0' }); expect(updated.body.items).toHaveLength(1);
    const detail = (await get(`/${row.id}`).expect(200)).body;
    expect(detail.audit).toHaveLength(2); expect(detail.audit[1]).toMatchObject({ action: 'UPDATED', before: { version: 0 }, after: { version: 1, reason: 'Xuất hàng hư hỏng có biên bản' } });
    expect(await balance(products[0])).toMatchObject({ on_hand: before!.on_hand, reserved: before!.reserved, version: before!.version, updated_at: before!.updated_at });
    expect(await db().collection('stock_movements').countDocuments()).toBe(movements);
    await get(`/${receiptId}`).expect(404); await post(receiptId).expect(404); await update(receiptId, { ...input(), version: 0 }).expect(404);
    expect((await get().expect(200)).body.items.map((item: { id: string }) => item.id)).toEqual([row.id]);
    await http().get(`/api/stock-receipts/${row.id}`).set('Authorization', `Bearer ${admin.token}`).expect(404);
  });

  it('TC02: all non-admin roles, revoked sessions and role changes cannot read/write/replay/lookup', async () => {
    await http().get(base).expect(401);
    const key = randomUUID(), row = (await create(input(), key).expect(201)).body;
    for (const actor of [staff, await login('MEMBER'), await login('TRAINER')]) {
      await get('', actor).expect(403); await get(`/${row.id}`, actor).expect(403); await create(input(), key, actor).expect(403);
      await http().patch(`${base}/${row.id}`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', randomUUID()).send({ ...input(), version: 0 }).expect(403);
      await http().post(`${base}/${row.id}/post`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0 }).expect(403);
      await http().get(`/api/operations/STOCK_ISSUE_CREATE/${key}`).set('Authorization', `Bearer ${actor.token}`).expect(403);
    }
    const role = await apps[0].get(UsersRepository).ensureRole('STAFF', 'STAFF');
    await db().collection('accounts').updateOne({ _id: new ObjectId(admin.id) }, { $set: { role_id: role._id } });
    await create(input(), key).expect(403);
    await db().collection('accounts').updateOne({ _id: new ObjectId(admin.id) }, { $inc: { auth_version: 1 } });
    await create(input(), key).expect(401);
  });

  it('TC03/08: strict DTO, quantity 1–999, distinct lines, exact money, filters, no sale adapter', async () => {
    const before = await countStock();
    for (const quantity of [0, -1, 1.5, 1000, '1']) await create({ ...input(), items: [{ ...input().items[0], quantity }] }).expect(400);
    for (const unitCost of ['-1', '1.5', '1e2', '1000000000000', 1, null]) await create({ ...input(), items: [{ ...input().items[0], unitCost }] }).expect(400);
    for (const change of [{ reason: '' }, { reason: 'short' }, { items: [] }, { items: [input().items[0], input().items[0]] },
      { items: Array.from({ length: 101 }, () => input().items[0]) }, { orderId: String(new ObjectId()) }, { status: 'POSTED' }]) await create({ ...input(), ...change }).expect(400);
    await create({ ...input(), items: [{ ...input().items[0], quantity: 2, unitCost: '999999999999' }] }).expect(400);
    await create(input(), 'invalid-key').expect(400);
    for (const query of ['?status=BAD', '?page=1.5', '?limit=101', '?fromDate=2026-02-30', '?fromDate=2024-01-01&toDate=2026-01-01', '?orderId=x']) await get(query).expect(400);
    expect(await countStock()).toEqual(before);
    const row = (await create().expect(201)).body;
    await http().post(`${base}/${row.id}/post`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0, items: input().items }).expect(400);
    const schema = (await http().get('/api/docs-json').expect(200)).body;
    expect(schema.paths[`${base}/{id}`].patch).toBeDefined();
    expect(schema.components.schemas.IssueItemDto.properties.quantity.maximum).toBe(999);
  });

  it('TC05/06: onHand=10/reserved=4 allows six, rejects seven atomically; actual POS reservations unchanged', async () => {
    await receive();
    const intent = await posIntent(4);
    await http().post('/api/pos/orders').set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send(intent).expect(201);
    const bad = { ...input(), items: [{ ...input().items[0], quantity: 7 }] }, badRow = (await create(bad).expect(201)).body;
    const balances = await balance(products[0]), counts = await countStock();
    expect((await post(badRow.id).expect(409)).body.error.code).toBe('INSUFFICIENT_AVAILABLE_STOCK');
    expect(await balance(products[0])).toEqual(balances); expect(await countStock()).toEqual(counts);
    const row = (await create().expect(201)).body, posted = (await post(row.id).expect(200)).body;
    expect(posted).toMatchObject({ status: 'POSTED', version: 1, postedBy: admin.id });
    expect(await balance(products[0])).toMatchObject({ on_hand: 4, reserved: 4, version: 3 });
    const movement = await db().collection('stock_movements').findOne({ source_id: new ObjectId(row.id), product_id: new ObjectId(products[0]) });
    expect(movement).toMatchObject({ kind: 'ISSUE_POST', event_key: `ISSUE_POST:${row.items[0].id}`, on_hand_delta: -6, reserved_delta: 0, before_on_hand: 10, after_on_hand: 4, before_reserved: 4, after_reserved: 4 });
    expect(movement!.order_item_id).toBeUndefined();
    const history = await http().get(`/api/inventory/${products[0]}/movements?kind=ISSUE_POST`).set('Authorization', `Bearer ${staff.token}`).expect(200);
    expect(history.body.items[0]).toMatchObject({ sourceType: 'STOCK_ISSUE', sourcePath: `/stock-issues/${row.id}`, sourceCode: row.code });
    expect(JSON.stringify(history.body)).not.toMatch(/unitCost|totalCost/);
    const detail = (await get(`/${row.id}`).expect(200)).body;
    expect(detail.items[0]).toMatchObject({ id: row.items[0].id, quantity: 6 }); expect(detail.audit.filter((event: { action: string }) => event.action === 'POSTED')).toHaveLength(1);
    await oracle();
  });

  it('TC07: final-line shortage, movement/audit/key failures roll back the entire document, guards and ledger', async () => {
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
    const lastShort = (await create({ ...input(), items: [input().items[0], { ...input().items[1], quantity: 11 }] }).expect(201)).body;
    const afterDraft = [await balance(products[0]), await balance(products[1])];
    expect((await post(lastShort.id).expect(409)).body.error.code).toBe('INSUFFICIENT_AVAILABLE_STOCK');
    expect([await balance(products[0]), await balance(products[1])]).toEqual(afterDraft);
    await post(row.id).expect(200); await oracle();
  });

  it('TC09: two independent processes compete for the last available units; only one issue commits', async () => {
    await receive(6); const a = (await create().expect(201)).body, b = (await create().expect(201)).body;
    const results = await Promise.all([processPost(0, a.id), processPost(1, b.id)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)!.body.error.code).toBe('INSUFFICIENT_AVAILABLE_STOCK');
    expect(await balance(products[0])).toMatchObject({ on_hand: 0, reserved: 0, version: 2 }); await oracle();
  });

  it('TC09: real POS reserve and ISSUE compete across processes; receipt and fulfill use the same ledger', async () => {
    await receive(6); const row = (await create().expect(201)).body, intent = await posIntent(6);
    const results = await Promise.all([processPost(0, row.id), request(processes[1].url).post('/api/pos/orders').set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send(intent)]);
    expect(results.map(result => result.status).sort()).toEqual([results[1].status === 201 ? 201 : 200, 409]);
    const current = (await balance(products[0]))!; expect(current.on_hand).toBeGreaterThanOrEqual(current.reserved); await oracle();
    // A separate actual POS order reserves four out of ten, then fulfills while an issue removes the free six.
    await receive(10);
    const nextIntent = await posIntent(4);
    const order = (await http().post('/api/pos/orders').set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send(nextIntent).expect(201)).body;
    await http().post(`/api/transactions/${order.transactionId}/confirm-payment`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID())
      .send({ method: 'CASH', amount: '36000', evidenceNote: 'Đã đếm tiền mặt thực nhận cho kiểm thử US38' }).expect(200);
    const issue = (await create().expect(201)).body;
    const orderVersion = (await http().get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${admin.token}`).expect(200)).body.version as number;
    const concurrent = await Promise.all([processPost(0, issue.id), request(processes[1].url).post(`/api/pos/orders/${order.id}/fulfill`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ version: orderVersion })]);
    concurrent.forEach(result => expect(result.status).toBe(200)); await oracle();
    expect(await db().collection('stock_movements').countDocuments({ kind: 'ISSUE_POST', source_id: new ObjectId(order.id) })).toBe(0);
  });

  it('TC10: 20 same-key requests and new keys post exactly once; posted snapshots immutable', async () => {
    await receive(); const row = (await create().expect(201)).body, key = randomUUID();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => processPost(i % 2, row.id, key)));
    results.forEach(result => { expect(result.status).toBe(200); expect(result.body).toEqual(results[0].body); });
    for (const result of await Promise.all([processPost(0, row.id), processPost(1, row.id)])) expect(result.body).toEqual(results[0].body);
    expect(await balance(products[0])).toMatchObject({ on_hand: 4, version: 2 });
    expect(await db().collection('stock_document_events').countDocuments({ document_id: new ObjectId(row.id), action: 'POSTED' })).toBe(1);
    expect((await post(row.id, 1, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await update(row.id, { ...input(), version: 1 }).expect(409)).body.error.code).toBe('DOCUMENT_NOT_EDITABLE');
    await http().delete(`${base}/${row.id}`).set('Authorization', `Bearer ${admin.token}`).expect(404);
    await db().collection('products').updateOne({ _id: new ObjectId(products[0]) }, { $set: { name: 'Tên sau khi ghi sổ' } });
    expect((await get(`/${row.id}`).expect(200)).body.items[0].nameSnapshot).toBe(row.items[0].nameSnapshot); await oracle();
  });

  it('TC11: update races post with version CAS; old update and post versions are rejected', async () => {
    await receive(); const row = (await create().expect(201)).body;
    const changed = { ...input(), version: 0, items: input().items.map(item => ({ ...item, quantity: 3 })) };
    const results = await Promise.all([update(row.id, changed, randomUUID(), 0), post(row.id, 0, randomUUID(), 1)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const detail = (await get(`/${row.id}`).expect(200)).body;
    if (detail.status === 'DRAFT') {
      expect((await post(row.id).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
      await post(row.id, 1).expect(200); expect(await balance(products[0])).toMatchObject({ on_hand: 7 });
    } else expect(await balance(products[0])).toMatchObject({ on_hand: 4 });
    await oracle();
  });

  it('TC09: receipt and issue post concurrently on two processes with continuous sequence and exact deltas', async () => {
    await receive(); const issue = (await create().expect(201)).body;
    const receipt = (await http().post('/api/stock-receipts').set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID())
      .send({ reason: 'Nhập hàng bổ sung đồng thời với xuất US38', items: [{ productId: products[0], quantity: 3, unitCost: '1000' }] }).expect(201)).body;
    const results = await Promise.all([processPost(0, issue.id), request(processes[1].url).post(`/api/stock-receipts/${receipt.id}/post`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0 })]);
    results.forEach(result => expect(result.status).toBe(200));
    expect(await balance(products[0])).toMatchObject({ on_hand: 7, reserved: 0, version: 3 }); await oracle();
  });

  it('TC12: lost response resolves original operation and replay; missing/inconsistent inventory blocks writes', async () => {
    await receive(); const row = (await create().expect(201)).body, key = randomUUID();
    const service = apps[0].get(StockIssuesService), original = service.post.bind(service);
    const spy = jest.spyOn(service, 'post').mockImplementationOnce(async (...args) => { await original(...args); throw new ApplicationError(503, 'OPERATION_OUTCOME_UNKNOWN', 'Response lost'); });
    await post(row.id, 0, key).expect(503); spy.mockRestore();
    const lookup = await http(1).get(`/api/operations/STOCK_ISSUE_POST/${key}`).set('Authorization', `Bearer ${admin.token}`).expect(200);
    expect((await post(row.id, 0, key).expect(200)).body).toEqual(lookup.body.responseBody); await oracle();
    await db().collection('inventory').deleteOne({ product_id: new ObjectId(products[1]) });
    expect((await create().expect(409)).body.error.code).toBe('INVENTORY_INTEGRITY_ERROR');
    expect(await balance(products[1])).toBeNull();
    await db().collection('stock_document_items').updateOne({ _id: new ObjectId(row.items[0].id) }, { $set: { quantity_delta: new Int32(-5) } });
    expect((await create().expect(409)).body.error.code).toBe('INVENTORY_INTEGRITY_ERROR');
  });
});

