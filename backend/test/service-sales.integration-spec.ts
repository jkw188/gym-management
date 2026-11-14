import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Long } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { toVndDecimal } from '../src/common/utils/vnd-money';
import { ensureFinancialIntegrity } from '../src/infrastructure/transaction/financial-integrity';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { MembersRepository } from '../src/modules/members/members.repository';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import { SaleActivation } from '../src/modules/sales/sale-activation.service';
import { SalesRepository } from '../src/modules/sales/sales.repository';
import { Plan } from '../src/modules/plans/schemas/plan.schema';
import { RoleCode } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const password = 'US14 test password 123';

describe('US-14: sale API, atomic free completion and activation port on a real replica set', () => {
  let mongo: MongoMemoryReplSet;
  const apps: INestApplication[] = [];
  const savedEnv = { ...process.env };
  let connection: Connection;
  let tokens: Record<RoleCode, string>;
  let adminId: Types.ObjectId;
  let staffId: Types.ObjectId;
  let memberId: string;
  let plan: Plan;
  let now = new Date('2026-11-01T03:00:00Z');
  let hash: string;
  const clock = { now: () => now, today: () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now) };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(),
      MONGODB_DB: 'gym_management_test_us14', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'), SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525',
      SMTP_SECURE: 'false', SMTP_USER: 'us14', SMTP_PASS: 'us14', SMTP_FROM: 'no-reply@gym.test' });
    const { AppModule } = await import('../src/app.module');
    for (let index = 0; index < 2; index++) {
      const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
      const app = module.createNestApplication({ logger: false, bodyParser: false });
      apps.push(app); configureHttp(app);
      connection = app.get<Connection>(getConnectionToken());
      await ensureFinancialIntegrity(connection);
      await app.init();
      await Promise.all(Object.values(connection.models).map(model => model.init()));
    }
    hash = await apps[0].get(PasswordService).hash(password);
  }, 600000);
  afterAll(async () => {
    for (const app of apps) await app.close();
    await mongo?.stop(); process.env = savedEnv;
  });
  beforeEach(async () => {
    now = new Date('2026-11-01T03:00:00Z');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const collection of await connection.db!.collections()) await collection.deleteMany({});
    for (const app of apps) {
      const limiter = new LoginLimiter();
      jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    }
    tokens = {} as Record<RoleCode, string>;
    const users = apps[0].get(UsersRepository);
    for (const [index, code] of (['ADMIN', 'STAFF', 'MEMBER', 'TRAINER'] as const).entries()) {
      const role = await users.ensureRole(code, code);
      const account = await users.createAccount({ roleId: role.id.toHexString(), fullName: `US14 ${code}`,
        phone: `+8491234567${index}`, passwordHash: hash });
      if (code === 'ADMIN') adminId = account._id;
      if (code === 'STAFF') staffId = account._id;
      tokens[code] = (await request(apps[0].getHttpServer()).post('/api/auth/login').set('Origin', origin)
        .send({ phone: account.phone, password }).expect(200)).body.accessToken;
    }
    const created = await apps[0].get(TransactionRunner).run(session => apps[0].get(MembersRepository)
      .insert({ fullName: 'Hội viên US14', phone: '+84909999999' }, staffId, session));
    memberId = created._id.toHexString();
    const model = apps[0].get<Model<Plan>>(getModelToken('Plan'));
    plan = (await model.create({ code: 'GYM30', name: 'Gym 30 ngày', kind: 'GYM', duration_days: 30,
      session_quota: 0, price: toVndDecimal('300000'), benefits: 'Tập Gym trong giờ mở cửa', status: 'ACTIVE',
      created_by: adminId, updated_by: adminId })).toObject();
  });
  afterEach(() => jest.restoreAllMocks());

  const input = (extra = {}) => ({ memberId, planId: plan._id.toHexString(), planVersion: 0, startDate: '2026-11-01', ...extra });
  const api = (path: string, body: Record<string, unknown>, key: string = randomUUID(), role: RoleCode = 'STAFF', instance = 0) =>
    request(apps[instance].getHttpServer()).post(`/api/service-sales${path}`).set('Origin', origin)
      .set('Authorization', `Bearer ${tokens[role]}`).set('Idempotency-Key', key).send(body);
  const detail = (id: string) => request(apps[0].getHttpServer()).get(`/api/service-sales/${id}`).set('Authorization', `Bearer ${tokens.STAFF}`);
  const count = (collection: string) => connection.collection(collection).countDocuments();
  const plans = () => apps[0].get<Model<Plan>>(getModelToken('Plan'));
  const free = () => plans().updateOne({ _id: plan._id }, { $set: { price: toVndDecimal('0') } });

  it('TC01/05: preview is read only; paid registration stays pending without entitlement or documents', async () => {
    const preview = await api('/preview', input()).expect(200);
    expect(preview.body).toMatchObject({ amountDue: '300000', canProceed: true, expectedEndDate: '2026-11-30' });
    expect(await count('transactions')).toBe(0);
    const sale = await api('', input()).expect(201);
    expect(sale.body).toMatchObject({ transactionStatus: 'PENDING', amountDue: '300000', notificationState: 'NOT_CREATED', sessions: 0 });
    expect(sale.body.transactionCode).toBe(`TX-${sale.body.transactionId}`);
    for (const collection of ['memberships', 'payments', 'invoices', 'notifications']) expect(await count(collection)).toBe(0);
    expect(JSON.parse(sale.body.policySnapshot)).toMatchObject({ rule: 'REGISTER_V1', durationDays: 30, dayInclusive: true });
    expect((await detail(sale.body.saleId).expect(200)).body).toEqual(sale.body);
  });

  it('TC02: authentication, role and missing resources are enforced for every sale endpoint', async () => {
    await request(apps[0].getHttpServer()).post('/api/service-sales').send(input()).expect(401);
    const created = await api('', input(), randomUUID(), 'ADMIN').expect(201);
    for (const role of ['MEMBER', 'TRAINER'] as const) {
      await api('', input(), randomUUID(), role).expect(403);
      await api('/preview', input(), randomUUID(), role).expect(403);
      await api(`/${created.body.saleId}/cancel`, { version: 0, reason: 'Không còn nhu cầu' }, randomUUID(), role).expect(403);
      for (const path of [`/${created.body.saleId}`, '/plans', `?memberId=${memberId}`]) {
        await request(apps[0].getHttpServer()).get(`/api/service-sales${path}`).set('Authorization', `Bearer ${tokens[role]}`).expect(403);
      }
    }
    await api('', input({ memberId: new Types.ObjectId().toHexString() })).expect(404);
    await api('', input({ planId: new Types.ObjectId().toHexString() })).expect(404);
    await detail('bad-id').expect(400);
    await detail(new Types.ObjectId().toHexString()).expect(404);
  });

  it('TC02/03/09: rejects inactive/stale terms, extra fields and invalid dates', async () => {
    for (const extra of [{ price: '0' }, { sessions: 999 }, { memberCode: 'fake' }, { startDate: '2026-02-30' }, { startDate: '2026-10-31' }, { planId: 'x' }]) {
      await api('', input(extra)).expect(400);
    }
    expect((await api('', input({ planVersion: 1 })).expect(409)).body.error.code).toBe('PLAN_CHANGED');
    await plans().updateOne({ _id: plan._id }, { $set: { status: 'INACTIVE' } });
    expect((await api('', input()).expect(409)).body.error.code).toBe('PLAN_NOT_AVAILABLE');
    expect(await count('service_sales')).toBe(0);
  });

  it('TC06/07: free sale atomically creates one membership/invoice/event/outbox and no payment; replay is exact', async () => {
    await free(); const key = randomUUID();
    const sale = await api('', input(), key).expect(201);
    expect(sale.body).toMatchObject({ transactionStatus: 'SETTLED', amountDue: '0', transactionVersion: 1, notificationState: 'NO_LINKED_ACCOUNT' });
    expect(sale.body.membershipId).toBeDefined(); expect(sale.body.invoiceId).toBeDefined();
    expect((await api('', input(), key.toUpperCase()).expect(201)).body).toEqual(sale.body);
    for (const collection of ['transactions', 'service_sales', 'memberships', 'invoices', 'notifications', 'notification_outbox']) expect(await count(collection)).toBe(1);
    expect(await count('payments')).toBe(0);
    const membership = await connection.collection('memberships').findOne({});
    expect(membership).toMatchObject({ sessions_used: 0, version: 0, status: 'ACTIVE' });
    const invoice = await connection.collection('invoices').findOne({});
    expect(invoice!.total_amount.toString()).toBe('0');
    expect(invoice!.invoice_no).toBe(`INV-${invoice!._id.toHexString()}`);
    expect(JSON.parse(invoice!.buyer_snapshot).memberCode).toBe(`HV-${memberId}`);
    expect((await connection.collection('notifications').findOne({}))!.event_key).toBe(`SERVICE_SALE_SETTLED:${sale.body.saleId}`);
    expect(JSON.parse(invoice!.buyer_snapshot)).toMatchObject({ fullName: 'Hội viên US14', phone: '+84909999999' });
    expect((await api(`/${sale.body.saleId}/cancel`, { version: 1, reason: 'Không còn nhu cầu' }).expect(409)).body.error.code).toBe('INVALID_TRANSACTION_STATE');
  });

  it('TC07: linked recipient is persisted and remains the original recipient after member relink', async () => {
    const memberAccount = await connection.collection('accounts').findOne({ full_name: 'US14 MEMBER' });
    await connection.collection('members').updateOne({ _id: new Types.ObjectId(memberId) }, { $set: { account_id: memberAccount!._id } });
    await free();
    const sale = await api('', input()).expect(201);
    expect(sale.body.notificationState).toBe('STORED'); expect(await count('notification_recipients')).toBe(1);
    await connection.collection('members').updateOne({ _id: new Types.ObjectId(memberId) }, { $unset: { account_id: '' } });
    expect((await detail(sale.body.saleId).expect(200)).body.notificationState).toBe('STORED');
  });

  it('TC10/11: different keys on two app instances serialize on the actual member revision; different kinds coexist', async () => {
    const results = await Promise.all([api('', input(), randomUUID(), 'STAFF', 0), api('', input(), randomUUID(), 'STAFF', 1)]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    expect(results.find(row => row.status === 409)!.body.error.code).toBe('PENDING_SALE_EXISTS');
    expect(await count('service_sales')).toBe(1);
    const raw = await connection.db!.collection('members').findOne({ _id: new Types.ObjectId(memberId) }, { promoteLongs: false });
    expect(raw!.service_revision).toBeInstanceOf(Long);
    const pt = await plans().create({ code: 'PT30', name: 'PT', kind: 'PT', duration_days: 30,
      session_quota: 10, price: toVndDecimal('1000000'), benefits: '10 buổi PT', status: 'ACTIVE',
      created_by: adminId, updated_by: adminId });
    await api('', input({ planId: pt._id.toHexString() })).expect(201);
    expect(await count('service_sales')).toBe(2);
  });

  it('TC10: future/current active settled package blocks the same kind; expired package permits a new registration', async () => {
    await free();
    await api('', input({ startDate: '2026-11-05' })).expect(201);
    expect((await api('/preview', input()).expect(200)).body).toMatchObject({ canProceed: false, blockingCode: 'CURRENT_SERVICE_EXISTS' });
    expect((await api('', input()).expect(409)).body.error.code).toBe('CURRENT_SERVICE_EXISTS');
    now = new Date('2026-12-05T03:00:00Z');
    await api('', input({ startDate: '2026-12-05' })).expect(201);
  });

  it('TC12: simultaneous replay and operation lookup commit one sale; changed payload conflicts', async () => {
    const key = randomUUID();
    const responses = await Promise.all([api('', input(), key), api('', input(), key, 'STAFF', 1)]);
    expect(responses.map(row => row.status)).toEqual([201, 201]); expect(responses[1].body).toEqual(responses[0].body);
    expect(await count('service_sales')).toBe(1);
    const lookup = await request(apps[0].getHttpServer()).get(`/api/operations/SALE_REGISTER/${key}`)
      .set('Authorization', `Bearer ${tokens.STAFF}`).expect(200);
    expect(lookup.body.responseBody).toEqual(responses[0].body);
    expect((await api('', input({ startDate: '2026-11-02' }), key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('TC14/15: cancel needs matching version/reason, replays once, retains history and releases pending intent', async () => {
    const sale = await api('', input()).expect(201);
    await api(`/${sale.body.saleId}/cancel`, { version: 0, reason: 'ngắn' }).expect(400);
    expect((await api(`/${sale.body.saleId}/cancel`, { version: 1, reason: 'Không còn nhu cầu' }).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
    const key = randomUUID(); const body = { version: 0, reason: 'Chọn sai ngày bắt đầu' };
    const cancelled = await api(`/${sale.body.saleId}/cancel`, body, key).expect(200);
    expect((await api(`/${sale.body.saleId}/cancel`, body, key).expect(200)).body).toEqual(cancelled.body);
    expect((await detail(sale.body.saleId)).body).toMatchObject({ transactionStatus: 'CANCELLED', transactionVersion: 1, cancelReason: body.reason });
    await api('', input()).expect(201); expect(await count('service_sales')).toBe(2);
    const pending = await request(apps[0].getHttpServer()).get(`/api/service-sales?memberId=${memberId}`)
      .set('Authorization', `Bearer ${tokens.STAFF}`).expect(200);
    expect(pending.body.total).toBe(1);
  });

  it('TC06/13: notification failure rolls back the entire free completion and key; retry can succeed', async () => {
    await free(); const key = randomUUID();
    const spy = jest.spyOn(apps[0].get(NotificationsService), 'persistBusinessEvent').mockRejectedValueOnce(new Error('Injected event failure'));
    await api('', input(), key).expect(500);
    for (const collection of ['transactions', 'service_sales', 'memberships', 'invoices', 'notifications', 'notification_outbox', 'operation_requests']) expect(await count(collection)).toBe(0);
    spy.mockRestore(); await api('', input(), key).expect(201);
  });

  it.each(['membership', 'invoice', 'outbox'] as const)('TC06/13: failure writing %s rolls back every free-sale document', async stage => {
    await free();
    const repository = apps[0].get(SalesRepository);
    const failure = new Error(`Injected ${stage} failure`);
    if (stage === 'membership') jest.spyOn(repository.memberships, 'create').mockRejectedValueOnce(failure);
    else if (stage === 'invoice') jest.spyOn(repository.invoices, 'create').mockRejectedValueOnce(failure);
    else jest.spyOn(apps[0].get(NotificationsRepository), 'insertOutbox').mockRejectedValueOnce(failure);
    await api('', input()).expect(500);
    for (const collection of ['transactions', 'service_sales', 'memberships', 'invoices', 'notifications',
      'notification_recipients', 'notification_outbox', 'operation_requests']) expect(await count(collection)).toBe(0);
  });

  // This exercises the internal US-22 integration boundary; it is not a US-22 HTTP/payment implementation.
  async function activatePaid(sale: { saleId: string; transactionId: string }, instance = 0, fail = false) {
    const app = apps[instance]; const repository = app.get(SalesRepository);
    return app.get(TransactionRunner).run(async session => {
      const paymentId = new Types.ObjectId();
      const activated = await app.get(SaleActivation).activateSaleWithinSession(session, { saleId: new Types.ObjectId(sale.saleId),
        memberId: new Types.ObjectId(memberId), transactionId: new Types.ObjectId(sale.transactionId) }, async () => {
          await repository.payments.create([{ _id: paymentId, id: paymentId, transaction_id: sale.transactionId, method: 'CASH',
            reference: `test-${randomUUID()}`, amount: toVndDecimal('300000'), status: 'SUCCEEDED', verified_by: staffId, paid_at: now }], { session });
        });
      if (fail) throw new Error('Injected settlement failure');
      await repository.transactions.updateOne({ _id: sale.transactionId, status: 'PENDING' }, { $set: { status: 'SETTLED', settled_at: now }, $inc: { version: 1 } }, { session });
      return activated;
    });
  }

  it('TC04/08: activation uses original terms and max(requested, server confirmation); no payment means no activation', async () => {
    const sale = (await api('', input()).expect(201)).body;
    await plans().updateOne({ _id: plan._id }, { $set: { price: toVndDecimal('999999'),
      duration_days: 90, benefits: 'Điều khoản mới', status: 'INACTIVE', version: 1 } });
    await expect(apps[0].get(TransactionRunner).run(session => apps[0].get(SaleActivation).activateSaleWithinSession(session,
      { saleId: new Types.ObjectId(sale.saleId), memberId: new Types.ObjectId(memberId), transactionId: new Types.ObjectId(sale.transactionId) })))
      .rejects.toMatchObject({ code: 'INVALID_TRANSACTION_STATE' });
    now = new Date('2026-11-03T03:00:00Z');
    const activated = await activatePaid(sale);
    expect(activated).toMatchObject({ startDate: '2026-11-03', endDate: '2026-12-02' });
    expect((await detail(sale.saleId)).body).toMatchObject({ amountDue: '300000', durationDays: 30,
      benefits: 'Tập Gym trong giờ mở cửa', requestedStartDate: '2026-11-01', startDate: '2026-11-03', endDate: '2026-12-02' });
  });

  it('TC08/09: future start, leap year and Vietnam midnight remain inclusive', async () => {
    await free(); now = new Date('2028-02-28T18:00:00Z'); // Feb 29 in Vietnam.
    const sale = await api('', input({ startDate: '2028-03-01' })).expect(201);
    expect(sale.body).toMatchObject({ startDate: '2028-03-01', endDate: '2028-03-30' });
  });

  it('TC13: failure after activation rolls back the payment and membership together', async () => {
    const sale = (await api('', input()).expect(201)).body;
    await expect(activatePaid(sale, 0, true)).rejects.toThrow('Injected settlement failure');
    expect(await count('payments')).toBe(0); expect(await count('memberships')).toBe(0);
    expect((await detail(sale.saleId)).body.transactionStatus).toBe('PENDING');
  });

  it('TC13: concurrent activation calls on two instances cannot commit two entitlements or payments', async () => {
    const sale = (await api('', input()).expect(201)).body;
    const attempts = await Promise.allSettled([activatePaid(sale, 0), activatePaid(sale, 1)]);
    expect(attempts.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(await count('payments')).toBe(1); expect(await count('memberships')).toBe(1);
  });

  it('TC15: cancellation racing activation leaves one committed outcome, no orphan payment', async () => {
    const sale = (await api('', input()).expect(201)).body;
    const [cancelled, activated] = await Promise.allSettled([
      api(`/${sale.saleId}/cancel`, { version: 0, reason: 'Hủy yêu cầu đăng ký này' }, randomUUID(), 'STAFF', 1), activatePaid(sale),
    ]);
    const final = (await detail(sale.saleId)).body;
    expect(['SETTLED', 'CANCELLED']).toContain(final.transactionStatus);
    if (final.transactionStatus === 'CANCELLED') {
      expect(cancelled.status).toBe('fulfilled'); expect(activated.status).toBe('rejected');
      expect(await count('payments')).toBe(0); expect(await count('memberships')).toBe(0);
    } else {
      expect(activated.status).toBe('fulfilled');
      expect(await count('payments')).toBe(1); expect(await count('memberships')).toBe(1);
    }
  });
});
