import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { ensureFinancialIntegrity } from '../src/infrastructure/transaction/financial-integrity';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { ensureMembersQueryIndexes } from '../src/modules/members/members-query.indexes';
import { MembersQueryRepository } from '../src/modules/members/members-query.repository';
import { ROLE_CODES, RoleCode } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const password = 'US11 test password 123';
const now = new Date('2026-11-08T18:00:00.000Z'); // Việt Nam đã sang 09/11.
const today = '2026-11-09';

describe('US-11 / UC-17: lookup with real MongoDB joins, indexes and JWT', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  let hash: string;
  let token: string;
  let sequence = 0;
  const savedEnv = { ...process.env };
  const db = () => connection.db!;

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(),
      MONGODB_DB: 'gym_management_test_us11', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '' });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    await ensureFinancialIntegrity(connection); await ensureMembersQueryIndexes(connection);
    hash = await app.get(PasswordService).hash(password);
  }, 600000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(app.get(ServerClock), 'now').mockReturnValue(now);
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await db().collections()) await collection.deleteMany({});
    for (const code of ROLE_CODES) await app.get(UsersRepository).ensureRole(code, code);
    token = await login('STAFF');
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = savedEnv; });

  async function login(code: RoleCode) {
    const users = app.get(UsersRepository);
    const role = await users.findRoleByCode(code);
    const account = await users.createAccount({ roleId: role!.id.toHexString(), fullName: `US11 ${code}`,
      phone: `090${String(++sequence).padStart(7, '0')}`, passwordHash: hash });
    const response = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin)
      .send({ phone: account.phone, password }).expect(200);
    return response.body.accessToken as string;
  }
  async function member(name = 'Nguyễn An', phone = `+8491${String(++sequence).padStart(7, '0')}`, linked = false) {
    const id = new ObjectId();
    await db().collection('members').insertOne({ _id: id, id, member_code: `HV-${id}`, full_name: name,
      phone, version: 4, service_revision: Long.ZERO, created_by: new ObjectId(), updated_by: new ObjectId(),
      created_at: now, updated_at: now, ...(linked ? { account_id: new ObjectId() } : {}) });
    return id;
  }
  async function sale(owner: ObjectId, options: { kind?: 'GYM' | 'PT'; status?: string; stored?: string;
    start?: string; end?: string; membership?: boolean; transactionOwner?: ObjectId } = {}) {
    const transaction = new ObjectId(); const sale = new ObjectId(); const membership = new ObjectId();
    await db().collection('transactions').insertOne({ _id: transaction, id: transaction,
      member_id: options.transactionOwner ?? owner, code: `GD-${transaction}`, kind: options.kind ?? 'GYM',
      status: options.status ?? 'SETTLED', amount_due: Decimal128.fromString('500000'), created_at: now,
      created_by: new ObjectId(), request_key: transaction.toHexString().padEnd(64, '0'), guard_revision: Long.ZERO });
    await db().collection('service_sales').insertOne({ _id: sale, id: sale, transaction_id: transaction,
      member_id: owner, plan_id: new ObjectId(), plan_name_snapshot: 'Gói gốc lúc bán', start_date: options.start ?? today,
      end_date: options.end ?? today, sessions_snapshot: options.kind === 'PT' ? 12 : 0 });
    if (options.membership !== false) await db().collection('memberships').insertOne({ _id: membership, id: membership,
      service_sale_id: sale, status: options.stored ?? 'ACTIVE', sessions_used: options.kind === 'PT' ? 2 : 0 });
    return { transaction, sale, membership };
  }
  function get(path = '', query: object = {}, bearer: string | null = token) {
    const call = request(app.getHttpServer()).get(`/api/members${path}`).query(query);
    return bearer ? call.set('Authorization', `Bearer ${bearer}`) : call;
  }

  it('TC01: Staff/Admin only on list, detail and both histories', async () => {
    const id = await member();
    const paths = ['', `/${id}`, `/${id}/memberships`, `/${id}/transactions`];
    for (const path of paths) await get(path).expect(200);
    const admin = await login('ADMIN');
    for (const path of paths) await get(path, {}, admin).expect(200);
    for (const role of ['MEMBER', 'TRAINER'] as const) {
      const denied = await login(role);
      for (const path of paths) await get(path, {}, denied).expect(403);
    }
    for (const path of paths) await get(path, {}, null).expect(401);
  });

  it('TC02: code/name/literal regex punctuation, complete 0/+84 phone normalization', async () => {
    const id = await member('Nguyễn [An].*', '+84912345678');
    for (const q of [id.toHexString(), 'nguyễn', '[An].*', '0912345678', '+84 912 345 678']) {
      const result = await get('', { q }).expect(200);
      expect(result.body.items.map((item: { id: string }) => item.id)).toEqual([id.toHexString()]);
    }
    expect((await get('', { q: '.*' }).expect(200)).body.total).toBe(1); // ký tự thật trong tên
    expect((await get('', { q: '^.*$' }).expect(200)).body.total).toBe(0);
    expect((await get('', { q: '(' }).expect(200)).body.total).toBe(0);
    expect((await get('', { q: '3456' }).expect(200)).body.total).toBe(1);
  });

  it('TC03: stable created_at/_id ordering, defaults, totals and bounded pages', async () => {
    const ids = [];
    for (let index = 0; index < 25; index++) ids.push((await member()).toHexString());
    const first = (await get().expect(200)).body;
    const second = (await get('', { page: 2 }).expect(200)).body;
    expect(first).toMatchObject({ page: 1, limit: 20, total: 25, totalPages: 2, asOf: now.toISOString(), businessDate: today });
    expect([...first.items, ...second.items].map(item => item.id)).toEqual(ids.sort().reverse());
    expect((await get('', { page: 3 }).expect(200)).body.items).toEqual([]);
  });

  it('TC04/10: empty members, unlinked member with no sales, invalid/missing IDs', async () => {
    expect((await get().expect(200)).body).toMatchObject({ items: [], total: 0, totalPages: 0 });
    const id = await member();
    const detail = (await get(`/${id}`).expect(200)).body;
    expect(detail).toMatchObject({ member: { id: id.toHexString(), version: 4 }, entitlementSummary: { GYM: ['NONE'], PT: ['NONE'] } });
    expect(detail.member.accountId).toBeUndefined();
    expect((await get().expect(200)).body.items[0].accountLinked).toBe(false);
    for (const suffix of ['', '/memberships', '/transactions']) {
      await get(`/invalid${suffix}`).expect(400);
      expect((await get(`/${new ObjectId()}${suffix}`).expect(404)).body.error.code).toBe('MEMBER_NOT_FOUND');
    }
    for (const suffix of ['/memberships', '/transactions']) {
      expect((await get(`/${id}${suffix}`).expect(200)).body).toMatchObject({ items: [], total: 0, totalPages: 0, businessDate: today });
    }
  });

  it('TC05/06: inclusive dates and Vietnamese day instead of UTC; same kind can have multiple states', async () => {
    const id = await member();
    await sale(id); // start=end=today
    await sale(id, { start: '2026-11-01', end: today });
    await sale(id, { start: '2026-11-10', end: '2026-12-09' });
    await sale(id, { start: '2026-10-01', end: '2026-11-08' });
    const detail = (await get(`/${id}`).expect(200)).body;
    expect(detail.entitlementSummary).toEqual({ GYM: ['CURRENT', 'SCHEDULED', 'EXPIRED'], PT: ['NONE'] });
    const history = (await get(`/${id}/memberships`).expect(200)).body;
    expect(history.items.map((item: { timeState: string }) => item.timeState).sort()).toEqual(['CURRENT', 'CURRENT', 'EXPIRED', 'SCHEDULED']);
    expect(history.asOf).toBe(now.toISOString()); expect(history.businessDate).toBe(today);
    for (const membershipState of ['CURRENT', 'SCHEDULED', 'EXPIRED']) expect((await get('', { membershipState }).expect(200)).body.total).toBe(1);
  });

  it('TC07: unsettled, superseded and cancelled rows are history only; pending sale does not fabricate a membership', async () => {
    const id = await member();
    await sale(id, { status: 'PENDING' });
    await sale(id, { stored: 'SUPERSEDED' });
    await sale(id, { stored: 'CANCELLED' });
    await sale(id, { status: 'CANCELLED' });
    await sale(id, { status: 'PENDING', membership: false });
    expect((await get(`/${id}`).expect(200)).body.entitlementSummary).toEqual({ GYM: ['NONE'], PT: ['NONE'] });
    const history = (await get(`/${id}/memberships`).expect(200)).body;
    expect(history.total).toBe(4);
    expect(history.items.every((item: { timeState: string }) => item.timeState === 'NONE')).toBe(true);
    expect((await get(`/${id}/transactions`).expect(200)).body.total).toBe(5);
    expect((await get('', { membershipState: 'NONE' }).expect(200)).body.total).toBe(1);
    expect((await get('', { membershipState: 'CURRENT' }).expect(200)).body.total).toBe(0);
  });

  it('TC08: kind scopes NONE and time filters while summary retains both kinds', async () => {
    const id = await member('Hai loại', undefined, true); const empty = await member('Không có PT');
    await sale(id); await sale(id, { kind: 'PT', start: '2026-10-01', end: '2026-11-08' });
    await sale(empty);
    const query = async (kind: string | undefined, membershipState: string) =>
      (await get('', { ...(kind ? { kind } : {}), membershipState }).expect(200)).body;
    expect((await query('GYM', 'CURRENT')).total).toBe(2);
    expect((await query('PT', 'CURRENT')).total).toBe(0);
    expect((await query(undefined, 'EXPIRED')).items[0]).toMatchObject({ id: id.toHexString(), accountLinked: true,
      entitlementSummary: { GYM: ['CURRENT'], PT: ['EXPIRED'] } });
    expect((await query('PT', 'NONE')).items.map((item: { id: string }) => item.id)).toEqual([empty.toHexString()]);
    expect((await query(undefined, 'NONE')).total).toBe(0);
    expect((await query('GYM', 'EXPIRED')).total).toBe(0);
  });

  it('TC09/11: member isolation, snapshot name, pagination, payment/invoice IDs only from existing records', async () => {
    const a = await member('Member A'); const b = await member('Member B');
    const first = await sale(a, { kind: 'PT' }); const pending = await sale(a, { status: 'PENDING', membership: false });
    const foreign = await sale(b);
    await sale(a, { transactionOwner: b }); // sai owner ở transaction: không được lộ qua membership join
    const payment = new ObjectId(); const invoice = new ObjectId();
    await db().collection('payments').insertMany([
      { _id: payment, transaction_id: first.transaction, status: 'SUCCEEDED', reference: 'p1', secret: 'hidden' },
      { _id: new ObjectId(), transaction_id: first.transaction, status: 'FAILED', reference: 'p2' },
      { _id: new ObjectId(), transaction_id: pending.transaction, status: 'SUCCEEDED', reference: 'unreconciled' },
      { _id: new ObjectId(), transaction_id: foreign.transaction, status: 'SUCCEEDED', reference: 'foreign' },
    ]);
    await db().collection('invoices').insertOne({ _id: invoice, transaction_id: first.transaction, invoice_no: 'INV1', buyer_snapshot: 'hidden' });
    const history = (await get(`/${a}/memberships`, { limit: 1 }).expect(200)).body;
    expect(history.total).toBe(1);
    expect(history.items[0]).toMatchObject({ membershipId: first.membership.toHexString(), saleId: first.sale.toHexString(),
      planName: 'Gói gốc lúc bán', kind: 'PT', sessionsQuota: 12, sessionsUsed: 2 });
    const transactions = (await get(`/${a}/transactions`, { limit: 1 }).expect(200)).body;
    const next = (await get(`/${a}/transactions`, { limit: 1, page: 2 }).expect(200)).body;
    expect(transactions).toMatchObject({ total: 2, totalPages: 2 });
    expect(transactions.items[0]).toMatchObject({ id: pending.transaction.toHexString(), amountDue: '500000' });
    expect(transactions.items[0].paymentId).toBeUndefined(); expect(transactions.items[0].invoiceId).toBeUndefined();
    expect(next.items[0]).toMatchObject({ id: first.transaction.toHexString(), paymentId: payment.toHexString(), invoiceId: invoice.toHexString() });
    const outputs = JSON.stringify([history, transactions, next, (await get(`/${a}`).expect(200)).body]);
    for (const secret of ['password_hash', 'auth_version', 'request_key', 'guard_revision', 'buyer_snapshot', 'secret', foreign.transaction.toHexString()]) expect(outputs).not.toContain(secret);
  });

  it('TC12: settlement between reads refreshes asOf/state; GET never mutates business collections', async () => {
    const id = await member(); const pending = await sale(id, { status: 'PENDING' });
    const snapshot = async () => Promise.all(['members', 'service_sales', 'memberships', 'transactions', 'payments', 'invoices']
      .map(name => db().collection(name).find().sort({ _id: 1 }).toArray()));
    const before = await snapshot();
    expect((await get(`/${id}`).expect(200)).body.entitlementSummary.GYM).toEqual(['NONE']);
    for (const path of ['', `/${id}`, `/${id}/memberships`, `/${id}/transactions`]) await get(path).expect(200);
    expect(await snapshot()).toEqual(before);
    await db().collection('transactions').updateOne({ _id: pending.transaction }, { $set: { status: 'SETTLED' } });
    jest.spyOn(app.get(ServerClock), 'now').mockReturnValue(new Date('2026-11-08T18:01:00Z'));
    const settled = (await get(`/${id}`).expect(200)).body;
    expect(settled.entitlementSummary.GYM).toEqual(['CURRENT']); expect(settled.asOf).toBe('2026-11-08T18:01:00.000Z');
  });

  it('TC09/11: retail transactions and Decimal128 exponent values use the integer VND string contract', async () => {
    const id = await member(); const transaction = new ObjectId();
    await db().collection('transactions').insertOne({ _id: transaction, member_id: id, kind: 'RETAIL', code: 'POS-01',
      status: 'SETTLED', amount_due: Decimal128.fromString('5E+5'), created_at: now, request_key: 'f'.repeat(64) });
    const response = (await get(`/${id}/transactions`).expect(200)).body;
    expect(response.items).toEqual([{ id: transaction.toHexString(), kind: 'RETAIL', code: 'POS-01', status: 'SETTLED',
      amountDue: '500000', createdAt: now.toISOString() }]);
  });

  it('TC13: one aggregation for many member rows, projected fields, query indexes usable', async () => {
    for (let index = 0; index < 22; index++) await sale(await member());
    const aggregate = jest.spyOn(connection.collection('members'), 'aggregate');
    await get('', { membershipState: 'CURRENT' }).expect(200);
    expect(aggregate).toHaveBeenCalledTimes(1);
    const pipeline = JSON.stringify(aggregate.mock.calls[0][0]);
    expect(pipeline).toContain('$group'); expect(pipeline).toContain('$project'); expect(pipeline).toContain('$facet');
    const explain = await db().collection('transactions').find({ member_id: new ObjectId() })
      .sort({ created_at: -1, _id: -1 }).hint('transactions_member_created_desc').explain('queryPlanner');
    expect(JSON.stringify(explain)).toContain('transactions_member_created_desc');
    expect((await db().collection('service_sales').indexes()).some(index => index.name === 'service_sales_member_transaction')).toBe(true);
    // Chạy lại chỉ tạo index, không đổi dữ liệu tài chính.
    await ensureMembersQueryIndexes(connection);
  });

  it('TC14: allowlist/types reject query injection; infrastructure errors have a safe envelope', async () => {
    const id = await member();
    for (const query of [{ q: 'a'.repeat(121) }, { q: { $ne: '' } }, { q: ['a', 'b'] }, { kind: 'RETAIL' },
      { membershipState: 'ACTIVE' }, { status: 'CURRENT' }, { fromDate: '2026-02-30' }, { page: 0 }, { page: '1.5' },
      { page: '1e2' }, { page: Number.MAX_SAFE_INTEGER, limit: 100 }, { limit: 101 }, { limit: '' }]) await get('', query).expect(400);
    for (const suffix of ['', '/memberships', '/transactions']) await get(`/${id}${suffix}`, { unknown: 'x' }).expect(400);
    const failure = new Error('mongodb://private-host password_hash'); failure.name = 'MongoNetworkError';
    jest.spyOn(app.get(MembersQueryRepository), 'list').mockRejectedValueOnce(failure);
    const response = await get().expect(503);
    expect(response.body).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' }, requestId: expect.any(String) });
    expect(JSON.stringify(response.body)).not.toMatch(/private-host|password_hash/);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('private-host');
  });
});
