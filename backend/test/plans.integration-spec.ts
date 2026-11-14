import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { PlanReaderService } from '../src/modules/plans/plan-reader.service';
import { PlanDto, PolicyDto } from '../src/modules/plans/plans.dto';
import { Plan } from '../src/modules/plans/schemas/plan.schema';
import { AccessCatalogService } from '../src/modules/users/access-catalog.service';
import { RoleCode, ROLE_CODES } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

const base = '/api/admin/plans', policyBase = '/api/admin/plan-policies';
const valid = { code: 'GYM_30', name: 'Gym 30 ngày', kind: 'GYM', durationDays: 30, sessionsQuota: 0, price: '500000', benefits: 'Tập luyện tại phòng Gym' };

describe('US-12: API, BSON constraints and races on real MongoDB replica set', () => {
  const savedEnv = { ...process.env };
  const apps: INestApplication[] = [];
  const tokens = {} as Record<RoleCode, string>;
  let mongo: MongoMemoryReplSet, connection: Connection;
  let sequence = 0;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: 'http://localhost:5173',
      MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_us12', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url') });
    const { AppModule } = await import('../src/app.module');
    for (let i = 0; i < 2; i++) {
      const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
      apps.push(app); configureHttp(app); await app.init();
    }
    connection = apps[0].get(getConnectionToken());
    expect(apps[1].get(getConnectionToken())).not.toBe(connection);
    await apps[0].get(AccessCatalogService).seed();
    const users = apps[0].get(UsersRepository), password = 'US12 test password 123';
    const hash = await apps[0].get(PasswordService).hash(password);
    for (const code of ROLE_CODES) {
      const role = await users.findRoleByCode(code);
      const account = await users.createAccount({ roleId: role!.id.toHexString(), fullName: `Test ${code}`, phone: `098000000${++sequence}`, passwordHash: hash });
      const login = await request(apps[0].getHttpServer()).post('/api/auth/login').set('Origin', 'http://localhost:5173').send({ phone: account.phone, password }).expect(200);
      tokens[code] = login.body.accessToken;
    }
  }, 180000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const name of ['plans', 'plan_conversion_policies', 'service_sales', 'transactions', 'invoices']) await connection.collection(name).deleteMany({});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { for (const app of apps) await app.close(); await mongo?.stop(); process.env = savedEnv; });
  const api = (index = 0) => request(apps[index].getHttpServer());
  const auth = () => `Bearer ${tokens.ADMIN}`;
  async function create(overrides: object = {}): Promise<PlanDto> {
    return (await api().post(base).set('Authorization', auth()).send({ ...valid, code: `PLAN_${++sequence}`, ...overrides }).expect(201)).body;
  }
  async function policy(from: PlanDto, to: PlanDto, status = 'ACTIVE'): Promise<PolicyDto> {
    return (await api().post(policyBase).set('Authorization', auth()).send({ fromPlanId: from.id, toPlanId: to.id, status }).expect(201)).body;
  }
  const patch = (plan: PlanDto, changes: object, instance = 0) => api(instance).patch(`${base}/${plan.id}`).set('Authorization', auth()).send({ version: plan.version, ...changes });

  it('TC01: GYM/PT, normalized unique code, Decimal128, Int32 version and Int64 guard', async () => {
    const gym = await create({ code: ' gym_30 ', price: '000000000000500000' });
    const pt = await create({ kind: 'PT', sessionsQuota: 12, price: '0' });
    expect(gym).toMatchObject({ code: 'GYM_30', version: 0, status: 'ACTIVE', sessionsQuota: 0, price: '500000' });
    expect(pt.sessionsQuota).toBe(12);
    expect(gym).not.toHaveProperty('guardRevision'); expect(gym).not.toHaveProperty('createdBy');
    const [types] = await connection.collection('plans').aggregate([{ $match: { _id: new ObjectId(gym.id) } },
      { $project: { price: { $type: '$price' }, version: { $type: '$version' }, guard: { $type: '$guard_revision' } } }]).toArray();
    expect(types).toMatchObject({ price: 'decimal', version: 'int', guard: 'long' });
  });

  const endpoints: { method: 'get' | 'post' | 'patch'; path: string }[] = [
    { method: 'get', path: base }, { method: 'get', path: `${base}/${new ObjectId()}` }, { method: 'post', path: base },
    { method: 'patch', path: `${base}/${new ObjectId()}` }, { method: 'get', path: policyBase },
    { method: 'post', path: policyBase }, { method: 'patch', path: `${policyBase}/${new ObjectId()}` },
  ];
  it.each(endpoints)('TC02: $method $path rejects Guest/STAFF/TRAINER/MEMBER', async endpoint => {
    for (const role of [undefined, 'STAFF', 'TRAINER', 'MEMBER'] as const) {
      const call = api()[endpoint.method](endpoint.path);
      if (role) call.set('Authorization', `Bearer ${tokens[role]}`);
      await call.send({}).expect(role ? 403 : 401);
    }
    expect(await connection.collection('plans').countDocuments()).toBe(0);
    expect(await connection.collection('plan_conversion_policies').countDocuments()).toBe(0);
  });
  it.each([
    [{ durationDays: 0 }, 'durationDays'], [{ durationDays: 1.5 }, 'durationDays'], [{ durationDays: '30' }, 'durationDays'],
    [{ kind: 'PT', sessionsQuota: 0 }, 'sessionsQuota'], [{ sessionsQuota: 1 }, 'sessionsQuota'],
    [{ price: '10.5' }, 'price'], [{ price: '-1' }, 'price'], [{ price: 100 }, 'price'], [{ price: '1000000000000' }, 'price'],
    [{ name: ' ' }, 'name'], [{ benefits: '' }, 'benefits'],
  ])('TC03: invalid product %j reports %s', async (changes, field) => {
    const response = await api().post(base).set('Authorization', auth()).send({ ...valid, ...changes }).expect(400);
    expect(response.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
    expect(response.body.requestId).toBeTruthy();
  });
  it('TC04/14: unique uppercase code and immutable/unknown PATCH fields', async () => {
    const plan = await create({ code: 'gym_30' });
    const duplicate = await api().post(base).set('Authorization', auth()).send({ ...valid, code: ' Gym_30 ' }).expect(409);
    expect(duplicate.body.error.code).toBe('PLAN_CODE_EXISTS');
    for (const changes of [{ kind: 'PT' }, { code: 'OTHER' }, { name: null }, { version: null }]) await patch(plan, changes).expect(400);
    expect((await api().get(`${base}?q=GYM_30`).set('Authorization', auth()).expect(200)).body.items[0].id).toBe(plan.id);
    await api().delete(`${base}/${plan.id}`).set('Authorization', auth()).expect(404);
  });
  it('TC05/06: two PATCH requests have one winner; no-op preserves version/timestamp, stale no-op conflicts', async () => {
    const plan = await create();
    const unchanged = await patch(plan, { name: plan.name }).expect(200);
    expect(unchanged.body).toEqual({ plan, changed: false });
    const results = await Promise.all([patch(plan, { price: '600000' }, 0), patch(plan, { price: '700000' }, 1)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.find(r => r.status === 409)!.body.error.code).toBe('VERSION_CONFLICT');
    const fresh = (await api().get(`${base}/${plan.id}`).set('Authorization', auth()).expect(200)).body;
    expect(fresh.version).toBe(1);
    expect((await patch(plan, { price: fresh.price }).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
    const [types] = await connection.collection('plans').aggregate([{ $project: { version: { $type: '$version' }, guard: { $type: '$guard_revision' } } }]).toArray();
    expect(types).toMatchObject({ version: 'int', guard: 'long' });
  });

  // Contract probe for the future US-14: the real US-12 reader and shared EN-02 transaction/lock.
  // No public sale API or settlement flow is claimed by these tests.
  function sale(plan: PlanDto, index = 1) {
    const runner = apps[index].get(TransactionRunner), reader = apps[index].get(PlanReaderService);
    const db = apps[index].get<Connection>(getConnectionToken()).db!;
    return runner.run(async session => {
      const snapshot = await reader.readForSale(session, plan.id, plan.version);
      const transactionId = new ObjectId();
      await db.collection('transactions').insertOne({ _id: transactionId, code: `TX-${transactionId.toHexString()}`,
        request_key: transactionId.toHexString(), status: 'PENDING', amount_due: snapshot.price, guard_revision: Long.ZERO }, { session });
      await db.collection('service_sales').insertOne({ transaction_id: transactionId, plan_snapshot: snapshot }, { session });
      return snapshot;
    });
  }
  it('TC07: stopping and sale serialize; a sale after stopping is rejected', async () => {
    const plan = await create();
    const [saleResult, stopResult] = await Promise.allSettled([sale(plan), patch(plan, { status: 'INACTIVE' })]);
    expect(stopResult.status).toBe('fulfilled');
    if (stopResult.status === 'fulfilled') expect(stopResult.value.status).toBe(200);
    if (saleResult.status === 'rejected') expect(saleResult.reason.code).toBe('PLAN_CHANGED');
    expect(await connection.collection('service_sales').countDocuments()).toBe(saleResult.status === 'fulfilled' ? 1 : 0);
    await expect(sale(plan)).rejects.toMatchObject({ status: 409, code: 'PLAN_CHANGED' });
  });
  it('TC08/13: historical snapshots/invoices stay unchanged; new sale reads new price', async () => {
    const plan = await create(); await sale(plan);
    await connection.collection('invoices').insertOne({ transaction_id: new ObjectId(), amount: '500000' });
    const historical = await connection.collection('service_sales').find().toArray();
    const transactions = await connection.collection('transactions').find().toArray();
    const invoices = await connection.collection('invoices').find().toArray();
    const changed = await patch(plan, { price: '800000' }).expect(200);
    expect(await sale(changed.body.plan)).toMatchObject({ price: '800000', version: 1 });
    expect((await connection.collection('service_sales').findOne({ _id: historical[0]._id }))).toEqual(historical[0]);
    expect(await connection.collection('transactions').findOne({ _id: transactions[0]._id })).toEqual(transactions[0]);
    expect(await connection.collection('invoices').find().toArray()).toEqual(invoices);
  });
  it('TC08: price change racing sale commits one coherent version', async () => {
    const plan = await create();
    const [result, updated] = await Promise.allSettled([sale(plan), patch(plan, { price: '800000' })]);
    expect(updated.status).toBe('fulfilled');
    if (updated.status === 'fulfilled') expect(updated.value.status).toBe(200);
    if (result.status === 'fulfilled') expect(result.value).toMatchObject({ price: '500000', version: 0 });
    else expect(result.reason.code).toBe('PLAN_CHANGED');
  });
  it('TC09: invalid ACTIVE edges are rejected; INACTIVE draft is allowed; self edge always rejected', async () => {
    const from = await create(), lower = await create({ price: '400000' }), pt = await create({ kind: 'PT', sessionsQuota: 5, price: '900000' });
    await api().post(policyBase).set('Authorization', auth()).send({ fromPlanId: from.id, toPlanId: from.id, status: 'INACTIVE' }).expect(400);
    for (const to of [lower, pt]) {
      const failed = await api().post(policyBase).set('Authorization', auth()).send({ fromPlanId: from.id, toPlanId: to.id, status: 'ACTIVE' }).expect(409);
      expect(failed.body.error.code).toBe('POLICY_CONFLICT');
      const draft = await policy(from, to, 'INACTIVE');
      await api().patch(`${policyBase}/${draft.id}`).set('Authorization', auth()).send({ version: 0, status: 'ACTIVE' }).expect(409);
    }
    const ptHigh = await create({ kind: 'PT', sessionsQuota: 4, price: '1000000' });
    await api().post(policyBase).set('Authorization', auth()).send({ fromPlanId: pt.id, toPlanId: ptHigh.id, status: 'ACTIVE' }).expect(409);
  });
  it('TC10/14: concurrent same pair has one policy, can recover by fromPlanId lookup', async () => {
    const from = await create(), to = await create({ price: '900000' });
    const results = await Promise.all([0, 1].map(index => api(index).post(policyBase).set('Authorization', auth()).send({ fromPlanId: from.id, toPlanId: to.id, status: 'ACTIVE' })));
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(results.find(r => r.status === 409)!.body.error.code).toBe('POLICY_EXISTS');
    const listed = await api().get(`${policyBase}?fromPlanId=${from.id}`).set('Authorization', auth()).expect(200);
    expect(listed.body.total).toBe(1); expect(listed.body.items[0].ruleCode).toBe('PRORATED_REMAINING_DAYS_V1');
    expect(await connection.collection('plan_conversion_policies').countDocuments()).toBe(1);
  });
  it('TC11/13: policy prevents invalid price/quota; explicit stopping permits plan change', async () => {
    const from = await create({ kind: 'PT', sessionsQuota: 5 }), to = await create({ kind: 'PT', sessionsQuota: 8, price: '900000' });
    const edge = await policy(from, to);
    for (const changes of [{ price: '400000' }, { sessionsQuota: 4 }]) {
      const conflict = await patch(to, changes).expect(409);
      expect(conflict.body.error.code).toBe('POLICY_CONFLICT'); expect(conflict.body.error.details[0].message).toContain(edge.id);
    }
    const stopped = await api().patch(`${policyBase}/${edge.id}`).set('Authorization', auth()).send({ version: 0, status: 'INACTIVE' }).expect(200);
    expect(stopped.body.policy.version).toBe(1);
    await patch(to, { price: '400000', sessionsQuota: 4, status: 'INACTIVE' }).expect(200);
    await api().patch(`${policyBase}/${edge.id}`).set('Authorization', auth()).send({ version: 1, status: 'ACTIVE' }).expect(409);
  });
  it('TC13: stopping/resuming a plan leaves policy and historical sales untouched; activating still requires ACTIVE endpoints', async () => {
    const from = await create(), to = await create({ price: '900000' }), edge = await policy(from, to);
    await sale(from);
    const historical = await connection.collection('service_sales').find().toArray();
    const stopped = await patch(to, { status: 'INACTIVE' }).expect(200);
    const unchanged = await api().get(`${policyBase}?fromPlanId=${from.id}`).set('Authorization', auth()).expect(200);
    expect(unchanged.body.items).toEqual([edge]);
    await api().patch(`${policyBase}/${edge.id}`).set('Authorization', auth()).send({ version: 0, status: 'INACTIVE' }).expect(200);
    await api().patch(`${policyBase}/${edge.id}`).set('Authorization', auth()).send({ version: 1, status: 'ACTIVE' }).expect(409);
    await patch(stopped.body.plan, { status: 'ACTIVE' }).expect(200);
    await api().patch(`${policyBase}/${edge.id}`).set('Authorization', auth()).send({ version: 1, status: 'ACTIVE' }).expect(200);
    expect(await connection.collection('service_sales').find().toArray()).toEqual(historical);
  });
  it('TC12: policy activation racing target price cannot commit invalid ACTIVE policy', async () => {
    for (let i = 0; i < 5; i++) {
      const from = await create(), to = await create({ price: '900000' }), edge = await policy(from, to, 'INACTIVE');
      const results = await Promise.all([
        api(1).patch(`${policyBase}/${edge.id}`).set('Authorization', auth()).send({ version: 0, status: 'ACTIVE' }),
        patch(to, { price: '400000' }),
      ]);
      expect(results.map(r => r.status).sort()).toEqual([200, 409]);
      expect(results.find(r => r.status === 409)!.body.error.code).toBe('POLICY_CONFLICT');
      const storedEdge = await connection.collection('plan_conversion_policies').findOne({ _id: new ObjectId(edge.id) });
      const storedPlan = await connection.collection('plans').findOne({ _id: new ObjectId(to.id) });
      if (storedEdge!.status === 'ACTIVE') expect(storedPlan!.price.toString()).toBe('900000');
    }
  });
  it('TC12: two policies on shared endpoints serialize and stale no-op stays stale', async () => {
    const from = await create(), to = await create({ price: '900000' }), edge = await policy(from, to);
    const unchanged = await api().patch(`${policyBase}/${edge.id}`).set('Authorization', auth()).send({ version: 0, status: 'ACTIVE' }).expect(200);
    expect(unchanged.body).toEqual({ policy: edge, changed: false });
    const results = await Promise.all([0, 1].map(index => api(index).patch(`${policyBase}/${edge.id}`).set('Authorization', auth()).send({ version: 0, status: 'INACTIVE', note: `Admin ${index}` })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    await api().patch(`${policyBase}/${edge.id}`).set('Authorization', auth()).send({ version: 0, status: 'INACTIVE' }).expect(409);
    for (const immutable of [{ fromPlanId: to.id }, { toPlanId: from.id }, { ruleCode: 'CUSTOM' }]) await api().patch(`${policyBase}/${edge.id}`).set('Authorization', auth()).send({ version: 1, status: 'INACTIVE', ...immutable }).expect(400);
  });
  it('AC04: pagination, literal search, filters, 400/404, public projection and OpenAPI', async () => {
    const empty = await api().get(base).set('Authorization', auth()).expect(200);
    expect(empty.body).toMatchObject({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
    const first = await create({ code: 'AAA', price: '0' }), second = await create({ code: 'BBB' });
    await patch(first, { status: 'INACTIVE' }).expect(200);
    const page = await api().get(`${base}?page=1&limit=1`).set('Authorization', auth()).expect(200);
    expect(page.body).toMatchObject({ total: 2, totalPages: 2 }); expect(page.body.items[0].id).toBe(second.id);
    expect((await api().get(`${base}?q=.*`).set('Authorization', auth()).expect(200)).body.total).toBe(0);
    expect((await api().get(`${base}?kind=GYM&status=INACTIVE`).set('Authorization', auth()).expect(200)).body.total).toBe(1);
    for (const query of ['page=0', 'page=1.5', 'limit=101', 'unknown=1', 'status=OTHER', 'q[x]=1', 'q=a&q=b']) await api().get(`${base}?${query}`).set('Authorization', auth()).expect(400);
    await api().get(`${base}/bad-id`).set('Authorization', auth()).expect(400);
    await api().get(`${base}/${new ObjectId()}`).set('Authorization', auth()).expect(404);
    await patch({ ...first, id: new ObjectId().toHexString() }, { name: 'Missing' }).expect(404);
    await api().post(policyBase).set('Authorization', auth()).send({ fromPlanId: first.id, toPlanId: new ObjectId().toHexString(), status: 'INACTIVE' }).expect(404);
    await api().get(`${policyBase}?fromPlanId=bad`).set('Authorization', auth()).expect(400);
    const publicPage = await apps[0].get(PlanReaderService).publicCatalog({ page: 1, limit: 20 });
    expect(publicPage.items.map(p => p.id)).toEqual([second.id]); expect(publicPage.items[0]).not.toHaveProperty('createdAt');
    const document = SwaggerModule.createDocument(apps[0], new DocumentBuilder().build());
    expect(document.paths['/api/admin/plans'].post?.responses['201']).toBeDefined();
    expect(document.components?.schemas?.CreatePlanDto).toBeDefined();
    const model = apps[0].get<Model<Plan>>(getModelToken('Plan'));
    const stored = await model.findById(second.id).orFail();
    stored.duration_days = 0;
    await expect(stored.validate()).rejects.toThrow();
  });
});
