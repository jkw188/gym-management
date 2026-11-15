// Process races use scripts/en05-app.cjs and dist, like the existing EN-05 harness. Run npm run build first.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Int32, ObjectId } from 'mongodb';
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
import { StockReceiptsService } from '../src/modules/stock/stock-receipts.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { AppProcess } from './helpers/en05-fixture';

type Actor = { id: string; token: string };
const base = '/api/stock-receipts', origin = 'http://localhost:5173';
describe('US-36 AC01–03: real replica set, HTTP, rollback, two processes and ledger reconciliation', () => {
  let mongo: MongoMemoryReplSet, connection: Connection, admin: Actor, staff: Actor;
  let products: string[], categoryId: string, sequence = 0;
  const apps: INestApplication[] = [], processes: AppProcess[] = [], saved = { ...process.env };
  const db = () => connection.db!, http = (index = 0) => request(apps[index].getHttpServer());
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_test_us36', FRONTEND_ORIGIN: origin,
      EN05_NOW: new Date().toISOString(), JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
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
    categoryId = (await catalog('categories', { name: 'US36 hàng thực nhận', status: 'ACTIVE' })).body.id as string;
    products = [];
    for (let i = 0; i < 2; i++) products.push((await catalog('products', { categoryId, sku: `SKU_${i}`, name: `Hàng ${i}`, status: 'ACTIVE', price: '9000' })).body.id as string);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { for (const app of processes) await app.close(); for (const app of apps) await app.close(); await mongo?.stop(); process.env = saved; });
  async function login(code: 'ADMIN' | 'STAFF' | 'MEMBER' | 'TRAINER'): Promise<Actor> {
    const users = apps[0].get(UsersRepository), role = await users.ensureRole(code, code), password = 'US36 test password 123';
    const account = await users.createAccount({ roleId: String(role.id), fullName: `US36 ${code}`, phone: `093360${String(++sequence).padStart(4, '0')}`,
      passwordHash: await apps[0].get(PasswordService).hash(password) });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
    return { id: String(account._id), token: response.body.accessToken as string };
  }
  const catalog = (kind: string, input: object) => http().post(`/api/admin/${kind}`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send(input).expect(201);
  const input = () => ({ reason: ' Nhập hàng thực nhận theo phiếu giao ', sourceReference: ' SOURCE_36 ',
    items: products.map((productId, i) => ({ productId, quantity: i ? 5 : 10, unitCost: i ? '0' : '005000' })) });
  const create = (body = input(), key: string = randomUUID(), actor = staff) => http().post(base).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send(body);
  const get = (path = '', actor = staff) => http().get(`${base}${path}`).set('Authorization', `Bearer ${actor.token}`);
  const update = (id: string, body: object, key = randomUUID(), index = 0) => http(index).put(`${base}/${id}`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', key).send(body);
  const post = (id: string, version = 0, key = randomUUID(), index = 0) => http(index).post(`${base}/${id}/post`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', key).send({ version });
  const balance = (id: string) => db().collection('inventory').findOne({ product_id: new ObjectId(id) });
  // Explicit test-only opening evidence. US-37 now blocks legacy nonzero stock without a complete ledger.
  async function openingFixture(id: string, hand: number, reserved = 0) {
    const product_id = new ObjectId(id), source_id = new ObjectId();
    await db().collection('stock_movements').insertOne({ product_id, source_id, actor_id: new ObjectId(staff.id),
      kind: 'FIXTURE_OPENING', event_key: `FIXTURE_OPENING:${source_id}`, sequence: new Int32(1), on_hand_delta: new Int32(hand), reserved_delta: new Int32(reserved),
      before_on_hand: new Int32(0), before_reserved: new Int32(0), after_on_hand: new Int32(hand), after_reserved: new Int32(reserved),
      sku_snapshot: 'FIXTURE', name_snapshot: 'Explicit test opening', created_at: new Date() });
    await db().collection('inventory').updateOne({ product_id }, { $set: { on_hand: new Int32(hand), reserved: new Int32(reserved), version: new Int32(1) } });
  }
  async function processPost(index: number, id: string, key = randomUUID()) {
    return request(processes[index].url).post(`${base}/${id}/post`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', key).send({ version: 0 });
  }
  async function countStock() {
    const result: Record<string, number> = {};
    for (const name of ['stock_documents', 'stock_document_items', 'stock_document_events', 'stock_movements', 'operation_requests']) result[name] = await db().collection(name).countDocuments();
    return result;
  }

  it('TC01/04/08: draft normalization, zero cost, inactive warnings; no balance/movement/payment/price mutation', async () => {
    await db().collection('products').updateOne({ _id: new ObjectId(products[0]) }, { $set: { status: 'INACTIVE' } });
    const key = randomUUID(), before = await balance(products[0]), result = await create(input(), key).expect(201);
    expect(result.body).toMatchObject({ status: 'DRAFT', version: 0, totalCost: '50000', sourceReference: 'SOURCE_36', createdBy: staff.id, postedAt: null });
    expect(result.body.code).toBe(`RCV-${result.body.id}`); expect(result.body.items[0]).toMatchObject({ unitCost: '5000', lineTotalCost: '50000', inactiveWarning: true });
    expect(await balance(products[0])).toEqual(before); expect(await db().collection('stock_movements').countDocuments()).toBe(0);
    expect(await db().collection('payments').countDocuments()).toBe(0);
    const replay = await create({ ...input(), reason: input().reason.trim(), sourceReference: 'SOURCE_36', items: input().items.map(item => ({ ...item, unitCost: String(Number(item.unitCost)) })) }, key).expect(201);
    expect(replay.body).toEqual(result.body);
    await post(result.body.id).expect(200);
    expect((await db().collection('products').findOne({ _id: new ObjectId(products[0]) }))!.price.toString()).toBe('9000');
    expect((await db().collection('products').findOne({ _id: new ObjectId(products[0]) }))!.status).toBe('INACTIVE');
    expect(await db().collection('payments').countDocuments()).toBe(0);
  });

  it('TC02: unauthenticated, Member/PT and locked/revoked sessions cannot see cost or replay/lookup', async () => {
    await http().get(base).expect(401);
    for (const role of ['MEMBER', 'TRAINER'] as const) {
      const actor = await login(role); await get('', actor).expect(403); await create(input(), randomUUID(), actor).expect(403);
      await http().get('/api/inventory/product-options').set('Authorization', `Bearer ${actor.token}`).expect(403);
    }
    const key = randomUUID(), row = (await create(input(), key).expect(201)).body;
    await get(`/${row.id}`, admin).expect(200); // Operations team, independent of creator.
    await db().collection('accounts').updateOne({ _id: new ObjectId(staff.id) }, { $set: { status: 'LOCKED' } });
    await get(`/${row.id}`).expect(401); await create(input(), key).expect(401);
    await http().get(`/api/operations/STOCK_RECEIPT_CREATE/${key}`).set('Authorization', `Bearer ${staff.token}`).expect(401);
  });

  it('TC03: strict nested allowlist, quantity, version, dates and bounded exact money reject before partial saves', async () => {
    const before = await countStock();
    const bad = [{ quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: '1' }, { quantity: 1000001 },
      { unitCost: 1 }, { unitCost: '1.5' }, { unitCost: '1e2' }, { unitCost: '1,000' }, { unitCost: '-1' }, { unitCost: '1000000000000' }, { unitCost: null }, { status: 'POSTED' }];
    for (const value of bad) await http().post(base).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID()).send({ ...input(), items: [{ ...input().items[0], ...value }] }).expect(400);
    await create({ ...input(), items: [input().items[0], input().items[0]] }).expect(400);
    for (const value of [{ reason: 'short' }, { reason: null }, { sourceReference: null }, { sourceReference: 'a'.repeat(101) }, { items: [] },
      { items: Array.from({ length: 101 }, () => input().items[0]) }, { createdAt: new Date().toISOString() }]) {
      await http().post(base).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID()).send({ ...input(), ...value }).expect(400);
    }
    await create({ ...input(), items: [{ ...input().items[0], quantity: 2, unitCost: '999999999999' }] }).expect(400);
    await create({ ...input(), items: input().items.map(item => ({ ...item, quantity: 1, unitCost: '999999999999' })) }).expect(400);
    await create(input(), 'bad-key').expect(400);
    for (const query of ['?fromDate=2026-02-30', '?fromDate=2024-01-01&toDate=2026-01-01', '?fromDate=2026-02-02&toDate=2026-01-01', '?status=INVALID', '?limit=101', '?page=1.5', '?sort=cost']) await get(query).expect(400);
    expect(await countStock()).toEqual(before);
    await create({ ...input(), items: [{ ...input().items[0], quantity: 1, unitCost: '999999999999' }] }).expect(201);
  });

  it('TC04: missing SKU blocks whole draft; picker includes inactive category/SKU and never returns costs or balances', async () => {
    const before = await countStock();
    const missing = await create({ ...input(), items: [...input().items, { productId: String(new ObjectId()), quantity: 1, unitCost: '0' }] }).expect(404);
    expect(missing.body.error.code).toBe('PRODUCT_NOT_FOUND'); expect(await countStock()).toEqual(before);
    await db().collection('categories').updateOne({ _id: new ObjectId(categoryId) }, { $set: { status: 'INACTIVE' } });
    const options = await http().get('/api/inventory/product-options?limit=1').set('Authorization', `Bearer ${staff.token}`).expect(200);
    expect(options.body).toMatchObject({ total: 2, totalPages: 2 }); expect(options.body.items[0]).toMatchObject({ effectiveActive: false, inventoryState: 'VALID' });
    expect(JSON.stringify(options.body)).not.toMatch(/price|Cost|reserved|onHand|guard/);
    await http().get('/api/inventory/product-options?status=ACTIVE').set('Authorization', `Bearer ${staff.token}`).expect(400);
    const empty = await http().get('/api/inventory/product-options?q=.%2A').set('Authorization', `Bearer ${staff.token}`).expect(200);
    expect(empty.body).toMatchObject({ items: [], totalPages: 0 });
    expect((await create().expect(201)).body.items.every((item: { inactiveWarning: boolean }) => item.inactiveWarning)).toBe(true);
  });

  it('TC05/06: posting preserves reserved; snapshots, Int32 sequence, event/source chain and immutable history match', async () => {
    await openingFixture(products[0], 12, 3);
    const row = (await create().expect(201)).body;
    await db().collection('products').updateOne({ _id: new ObjectId(products[0]) }, { $set: { name: 'Tên tại ghi sổ' } });
    const posted = await post(row.id).expect(200);
    expect(posted.body).toMatchObject({ status: 'POSTED', version: 1, totalCost: '50000', postedBy: staff.id }); expect(posted.body.movementIds).toHaveLength(2);
    expect(await balance(products[0])).toMatchObject({ on_hand: 22, reserved: 3, version: 2 });
    expect(await balance(products[1])).toMatchObject({ on_hand: 5, reserved: 0, version: 1 });
    const movement = await db().collection('stock_movements').findOne({ product_id: new ObjectId(products[0]), kind: 'RECEIPT_POST' });
    expect(movement).toMatchObject({ event_key: `RECEIPT_POST:${row.items[0].id}`, sequence: 2, kind: 'RECEIPT_POST',
      before_on_hand: 12, before_reserved: 3, after_on_hand: 22, after_reserved: 3, on_hand_delta: 10, reserved_delta: 0, name_snapshot: 'Tên tại ghi sổ' });
    expect(String(movement!.source_id)).toBe(row.id); expect(String(movement!.document_item_id)).toBe(row.items[0].id);
    const types = await db().collection('stock_movements').aggregate([{ $project: { sequence: { $type: '$sequence' }, delta: { $type: '$on_hand_delta' } } }]).toArray();
    expect(types.every(row => row.sequence === 'int' && row.delta === 'int')).toBe(true);
    await db().collection('products').updateOne({ _id: new ObjectId(products[0]) }, { $set: { name: 'Tên sau ghi sổ' } });
    const detail = (await get(`/${row.id}`).expect(200)).body;
    expect(detail.items[0]).toMatchObject({ id: row.items[0].id, nameSnapshot: 'Tên tại ghi sổ' });
    expect(detail.movements[0]).toMatchObject({ id: String(movement!._id), documentItemId: row.items[0].id, sequence: 2, sourceId: row.id, sourceCode: row.code, beforeOnHand: 12, afterOnHand: 22 });
    expect(await db().collection('stock_document_events').countDocuments({ document_id: new ObjectId(row.id), action: 'POSTED' })).toBe(1);
  });

  it('TC07: draft replace is atomic/versioned with no movement; POSTED cannot update/delete/reverse or accept items', async () => {
    const row = (await create().expect(201)).body, before = await balance(products[0]);
    const changed = { ...input(), version: 0, reason: 'Nhập theo chứng từ mới', sourceReference: '', items: [input().items[1]] };
    const updated = (await update(row.id, changed).expect(200)).body;
    expect(updated).toMatchObject({ version: 1, reason: changed.reason, sourceReference: '' }); expect(updated.items).toHaveLength(1);
    expect(await db().collection('stock_document_items').countDocuments({ document_id: new ObjectId(row.id) })).toBe(1);
    expect(await balance(products[0])).toMatchObject({ on_hand: before!.on_hand, reserved: before!.reserved, version: 0 });
    expect(await db().collection('stock_movements').countDocuments()).toBe(0);
    expect((await update(row.id, changed).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
    const key = randomUUID(); await update(row.id, { ...changed, version: 1 }, key).expect(200);
    expect((await update(row.id, { ...changed, version: 1 }, key).expect(200)).body.version).toBe(2);
    await post(row.id, 2).expect(200);
    expect((await update(row.id, { ...changed, version: 3 }).expect(409)).body.error.code).toBe('DOCUMENT_NOT_EDITABLE');
    await http().post(`${base}/${row.id}/post`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0, items: [] }).expect(400);
    await http().delete(`${base}/${row.id}`).set('Authorization', `Bearer ${staff.token}`).expect(404);
    await get(`/${new ObjectId()}`).expect(404);
    await db().collection('stock_documents').updateOne({ _id: new ObjectId(row.id) }, { $set: { kind: 'ISSUE' } }); await get(`/${row.id}`).expect(404);
  });

  it('TC09: two Node processes replay same key and new keys on POSTED exactly once, including stale draft versions', async () => {
    const row = (await create().expect(201)).body, key = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => processPost(i % 2, row.id, key)));
    for (const result of results) { expect(result.status).toBe(200); expect(result.body).toEqual(results[0].body); }
    const freshKeys = await Promise.all([processPost(0, row.id), processPost(1, row.id)]);
    freshKeys.forEach(result => { expect(result.status).toBe(200); expect(result.body).toEqual(results[0].body); });
    expect(await balance(products[0])).toMatchObject({ on_hand: 10, version: 1 });
    expect(await db().collection('stock_movements').countDocuments()).toBe(2);
    expect(await db().collection('stock_document_events').countDocuments({ action: 'POSTED' })).toBe(1);
    expect(await db().collection('operation_requests').countDocuments({ operation: 'STOCK_RECEIPT_POST' })).toBe(3);
    expect((await post(row.id, 1, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('TC10: two processes post different receipts on the same SKUs with continuous sequence and exact sum', async () => {
    const first = (await create().expect(201)).body, second = (await create().expect(201)).body;
    const results = await Promise.all([processPost(0, first.id), processPost(1, second.id)]); results.forEach(result => expect(result.status).toBe(200));
    for (const [i, id] of products.entries()) {
      const rows = await db().collection('stock_movements').find({ product_id: new ObjectId(id) }).sort({ sequence: 1 }).toArray();
      expect(rows.map(row => row.sequence)).toEqual([1, 2]); expect(rows[0].before_on_hand).toBe(0); expect(rows[1].before_on_hand).toBe(rows[0].after_on_hand);
      expect(await balance(id)).toMatchObject({ on_hand: i ? 10 : 20, reserved: 0, version: 2 });
      expect(rows.reduce((sum, row) => sum + row.on_hand_delta, 0)).toBe((await balance(id))!.on_hand);
      expect(rows[1].after_on_hand).toBe((await balance(id))!.on_hand);
    }
  });

  it('TC09: different keys racing the same DRAFT on two processes return one posted result', async () => {
    const row = (await create().expect(201)).body;
    const results = await Promise.all([processPost(0, row.id), processPost(1, row.id)]);
    results.forEach(result => expect(result.status).toBe(200)); expect(results[0].body).toEqual(results[1].body);
    expect(await db().collection('stock_document_events').countDocuments({ action: 'POSTED' })).toBe(1);
    expect(await db().collection('stock_movements').countDocuments()).toBe(2);
    expect(await balance(products[0])).toMatchObject({ on_hand: 10, version: 1 });
  });

  it('TC03/07/12: failure after draft replacement rolls back header/items/audit/key', async () => {
    const row = (await create().expect(201)).body, repo = apps[0].get(StockRepository), original = repo.replaceItems.bind(repo);
    const before = await countStock(), balances = [await balance(products[0]), await balance(products[1])], key = randomUUID();
    const spy = jest.spyOn(repo, 'replaceItems').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('FAIL_REPLACE'); });
    const changed = { ...input(), version: 0, items: [input().items[1]], sourceReference: 'NEW_SOURCE' };
    await update(row.id, changed, key).expect(500); spy.mockRestore();
    expect((await get(`/${row.id}`).expect(200)).body).toEqual(row); expect(await countStock()).toEqual(before);
    expect([await balance(products[0]), await balance(products[1])]).toEqual(balances);
    await update(row.id, changed, key).expect(200);
  });

  it('schema/index readiness: missing constraints block writes; unique movement/audit indexes protect ledger', async () => {
    const row = (await create().expect(201)).body;
    await db().collection('stock_movements').dropIndex('stock_movements_event_key_unique');
    expect((await post(row.id).expect(503)).body.error.code).toBe('STOCK_NOT_READY');
    await apps[0].get(StockRepository).movements.createIndexes();
    await post(row.id).expect(200);
    const movement = (await db().collection('stock_movements').findOne({ source_id: new ObjectId(row.id) }))!;
    await expect(db().collection('stock_movements').insertOne({ ...movement, _id: new ObjectId() })).rejects.toMatchObject({ code: 11000 });
    const event = (await db().collection('stock_document_events').findOne({ action: 'POSTED' }))!;
    await expect(db().collection('stock_document_events').insertOne({ ...event, _id: new ObjectId(), request_key: 'different-key' })).rejects.toMatchObject({ code: 11000 });
    const swagger = (await http().get('/api/docs-json').expect(200)).body;
    expect(swagger.components.schemas.CreateReceiptDto.required).toEqual(expect.arrayContaining(['reason', 'items']));
    expect(swagger.paths[`${base}/{id}/post`].post.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key', required: true })]));
  });

  it('TC11: concurrent draft replacement and posting accept one complete version, never mixed content', async () => {
    const row = (await create().expect(201)).body;
    const changed = { ...input(), version: 0, items: input().items.map(item => ({ ...item, quantity: 7 })) };
    const results = await Promise.all([update(row.id, changed, randomUUID(), 0), post(row.id, 0, randomUUID(), 1)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const detail = (await get(`/${row.id}`).expect(200)).body;
    if (detail.status === 'DRAFT') {
      expect(detail.items.every((item: { quantity: number }) => item.quantity === 7)).toBe(true); expect(await db().collection('stock_movements').countDocuments()).toBe(0);
      await post(row.id, 1).expect(200); expect(await balance(products[0])).toMatchObject({ on_hand: 7 }); expect(await balance(products[1])).toMatchObject({ on_hand: 7 });
    } else { expect(await balance(products[0])).toMatchObject({ on_hand: 10 }); expect(await balance(products[1])).toMatchObject({ on_hand: 5 }); }
  });

  it('TC12: failure after line2/movement/audit/operation writes rolls back everything, including locks and snapshots', async () => {
    const row = (await create().expect(201)).body, repo = apps[0].get(StockRepository), writer = apps[0].get(InventoryWriter), operations = apps[0].get(OperationRequestsRepository);
    const before = await countStock(), balances = [await balance(products[0]), await balance(products[1])];
    const guard = await db().collection('catalog_state').findOne({ _id: 'retail' } as never);
    for (const point of ['line2', 'audit', 'operation'] as const) {
      const originalMove = writer.insertMovement.bind(writer), originalAudit = repo.insertEvent.bind(repo), originalKey = operations.insert.bind(operations); let line = 0;
      const spy = point === 'line2' ? jest.spyOn(writer, 'insertMovement').mockImplementation(async (...args) => {
        const result = await originalMove(...args); if (++line === 2) throw new Error('FAIL_LINE2'); return result;
      }) : point === 'audit' ? jest.spyOn(repo, 'insertEvent').mockImplementation(async (...args) => { await originalAudit(...args); throw new Error('FAIL_AUDIT'); })
        : jest.spyOn(operations, 'insert').mockImplementation(async (...args) => { await originalKey(...args); throw new Error('FAIL_OPERATION'); });
      await post(row.id).expect(500); spy.mockRestore();
      expect(await countStock()).toEqual(before); expect([await balance(products[0]), await balance(products[1])]).toEqual(balances);
      expect(await db().collection('catalog_state').findOne({ _id: 'retail' } as never)).toEqual(guard);
      expect((await get(`/${row.id}`).expect(200)).body).toEqual(row);
    }
    await post(row.id).expect(200);
  });

  it('TC13: lost post response resolves by lookup/replay; unknown key is not evidence of failure', async () => {
    const row = (await create().expect(201)).body, service = apps[0].get(StockReceiptsService), original = service.post.bind(service), key = randomUUID();
    const spy = jest.spyOn(service, 'post').mockImplementationOnce(async (...args) => { await original(...args); throw new ApplicationError(503, 'OPERATION_OUTCOME_UNKNOWN', 'Response lost'); });
    await post(row.id, 0, key).expect(503); spy.mockRestore();
    const lookup = await http(1).get(`/api/operations/STOCK_RECEIPT_POST/${key}`).set('Authorization', `Bearer ${staff.token}`).expect(200);
    const replay = await post(row.id, 0, key).expect(200); expect(replay.body).toEqual(lookup.body.responseBody);
    expect(await balance(products[0])).toMatchObject({ on_hand: 10, version: 1 });
    await http().get(`/api/operations/STOCK_RECEIPT_POST/${key}`).set('Authorization', `Bearer ${admin.token}`).expect(404);
    await http().get(`/api/operations/STOCK_RECEIPT_POST/${randomUUID()}`).set('Authorization', `Bearer ${staff.token}`).expect(404);
  });

  it('TC14: missing/invalid inventory, Int32 ceiling and sequence ceiling abort all lines without upsert/reset/overflow', async () => {
    const row = (await create().expect(201)).body, collection = db().collection('inventory'), product_id = new ObjectId(products[1]);
    const good = (await collection.findOne({ product_id }, { promoteLongs: false }))!;
    const cases = [null, { on_hand: new Int32(0), reserved: new Int32(1) }, { on_hand: new Int32(-1) }, { on_hand: new Int32(2147483647) }, { version: new Int32(2147483647) }, { on_hand: 1.5 }];
    for (const bad of cases) {
      await collection.deleteOne({ product_id }); if (bad) await collection.insertOne({ ...good, ...bad });
      const result = await post(row.id).expect(409);
      expect(['INVENTORY_INTEGRITY_ERROR', 'STOCK_LIMIT_EXCEEDED']).toContain(result.body.error.code);
      expect(await balance(products[0])).toMatchObject({ on_hand: 0, version: 0 }); expect(await db().collection('stock_movements').countDocuments()).toBe(0);
      expect((await get(`/${row.id}`).expect(200)).body.status).toBe('DRAFT');
    }
    await collection.deleteOne({ product_id }); await collection.insertOne(good); await openingFixture(products[1], 2147483642);
    await post(row.id).expect(200); expect(await balance(products[1])).toMatchObject({ on_hand: 2147483647 });
  });

  it('TC15: catalog rename/deactivation race is serialized with posting; posted snapshots never change again', async () => {
    const row = (await create().expect(201)).body;
    const changed = http(1).patch(`/api/admin/products/${products[0]}`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0, name: 'Đổi tên cạnh tranh' });
    const stop = http().patch(`/api/admin/categories/${categoryId}`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0, status: 'INACTIVE' });
    const results = await Promise.all([post(row.id), changed, stop]); results.forEach(result => expect(result.status).toBe(200));
    const detail = (await get(`/${row.id}`).expect(200)).body;
    const movement = await db().collection('stock_movements').findOne({ product_id: new ObjectId(products[0]) });
    expect(['Hàng 0', 'Đổi tên cạnh tranh']).toContain(detail.items[0].nameSnapshot); expect(movement!.name_snapshot).toBe(detail.items[0].nameSnapshot);
    expect(detail.items[0].inactiveWarning).toBe(true); expect((await db().collection('categories').findOne({ _id: new ObjectId(categoryId) }))!.status).toBe('INACTIVE');
  });

  it('list: VN half-open date boundaries, literal search, default range, stable pagination and empty pages', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await create().expect(201)).body.id as string);
    const times = ['2026-10-31T16:59:59.999Z', '2026-10-31T17:00:00.000Z', '2026-11-01T16:59:59.999Z'];
    for (let i = 0; i < 3; i++) await db().collection('stock_documents').updateOne({ _id: new ObjectId(ids[i]) }, { $set: { created_at: new Date(times[i]) } });
    const page = (await get('?fromDate=2026-11-01&toDate=2026-11-01&limit=1').expect(200)).body;
    expect(page).toMatchObject({ total: 2, totalPages: 2 }); expect(page.items[0].id).toBe(ids[2]);
    expect((await get('?fromDate=2026-11-01&toDate=2026-11-01&limit=1&page=2').expect(200)).body.items[0].id).toBe(ids[1]);
    expect((await get('?q=.%2A').expect(200)).body).toMatchObject({ items: [], totalPages: 0 });
    expect((await get(`?q=${ids[1]}&fromDate=2026-11-01&toDate=2026-11-01`).expect(200)).body.total).toBe(1);
    await db().collection('stock_documents').updateMany({}, { $set: { created_at: new Date('2020-01-01T00:00:00Z') } });
    expect((await get().expect(200)).body.total).toBe(0);
    // Tampered stored line is revalidated at posting, without creating any partial stock writes.
    await db().collection('stock_document_items').updateOne({ document_id: new ObjectId(ids[0]) }, { $set: { unit_cost: Decimal128.fromString('0.5') } });
    expect((await post(ids[0]).expect(409)).body.error.code).toBe('INVENTORY_INTEGRITY_ERROR');
  });
});
