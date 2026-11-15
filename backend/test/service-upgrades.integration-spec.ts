import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ClientSession, Long, MongoServerError } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { addCalendarDays, ServerClock } from '../src/common/utils/business-date';
import { toVndDecimal } from '../src/common/utils/vnd-money';
import { ensureFinancialIntegrity } from '../src/infrastructure/transaction/financial-integrity';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import { UpgradeBookingsAdapter } from '../src/modules/sales/upgrade-bookings.adapter';
import { UpgradeService } from '../src/modules/sales/upgrade.service';
import { SettlementRepository } from '../src/modules/payments/settlement.repository';
import { RenewalService } from '../src/modules/sales/renewal.service';
import { SalesRepository } from '../src/modules/sales/sales.repository';
import { Plan } from '../src/modules/plans/schemas/plan.schema';
import { UsersRepository } from '../src/modules/users/users.repository';
import { AccessCatalogService } from '../src/modules/users/access-catalog.service';
import { ACCOUNT_ADMINISTRATION } from '../src/modules/users/schemas/security-state.schema';
import { RoleCode } from '../src/modules/users/schemas/role.schema';

interface Sale { saleId: string; memberId: string; planId: string; transactionId: string; membershipId: string }

describe('US-16 upgrade: real API/Guard, credit, booking gates and rollback', () => {
  const savedEnv = { ...process.env }, apps: INestApplication[] = [];
  const tokens = {} as Record<RoleCode, string>, accounts = {} as Record<RoleCode, Types.ObjectId>;
  let mongo: MongoMemoryReplSet, db: Connection, source: Sale, targetPlanId: string, sequence = 0;
  let now = new Date('2026-11-01T03:00:00Z');
  const clock = { now: () => now, today: () => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }) };
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', FRONTEND_ORIGIN: 'http://localhost:5173', MONGODB_URI: mongo.getUri(),
      MONGODB_DB: `gym_test_us16_${randomBytes(6).toString('hex')}`, JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: '', RECEIVING_ACCOUNTS: '["GYM_MAIN"]' });
    const { AppModule } = await import('../src/app.module');
    for (let i = 0; i < 2; i++) {
      const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
      const app = module.createNestApplication({ logger: false, bodyParser: false }); apps.push(app); configureHttp(app);
      db = app.get(getConnectionToken()); await ensureFinancialIntegrity(db); await app.init();
      await Promise.all(Object.values(db.models).map(model => model.init()));
    }
    await apps[0].get(AccessCatalogService).seed();
    const users = apps[0].get(UsersRepository), password = 'US16 integration password 123';
    const hash = await apps[0].get(PasswordService).hash(password);
    for (const [i, role] of (['ADMIN', 'STAFF', 'MEMBER', 'TRAINER'] as const).entries()) {
      const roleRecord = await users.findRoleByCode(role);
      const account = await users.createAccount({ roleId: roleRecord!.id.toHexString(), fullName: `US16 ${role}`, phone: `+8492345678${i}`, passwordHash: hash });
      accounts[role] = account._id;
      tokens[role] = (await request(apps[0].getHttpServer()).post('/api/auth/login').set('Origin', 'http://localhost:5173')
        .send({ phone: account.phone, password }).expect(200)).body.accessToken;
    }
  }, 600000);
  afterAll(async () => { for (const app of apps) await app.close(); await mongo?.stop(); process.env = savedEnv; });
  beforeEach(async () => {
    now = new Date('2026-11-01T03:00:00Z');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const name of ['members', 'plans', 'plan_conversion_policies', 'trainers', 'work_shifts', 'transactions', 'service_sales', 'memberships', 'payments', 'invoices', 'pt_bookings',
      'notifications', 'notification_recipients', 'notification_outbox', 'operation_requests']) await db.collection(name).deleteMany({});
    await db.db!.collection<{ _id: string; revision: Long }>('security_state').updateOne({ _id: ACCOUNT_ADMINISTRATION }, { $set: { revision: Long.ZERO } }, { upsert: true });
    await db.db!.collection<{ _id: string; revision: Long }>('schedule_guards').updateOne({ _id: 'global' }, { $set: { revision: Long.ZERO } }, { upsert: true });
    source = await createSource();
    await db.collection('members').updateOne({ _id: oid(source.memberId) }, { $set: { account_id: accounts.MEMBER } });
    targetPlanId = await target();
    now = new Date('2026-11-16T03:00:00Z');
  });
  afterEach(() => jest.restoreAllMocks());
  const oid = (id: string) => new Types.ObjectId(id);
  const post = (path: string, body: object, key: string = randomUUID(), role: RoleCode = 'STAFF', instance = 0) => request(apps[instance].getHttpServer())
    .post(`/api${path}`).set('Authorization', `Bearer ${tokens[role]}`).set('Idempotency-Key', key).send(body);
  const get = (path: string, role: RoleCode = 'STAFF') => request(apps[0].getHttpServer()).get(`/api${path}`).set('Authorization', `Bearer ${tokens[role]}`);
  const cash = (amount = '900000') => ({ method: 'CASH', amount, evidenceNote: 'Đã đếm đủ tiền mặt thực nhận' });
  const input = (extra = {}) => ({ memberId: source.memberId, sourceMembershipId: source.membershipId, sourceVersion: 0,
    targetPlanId, targetPlanVersion: 0, policyVersion: 0, ...extra });
  const create = (extra = {}, key: string = randomUUID(), role: RoleCode = 'STAFF', instance = 0) => post('/service-upgrades', input(extra), key, role, instance);
  const preview = (extra = {}) => post('/service-upgrades/preview', input(extra));
  const confirm = (id: string, key: string = randomUUID(), instance = 0, body: object = cash()) => post(`/transactions/${id}/confirm-payment`, body, key, 'STAFF', instance);
  const settle = (sale: {transactionId: string; amountDue: string}, instance = 0, key: string = randomUUID()) => confirm(sale.transactionId, key, instance, cash(sale.amountDue));
  const plans = () => apps[0].get<Model<Plan>>(getModelToken('Plan'));
  async function createSource(kind: 'GYM' | 'PT' = 'GYM', memberId?: string): Promise<Sale> {
    const n = ++sequence;
    const member = memberId ?? (await post('/members', { fullName: `Hội viên US16 ${n}`, phone: `+8497${String(n).padStart(7, '0')}` }).expect(201)).body.id as string;
    const plan = await plans().create({ code: `US16_${n}`, name: `Gói US16 ${n}`, kind, duration_days: 30,
      session_quota: kind === 'PT' ? 10 : 0, price: toVndDecimal('900000'), benefits: 'Điều khoản nguồn', status: 'ACTIVE', created_by: accounts.ADMIN, updated_by: accounts.ADMIN });
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

  async function target(price = '1500000', kind: 'GYM' | 'PT' = 'GYM', quota = 0, duration = 30) {
    const plan = await plans().create({ code: `UP_${++sequence}`, name: `G?i ??ch ${sequence}`, kind, duration_days: duration,
      session_quota: quota, price: toVndDecimal(price), benefits: 'Quy?n l?i ??ch', status: 'ACTIVE', created_by: accounts.ADMIN, updated_by: accounts.ADMIN });
    await post('/admin/plan-policies', { fromPlanId: source.planId, toPlanId: plan._id.toHexString(), status: 'ACTIVE' }, randomUUID(), 'ADMIN').expect(201);
    return plan._id.toHexString();
  }
  async function ptSource() {
    source = await createSource('PT', source.memberId);
    targetPlanId = await target('1500000', 'PT', 12);
    await db.collection('memberships').updateOne({ _id: oid(source.membershipId) }, { $set: { sessions_used: 3 } });
  }
  async function booking(status: 'BOOKED' | 'COMPLETED' | 'CANCELLED' = 'BOOKED', start = new Date('2026-11-17T03:00:00Z')) {
    let trainer = await db.collection('trainers').findOne({ account_id: accounts.TRAINER });
    if (!trainer) {
      const id = new Types.ObjectId();
      await db.collection('trainers').insertOne({ _id: id, id, account_id: accounts.TRAINER, specialty: 'PT', status: 'ACTIVE', version: 0 });
      trainer = await db.collection('trainers').findOne({ _id: id });
    }
    const id = new Types.ObjectId(), shiftId = new Types.ObjectId(), end = new Date(start.getTime() + 3600000);
    await db.collection('work_shifts').insertOne({ _id: shiftId, id: shiftId, trainer_id: trainer!._id, start_at: start, end_at: end,
      status: 'CONFIRMED', location: 'Ph?ng PT', version: 1, created_by: accounts.TRAINER, updated_by: accounts.TRAINER, created_at: now, updated_at: now, confirmed_at: now });
    await apps[0].get(SalesRepository).sales.db.model('PtBooking').create({ _id: id, id, member_id: oid(source.memberId), membership_id: oid(source.membershipId),
      trainer_id: trainer!._id, shift_id: shiftId, start_at: start, end_at: end, status, request_key: randomBytes(32).toString('hex'), version: 0, created_at: now,
      trainer_name_snapshot: 'PT th? nghi?m', location_snapshot: 'Ph?ng PT', completion_revision: status === 'COMPLETED' ? 1 : 0,
      ...(status === 'COMPLETED' ? { completed_at: end, completed_by: accounts.TRAINER, completed_actor_type: 'TRAINER', completion_membership_id: oid(source.membershipId) } : {}) });
    return { id: id.toHexString(), trainerId: trainer!._id.toHexString(), shiftId: shiftId.toHexString(), startAt: start.toISOString() };
  }

  it('TC01/05: real staff quote/create snapshots, pending does not replace source or grant early', async () => {
    const before = await sourceSale(), membership = await sourceMembership();
    const quote = (await preview().expect(200)).body;
    expect(quote).toMatchObject({ baseValue: '900000', remainingDays: 15, totalDays: 30, rawCredit: '450000', appliedCredit: '450000', excessCredit: '0', amountDue: '1050000', canProceed: true });
    const targets = (await get(`/service-upgrades/targets?memberId=${source.memberId}&sourceMembershipId=${source.membershipId}`).expect(200)).body;
    expect(targets.items[0]).toMatchObject({ planId: targetPlanId, policyVersion: 0, planVersion: 0 });
    const sale = (await create({}, randomUUID(), 'ADMIN').expect(201)).body;
    expect(sale).toMatchObject({ operation: 'UPGRADE', previousSaleId: source.saleId, sourceMembershipId: source.membershipId, creditAmount: '450000', transactionStatus: 'PENDING', amountDue: '1050000' });
    await assertPending(sale); expect(await sourceSale()).toEqual(before); expect(await sourceMembership()).toEqual(membership);
    const done = (await settle(sale).expect(200)).body;
    expect((await sourceMembership())!).toMatchObject({ status: 'SUPERSEDED', version: 1, superseded_by_membership_id: oid(done.membershipId), superseded_at: now });
    expect(await sourceSale()).toEqual(before);
    expect((await get(`/invoices/${done.invoiceId}`).expect(200)).body).toMatchObject({ totalAmount: '1050000', serviceLine: { listPrice: '1500000', creditAmount: '450000' } });
  });
  it('TC02/04: real auth, ownership, versions and strict input allowlist', async () => {
    await request(apps[0].getHttpServer()).post('/api/service-upgrades').send(input()).expect(401);
    for (const role of ['MEMBER', 'TRAINER'] as const) {
      await create({}, randomUUID(), role).expect(403);
      await post('/service-upgrades/preview', input(), randomUUID(), role).expect(403);
      await get(`/service-upgrades/targets?memberId=${source.memberId}&sourceMembershipId=${source.membershipId}`, role).expect(403);
    }
    for (const extra of [{ sourceVersion: '0' }, { targetPlanVersion: -1 }, { price: '0' }, { creditAmount: '9999' }, { asOfDate: '2026-11-01' },
      { channel: 'SELF_SERVICE' }, { sourceMembershipId: 'bad' }]) await create(extra).expect(400);
    await create({}, 'bad').expect(400);
    expect((await create({ sourceVersion: 1 }).expect(409)).body.error.code).toBe('SOURCE_CHANGED');
    expect((await create({ targetPlanVersion: 1 }).expect(409)).body.error.code).toBe('PLAN_CHANGED');
    expect((await create({ policyVersion: 1 }).expect(409)).body.error.code).toBe('POLICY_CHANGED');
    const other = await createSource();
    await create({ sourceMembershipId: other.membershipId }).expect(404);
  });
  it.each(['SUPERSEDED', 'CANCELLED'])('TC02: source %s is not current', async status => {
    await db.collection('memberships').updateOne({ _id: oid(source.membershipId) }, { $set: { status } });
    expect((await create().expect(409)).body.error.code).toBe('SOURCE_NOT_CURRENT');
  });
  it.each(['2026-10-31', '2026-12-30'])('TC02: end %s makes expired/future source ineligible', async end => {
    await sourcePeriod(end);
    expect((await create().expect(409)).body.error.code).toBe('SOURCE_NOT_CURRENT');
  });
  it('TC03: settled future renewal prevents breaking a purchased chain', async () => {
    const renew = (await post('/service-renewals', { memberId: source.memberId, previousSaleId: source.saleId, planVersion: 0 }).expect(201)).body;
    await confirm(renew.transactionId).expect(200);
    expect((await create().expect(409)).body.error.code).toBe('FUTURE_PERIOD_EXISTS');
  });
  it('TC04: missing/inactive policy and wrong kind cannot be inferred from price/name', async () => {
    await db.collection('plan_conversion_policies').updateMany({}, { $set: { status: 'INACTIVE' } });
    expect((await create().expect(409)).body.error.code).toBe('POLICY_NOT_ALLOWED');
    await db.collection('plan_conversion_policies').updateMany({}, { $set: { status: 'ACTIVE' } });
    await db.collection('plans').updateOne({ _id: oid(targetPlanId) }, { $set: { kind: 'PT' } });
    expect((await create().expect(409)).body.error.code).toBe('POLICY_NOT_ALLOWED');
  });
  it('TC07/08: credit cap creates invoice0 without payment/wallet, then upgrade-chain base excludes discarded excess', async () => {
    await request(apps[0].getHttpServer()).patch(`/api/admin/plans/${source.planId}`).set('Authorization', `Bearer ${tokens.ADMIN}`).send({ version: 0, price: '100000' }).expect(200);
    targetPlanId = await target('500000'); now = new Date('2026-11-11T03:00:00Z');
    const before = await sourceSale(), sale = (await create().expect(201)).body;
    expect(sale).toMatchObject({ transactionStatus: 'SETTLED', amountDue: '0', creditAmount: '500000', quote: { rawCredit: '600000', excessCredit: '100000' } });
    expect(await db.collection('payments').countDocuments({ transaction_id: oid(sale.transactionId) })).toBe(0);
    expect((await db.collection('invoices').findOne({ transaction_id: oid(sale.transactionId) }))!.total_amount.toString()).toBe('0');
    expect(await sourceSale()).toEqual(before);
    const nextTarget = await plans().create({ code: `CHAIN_${++sequence}`, name: 'Đích tiếp theo', kind: 'GYM', duration_days: 30, session_quota: 0,
      price: toVndDecimal('800000'), benefits: 'Kỳ tiếp theo', status: 'ACTIVE', created_by: accounts.ADMIN, updated_by: accounts.ADMIN });
    await post('/admin/plan-policies', { fromPlanId: targetPlanId, toPlanId: nextTarget._id.toHexString(), status: 'ACTIVE' }, randomUUID(), 'ADMIN').expect(201);
    const next = (await preview({ sourceMembershipId: sale.membershipId, targetPlanId: nextTarget._id.toHexString() }).expect(200)).body;
    expect(next).toMatchObject({ baseValue: '500000', rawCredit: '500000', amountDue: '300000' });
  });
  it('TC09: exact next VN midnight rejects confirmation and leaves old package and immutable pending amount', async () => {
    now = new Date('2026-11-16T16:59:59.999Z');
    const sale = (await create().expect(201)).body;
    now = new Date('2026-11-16T17:00:00.000Z');
    expect((await settle(sale).expect(409)).body.error.code).toBe('QUOTE_EXPIRED');
    await assertPending(sale); expect((await sourceMembership())!.status).toBe('ACTIVE');
    expect((await get(`/service-sales/${sale.saleId}`).expect(200)).body.amountDue).toBe(sale.amountDue);
    await post(`/service-sales/${sale.saleId}/cancel`, { version: 0, reason: 'Báo giá đã hết hạn, cần đối chiếu lại' }).expect(200);
    const fresh = (await preview().expect(200)).body;
    expect(fresh.amountDue).toBe('1080000');
  });
  it('TC09: same-day target price/policy deactivation cannot alter frozen obligation', async () => {
    const sale = (await create().expect(201)).body;
    await db.collection('plans').updateOne({ _id: oid(targetPlanId) }, { $set: { price: toVndDecimal('1'), status: 'INACTIVE', duration_days: 90 } });
    await db.collection('plan_conversion_policies').updateMany({}, { $set: { status: 'INACTIVE', version: 8 } });
    expect((await settle(sale).expect(200)).body).toMatchObject({ startDate: '2026-11-16', endDate: '2026-12-15' });
    expect((await get(`/service-sales/${sale.saleId}`).expect(200)).body).toMatchObject({ amountDue: '1050000', listPrice: '1500000' });
  });
  it('TC10: PT used3 + BOOKED2 blocks target quota4 both before and after proposal creation', async () => {
    await ptSource();
    await request(apps[0].getHttpServer()).patch(`/api/admin/plans/${source.planId}`).set('Authorization', `Bearer ${tokens.ADMIN}`).send({ version: 0, sessionsQuota: 1 }).expect(200);
    targetPlanId = await target('1500000', 'PT', 4);
    await booking(); await booking('BOOKED', new Date('2026-11-18T03:00:00Z'));
    expect((await preview().expect(200)).body).toMatchObject({ canProceed: false, blockingCode: 'QUOTA_INSUFFICIENT', quotaSummary: { used: 3, reserved: 2 } });
    expect((await create().expect(409)).body.error.code).toBe('QUOTA_INSUFFICIENT');
    await db.collection('pt_bookings').deleteMany({});
    const sale = (await create().expect(201)).body;
    await booking(); await booking('BOOKED', new Date('2026-11-18T03:00:00Z'));
    expect((await settle(sale).expect(409)).body.error.code).toBe('QUOTA_INSUFFICIENT');
    await assertPending(sale);
  });
  it('TC11/12: carries used3; migrates only BOOKED/version+1 while trainer/shift/time and old COMPLETED/CANCELLED remain', async () => {
    await ptSource();
    const booked = await booking(), completed = await booking('COMPLETED'), cancelled = await booking('CANCELLED');
    const read = (id: string) => db.collection('pt_bookings').findOne({ _id: oid(id) });
    const before = await read(booked.id), oldComplete = await read(completed.id), oldCancel = await read(cancelled.id), originalSale = await sourceSale();
    const sale = (await create().expect(201)).body;
    const done = (await settle(sale).expect(200)).body;
    const moved = await read(booked.id);
    expect(moved).toEqual({ ...before, membership_id: oid(done.membershipId), version: 1, updated_at: now });
    expect(await read(completed.id)).toEqual(oldComplete); expect(await read(cancelled.id)).toEqual(oldCancel);
    expect((await db.collection('memberships').findOne({ _id: oid(done.membershipId) }))!.sessions_used).toBe(3);
    expect((await get(`/service-sales/${sale.saleId}`).expect(200)).body.carriedSessionsUsed).toBe(3);
    expect(await sourceSale()).toEqual(originalSale);
  });
  it.each(['started', 'outside'])('TC12: BOOKED %s blocks upgrade without automatic cancellation', async scenario => {
    await ptSource();
    const row = await booking('BOOKED', scenario === 'started' ? now : new Date('2027-01-01T03:00:00Z'));
    expect((await create().expect(409)).body.error.code).toBe('BOOKING_CONFLICT');
    expect((await db.collection('pt_bookings').findOne({ _id: oid(row.id) }))!.status).toBe('BOOKED');
  });
  it('TC13: real cancellation racing upgrade shares member gate, no orphaned link', async () => {
    await ptSource(); const row = await booking(), sale = (await create().expect(201)).body;
    const [upgraded, cancelled] = await Promise.all([settle(sale), post(`/pt-bookings/${row.id}/cancel`, { version: 0, reason: 'Hội viên thay đổi lịch cá nhân' }, randomUUID(), 'STAFF', 1)]);
    expect(upgraded.status).toBe(200); expect([200, 409]).toContain(cancelled.status);
    const actual = await db.collection('pt_bookings').findOne({ _id: oid(row.id) });
    expect(actual!.membership_id.toHexString()).toBe(cancelled.status === 200 ? source.membershipId : upgraded.body.membershipId);
    expect(actual!.status).toBe(cancelled.status === 200 ? 'CANCELLED' : 'BOOKED');
  });
  it('TC13: real completion racing upgrade re-reads current usage; completed link remains old', async () => {
    await ptSource(); const row = await booking('BOOKED', new Date('2026-11-16T03:30:00Z')), sale = (await create().expect(201)).body;
    now = new Date('2026-11-16T04:30:00Z');
    const [upgraded, completed] = await Promise.all([settle(sale), post(`/me/pt-bookings/${row.id}/complete`, { version: 0 }, randomUUID(), 'TRAINER', 1)]);
    expect(completed.status).toBe(200); expect([200, 409]).toContain(upgraded.status);
    const actual = await db.collection('pt_bookings').findOne({ _id: oid(row.id) });
    expect(actual!.status).toBe('COMPLETED'); expect(actual!.membership_id.toHexString()).toBe(source.membershipId);
    if (upgraded.status === 200) expect((await db.collection('memberships').findOne({ _id: oid(upgraded.body.membershipId) }))!.sessions_used).toBe(4);
    else expect(upgraded.body.error.code).toBe('BOOKING_CONFLICT');
  });
  it('TC13: real booking create racing upgrade cannot overbook or retain BOOKED on superseded source', async () => {
    await ptSource();
    await request(apps[0].getHttpServer()).patch(`/api/admin/plans/${source.planId}`).set('Authorization', `Bearer ${tokens.ADMIN}`).send({ version: 0, sessionsQuota: 1 }).expect(200);
    targetPlanId = await target('1500000', 'PT', 3);
    const slot = await booking(); await db.collection('pt_bookings').deleteOne({ _id: oid(slot.id) });
    const sale = (await create().expect(201)).body;
    const [upgraded, booked] = await Promise.all([settle(sale), post('/me/pt-bookings', { membershipId: source.membershipId, trainerId: slot.trainerId, shiftId: slot.shiftId, startAt: slot.startAt }, randomUUID(), 'MEMBER', 1)]);
    expect([200, 409]).toContain(upgraded.status); expect([201, 409]).toContain(booked.status);
    expect(upgraded.status === 200 && booked.status === 201).toBe(false);
    if (booked.status === 201) expect(upgraded.body.error.code).toBe('QUOTA_INSUFFICIENT');
    else expect(upgraded.status).toBe(200);
  });
  it.each(['invoice', 'booking', 'outbox'] as const)('TC14: failure after partial %s writes rolls back money/source/new membership/all booking links', async stage => {
    await ptSource(); const row = await booking(), sale = (await create().expect(201)).body;
    const before = await sourceMembership(), booked = await db.collection('pt_bookings').findOne({ _id: oid(row.id) });
    if (stage === 'invoice') {
      const repository = apps[0].get(SettlementRepository), original = repository.insertInvoice.bind(repository);
      jest.spyOn(repository, 'insertInvoice').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('Injected invoice failure after write'); });
    } else if (stage === 'booking') {
      const adapter = apps[0].get(UpgradeBookingsAdapter), original = adapter.moveWithinSession.bind(adapter);
      jest.spyOn(adapter, 'moveWithinSession').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('Injected booking failure after write'); });
    } else jest.spyOn(apps[0].get(NotificationsRepository), 'insertOutbox').mockRejectedValueOnce(new Error('Injected outbox failure'));
    await settle(sale).expect(500); await assertPending(sale);
    expect(await sourceMembership()).toEqual(before);
    expect(await db.collection('pt_bookings').findOne({ _id: oid(row.id) })).toEqual(booked);
    await settle(sale).expect(200);
  });
  it('TC15: upgrade and renewal on different instances cannot create two PENDING intents', async () => {
    const [upgrade, renewal] = await Promise.all([create(), post('/service-renewals', { memberId: source.memberId, previousSaleId: source.saleId, planVersion: 0 }, randomUUID(), 'STAFF', 1)]);
    expect([upgrade.status, renewal.status].sort()).toEqual([201, 409]);
    expect(await db.collection('transactions').countDocuments({ status: 'PENDING' })).toBe(1);
  });
  it('TC15: two confirms commit one replacement/payment/event, not two upgrades', async () => {
    const sale = (await create().expect(201)).body;
    const results = await Promise.all([settle(sale), settle(sale, 1)]);
    expect(results.map(row => row.status).sort()).toEqual([200, 409]);
    expect(await db.collection('memberships').countDocuments({ service_sale_id: oid(sale.saleId) })).toBe(1);
    expect(await db.collection('payments').countDocuments({ transaction_id: oid(sale.transactionId) })).toBe(1);
    expect(await db.collection('notifications').countDocuments({ event_key: `SERVICE_SALE_SETTLED:${sale.saleId}` })).toBe(1);
  });
  it('TC16: replay/lookup preserve exact quote; different payload conflicts; lost commit reply recovers same command', async () => {
    const key = randomUUID(), original = ClientSession.prototype.commitTransaction;
    const unknown = new MongoServerError({ message: 'injected lost reply' }); unknown.addErrorLabel('UnknownTransactionCommitResult');
    jest.spyOn(ClientSession.prototype, 'commitTransaction').mockImplementation(async function (this: ClientSession, ...args) { await original.apply(this, args); throw unknown; });
    await create({}, key).expect(503); jest.restoreAllMocks();
    const lookup = (await get(`/operations/SALE_UPGRADE/${key}`).expect(200)).body.responseBody;
    expect((await create({}, key.toUpperCase()).expect(201)).body).toEqual(lookup);
    expect((await create({ sourceVersion: 1 }, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await db.collection('service_sales').countDocuments({ operation: 'UPGRADE' })).toBe(1);
  }, 30000);
  it('US20 shared port: COUNTER and SELF_SERVICE use same constraints without exposing a Member counter endpoint', async () => {
    const results = await Promise.allSettled([create(), apps[1].get(UpgradeService).create(accounts.MEMBER.toHexString(), input(), randomUUID(), 'SELF_SERVICE')]);
    expect(results.map(row => row.status === 'fulfilled' ? row.value.status : (row.reason as {status: number}).status).sort()).toEqual([201, 409]);
  });
  it('S07 integration: completed history cannot be reopened after usage was carried into the upgraded membership', async () => {
    await ptSource(); const completed = await booking('COMPLETED'), sale = (await create().expect(201)).body;
    await settle(sale).expect(200);
    const response = await post(`/admin/pt-bookings/${completed.id}/corrections`, { version: 0, action: 'REOPEN', reason: 'Đối chiếu buổi đã hoàn tất trước nâng cấp' }, randomUUID(), 'ADMIN');
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('COMPLETION_RECONCILIATION_REQUIRED');
  });
  it('migration: index installation reruns safely and preserves historical financial snapshots', async () => {
    await db.collection('service_sales').updateOne({ _id: oid(source.saleId) }, { $unset: { channel: '' } });
    const before = await sourceSale(), options = { encoding: 'utf8' as const, windowsHide: true, env: { ...process.env }, timeout: 120000 };
    // Keep draining mongod stdout while the CLI runs; blocking this process can fill its log pipe on Linux CI.
    const runNode = promisify(execFile);
    await runNode(process.execPath, [require.resolve('@nestjs/cli/bin/nest.js'), 'build'], options);
    for (let i = 0; i < 2; i++) {
      const result = await runNode(process.execPath, ['scripts/admin.cjs', 'ensure-indexes'], options);
      expect(result.stdout).toContain('INDEXES_ENSURED');
    }
    expect(await sourceSale()).toEqual({ ...before, channel: 'COUNTER' });
    expect((await db.collection('service_sales').indexes()).some(index => index.name === 'service_sales_upgrade_source')).toBe(true);
  }, 120000);
});
