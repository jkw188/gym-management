import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Document, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { UsersRepository } from '../src/modules/users/users.repository';
import { MembershipReportsRepository } from '../src/modules/reports/membership-reports.repository';

describe('US-50 / UC-38 / S08-M01 (MongoDB replica set + real JWT)', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };
  const auth: Record<string, { token: string; id: ObjectId }> = {};
  const db = () => connection.db!;
  const password = 'US50-Password-123!';
  const origin = 'http://localhost:5173';
  const base = '/api/reports/memberships';
  const observedAt = '2026-11-17T05:00:00.000Z';
  const get = (path = '/summary', role = 'ADMIN') => request(app.getHttpServer()).get(base + path).set('Authorization', `Bearer ${auth[role].token}`);
  let ids: ObjectId[];
  let gym: ObjectId, pt: ObjectId;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_us50', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'), SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'test@gym.test' });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    const users = app.get(UsersRepository);
    const hash = await app.get(PasswordService).hash(password);
    let sequence = 0;
    for (const code of ['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as const) {
      const role = await users.ensureRole(code, code);
      const account = await users.createAccount({ roleId: String(role.id), fullName: `US50 ${code}`, phone: `098500000${++sequence}`, passwordHash: hash });
      const response = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
      auth[code] = { token: response.body.accessToken, id: new ObjectId(String(account.id)) };
    }
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(ServerClock.prototype, 'now').mockReturnValue(new Date(observedAt));
    for (const name of ['members', 'memberships', 'service_sales', 'transactions', 'payments', 'invoices']) await db().collection(name).deleteMany({});
    ids = Array.from({ length: 4 }, () => new ObjectId());
    await db().collection('members').insertMany(ids.map((_id, i) => ({ _id, id: _id, member_code: `HV-${_id}`,
      full_name: ['A', 'B', 'C', 'D'][i], phone: `090500000${i}`, created_at: new Date('2026-10-01T00:00:00+07:00') })));
    gym = await entitlement(ids[0], 'GYM'); pt = await entitlement(ids[0], 'PT');
    await entitlement(ids[1], 'GYM');
    const pending = new ObjectId(), sale = new ObjectId();
    await db().collection('transactions').insertOne({ _id: pending, code: `TX-${pending}`, request_key: String(pending), member_id: ids[2], kind: 'GYM', status: 'PENDING' });
    await db().collection('service_sales').insertOne({ _id: sale, member_id: ids[2], transaction_id: pending });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = savedEnv; });
  async function entitlement(memberId: ObjectId, kind: 'GYM' | 'PT', membershipPatch: Document = {}, txPatch: Document = {}, salePatch: Document = {}) {
    const _id = new ObjectId(), sale = new ObjectId(), tx = new ObjectId();
    await db().collection('transactions').insertOne({ _id: tx, id: tx, code: `TX-${tx}`, request_key: String(tx),
      member_id: memberId, kind, status: 'SETTLED', settled_at: new Date('2026-11-01T03:00:00+07:00'), amount_due: 0, ...txPatch });
    await db().collection('service_sales').insertOne({ _id: sale, id: sale, member_id: memberId, transaction_id: tx,
      kind_snapshot: kind, plan_id: new ObjectId(), plan_name_snapshot: `Snapshot ${kind}`, start_date: '2026-11-01', end_date: '2026-11-30', ...salePatch });
    await db().collection('memberships').insertOne({ _id, id: _id, service_sale_id: sale, status: 'ACTIVE',
      created_at: new Date('2026-11-01T03:00:00+07:00'), sessions_used: kind === 'PT' ? 10 : 0, ...membershipPatch });
    return _id;
  }
  it('TC01-05: distinct, denominator, free SETTLED, quota exhausted and unlinked members', async () => {
    const result = (await get().expect(200)).body;
    expect(result).toMatchObject({ totalMembers: 4, activeMembers: 2, inactiveMembers: 2, activeRate: 50,
      activeMemberships: 3, dataQuality: 'COMPLETE', metricVersion: 'S08-V1', observedAt,
      byKind: { GYM: { activeMembers: 2, activeMemberships: 2 }, PT: { activeMembers: 1, activeMemberships: 1 } } });
    const page = (await get('/members').query({ limit: 1 }).expect(200)).body;
    expect(page).toMatchObject({ total: 4, totalPages: 4, totalMembers: 4, activeMembers: 2, activeMemberships: 3 });
    expect(page.items[0]).not.toHaveProperty('phone'); expect(page.items[0]).not.toHaveProperty('accountId');
    const oracle = require('./helpers/en08-report-oracle.cjs') as {
      membershipOracle(source: Record<string, Document[]>, asOfAt: string, observedAt: string): Record<string, unknown>;
    };
    const committed: Record<string, Document[]> = {};
    for (const name of ['members', 'memberships', 'service_sales', 'transactions']) committed[name] = await db().collection(name).find().toArray();
    const expected = oracle.membershipOracle(JSON.parse(JSON.stringify(committed)) as Record<string, Document[]>, result.asOfAt, observedAt);
    for (const metric of ['totalMembers', 'activeMembers', 'inactiveMembers', 'activeRate', 'activeMemberships', 'dataQuality']) expect(result[metric]).toEqual(expected[metric]);
    const ptOnly = (await get().query({ kind: 'PT' }).expect(200)).body;
    expect(ptOnly).toMatchObject({ totalMembers: 4, activeMembers: 1, inactiveMembers: 3, activeRate: 25, activeMemberships: 1 });
    await db().collection('members').updateOne({ _id: ids[0] }, { $set: { account_id: auth.MEMBER.id } });
    await db().collection('accounts').updateOne({ _id: auth.MEMBER.id }, { $set: { status: 'LOCKED' } });
    expect((await get().expect(200)).body.activeMembers).toBe(2);
    await db().collection('accounts').updateOne({ _id: auth.MEMBER.id }, { $set: { status: 'ACTIVE' } });
  });
  it('TC05: literal search, activity, pagination never change whole-room KPI', async () => {
    const active = (await get('/members').query({ activity: 'ACTIVE', limit: 1, page: 2 }).expect(200)).body;
    expect(active).toMatchObject({ total: 2, totalPages: 2, totalMembers: 4, activeMembers: 2 });
    expect(active.items).toHaveLength(1);
    expect((await get('/members').query({ q: ' .* ' }).expect(200)).body).toMatchObject({ total: 0, totalPages: 0, activeMembers: 2 });
    expect((await get('/members').query({ q: ' A ' }).expect(200)).body.filter.q).toBe('A');
  });
  it('TC06/08: exact VN start, settlement and exclusive midnight after end', async () => {
    for (const [asOfAt, expected] of [
      ['2026-10-31T23:59:59.999+07:00', 0], ['2026-11-01T00:00:00+07:00', 0],
      ['2026-11-01T02:59:59.999+07:00', 0], ['2026-11-01T03:00:00+07:00', 3],
    ] as const) expect((await get().query({ asOfAt }).expect(200)).body.activeMemberships).toBe(expected);
    await db().collection('service_sales').updateMany({ kind_snapshot: { $exists: true } }, { $set: { end_date: '2026-11-16' } });
    expect((await get().query({ asOfAt: '2026-11-16T23:59:59.999+07:00' }).expect(200)).body.activeMemberships).toBe(3);
    expect((await get().query({ asOfAt: '2026-11-17T00:00:00+07:00' }).expect(200)).body.activeMemberships).toBe(0);
  });
  it('TC07: historical SUPERSEDED source before 10:30, destination at the same exact instant', async () => {
    const boundary = new Date('2026-11-10T10:30:00+07:00');
    const target = await entitlement(ids[0], 'GYM', { created_at: boundary }, { settled_at: boundary });
    await db().collection('memberships').updateOne({ _id: gym }, { $set: { status: 'SUPERSEDED', superseded_at: boundary, superseded_by_membership_id: target } });
    for (const [asOfAt, sourceId] of [['2026-11-10T10:29:59.999+07:00', gym], ['2026-11-10T10:30:00+07:00', target]] as const) {
      const report = (await get(`/members/${ids[0]}`).query({ asOfAt }).expect(200)).body;
      expect(report.activeMemberships).toBe(3);
      const qualifying = report.memberships.filter((row: { kind: string; qualifies: boolean }) => row.kind === 'GYM' && row.qualifies);
      expect(qualifying).toHaveLength(1); expect(qualifying[0].membershipId).toBe(String(sourceId));
      expect(report.memberships.find((row: { membershipId: string }) => row.membershipId === String(gym)).currentStatus).toBe('SUPERSEDED');
    }
  });
  it('TC08/12: paid_at and multiplicative payment/invoice records have no effect', async () => {
    const member = await db().collection('memberships').findOne({ _id: gym });
    const sale = await db().collection('service_sales').findOne({ _id: member!.service_sale_id });
    for (let i = 0; i < 3; i++) {
      const id = new ObjectId();
      await db().collection('payments').insertOne({ _id: id, id, reference: `PAY-${id}`, transaction_id: sale!.transaction_id,
        status: i === 0 ? 'SUCCEEDED' : 'FAILED', paid_at: new Date('2026-10-01Z') });
    }
    await db().collection('invoices').insertOne({ _id: new ObjectId(), invoice_no: 'US50-INVOICE', transaction_id: sale!.transaction_id });
    expect((await get().query({ asOfAt: '2026-11-01T02:00:00+07:00' }).expect(200)).body.activeMemberships).toBe(0);
    expect((await get().expect(200)).body.activeMemberships).toBe(3);
  });
  it('TC09: unknown history is null/partial; unaffected PT metrics remain known', async () => {
    await db().collection('memberships').updateOne({ _id: gym }, { $set: { status: 'SUPERSEDED' } });
    const body = (await get().expect(200)).body;
    expect(body).toMatchObject({ totalMembers: 4, activeMembers: null, activeRate: null, activeMemberships: null,
      dataQuality: 'PARTIAL', invalidRecordCount: 1, byKind: { PT: { activeMembers: 1 } } });
    expect(body.warningCodes).toContain('SUPERSESSION_HISTORY_MISSING'); expect(body.historyCoverageFrom).toBeUndefined();
    expect((await get().query({ kind: 'PT' }).expect(200)).body.activeMembers).toBe(1);
    const source = (await get(`/members/${ids[0]}`).expect(200)).body.memberships.find((row: { membershipId: string }) => row.membershipId === String(gym));
    expect(source.qualifies).toBeNull(); expect(source.effectiveEnd).toBeNull();
  });
  it('TC09: missing settled_at, orphan membership, missing member timestamp and missing granted membership', async () => {
    const membership = await db().collection('memberships').findOne({ _id: gym });
    const sale = await db().collection('service_sales').findOne({ _id: membership!.service_sale_id });
    await db().collection('transactions').updateOne({ _id: sale!.transaction_id }, { $unset: { settled_at: '' } });
    expect((await get().expect(200)).body.warningCodes).toContain('SETTLED_AT_MISSING');
    await db().collection('service_sales').deleteOne({ _id: sale!._id });
    expect((await get().expect(200)).body.warningCodes).toContain('SALE_MISSING');
    await db().collection('members').updateOne({ _id: ids[0] }, { $unset: { created_at: '' } });
    expect((await get().expect(200)).body).toMatchObject({ dataQuality: 'UNAVAILABLE', totalMembers: null, activeRate: null });
    await db().collection('memberships').deleteOne({ _id: pt });
    expect((await get().expect(200)).body.warningCodes).toContain('SETTLED_MEMBERSHIP_MISSING');
  });
  it('TC06/09: creation is a lower bound and invalid history outside the period does not poison known metrics', async () => {
    await db().collection('memberships').updateOne({ _id: gym }, { $set: { created_at: new Date('2026-11-10T10:30:00+07:00') } });
    expect((await get().query({ asOfAt: '2026-11-10T10:29:59.999+07:00' }).expect(200)).body.activeMemberships).toBe(2);
    expect((await get().query({ asOfAt: '2026-11-10T10:30:00+07:00' }).expect(200)).body.activeMemberships).toBe(3);
    await db().collection('memberships').updateOne({ _id: gym }, { $set: { status: 'SUPERSEDED' } });
    expect((await get().query({ asOfAt: '2026-10-31T23:59:59+07:00' }).expect(200)).body).toMatchObject({ dataQuality: 'COMPLETE', activeMemberships: 0 });
    await db().collection('members').updateOne({ _id: ids[0] }, { $set: { created_at: new Date('2026-11-18T00:00:00+07:00') } });
    expect((await get().expect(200)).body).toMatchObject({ totalMembers: 3, activeMembers: 1, dataQuality: 'COMPLETE' });
  });
  it('TC09: CANCELLED needs historical evidence; exact cancellation boundary is exclusive', async () => {
    await db().collection('memberships').updateOne({ _id: gym }, { $set: { status: 'CANCELLED', cancelled_at: new Date('2026-11-10T10:30:00+07:00') } });
    expect((await get().query({ asOfAt: '2026-11-10T10:29:59.999+07:00' }).expect(200)).body.activeMemberships).toBe(3);
    expect((await get().query({ asOfAt: '2026-11-10T10:30:00+07:00' }).expect(200)).body.activeMemberships).toBe(2);
    await db().collection('memberships').updateOne({ _id: gym }, { $unset: { cancelled_at: '' } });
    const body = (await get().expect(200)).body;
    expect(body.activeMembers).toBeNull(); expect(body.warningCodes).toContain('CANCELLATION_HISTORY_MISSING');
    await db().collection('memberships').updateOne({ _id: gym }, { $set: { status: 'ACTIVE', superseded_at: 'invalid-date' } });
    expect((await get().expect(200)).body.warningCodes).toContain('SUPERSESSION_HISTORY_INVALID');
  });
  it('TC09: a PT orphan does not turn unrelated GYM table rows into UNKNOWN', async () => {
    await entitlement(new ObjectId(), 'PT');
    const body = (await get('/members').query({ kind: 'GYM' }).expect(200)).body;
    expect(body).toMatchObject({ dataQuality: 'PARTIAL', activeMembers: 2 });
    expect(body.items.find((row: { memberId: string }) => row.memberId === String(ids[3])).activity).toBe('INACTIVE');
  });
  it('TC10: empty denominator is valid zero with null rate', async () => {
    const body = (await get().query({ asOfAt: '2026-01-01T00:00:00+07:00' }).expect(200)).body;
    expect(body).toMatchObject({ totalMembers: 0, activeMembers: 0, activeRate: null, dataQuality: 'COMPLETE' });
    expect((await get('/members').query({ asOfAt: body.asOfAt }).expect(200)).body.totalPages).toBe(0);
  });
  it.each([{ asOfAt: '2026-11-18T00:00:00Z' }, { asOfAt: '2026-11-01T00:00:00' },
    { asOfAt: '2026-02-30T00:00:00Z' }, { kind: 'RETAIL' }, { fromDate: '2026-01-01' },
    { page: '1.2' }, { limit: 101 }, { activity: 'UNKNOWN' }, { q: 'a'.repeat(121) }])('TC10: rejects invalid filters %j', async query => {
    await get('/members').query(query).expect(400);
  });
  it('TC11: real auth rejects other roles and revoked session on every endpoint', async () => {
    for (const path of ['/summary', '/members', `/members/${ids[0]}`]) {
      for (const role of ['STAFF', 'TRAINER', 'MEMBER']) await get(path, role).expect(403);
      await request(app.getHttpServer()).get(base + path).expect(401);
    }
    await db().collection('auth_sessions').updateMany({ account_id: auth.ADMIN.id }, { $set: { revoked_at: new Date() } });
    try { await get().expect(401); }
    finally { await db().collection('auth_sessions').updateMany({ account_id: auth.ADMIN.id }, { $unset: { revoked_at: '' } }); }
    await get('/members/invalid').expect(400); await get(`/members/${new ObjectId()}`).expect(404);
    expect((await get(`/members/${String(ids[0]).toUpperCase()}`).expect(200)).body.memberships).toHaveLength(2);
  });
  it('TC13: concurrent commit during source reads cannot mix summary, groups and list', async () => {
    const repo = app.get(MembershipReportsRepository), original = repo.members.bind(repo);
    const spy = jest.spyOn(repo, 'members').mockImplementationOnce(async session => {
      const rows = await original(session);
      await db().collection('memberships').updateOne({ _id: gym }, { $set: { cancelled_at: new Date('2026-11-02Z'), status: 'CANCELLED' } });
      return rows;
    });
    const first = (await get('/members').expect(200)).body;
    expect(first.activeMemberships).toBe(3); expect(first.byKind.GYM.activeMemberships).toBe(2);
    expect(first.items.find((row: { memberId: string }) => row.memberId === String(ids[0])).qualifyingMembershipCount).toBe(2);
    spy.mockRestore();
    jest.mocked(ServerClock.prototype.now).mockReturnValue(new Date('2026-11-17T05:01:00.000Z'));
    const second = (await get('/members').expect(200)).body;
    expect(second.activeMemberships).toBe(2); expect(second.observedAt).not.toBe(first.observedAt);
  });
  it('TC14: repeated GET has no writes; infrastructure error is sanitized 503', async () => {
    const read = async () => { const rows = []; for (const name of ['members', 'memberships', 'service_sales', 'transactions']) rows.push(await db().collection(name).find().toArray()); return rows; };
    const before = await read(); await get().expect(200); await get('/members').expect(200); await get(`/members/${ids[0]}`).expect(200);
    expect(await read()).toEqual(before);
    const error = new Error('mongodb://private-secret'); error.name = 'MongoNetworkError';
    jest.spyOn(app.get(MembershipReportsRepository), 'sources').mockRejectedValueOnce(error);
    const response = await get().expect(503);
    expect(response.body.error.code).toBe('DATABASE_UNAVAILABLE'); expect(response.body.requestId).toBeTruthy();
    expect(JSON.stringify(response.body)).not.toContain('private-secret'); expect(response.body.totalMembers).toBeUndefined();
  });
  it('existing source indexes support member ordering and source lookups (explain)', async () => {
    const report = await db().collection('members').find({ created_at: { $lte: new Date(observedAt) } }).sort({ created_at: -1, _id: -1 }).hint('members_created_desc').explain('executionStats');
    expect(report.executionStats.nReturned).toBe(4);
    expect(JSON.stringify(report.queryPlanner.winningPlan)).toContain('IXSCAN');
    const sale = await db().collection('service_sales').find({ member_id: ids[0], kind_snapshot: 'GYM' }).hint('service_sales_member_kind').explain('executionStats');
    expect(JSON.stringify(sale.queryPlanner.winningPlan)).toContain('IXSCAN');
    expect(await db().collection('memberships').indexes()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'memberships_sale_unique', unique: true })]));
  });
});
