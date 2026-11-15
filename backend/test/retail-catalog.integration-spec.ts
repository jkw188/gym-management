import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Int32, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { configureHttp } from '../src/common/http/configure-http';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { RetailCatalogRepository } from '../src/modules/catalog/retail-catalog.repository';
import { ensureRetailCatalogIntegrity } from '../src/modules/catalog/retail-catalog.migration';
import { RetailCatalogService } from '../src/modules/catalog/retail-catalog.service';
import { ApplicationError } from '../src/common/errors/application-error';
import { UsersRepository } from '../src/modules/users/users.repository';

type Actor = { id: string; token: string };
const base = '/api/admin', origin = 'http://localhost:5173';
describe('US-34: catalog transactions, policy, migration and two application instances', () => {
  let mongo: MongoMemoryReplSet, connection: Connection, admin: Actor;
  const apps: INestApplication[] = [], saved = { ...process.env };
  const db = () => connection.db!;
  const http = (index = 0) => request(apps[index].getHttpServer());
  let sequence = 0;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_us34', FRONTEND_ORIGIN: origin,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'no-reply@gym.test' });
    const { AppModule } = await import('../src/app.module');
    for (let index = 0; index < 2; index++) {
      const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
      apps.push(app); configureHttp(app); await app.init();
      await Promise.all(Object.values(app.get<Connection>(getConnectionToken()).models).map(model => model.init()));
    }
    connection = apps[0].get<Connection>(getConnectionToken());
  }, 600000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const app of apps) { const limiter = new LoginLimiter(); jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter)); }
    for (const collection of await db().collections()) if (collection.collectionName !== 'roles') await collection.deleteMany({});
    await ensureRetailCatalogIntegrity(connection);
    admin = await login('ADMIN');
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { for (const app of apps) await app.close(); await mongo?.stop(); process.env = saved; });
  async function login(code: 'ADMIN' | 'TRAINER' | 'STAFF' | 'MEMBER'): Promise<Actor> {
    const users = apps[0].get(UsersRepository), role = await users.ensureRole(code, code), password = 'US34 test password 123';
    const account = await users.createAccount({ roleId: String(role.id), fullName: `US34 ${code}`, phone: `093340${String(++sequence).padStart(4, '0')}`,
      passwordHash: await apps[0].get(PasswordService).hash(password) });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
    return { id: String(account._id), token: response.body.accessToken as string };
  }
  const post = (kind: string, body: object, key = randomUUID(), actor = admin, index = 0) => http(index).post(`${base}/${kind}`)
    .set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send(body);
  const patch = (kind: string, id: string, body: object, key = randomUUID(), index = 0) => http(index).patch(`${base}/${kind}/${id}`)
    .set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', key).send(body);
  const get = (path: string, actor = admin) => http().get(`${base}/${path}`).set('Authorization', `Bearer ${actor.token}`);
  const draft = (categoryId: string, sku = 'water_01') => ({ categoryId, sku, name: ' Nước suối ', price: '0000', status: 'ACTIVE' });
  async function category(name = ' Đồ uống ', status = 'ACTIVE'): Promise<string> { return (await post('categories', { name, status }).expect(201)).body.id as string; }
  async function product(categoryId: string): Promise<string> { return (await post('products', draft(categoryId)).expect(201)).body.id as string; }

  it('TC01/03: normalization, unique indexes, money projection and exact zero inventory/audit commit', async () => {
    const categoryId = await category(' Đồ uống '.normalize('NFD'));
    const result = await post('products', { ...draft(categoryId), description: ' ', imageUrl: '' }).expect(201);
    expect(result.body).toMatchObject({ sku: 'WATER_01', name: 'Nước suối', price: '0', version: 0, effectiveActive: true, imageUrl: null, description: null });
    expect(JSON.stringify(result.body)).not.toMatch(/created_by|updated_by|guard_revision|reserved|on_hand|unitCost|name_key/);
    const inventory = await db().collection('inventory').findOne({ product_id: new ObjectId(result.body.id) }, { promoteLongs: false });
    expect(inventory).toMatchObject({ on_hand: 0, reserved: 0, version: 0 }); expect(Long.isLong(inventory!.guard_revision)).toBe(true);
    expect((await db().collection('inventory').aggregate([{ $project: { versionType: { $type: '$version' }, handType: { $type: '$on_hand' } } }]).toArray())[0]).toMatchObject({ versionType: 'int', handType: 'int' });
    expect(await db().collection('catalog_events').countDocuments()).toBe(2);
    expect(await db().collection('inventory_movements').countDocuments()).toBe(0);
    expect((await post('categories', { name: 'đồ uống', status: 'INACTIVE' }).expect(409)).body.error.code).toBe('CATEGORY_NAME_EXISTS');
    await category('Do uong');
    expect((await post('products', draft(categoryId, ' WATER_01 ')).expect(409)).body.error.code).toBe('SKU_EXISTS');
    expect(await db().collection('inventory').countDocuments()).toBe(1);
  });
  it('TC02: roles, revoked sessions and replay/lookup current permission', async () => {
    await http().post(`${base}/categories`).send({ name: 'X', status: 'ACTIVE' }).expect(401);
    for (const role of ['TRAINER', 'STAFF', 'MEMBER'] as const) {
      const actor = await login(role);
      await get('categories', actor).expect(403); await get('products', actor).expect(403);
      await post('categories', { name: 'X', status: 'ACTIVE' }, randomUUID(), actor).expect(403);
      await post('products', draft(String(new ObjectId())), randomUUID(), actor).expect(403);
    }
    const key = randomUUID(), input = { name: 'X', status: 'ACTIVE' };
    await post('categories', input, key).expect(201);
    await db().collection('auth_sessions').updateMany({ account_id: new ObjectId(admin.id) }, { $set: { revoked_at: new Date() } });
    await post('categories', input, key).expect(401);
    await http().get(`/api/operations/CATEGORY_CREATE/${key}`).set('Authorization', `Bearer ${admin.token}`).expect(401);
    expect(await db().collection('catalog_events').countDocuments()).toBe(1);
  });
  it('TC04/13: rejects non-allowlisted input, nulls, unsafe images, invalid money/SKU/query; optional clear works', async () => {
    const categoryId = await category();
    for (const extra of [{ price: 1.1 }, { price: '1.1' }, { price: '1e2' }, { price: '1000000000000' }, { sku: 'á' }, { sku: 'a b' },
      { onHand: 1 }, { reserved: 1 }, { available: 1 }, { unitCost: '1' }, { stockDelta: 1 }, { createdBy: admin.id }, { price: null },
      { name: null }, { categoryId: null }, { status: null }, { imageUrl: 'javascript:alert(1)' }, { imageUrl: 'data:image/png;base64,xxx' },
      { imageUrl: 'file:///tmp/x' }, { imageUrl: '//evil.test/a.png' }, { imageUrl: 'https://user:pass@a.test/a.png' }]) {
      await post('products', { ...draft(categoryId), ...extra }).expect(400);
    }
    await post('categories', { name: 'X', status: 'ACTIVE', nameKey: 'x' }).expect(400);
    await get('products?categoryId=bad').expect(400); await get('products?sort=price').expect(400); await get('categories?status=bad').expect(400);
    await get('products?limit=101').expect(400); await get('products?page=1.5').expect(400);
    const row = (await post('products', { ...draft(categoryId), price: '999999999999', description: '<b>text</b>', imageUrl: 'https://example.test/image.png' }).expect(201)).body;
    await patch('products', row.id, { version: 0 }).expect(400); await patch('products', row.id, { version: null, name: 'X' }).expect(400);
    await patch('products', row.id, { version: 0, sku: 'OTHER' }).expect(400);
    const updated = await patch('products', row.id, { version: 0, description: null, imageUrl: ' ' }).expect(200);
    expect(updated.body).toMatchObject({ version: 1, description: null, imageUrl: null, price: '999999999999' });
    const raw = await db().collection('products').findOne({ _id: new ObjectId(row.id) }); expect(raw).not.toHaveProperty('image_url'); expect(raw).not.toHaveProperty('description');
  });
  it('TC05/06/07/08: effective status, content edit under stopped category, price and reserved/snapshot isolation', async () => {
    const categoryId = await category(), productId = await product(categoryId), stopped = await category('Ẩn', 'INACTIVE');
    await post('products', draft(stopped)).expect(409);
    const inactive = (await post('products', { ...draft(stopped, 'HIDDEN'), status: 'INACTIVE' }).expect(201)).body;
    await patch('products', inactive.id, { version: 0, status: 'ACTIVE' }).expect(409);
    await patch('products', productId, { version: 0, categoryId: stopped }).expect(409);
    await db().collection('inventory').updateOne({ product_id: new ObjectId(productId) }, { $set: { on_hand: new Int32(10), reserved: new Int32(3) } });
    await db().collection('orders').insertOne({ product_id: new ObjectId(productId), unit_price: '5000', quantity: 3, status: 'PENDING' });
    const beforeStock = await db().collection('inventory').findOne({ product_id: new ObjectId(productId) });
    const beforeOrder = await db().collection('orders').findOne({ product_id: new ObjectId(productId) });
    expect((await get(`categories/${categoryId}`).expect(200)).body.affectedActiveProductCount).toBe(1);
    await patch('categories', categoryId, { version: 0, status: 'INACTIVE' }).expect(200);
    expect((await get(`products/${productId}`).expect(200)).body).toMatchObject({ status: 'ACTIVE', effectiveActive: false });
    expect((await patch('products', productId, { version: 0, name: 'Tên mới', price: '7000' }).expect(200)).body).toMatchObject({ status: 'ACTIVE', effectiveActive: false, price: '7000' });
    await patch('categories', categoryId, { version: 1, status: 'ACTIVE' }).expect(200);
    expect((await get(`products/${productId}`).expect(200)).body.effectiveActive).toBe(true);
    await patch('products', productId, { version: 1, status: 'INACTIVE' }).expect(200);
    expect(await db().collection('inventory').findOne({ product_id: new ObjectId(productId) })).toEqual(beforeStock);
    expect(await db().collection('orders').findOne({ product_id: new ObjectId(productId) })).toEqual(beforeOrder);
    await post('products', draft(categoryId)).expect(409);
    await http().delete(`${base}/products/${productId}`).set('Authorization', `Bearer ${admin.token}`).expect(404);
    await http().delete(`${base}/categories/${categoryId}`).set('Authorization', `Bearer ${admin.token}`).expect(404);
  });
  it('list/detail: literal search, raw status, stable pages, 404 and private projection', async () => {
    const swagger = (await http().get('/api/docs-json').expect(200)).body;
    expect(swagger.paths['/api/admin/products'].post.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key', required: true })]));
    expect(swagger.components.schemas.CreateRetailProductDto.required).toEqual(expect.arrayContaining(['categoryId', 'sku', 'name', 'price', 'status']));
    expect(swagger.components.schemas.UpdateRetailProductDto.properties).not.toHaveProperty('sku');
    expect(swagger.components.schemas.RetailProductResponseDto.properties).toHaveProperty('effectiveActive');
    expect(swagger.components.schemas.RetailProductResponseDto.properties).not.toHaveProperty('reserved');
    const categoryId = await category('A [x]'), productId = await product(categoryId);
    await category('B'); await category('C', 'INACTIVE');
    expect((await get('categories?q=%5Bx%5D').expect(200)).body.total).toBe(1);
    expect((await get('categories?q=.*').expect(200)).body).toMatchObject({ items: [], totalPages: 0 });
    expect((await get('categories?limit=2').expect(200)).body).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
    await patch('categories', categoryId, { version: 0, status: 'INACTIVE' }).expect(200);
    const list = await get(`products?categoryId=${categoryId}&status=ACTIVE&q=water`).expect(200);
    expect(list.body.items).toHaveLength(1); expect(list.body.items[0]).toMatchObject({ id: productId, status: 'ACTIVE', effectiveActive: false });
    expect(JSON.stringify(list.body)).not.toMatch(/created_by|updated_by|name_key|guard_revision|on_hand|reserved/);
    await get(`products/${new ObjectId()}`).expect(404); await get('products/invalid').expect(400);
    await get(`categories/${new ObjectId()}`).expect(404); await get(`products/${productId}?stock=1`).expect(400);
  });
  it('TC09/10: two apps race SKU, category deactivation and CAS; same-key replay has one audit/inventory', async () => {
    const categoryId = await category();
    const created = await Promise.all([post('products', draft(categoryId), randomUUID(), admin, 0), post('products', draft(categoryId), randomUUID(), admin, 1)]);
    expect(created.map(result => result.status).sort()).toEqual([201, 409]);
    const productId = created.find(result => result.status === 201)!.body.id as string;
    const updates = await Promise.all([patch('products', productId, { version: 0, price: '1000' }, randomUUID(), 0), patch('products', productId, { version: 0, price: '2000' }, randomUUID(), 1)]);
    expect(updates.map(result => result.status).sort()).toEqual([200, 409]);
    expect(updates.find(result => result.status === 409)!.body.error.code).toBe('VERSION_CONFLICT');
    const key = randomUUID(), input = { ...draft(categoryId, 'REPLAY'), description: ' Chai nước ' };
    const replays = await Promise.all(Array.from({ length: 8 }, (_, index) => post('products', input, key, admin, index % 2)));
    for (const result of replays) { expect(result.status).toBe(201); expect(result.body).toEqual(replays[0].body); }
    expect(await db().collection('products').countDocuments({ sku: 'REPLAY' })).toBe(1);
    expect(await db().collection('inventory').countDocuments()).toBe(2);
    expect(await db().collection('catalog_events').countDocuments({ entity_type: 'PRODUCT' })).toBe(3);
    const raceCategory = await category('Race');
    const race = await Promise.all([patch('categories', raceCategory, { version: 0, status: 'INACTIVE' }, randomUUID(), 0),
      post('products', draft(raceCategory, 'RACE'), randomUUID(), admin, 1)]);
    expect(race[0].status).toBe(200); expect([201, 409]).toContain(race[1].status);
    if (race[1].status === 201) expect((await get(`products/${race[1].body.id}`).expect(200)).body.effectiveActive).toBe(false);
    else expect(race[1].body.error.code).toBe('CATEGORY_NOT_ACTIVE');
  });
  it('TC11: inventory/audit exceptions abort product, state revision and operation record; same key retries safely', async () => {
    const categoryId = await category(), repository = apps[0].get(RetailCatalogRepository);
    for (const method of ['insertInventory', 'insertEvent'] as const) {
      const before = await db().collection('catalog_state').findOne({ _id: 'retail' } as never);
      const spy = jest.spyOn(repository, method).mockRejectedValueOnce(new Error('INJECTED_BEFORE_COMMIT'));
      const key = randomUUID(); await post('products', draft(categoryId), key).expect(500); spy.mockRestore();
      expect(await db().collection('products').countDocuments()).toBe(0); expect(await db().collection('inventory').countDocuments()).toBe(0);
      expect(await db().collection('catalog_events').countDocuments()).toBe(1);
      expect(await db().collection('operation_requests').countDocuments({ operation: 'PRODUCT_CREATE' })).toBe(0);
      expect(await db().collection('catalog_state').findOne({ _id: 'retail' } as never)).toEqual(before);
    }
    await product(categoryId);
  });
  it('TC12: discarded response, normalized replay/lookup and changed payload conflict', async () => {
    const categoryId = await category(), key = randomUUID(), input = draft(categoryId);
    const service = apps[0].get(RetailCatalogService), save = service.saveProduct.bind(service);
    // Commit succeeds but the caller receives an unknown outcome instead of the committed response.
    const lost = jest.spyOn(service, 'saveProduct').mockImplementationOnce(async (...args) => {
      await save(...args); throw new ApplicationError(503, 'OPERATION_OUTCOME_UNKNOWN', 'Response lost after commit');
    });
    await post('products', { ...input, description: '', imageUrl: null }, key).expect(503); lost.mockRestore();
    const committed = await post('products', input, key).expect(201);
    const lookup = await http(1).get(`/api/operations/PRODUCT_CREATE/${key}`).set('Authorization', `Bearer ${admin.token}`).expect(200);
    expect(lookup.body.responseBody).toEqual(committed.body);
    expect((await post('products', { ...input, sku: ' WATER_01 ', name: 'Nước suối', price: '0' }, key, admin, 1).expect(201)).body).toEqual(committed.body);
    expect((await post('products', { ...input, price: '1' }, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await http().get(`/api/operations/PRODUCT_CREATE/${randomUUID()}`).set('Authorization', `Bearer ${admin.token}`).expect(404)).body.error.code).toBe('OPERATION_UNKNOWN');
    expect(await db().collection('products').countDocuments()).toBe(1);
  });
  it('TC14: migration blocks normalized duplicates, orphans/missing inventory and absent guard/index; never resets stock', async () => {
    const categoryId = await category(), productId = await product(categoryId);
    const rawCategory = await db().collection('categories').findOne({ _id: new ObjectId(categoryId) });
    const duplicateId = new ObjectId();
    await db().collection('categories').insertOne({ ...rawCategory!, _id: duplicateId, id: duplicateId, name: 'đồ uống'.normalize('NFD'), name_key: 'temporary' });
    await expect(ensureRetailCatalogIntegrity(connection)).rejects.toThrow('CATALOG_DATA_INVALID: category_name/');
    await expect(apps[0].get(RetailCatalogRepository).onModuleInit()).rejects.toThrow('CATALOG_DATA_INVALID: category_name/');
    await db().collection('categories').deleteOne({ _id: duplicateId });
    const rawProduct = await db().collection('products').findOne({ _id: new ObjectId(productId) });
    await db().collection('products').insertOne({ ...rawProduct!, _id: duplicateId, id: duplicateId, sku: 'water_01' });
    await expect(ensureRetailCatalogIntegrity(connection)).rejects.toThrow('CATALOG_DATA_INVALID: sku/');
    await db().collection('products').deleteOne({ _id: duplicateId });
    await db().collection('products').updateOne({ _id: new ObjectId(productId) }, { $set: { category_id: new ObjectId() } });
    await expect(ensureRetailCatalogIntegrity(connection)).rejects.toThrow('CATALOG_DATA_INVALID: product/');
    await db().collection('products').updateOne({ _id: new ObjectId(productId) }, { $set: { category_id: new ObjectId(categoryId) } });
    const inventory = await db().collection('inventory').findOne({ product_id: new ObjectId(productId) });
    await db().collection('inventory').deleteOne({ _id: inventory!._id });
    await expect(ensureRetailCatalogIntegrity(connection)).rejects.toThrow('inventory_reconciliation');
    expect(await db().collection('inventory').countDocuments()).toBe(0);
    await db().collection('inventory').insertOne({ ...inventory!, on_hand: new Int32(12), reserved: new Int32(3) });
    await ensureRetailCatalogIntegrity(connection); await ensureRetailCatalogIntegrity(connection);
    expect(await db().collection('inventory').findOne({ product_id: new ObjectId(productId) })).toMatchObject({ on_hand: 12, reserved: 3 });
    await db().collection('catalog_state').deleteMany({});
    expect((await post('categories', { name: 'Blocked', status: 'ACTIVE' }).expect(503)).body.error.code).toBe('CATALOG_NOT_READY');
    await ensureRetailCatalogIntegrity(connection);
    await db().collection('products').dropIndex('products_sku_unique');
    expect((await post('products', draft(categoryId, 'BLOCKED')).expect(503)).body.error.code).toBe('CATALOG_NOT_READY');
    await ensureRetailCatalogIntegrity(connection);
  });
});
