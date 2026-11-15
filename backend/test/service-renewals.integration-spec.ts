import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ClientSession, Long, MongoServerError } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { addCalendarDays, ServerClock } from '../src/common/utils/business-date';
import { toVndDecimal } from '../src/common/utils/vnd-money';
import { ensureFinancialIntegrity } from '../src/infrastructure/transaction/financial-integrity';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import { RenewalService } from '../src/modules/sales/renewal.service';
import { SalesRepository } from '../src/modules/sales/sales.repository';
import { Plan } from '../src/modules/plans/schemas/plan.schema';
import { UsersRepository } from '../src/modules/users/users.repository';
import { AccessCatalogService } from '../src/modules/users/access-catalog.service';
import { ACCOUNT_ADMINISTRATION } from '../src/modules/users/schemas/security-state.schema';
import { RoleCode } from '../src/modules/users/schemas/role.schema';

interface Sale { saleId: string; memberId: string; planId: string; transactionId: string; membershipId: string }

describe('US-15 renewal: real API/Guard, replica set, two instances and shared self-service port', () => {
  const savedEnv = { ...process.env }, apps: INestApplication[] = [];
  const tokens = {} as Record<RoleCode, string>, accounts = {} as Record<RoleCode, Types.ObjectId>;
  let mongo: MongoMemoryReplSet, db: Connection, source: Sale, sequence = 0;
  let now = new Date('2026-11-14T03:00:00Z');
  const clock = { now: () => now, today: () => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }) };
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', FRONTEND_ORIGIN: 'http://localhost:5173', MONGODB_URI: mongo.getUri(),
      MONGODB_DB: `gym_test_us15_${randomBytes(6).toString('hex')}`, JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: '', RECEIVING_ACCOUNTS: '["GYM_MAIN"]' });
    const { AppModule } = await import('../src/app.module');
    for (let i = 0; i < 2; i++) {
      const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
      const app = module.createNestApplication({ logger: false, bodyParser: false }); apps.push(app); configureHttp(app);
      db = app.get(getConnectionToken()); await ensureFinancialIntegrity(db); await app.init();
      await Promise.all(Object.values(db.models).map(model => model.init()));
    }
    await apps[0].get(AccessCatalogService).seed();
    const users = apps[0].get(UsersRepository), password = 'US15 integration password 123';
    const hash = await apps[0].get(PasswordService).hash(password);
    for (const [i, role] of (['ADMIN', 'STAFF', 'MEMBER', 'TRAINER'] as const).entries()) {
      const roleRecord = await users.findRoleByCode(role);
      const account = await users.createAccount({ roleId: roleRecord!.id.toHexString(), fullName: `US15 ${role}`, phone: `+8492345678${i}`, passwordHash: hash });
      accounts[role] = account._id;
      tokens[role] = (await request(apps[0].getHttpServer()).post('/api/auth/login').set('Origin', 'http://localhost:5173')
        .send({ phone: account.phone, password }).expect(200)).body.accessToken;
    }
  }, 600000);
  afterAll(async () => { for (const app of apps) await app.close(); await mongo?.stop(); process.env = savedEnv; });
  beforeEach(async () => {
    now = new Date('2026-11-14T03:00:00Z');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const name of ['members', 'plans', 'transactions', 'service_sales', 'memberships', 'payments', 'invoices', 'pt_bookings',
      'notifications', 'notification_recipients', 'notification_outbox', 'operation_requests']) await db.collection(name).deleteMany({});
    await db.db!.collection<{ _id: string; revision: Long }>('security_state').updateOne({ _id: ACCOUNT_ADMINISTRATION }, { $set: { revision: Long.ZERO } }, { upsert: true });
    source = await createSource();
    await db.collection('members').updateOne({ _id: oid(source.memberId) }, { $set: { account_id: accounts.MEMBER } });
  });
  afterEach(() => jest.restoreAllMocks());
  const oid = (id: string) => new Types.ObjectId(id);
  const post = (path: string, body: object, key: string = randomUUID(), role: RoleCode = 'STAFF', instance = 0) => request(apps[instance].getHttpServer())
    .post(`/api${path}`).set('Authorization', `Bearer ${tokens[role]}`).set('Idempotency-Key', key).send(body);
  const get = (path: string, role: RoleCode = 'STAFF') => request(apps[0].getHttpServer()).get(`/api${path}`).set('Authorization', `Bearer ${tokens[role]}`);
  const cash = (amount = '300000') => ({ method: 'CASH', amount, evidenceNote: 'Đã đếm đủ tiền mặt thực nhận' });
  const input = (extra = {}) => ({ memberId: source.memberId, previousSaleId: source.saleId, planVersion: 0, ...extra });
  const create = (extra = {}, key: string = randomUUID(), role: RoleCode = 'STAFF', instance = 0) => post('/service-renewals', input(extra), key, role, instance);
  const preview = (extra = {}) => post('/service-renewals/preview', input(extra));
  const confirm = (id: string, key: string = randomUUID(), instance = 0, body: object = cash()) => post(`/transactions/${id}/confirm-payment`, body, key, 'STAFF', instance);
  const plans = () => apps[0].get<Model<Plan>>(getModelToken('Plan'));
  async function createSource(kind: 'GYM' | 'PT' = 'GYM', memberId?: string): Promise<Sale> {
    const n = ++sequence;
    const member = memberId ?? (await post('/members', { fullName: `Hội viên US15 ${n}`, phone: `+8497${String(n).padStart(7, '0')}` }).expect(201)).body.id as string;
    const plan = await plans().create({ code: `US15_${n}`, name: `Gói US15 ${n}`, kind, duration_days: 30,
      session_quota: kind === 'PT' ? 10 : 0, price: toVndDecimal('300000'), benefits: 'Điều khoản nguồn', status: 'ACTIVE', created_by: accounts.ADMIN, updated_by: accounts.ADMIN });
    const sale = (await post('/service-sales', { memberId: member, planId: plan._id.toHexString(), planVersion: 0, startDate: clock.today() }).expect(201)).body;
    const settled = (await confirm(sale.transactionId).expect(200)).body;
    return { ...sale, memberId: member, membershipId: settled.membershipId } as Sale;
  }
  async function sourcePeriod(end: string) {
    await db.collection('service_sales').updateOne({ _id: oid(source.saleId) }, { $set: { start_date: addCalendarDays(end, -29), end_date: end } });
  }
  const sourceSale = () => db.collection('service_sales').findOne({ _id: oid(source.saleId) });
  const sourceMembership = () => db.collection('memberships').findOne({ _id: oid(source.membershipId) });
  async function assertPending(sale: Sale) {
    expect((await db.collection('transactions').findOne({ _id: oid(sale.transactionId) }))!.status).toBe('PENDING');
    expect(await db.collection('memberships').countDocuments({ service_sale_id: oid(sale.saleId) })).toBe(0);
    for (const name of ['payments', 'invoices', 'notifications']) expect(await db.collection(name).countDocuments({ transaction_id: oid(sale.transactionId) })).toBe(0);
  }

  it('US-15-TC01: read-only preview, paid COUNTER RENEW PENDING, source unchanged and no early entitlement', async () => {
    const before = await sourceSale();
    const count = await db.collection('operation_requests').countDocuments();
    expect((await preview().expect(200)).body).toMatchObject({ previousSaleId: source.saleId, sourceEndDate: '2026-12-13', amountDue: '300000',
      expectedStartDate: '2026-12-14', expectedEndDate: '2027-01-12', canProceed: true });
    expect(await db.collection('operation_requests').countDocuments()).toBe(count);
    const result = (await create({}, randomUUID(), 'ADMIN').expect(201)).body;
    expect(result).toMatchObject({ operation: 'RENEW', previousSaleId: source.saleId, channel: 'COUNTER', creditAmount: '0', transactionStatus: 'PENDING' });
    expect(JSON.parse(result.policySnapshot).rule).toBe('RENEW_V1');
    await assertPending(result);
    expect(await sourceSale()).toEqual(before);
  });

  it('US-15-TC02/14: real auth/RBAC, ownership 404 and strict DTO/key validation', async () => {
    await request(apps[0].getHttpServer()).post('/api/service-renewals').send(input()).expect(401);
    for (const role of ['MEMBER', 'TRAINER'] as const) {
      await create({}, randomUUID(), role).expect(403);
      await post('/service-renewals/preview', input(), randomUUID(), role).expect(403);
    }
    for (const extra of [{ previousSaleId: 'bad' }, { memberId: null }, { planVersion: '0' }, { planVersion: -1 }, { price: '0' },
      { durationDays: 999 }, { startDate: '2026-01-01' }, { channel: 'SELF_SERVICE' }, { preferredPaymentMethod: 'CASH' }]) await create(extra).expect(400);
    await create({}, 'bad').expect(400);
    const other = await createSource();
    await create({ previousSaleId: other.saleId }).expect(404);
    await create({ previousSaleId: new Types.ObjectId().toHexString() }).expect(404);
    expect(await db.collection('service_sales').countDocuments({ operation: 'RENEW' })).toBe(0);
  });

  it.each(['CANCELLED', 'SUPERSEDED'] as const)('US-15-TC03: source membership %s is not eligible', async status => {
    await db.collection('memberships').updateOne({ _id: oid(source.membershipId) }, { $set: { status } });
    expect((await create().expect(409)).body.error.code).toBe('SOURCE_NOT_ELIGIBLE');
  });
  it.each(['PENDING', 'CANCELLED'] as const)('US-15-TC03: source transaction %s is not eligible', async status => {
    await db.collection('transactions').updateOne({ _id: oid(source.transactionId) }, { $set: { status } });
    expect((await create().expect(409)).body.error.code).toBe('SOURCE_NOT_ELIGIBLE');
  });
  it('US-15-TC03: never-issued source is rejected, old source rejected after a settled successor', async () => {
    await db.collection('memberships').deleteOne({ _id: oid(source.membershipId) });
    expect((await create().expect(409)).body.error.code).toBe('SOURCE_NOT_ELIGIBLE');
    await apps[0].get(SalesRepository).memberships.create({ _id: oid(source.membershipId), id: oid(source.membershipId), service_sale_id: oid(source.saleId), status: 'ACTIVE', sessions_used: 0 });
    const renewal = (await create().expect(201)).body;
    await confirm(renewal.transactionId).expect(200);
    expect((await create().expect(409)).body.error.code).toBe('SOURCE_NOT_LATEST');
    const next = (await create({ previousSaleId: renewal.saleId }).expect(201)).body;
    expect(next.startDate).toBe('2027-01-13');
  });

  it('US-15-TC04: stale plan rejected at create; frozen NEW price/duration/benefits survive later plan deactivation', async () => {
    await plans().updateOne({ _id: oid(source.planId) }, { $set: { price: toVndDecimal('450000'), duration_days: 45, benefits: 'Quyền lợi kỳ mới' }, $inc: { version: 1 } });
    expect((await create().expect(409)).body.error.code).toBe('PLAN_CHANGED');
    const renewal = (await create({ planVersion: 1 }).expect(201)).body;
    expect(renewal).toMatchObject({ amountDue: '450000', durationDays: 45, benefits: 'Quyền lợi kỳ mới' });
    await plans().updateOne({ _id: oid(source.planId) }, { $set: { price: toVndDecimal('1'), duration_days: 90, benefits: 'Đổi sau tạo', status: 'INACTIVE' } });
    const settled = (await confirm(renewal.transactionId, randomUUID(), 0, cash('450000')).expect(200)).body;
    expect(settled).toMatchObject({ startDate: '2026-12-14', endDate: '2027-01-27' });
    expect((await get(`/service-sales/${renewal.saleId}`).expect(200)).body.benefits).toBe('Quyền lợi kỳ mới');
    expect((await create({ previousSaleId: renewal.saleId, planVersion: 1 }).expect(409)).body.error.code).toBe('PLAN_NOT_AVAILABLE');
  });

  it.each([
    ['2026-12-13', '2026-11-14T03:00:00Z', '2026-12-14', '2027-01-12'],
    ['2026-11-14', '2026-11-13T17:00:00Z', '2026-11-15', '2026-12-14'],
    ['2027-01-01', '2026-11-14T03:00:00Z', '2027-01-02', '2027-01-31'],
    ['2028-02-28', '2028-02-28T03:00:00Z', '2028-02-29', '2028-03-29'],
  ])('US-15-TC05: inclusive end %s and VN server time %s join without overlap', async (end, time, start, nextEnd) => {
    await sourcePeriod(end); now = new Date(time);
    const renewal = (await create().expect(201)).body;
    expect((await confirm(renewal.transactionId).expect(200)).body).toMatchObject({ startDate: start, endDate: nextEnd });
    expect((await sourceSale())!.end_date).toBe(end);
  });
  it('US-15-TC06: expired source and delayed transfer settlement use confirmation day, not receivedAt or preview', async () => {
    await sourcePeriod('2026-11-13');
    expect((await preview().expect(200)).body.expectedStartDate).toBe('2026-11-14');
    const renewal = (await create().expect(201)).body;
    now = new Date('2026-11-20T17:00:00Z');
    const settled = (await confirm(renewal.transactionId, randomUUID(), 0, { method: 'TRANSFER', amount: '300000', evidenceNote: 'Đối chiếu báo có thực tế',
      receivingAccountCode: 'GYM_MAIN', bankReference: 'US15-DELAYED', receivedAt: '2026-11-14T03:00:00Z' }).expect(200)).body;
    expect(settled).toMatchObject({ startDate: '2026-11-21', endDate: '2026-12-20' });
  });
  it('US-15-TC07/08: PT quota/BOOKED remain on old period; fresh membership used0 and separate read history', async () => {
    source = await createSource('PT', source.memberId);
    await db.collection('memberships').updateOne({ _id: oid(source.membershipId) }, { $set: { sessions_used: 3 } });
    const id = new Types.ObjectId();
    // Existing BOOKED fixture: renewal must preserve every field and the membership link.
    await apps[0].get(SalesRepository).sales.db.model('PtBooking').create({ _id: id, id, membership_id: oid(source.membershipId), member_id: oid(source.memberId),
      trainer_id: new Types.ObjectId(), shift_id: new Types.ObjectId(), start_at: new Date('2026-11-16T03:00:00Z'), end_at: new Date('2026-11-16T04:00:00Z'),
      status: 'BOOKED', request_key: randomBytes(32).toString('hex'), created_at: now, version: 0 });
    const booking = await db.collection('pt_bookings').findOne({ _id: id }), oldSale = await sourceSale(), oldMembership = await sourceMembership();
    await plans().updateOne({ _id: oid(source.planId) }, { $set: { session_quota: 12 }, $inc: { version: 1 } });
    const renewal = (await create({ planVersion: 1 }).expect(201)).body;
    const settled = (await confirm(renewal.transactionId).expect(200)).body;
    expect((await db.collection('memberships').findOne({ _id: oid(settled.membershipId) }))!.sessions_used).toBe(0);
    expect(renewal.sessions).toBe(12);
    expect(await sourceSale()).toEqual(oldSale); expect(await sourceMembership()).toEqual(oldMembership);
    expect(await db.collection('pt_bookings').findOne({ _id: id })).toEqual(booking);
    const history = (await get(`/members/${source.memberId}/memberships`).expect(200)).body.items as { saleId: string; sessionsUsed: number }[];
    expect(history.find(item => item.saleId === source.saleId)!.sessionsUsed).toBe(3);
    expect(history.find(item => item.saleId === renewal.saleId)!.sessionsUsed).toBe(0);
    const own = (await get('/me/memberships?kind=PT', 'MEMBER').expect(200)).body;
    expect(own.items).toHaveLength(2);
  });

  it('US-15-TC09: two counter requests on two instances create one PENDING', async () => {
    const results = await Promise.all([create({}, randomUUID(), 'STAFF', 0), create({}, randomUUID(), 'ADMIN', 1)]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    expect(results.find(row => row.status === 409)!.body.error.code).toBe('PENDING_SALE_EXISTS');
  });
  it('US-15-TC09: COUNTER and SELF_SERVICE use the same lock, pending constraint and service', async () => {
    const results = await Promise.allSettled([create(), apps[1].get(RenewalService).create(accounts.MEMBER.toHexString(), input(), randomUUID(), 'SELF_SERVICE')]);
    const statuses = results.map(row => row.status === 'fulfilled' ? row.value.status : (row.reason as { status: number }).status);
    expect(statuses.sort()).toEqual([201, 409]);
    expect(await db.collection('service_sales').countDocuments({ operation: 'RENEW' })).toBe(1);
    expect(await db.collection('transactions').countDocuments({ status: 'PENDING' })).toBe(1);
  });
  it('US-15-TC09: shared REGISTER/RENEW/UPGRADE pending rule, independent from current entitlement blocking', async () => {
    await sourcePeriod('2026-11-13');
    const registration = (await post('/service-sales', { memberId: source.memberId, planId: source.planId, planVersion: 0, startDate: clock.today() }).expect(201)).body;
    expect((await create().expect(409)).body.error.code).toBe('PENDING_SALE_EXISTS');
    expect((await preview().expect(200)).body).toMatchObject({ canProceed: false, blockingCode: 'PENDING_SALE_EXISTS' });
    await db.collection('service_sales').updateOne({ _id: oid(registration.saleId) }, { $set: { operation: 'UPGRADE' } });
    expect((await create().expect(409)).body.error.code).toBe('PENDING_SALE_EXISTS');
  });
  it('US-15-TC10: two confirms commit exactly one membership/payment/event', async () => {
    const renewal = (await create().expect(201)).body;
    const results = await Promise.all([confirm(renewal.transactionId), confirm(renewal.transactionId, randomUUID(), 1)]);
    expect(results.map(row => row.status).sort()).toEqual([200, 409]);
    expect(await db.collection('payments').countDocuments({ transaction_id: oid(renewal.transactionId) })).toBe(1);
    expect(await db.collection('memberships').countDocuments({ service_sale_id: oid(renewal.saleId) })).toBe(1);
    const event = await db.collection('notifications').findOne({ event_key: `SERVICE_SALE_SETTLED:${renewal.saleId}` });
    expect(event!.body).toContain('RENEW');
    expect((await db.collection('notification_recipients').findOne({ notification_id: event!._id }))!.account_id).toEqual(accounts.MEMBER);
  });
  it.each(['activation', 'outbox'] as const)('US-15-TC10: %s failure rolls back payment, invoice, membership, event and settlement', async stage => {
    const renewal = (await create().expect(201)).body, original = await sourceSale();
    if (stage === 'activation') jest.spyOn(apps[0].get(SalesRepository).memberships, 'create').mockRejectedValueOnce(new Error('Injected activation failure'));
    else jest.spyOn(apps[0].get(NotificationsRepository), 'insertOutbox').mockRejectedValueOnce(new Error('Injected outbox failure'));
    await confirm(renewal.transactionId).expect(500); await assertPending(renewal); expect(await sourceSale()).toEqual(original);
    await confirm(renewal.transactionId).expect(200);
  });
  it('US-15-TC10: source becoming stale before settlement rejects and does not collect', async () => {
    const renewal = (await create().expect(201)).body;
    await db.collection('memberships').updateOne({ _id: oid(source.membershipId) }, { $set: { status: 'SUPERSEDED' } });
    expect((await confirm(renewal.transactionId).expect(409)).body.error.code).toBe('SOURCE_NOT_ELIGIBLE');
    await assertPending(renewal);
  });
  it('US-15-TC11: same key replays original terms; payload/source/channel changes conflict', async () => {
    const key = randomUUID(), created = (await create({}, key).expect(201)).body;
    expect((await create({}, key.toUpperCase()).expect(201)).body).toEqual(created);
    expect((await create({ previousSaleId: new Types.ObjectId().toHexString() }, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    await expect(apps[1].get(RenewalService).create(accounts.STAFF.toHexString(), input(), key, 'SELF_SERVICE')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await get(`/operations/SALE_RENEW/${key}`).expect(200)).body.responseBody).toEqual(created);
  });
  it('US-15-TC11: committed but lost reply retains result, lookup and replay use same key', async () => {
    const original = ClientSession.prototype.commitTransaction, error = new MongoServerError({ message: 'injected lost reply' });
    error.addErrorLabel('UnknownTransactionCommitResult');
    jest.spyOn(ClientSession.prototype, 'commitTransaction').mockImplementation(async function (this: ClientSession, ...args) { await original.apply(this, args); throw error; });
    const key = randomUUID(); await create({}, key).expect(503); jest.restoreAllMocks();
    const recovered = (await get(`/operations/SALE_RENEW/${key}`).expect(200)).body.responseBody;
    expect((await create({}, key).expect(201)).body).toEqual(recovered);
    expect(await db.collection('service_sales').countDocuments({ operation: 'RENEW' })).toBe(1);
  }, 30000);
  it('US-15-TC12: cancel racing confirmation produces one terminal state, no partial collection', async () => {
    const renewal = (await create().expect(201)).body;
    const results = await Promise.all([confirm(renewal.transactionId), post(`/service-sales/${renewal.saleId}/cancel`, { version: 0, reason: 'Hội viên đổi kế hoạch gia hạn' }, randomUUID(), 'STAFF', 1)]);
    expect(results.map(row => row.status).sort()).toEqual([200, 409]);
    const settled = (await db.collection('transactions').findOne({ _id: oid(renewal.transactionId) }))!.status === 'SETTLED';
    expect(await db.collection('memberships').countDocuments({ service_sale_id: oid(renewal.saleId) })).toBe(settled ? 1 : 0);
    expect(await db.collection('payments').countDocuments({ transaction_id: oid(renewal.transactionId) })).toBe(settled ? 1 : 0);
  });
  it('US-15-TC13: current free plan settles zero invoice/new membership/event without payment0', async () => {
    await plans().updateOne({ _id: oid(source.planId) }, { $set: { price: toVndDecimal('0') }, $inc: { version: 1 } });
    const before = await sourceSale(), renewal = (await create({ planVersion: 1 }).expect(201)).body;
    expect(renewal).toMatchObject({ transactionStatus: 'SETTLED', operation: 'RENEW', amountDue: '0', startDate: '2026-12-14' });
    expect(await db.collection('payments').countDocuments({ transaction_id: oid(renewal.transactionId) })).toBe(0);
    expect((await db.collection('invoices').findOne({ transaction_id: oid(renewal.transactionId) }))!.total_amount.toString()).toBe('0');
    expect(await sourceSale()).toEqual(before);
  });
  it('US-15 migration: rerunnable COUNTER backfill preserves historical price, creator and dates', async () => {
    await db.collection('service_sales').updateOne({ _id: oid(source.saleId) }, { $unset: { channel: '' } });
    const before = await sourceSale();
    const options = { encoding: 'utf8' as const, windowsHide: true, env: { ...process.env } };
    expect(spawnSync(process.execPath, [require.resolve('@nestjs/cli/bin/nest.js'), 'build'], options).status).toBe(0);
    for (let i = 0; i < 2; i++) {
      const migrated = spawnSync(process.execPath, ['scripts/admin.cjs', 'ensure-indexes'], options);
      expect({ status: migrated.status, output: migrated.stdout + migrated.stderr }).toMatchObject({ status: 0 });
    }
    expect(await sourceSale()).toEqual({ ...before, channel: 'COUNTER' });
  }, 120000);
});
