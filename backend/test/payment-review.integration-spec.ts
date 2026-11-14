import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoNetworkError } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { toVndDecimal } from '../src/common/utils/vnd-money';
import { ensureFinancialIntegrity } from '../src/infrastructure/transaction/financial-integrity';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { MembersRepository } from '../src/modules/members/members.repository';
import { PaymentsQueryRepository } from '../src/modules/payments/payments-query.repository';
import { Plan } from '../src/modules/plans/schemas/plan.schema';
import { UsersRepository } from '../src/modules/users/users.repository';
import { RoleCode } from '../src/modules/users/schemas/role.schema';

describe('US-21 real MongoDB, HTTP/RBAC and read-only payment review', () => {
  const savedEnv = { ...process.env };
  const now = new Date('2026-11-14T03:00:00Z');
  let mongo: MongoMemoryReplSet, app: INestApplication, db: Connection, staffId: Types.ObjectId;
  const tokens = {} as Record<RoleCode, string>;
  let sequence = 0;
  let sale: { transactionId: string; transactionCode: string; saleId: string; memberId: string };
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', FRONTEND_ORIGIN: 'http://localhost:5173', MONGODB_URI: mongo.getUri(),
      MONGODB_DB: `gym_test_us21_${randomBytes(6).toString('hex')}`, JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'), SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525',
      SMTP_SECURE: 'false', SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'no-reply@gym.test', RECEIVING_ACCOUNTS: '["GYM_MAIN"]' });
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock)
      .useValue({ now: () => now, today: () => '2026-11-14' }).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false }); configureHttp(app);
    db = app.get(getConnectionToken()); await ensureFinancialIntegrity(db); await app.init();
    await Promise.all(Object.values(db.models).map(model => model.init()));
    const users = app.get(UsersRepository), password = 'US21 test password 123';
    const hash = await app.get(PasswordService).hash(password);
    for (const [index, code] of (['ADMIN', 'STAFF', 'MEMBER', 'TRAINER'] as const).entries()) {
      const role = await users.ensureRole(code, code);
      const account = await users.createAccount({ roleId: role.id.toHexString(), fullName: `US21 ${code}`, phone: `+8491234567${index}`, passwordHash: hash });
      if (code === 'STAFF') staffId = account._id;
      tokens[code] = (await request(app.getHttpServer()).post('/api/auth/login').set('Origin', 'http://localhost:5173')
        .send({ phone: account.phone, password }).expect(200)).body.accessToken;
    }
  }, 600000);
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = savedEnv; });
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const name of ['members', 'plans', 'transactions', 'service_sales', 'memberships', 'payments', 'invoices',
      'notifications', 'notification_recipients', 'notification_outbox', 'operation_requests']) await db.collection(name).deleteMany({});
    sale = await createSale();
  });
  afterEach(() => jest.restoreAllMocks());

  const get = (path = '', role: RoleCode = 'STAFF') => request(app.getHttpServer()).get(`/api/transactions${path}`).set('Authorization', `Bearer ${tokens[role]}`);
  const cash = (extra: Record<string, unknown> = {}) => ({ method: 'CASH', amount: '300000', evidenceNote: 'Đã đếm đủ tiền mặt thực nhận', ...extra });
  const transfer = (extra: Record<string, unknown> = {}) => ({ method: 'TRANSFER', amount: '300000', evidenceNote: 'Đã kiểm tra báo có ngân hàng thực tế',
    receivingAccountCode: 'GYM_MAIN', bankReference: '  AbC-001  ', receivedAt: now.toISOString(), ...extra });
  const preview = (body = cash(), id = sale.transactionId, role: RoleCode = 'STAFF') => request(app.getHttpServer())
    .post(`/api/transactions/${id}/payment-preview`).set('Authorization', `Bearer ${tokens[role]}`).send(body);
  async function createSale(kind: 'GYM' | 'PT' = 'GYM', price = '300000') {
    const number = ++sequence;
    const member = await app.get(TransactionRunner).run(session => app.get(MembersRepository).insert(
      { fullName: `Hội viên ${number}`, phone: `+8498${String(number).padStart(7, '0')}` }, staffId, session));
    const plan = await app.get<Model<Plan>>(getModelToken('Plan')).create({ code: `PLAN_${number}`, name: `Gói ${number}`, kind,
      duration_days: 30, session_quota: kind === 'PT' ? 10 : 0, price: toVndDecimal(price), benefits: 'Điều khoản gốc', status: 'ACTIVE', created_by: staffId, updated_by: staffId });
    const result = await request(app.getHttpServer()).post('/api/service-sales').set('Authorization', `Bearer ${tokens.STAFF}`)
      .set('Idempotency-Key', randomUUID()).send({ memberId: member._id.toHexString(), planId: plan._id.toHexString(), planVersion: 0, startDate: '2026-11-14' }).expect(201);
    return { ...result.body, memberId: member._id.toHexString() } as typeof sale;
  }

  it('TC01/03: real Staff/Admin reads and previews; guest/Member/PT denied; RETAIL unsupported', async () => {
    for (const role of ['STAFF', 'ADMIN'] as const) {
      await get('', role).expect(200); await get(`/${sale.transactionId}`, role).expect(200); await preview(cash(), sale.transactionId, role).expect(200);
    }
    for (const role of ['MEMBER', 'TRAINER'] as const) {
      await get('', role).expect(403); await get(`/${sale.transactionId}`, role).expect(403); await preview(cash(), sale.transactionId, role).expect(403);
    }
    await request(app.getHttpServer()).get('/api/transactions').expect(401);
    expect((await get('?kind=RETAIL').expect(400)).body.error.code).toBe('UNSUPPORTED_KIND');
  });

  it('TC02: paginates stable ties; combines status/kind/member/code, returns empty totalPages=0 and safe projections', async () => {
    const pt = await createSale('PT');
    const first = (await get('?limit=1').expect(200)).body;
    const second = (await get('?limit=1&page=2').expect(200)).body;
    expect(first.total).toBe(2); expect(first.totalPages).toBe(2); expect(first.items[0].id).toBe(pt.transactionId);
    expect(second.items[0].id).toBe(sale.transactionId);
    expect((await get(`?kind=PT&status=PENDING&memberId=${pt.memberId}&q=${pt.transactionCode}`).expect(200)).body.total).toBe(1);
    expect((await get('?status=SETTLED').expect(200)).body).toMatchObject({ total: 0, totalPages: 0 });
    expect((await get('?q=.*').expect(200)).body.total).toBe(0);
    const detail = (await get(`/${sale.transactionId}`).expect(200)).body;
    expect(detail).toMatchObject({ transaction: { id: sale.transactionId, version: 0, amountDue: '300000', memberId: sale.memberId }, sale: { id: sale.saleId }, payments: [] });
    expect(first.items[0].saleId).toBe(pt.saleId);
    expect(JSON.stringify(detail)).not.toMatch(/request_key|requestKey|guard_revision|password|hash|client_key/);
  });

  it('TC04/05/06/09/10: repeated and concurrent previews are read-only and do not reserve a reference', async () => {
    const other = await createSale('PT');
    const collections = (await db.db!.listCollections().toArray()).map(row => row.name).sort();
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const name of collections) result[name] = await db.collection(name).find().sort({ _id: 1 }).toArray();
      return JSON.stringify(result);
    };
    const before = await snapshot();
    expect((await preview().expect(200)).body).toMatchObject({ canConfirm: true, reviewState: 'READY', blockingCodes: [], amountDue: '300000' });
    const responses = await Promise.all([preview(transfer()), preview(transfer(), other.transactionId)]);
    for (const response of responses) expect(response.body).toMatchObject({ canConfirm: true, normalizedReference: 'TRF:GYM_MAIN:AbC-001' });
    for (const amount of ['299999', '300001', '0']) expect((await preview(cash({ amount })).expect(200)).body)
      .toMatchObject({ canConfirm: false, reviewState: 'NEEDS_REVIEW', blockingCodes: ['AMOUNT_MISMATCH'], amountDue: '300000' });
    expect(await snapshot()).toBe(before);
  });

  it('TC07/12: rejects unknown fields, invalid amounts/notes/method/account/reference/timestamps and CASH client metadata', async () => {
    for (const patch of [{ amount: 300000 }, { amount: '3e5' }, { amount: '1.5' }, { amount: '-1' }, { amount: '1000000000000' },
      { evidenceNote: '          abc  ' }, { evidenceNote: 'a'.repeat(501) }, { method: 'CARD' }, { status: 'SETTLED' },
      { reference: 'CASH:chosen' }, { receivedAt: now.toISOString() }, { receivingAccountCode: 'GYM_MAIN' }, { bankReference: null }]) await preview(cash(patch)).expect(400);
    for (const patch of [{ receivingAccountCode: '' }, { receivingAccountCode: 'WRONG' }, { bankReference: ' ' }, { bankReference: 'x'.repeat(100) },
      { receivedAt: '2026-11-14T03:00:00' }, { receivedAt: '2026-11-15T03:00:00Z' }, { receivedAt: '2026-11-13T03:00:00Z' },
      { receivedAt: '2026-02-30T03:00:00Z' }, { receivedAt: null }, { receivingAccountCode: null }]) await preview(transfer(patch)).expect(400);
    expect((await preview(transfer({ receivedAt: '2026-11-14T10:00:00+07:00' })).expect(200)).body.canConfirm).toBe(true);
  });

  it('TC08: canonical reference is case sensitive and checked against all historical payment states', async () => {
    const id = new Types.ObjectId();
    await db.collection('payments').insertOne({ _id: id, id, transaction_id: new Types.ObjectId(), method: 'TRANSFER',
      reference: 'TRF:GYM_MAIN:AbC-001', amount: toVndDecimal('300000'), status: 'FAILED' });
    const result = (await preview(transfer()).expect(200)).body;
    expect(result).toMatchObject({ canConfirm: false, reviewState: 'BLOCKED' }); expect(result.blockingCodes).toContain('PAYMENT_REFERENCE_USED');
    expect((await preview(transfer({ bankReference: 'abc-001' })).expect(200)).body.canConfirm).toBe(true);
    expect((await get(`/${sale.transactionId}`).expect(200)).body.transaction.status).toBe('PENDING');
  });

  it('TC11: real cancellation/free settlement block preview; settled detail returns original invoice/membership', async () => {
    await request(app.getHttpServer()).post(`/api/service-sales/${sale.saleId}/cancel`).set('Authorization', `Bearer ${tokens.STAFF}`)
      .set('Idempotency-Key', randomUUID()).send({ version: 0, reason: 'Không còn nhu cầu đăng ký' }).expect(200);
    expect((await preview().expect(200)).body.blockingCodes).toContain('INVALID_TRANSACTION_STATE');
    const free = await createSale('PT', '0');
    expect((await preview(cash({ amount: '0' }), free.transactionId).expect(200)).body.blockingCodes).toContain('ZERO_PAYMENT_NOT_REQUIRED');
    const detail = (await get(`/${free.transactionId}`).expect(200)).body;
    expect(detail.transaction.status).toBe('SETTLED'); expect(detail.payments).toEqual([]); expect(detail.invoice.totalAmount).toBe('0');
    expect(detail.membershipId).toMatch(/^[a-f0-9]{24}$/);
    expect((await get('?status=SETTLED').expect(200)).body.total).toBe(1);
  });

  it('detail reads internal payment evidence and invoice snapshots as strings without leaking unrelated fields', async () => {
    const id = new Types.ObjectId(), invoiceId = new Types.ObjectId();
    await db.collection('payments').insertOne({ _id: id, id, transaction_id: new Types.ObjectId(sale.transactionId), method: 'CASH',
      reference: `CASH:${id}`, amount: toVndDecimal('300000'), status: 'SUCCEEDED', verified_by: staffId, paid_at: now,
      verified_at: now, evidence_note: 'Đã kiểm đếm tiền thật', secret: 'should not be exposed' });
    await db.collection('invoices').insertOne({ _id: invoiceId, id: invoiceId, transaction_id: new Types.ObjectId(sale.transactionId),
      invoice_no: `INV-${invoiceId}`, issued_at: now, total_amount: toVndDecimal('300000'), buyer_snapshot: '{"fullName":"Tên lúc thu"}' });
    const result = (await get(`/${sale.transactionId}`).expect(200)).body;
    expect(result.payments[0]).toMatchObject({ id: id.toHexString(), amount: '300000', reference: `CASH:${id}`,
      verifiedBy: staffId.toHexString(), verifiedAt: now.toISOString(), evidenceNote: 'Đã kiểm đếm tiền thật' });
    expect(result.invoice).toMatchObject({ totalAmount: '300000', buyerSnapshot: '{"fullName":"Tên lúc thu"}' });
    expect(JSON.stringify(result)).not.toContain('should not be exposed');
    expect((await preview().expect(200)).body.blockingCodes).toContain('PAYMENT_ALREADY_SUCCEEDED');
  });

  it('missing member/sale and incompatible snapshots cannot be presented as READY', async () => {
    await db.collection('service_sales').updateOne({ _id: new Types.ObjectId(sale.saleId) }, { $set: { list_price_snapshot: toVndDecimal('1') } });
    expect((await preview().expect(200)).body.blockingCodes).toContain('INVALID_SALE_STATE');
    await db.collection('service_sales').deleteOne({ _id: new Types.ObjectId(sale.saleId) });
    expect((await preview().expect(200)).body.blockingCodes).toContain('SALE_NOT_FOUND');
    await db.collection('members').deleteOne({ _id: new Types.ObjectId(sale.memberId) });
    await preview().expect(404); await get(`/${sale.transactionId}`).expect(404);
  });

  it('TC12: Vietnam date filters include the last day at month end; rejects invalid filters', async () => {
    const pt = await createSale('PT');
    await db.collection('transactions').updateOne({ _id: new Types.ObjectId(sale.transactionId) }, { $set: { created_at: new Date('2026-10-31T16:59:59.999Z') } });
    await db.collection('transactions').updateOne({ _id: new Types.ObjectId(pt.transactionId) }, { $set: { created_at: new Date('2026-10-31T17:00:00Z') } });
    expect((await get('?createdFrom=2026-10-31&createdTo=2026-10-31').expect(200)).body.items.map((row: { id: string }) => row.id)).toEqual([sale.transactionId]);
    expect((await get('?createdFrom=2026-11-01&createdTo=2026-11-01').expect(200)).body.items.map((row: { id: string }) => row.id)).toEqual([pt.transactionId]);
    for (const query of ['createdFrom=2026-02-30', 'createdFrom=2026-11-02&createdTo=2026-11-01', 'limit=101', 'page=1e2', 'status=x',
      'memberId=x', 'q[$ne]=x', 'sort=asc', 'page=1&page=2', 'kind=GYM&kind=PT']) await get(`?${query}`).expect(400);
  });

  it('TC13: not-found and DB failures use structured errors, never fake successful empty results', async () => {
    await get('/bad').expect(400); await get(`/${new Types.ObjectId()}`).expect(404);
    await get(`?memberId=${new Types.ObjectId()}`).expect(404); await preview(cash(), new Types.ObjectId().toHexString()).expect(404);
    jest.spyOn(app.get(PaymentsQueryRepository), 'page').mockRejectedValueOnce(new MongoNetworkError('secret uri'));
    const response = await get().expect(503);
    expect(response.body).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' }, requestId: expect.any(String) });
    expect(JSON.stringify(response.body)).not.toContain('secret');
    jest.spyOn(app.get(PaymentsQueryRepository), 'transaction').mockRejectedValueOnce(new MongoNetworkError('internal'));
    await preview().expect(503);
  });

  it('uses the actual lookup and global unique reference indexes', async () => {
    const txIndexes = await db.collection('transactions').indexes(), payIndexes = await db.collection('payments').indexes();
    expect(txIndexes.some(row => JSON.stringify(row.key) === JSON.stringify({ status: 1, kind: 1, created_at: -1, _id: -1 }))).toBe(true);
    expect(payIndexes.some(row => JSON.stringify(row.key) === JSON.stringify({ transaction_id: 1 }) && !row.unique)).toBe(true);
    expect(payIndexes.some(row => row.key.reference === 1 && row.unique)).toBe(true);
  });
});
