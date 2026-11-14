import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ClientSession, Long, MongoServerError, MongoNetworkError } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { toVndDecimal } from '../src/common/utils/vnd-money';
import { ensureFinancialIntegrity } from '../src/infrastructure/transaction/financial-integrity';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import { PaymentsQueryRepository } from '../src/modules/payments/payments-query.repository';
import { SettlementRepository } from '../src/modules/payments/settlement.repository';
import { Plan } from '../src/modules/plans/schemas/plan.schema';
import { SalesRepository } from '../src/modules/sales/sales.repository';
import { UsersRepository } from '../src/modules/users/users.repository';
import { AccessCatalogService } from '../src/modules/users/access-catalog.service';
import { ACCOUNT_ADMINISTRATION } from '../src/modules/users/schemas/security-state.schema';
import { RoleCode } from '../src/modules/users/schemas/role.schema';

interface Sale { transactionId: string; saleId: string; memberId: string; planId: string; invoiceId?: string; membershipId?: string }
describe('US22 settlement via real APIs, two app instances and real replica set', () => {
  const savedEnv = { ...process.env }, apps: INestApplication[] = [];
  const tokens = {} as Record<RoleCode, string>, accountIds = {} as Record<RoleCode, Types.ObjectId>;
  let mongo: MongoMemoryReplSet, db: Connection, sequence = 0, sale: Sale;
  let now = new Date('2026-11-14T03:00:00Z');
  const clock = { now: () => now, today: () => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }) };
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', FRONTEND_ORIGIN: 'http://localhost:5173', MONGODB_URI: mongo.getUri(),
      MONGODB_DB: `gym_test_us22_${randomBytes(6).toString('hex')}`, JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'), SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'no-reply@gym.test', RECEIVING_ACCOUNTS: '["GYM_MAIN"]' });
    const { AppModule } = await import('../src/app.module');
    for (let index = 0; index < 2; index++) {
      const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
      const app = module.createNestApplication({ logger: false, bodyParser: false }); apps.push(app); configureHttp(app);
      db = app.get(getConnectionToken()); await ensureFinancialIntegrity(db); await app.init();
      await Promise.all(Object.values(db.models).map(model => model.init()));
    }
    await apps[0].get(AccessCatalogService).seed();
    const users = apps[0].get(UsersRepository), password = 'US22 integration password 123';
    const hash = await apps[0].get(PasswordService).hash(password);
    for (const [index, role] of (['ADMIN', 'STAFF', 'MEMBER', 'TRAINER'] as const).entries()) {
      const found = await users.findRoleByCode(role);
      const account = await users.createAccount({ roleId: found!.id.toHexString(), fullName: `US22 ${role}`, phone: `+8491234567${index}`, passwordHash: hash });
      accountIds[role] = account._id;
      tokens[role] = (await request(apps[0].getHttpServer()).post('/api/auth/login').set('Origin', 'http://localhost:5173')
        .send({ phone: account.phone, password }).expect(200)).body.accessToken;
    }
  }, 600000);
  afterAll(async () => { for (const app of apps) await app.close(); await mongo?.stop(); process.env = savedEnv; });
  beforeEach(async () => {
    now = new Date('2026-11-14T03:00:00Z');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const name of ['members', 'plans', 'transactions', 'service_sales', 'memberships', 'payments', 'invoices', 'notifications',
      'notification_recipients', 'notification_outbox', 'operation_requests']) await db.collection(name).deleteMany({});
    await db.db!.collection<{ _id: string; revision: Long }>('security_state').updateOne({ _id: ACCOUNT_ADMINISTRATION }, { $set: { revision: Long.ZERO } }, { upsert: true });
    sale = await createSale();
  });
  afterEach(() => jest.restoreAllMocks());
  const cash = (extra = {}) => ({ method: 'CASH', amount: '300000', evidenceNote: 'Đã đếm đủ tiền mặt thực nhận', ...extra });
  const transfer = (extra = {}) => ({ method: 'TRANSFER', amount: '300000', evidenceNote: 'Đã đối chiếu báo có ngân hàng thực tế',
    receivingAccountCode: 'GYM_MAIN', bankReference: ' AbC-001 ', receivedAt: now.toISOString(), ...extra });
  const post = (path: string, body: object, key: string = randomUUID(), role: RoleCode = 'STAFF', instance = 0) => request(apps[instance].getHttpServer())
    .post(`/api${path}`).set('Authorization', `Bearer ${tokens[role]}`).set('Idempotency-Key', key).send(body);
  const confirm = (body = cash(), id = sale.transactionId, key: string = randomUUID(), instance = 0, role: RoleCode = 'STAFF') =>
    post(`/transactions/${id}/confirm-payment`, body, key, role, instance);
  const get = (path: string, role: RoleCode = 'STAFF') => request(apps[0].getHttpServer()).get(`/api${path}`).set('Authorization', `Bearer ${tokens[role]}`);
  async function createSale(kind: 'GYM' | 'PT' = 'GYM', price = '300000'): Promise<Sale> {
    const number = ++sequence;
    const member = (await post('/members', { fullName: `Hội viên ${number}`, phone: `+8498${String(number).padStart(7, '0')}` }).expect(201)).body;
    const plan = await apps[0].get<Model<Plan>>(getModelToken('Plan')).create({ code: `PLAN_${number}`, name: `Gói gốc ${number}`, kind,
      duration_days: 30, session_quota: kind === 'PT' ? 10 : 0, price: toVndDecimal(price), benefits: 'Điều khoản gốc', status: 'ACTIVE',
      created_by: accountIds.STAFF, updated_by: accountIds.STAFF });
    const result = (await post('/service-sales', { memberId: member.id, planId: plan._id.toHexString(), planVersion: 0, startDate: clock.today() }).expect(201)).body;
    return { ...result, memberId: member.id, planId: plan._id.toHexString() };
  }
  async function untouched() {
    for (const name of ['payments', 'invoices', 'memberships', 'notifications', 'notification_recipients', 'notification_outbox']) expect(await db.collection(name).countDocuments()).toBe(0);
    expect(await db.collection('operation_requests').countDocuments({ operation: 'PAYMENT_CONFIRM' })).toBe(0);
    expect((await get(`/transactions/${sale.transactionId}`).expect(200)).body.transaction.status).toBe('PENDING');
  }

  it('TC01/06/08/14: HTTP member -> sale -> preview -> transfer settlement -> immutable invoice/membership, uses original terms and paid_at', async () => {
    await db.collection('members').updateOne({ _id: new Types.ObjectId(sale.memberId) }, { $set: { account_id: accountIds.MEMBER } });
    now = new Date('2026-11-15T04:00:00Z');
    const input = transfer({ receivedAt: '2026-11-14T10:00:00+07:00' });
    await db.collection('plans').updateOne({ _id: new Types.ObjectId(sale.planId) }, { $set: { price: toVndDecimal('999999'), status: 'INACTIVE', benefits: 'Đã đổi', duration_days: 90 } });
    expect((await post(`/transactions/${sale.transactionId}/payment-preview`, input).expect(200)).body.canConfirm).toBe(true);
    const settled = (await confirm(input, sale.transactionId, randomUUID(), 0, 'ADMIN').expect(200)).body;
    expect(settled).toMatchObject({ status: 'SETTLED', transactionId: sale.transactionId, startDate: '2026-11-15', endDate: '2026-12-14', notificationState: 'STORED' });
    const payment = await db.collection('payments').findOne({});
    expect(payment).toMatchObject({ reference: 'TRF:GYM_MAIN:AbC-001', evidence_note: input.evidenceNote, verified_by: accountIds.ADMIN,
      paid_at: new Date('2026-11-14T03:00:00Z'), verified_at: now, created_at: now });
    expect(payment!.amount.toString()).toBe('300000');
    // Q13: actual cashflow belongs to paid_at (Nov14), not verification/issuance (Nov15).
    const cashflow = await db.collection('payments').aggregate([{ $match: { status: 'SUCCEEDED', paid_at: {
      $gte: new Date('2026-11-14T00:00:00+07:00'), $lt: new Date('2026-11-15T00:00:00+07:00') } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }]).toArray();
    expect(cashflow[0].total.toString()).toBe('300000');
    await db.collection('members').updateOne({ _id: new Types.ObjectId(sale.memberId) }, { $set: { full_name: 'Tên mới', phone: '+84999999999' } });
    const invoice = (await get(`/invoices/${settled.invoiceId}`).expect(200)).body;
    expect(invoice).toMatchObject({ totalAmount: '300000', transactionId: sale.transactionId, serviceLine: { benefits: 'Điều khoản gốc', listPrice: '300000', endDate: '2026-12-14' } });
    expect(invoice.buyerSnapshot).not.toContain('Tên mới'); expect(invoice.invoiceNo).toBe(`INV-${invoice.id}`);
    const detail = (await get(`/transactions/${sale.transactionId}`).expect(200)).body;
    expect(detail.transaction).toMatchObject({ status: 'SETTLED', version: 1, settledAt: now.toISOString() });
    for (const name of ['payments', 'invoices', 'memberships', 'notifications', 'notification_recipients', 'notification_outbox']) expect(await db.collection(name).countDocuments()).toBe(1);
    expect((await db.collection('notification_recipients').findOne({}))!.account_id).toEqual(accountIds.MEMBER);
  });

  it('TC01/09/10: CASH server reference/time, canonical replay and operation lookup; changed payload/target conflicts', async () => {
    const key = randomUUID();
    const settled = (await confirm(cash(), sale.transactionId, key).expect(200)).body;
    const payment = await db.collection('payments').findOne({});
    expect(payment).toMatchObject({ reference: `CASH:${settled.paymentId}`, paid_at: now, verified_at: now });
    expect(payment!.receiving_account_code).toBeUndefined(); expect(payment!.bank_reference).toBeUndefined();
    const replay = await confirm(cash({ evidenceNote: '  Đã đếm đủ tiền mặt thực nhận  ', amount: '0300000' }), sale.transactionId, key.toUpperCase()).expect(200);
    expect(replay.body).toEqual(settled);
    expect((await get(`/operations/PAYMENT_CONFIRM/${key}`).expect(200)).body.responseBody).toEqual(settled);
    for (const input of [cash({ amount: '1' }), transfer(), cash({ evidenceNote: 'Đã đếm tiền căn cứ khác' })]) expect((await confirm(input, sale.transactionId, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const other = await createSale('PT');
    expect((await confirm(cash(), other.transactionId, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const again = (await confirm().expect(409)).body;
    expect(again.error.code).toBe('TRANSACTION_ALREADY_SETTLED');
    expect(again.error.details).toContainEqual({ field: 'invoiceId', message: settled.invoiceId });
    expect(await db.collection('payments').countDocuments()).toBe(1);
  });

  it('TC02: real roles/session and DTO allowlists guard confirmation and invoice; invalid IDs/not found/key', async () => {
    for (const role of ['MEMBER', 'TRAINER'] as const) {
      await confirm(cash(), sale.transactionId, randomUUID(), 0, role).expect(403);
      await get(`/invoices/${new Types.ObjectId()}`, role).expect(403);
    }
    await request(apps[0].getHttpServer()).post(`/api/transactions/${sale.transactionId}/confirm-payment`).send(cash()).expect(401);
    for (const extra of [{ status: 'SETTLED' }, { verifiedBy: accountIds.ADMIN }, { invoiceNo: 'INV-1' }, { amount_due: '0' }, { memberId: sale.memberId }]) await confirm(cash(extra)).expect(400);
    await confirm(cash(), 'bad').expect(400); await confirm(cash(), new Types.ObjectId().toHexString()).expect(404);
    await confirm(cash(), sale.transactionId, 'bad-key').expect(400);
    await request(apps[0].getHttpServer()).post(`/api/transactions/${sale.transactionId}/confirm-payment`).set('Authorization', `Bearer ${tokens.STAFF}`).send(cash()).expect(400);
    await get('/invoices/bad').expect(400); await get(`/invoices/${new Types.ObjectId()}`).expect(404);
    await db.collection('accounts').updateOne({ _id: accountIds.STAFF }, { $set: { status: 'LOCKED' } });
    await confirm().expect(401);
    await db.collection('accounts').updateOne({ _id: accountIds.STAFF }, { $set: { status: 'ACTIVE' } });
    await db.collection('auth_sessions').updateMany({ account_id: accountIds.STAFF }, { $set: { revoked_at: new Date() } });
    await confirm().expect(401);
    await db.collection('auth_sessions').updateMany({ account_id: accountIds.STAFF }, { $unset: { revoked_at: '' } });
    await untouched();
  });

  it('TC03/14: invalid amount/evidence/method/account/reference/time do not create any collection artifacts', async () => {
    for (const amount of ['299999', '300001', '0']) expect((await confirm(cash({ amount })).expect(409)).body.error.code).toBe('AMOUNT_MISMATCH');
    for (const input of [cash({ amount: 300000 }), cash({ amount: '3e5' }), cash({ amount: '1.5' }), cash({ method: 'CARD' }), cash({ evidenceNote: 'ngắn' }),
      cash({ receivedAt: now.toISOString() }), transfer({ receivingAccountCode: 'WRONG' }), transfer({ bankReference: '' }), transfer({ bankReference: 'x'.repeat(100) }),
      transfer({ receivedAt: '2026-11-14T03:00:00' }), transfer({ receivedAt: '2026-11-15T00:00:00Z' }), transfer({ receivedAt: '2026-11-13T00:00:00Z' })]) await confirm(input).expect(400);
    await untouched();
  });

  it.each(['invoice', 'activation', 'outbox', 'transaction', 'operation'] as const)('TC05: injected %s failure rolls back payment, entitlement, invoice, event and operation atomically', async stage => {
    const key = randomUUID(); const failure = new Error(`Injected ${stage} failure`);
    if (stage === 'invoice') jest.spyOn(apps[0].get(SettlementRepository), 'insertInvoice').mockRejectedValueOnce(failure);
    if (stage === 'activation') jest.spyOn(apps[0].get(SalesRepository).memberships, 'create').mockRejectedValueOnce(failure);
    if (stage === 'outbox') jest.spyOn(apps[0].get(NotificationsRepository), 'insertOutbox').mockRejectedValueOnce(failure);
    if (stage === 'transaction') jest.spyOn(apps[0].get(SettlementRepository), 'settle').mockRejectedValueOnce(failure);
    if (stage === 'operation') {
      const { OperationRequestsRepository } = await import('../src/modules/operations/operation-requests.repository');
      jest.spyOn(apps[0].get(OperationRequestsRepository), 'insert').mockRejectedValueOnce(failure);
    }
    await confirm(cash(), sale.transactionId, key).expect(500); await untouched();
    await confirm(cash(), sale.transactionId, key).expect(200);
    expect(await db.collection('payments').countDocuments()).toBe(1);
  });

  it('TC07/08: actual US10 update racing the member write guard yields one coherent buyer snapshot, frozen after issuance', async () => {
    const update = request(apps[1].getHttpServer()).patch(`/api/members/${sale.memberId}`).set('Authorization', `Bearer ${tokens.STAFF}`)
      .send({ version: 0, fullName: 'Tên sau cập nhật', phone: '+84999999998' });
    const [confirmed, updated] = await Promise.all([confirm(), update]);
    expect(confirmed.status).toBe(200); expect(updated.status).toBe(200);
    const invoice = (await get(`/invoices/${confirmed.body.invoiceId}`).expect(200)).body;
    const buyer = JSON.parse(invoice.buyerSnapshot);
    expect(buyer.fullName === 'Tên sau cập nhật' ? buyer.phone === '+84999999998' : buyer.phone !== '+84999999998').toBe(true);
    expect((await get(`/invoices/${confirmed.body.invoiceId}`)).body.buyerSnapshot).toBe(invoice.buyerSnapshot);
  });

  it('TC09/11: two app instances, same key replay and different keys cannot create two payments or memberships', async () => {
    const key = randomUUID();
    const replay = await Promise.all([confirm(cash(), sale.transactionId, key), confirm(cash(), sale.transactionId, key, 1)]);
    expect(replay.map(row => row.status)).toEqual([200, 200]); expect(replay[0].body).toEqual(replay[1].body);
    const other = await createSale('PT');
    const race = await Promise.all([confirm(cash(), other.transactionId), confirm(cash(), other.transactionId, randomUUID(), 1)]);
    expect(race.map(row => row.status).sort()).toEqual([200, 409]);
    expect(race.find(row => row.status === 409)!.body.error.code).toBe('TRANSACTION_ALREADY_SETTLED');
    expect(await db.collection('payments').countDocuments()).toBe(2); expect(await db.collection('memberships').countDocuments()).toBe(2);
  });

  it('TC04/12 + US21 TC10: two READY previews do not reserve a bank reference; unique index decides competing confirms', async () => {
    const other = await createSale('PT'), input = transfer();
    for (const target of [sale, other]) expect((await post(`/transactions/${target.transactionId}/payment-preview`, input).expect(200)).body.canConfirm).toBe(true);
    // Both confirmation callbacks must finish all reads before either writes a payment.
    // The real unique reference index, rather than a lucky sequential read, resolves this race.
    let arrived = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    for (const app of apps) {
      const repository = app.get(SettlementRepository), original = repository.insertPayment.bind(repository);
      jest.spyOn(repository, 'insertPayment').mockImplementation(async (payment, session) => {
        if (++arrived === 2) release();
        await barrier;
        return original(payment, session);
      });
    }
    const results = await Promise.all([confirm(input), confirm(input, other.transactionId, randomUUID(), 1)]);
    expect(results.map(row => row.status).sort()).toEqual([200, 409]);
    expect(results.find(row => row.status === 409)!.body.error.code).toBe('PAYMENT_REFERENCE_USED');
    expect(await db.collection('payments').countDocuments()).toBe(1); expect(await db.collection('invoices').countDocuments()).toBe(1);
    const losingId = results[0].status === 409 ? sale.transactionId : other.transactionId;
    expect((await get(`/transactions/${losingId}`).expect(200)).body.transaction.status).toBe('PENDING');
  });

  it('TC13: cancel and confirm serialize through the same real guards, with no orphan payment', async () => {
    const results = await Promise.all([confirm(), post(`/service-sales/${sale.saleId}/cancel`, { version: 0, reason: 'Hủy yêu cầu đăng ký gói' }, randomUUID(), 'STAFF', 1)]);
    expect(results.map(row => row.status).sort()).toEqual([200, 409]);
    const transaction = (await get(`/transactions/${sale.transactionId}`).expect(200)).body.transaction;
    const count = transaction.status === 'SETTLED' ? 1 : 0;
    for (const name of ['payments', 'invoices', 'memberships', 'notifications', 'notification_outbox']) expect(await db.collection(name).countDocuments()).toBe(count);
    if (!count) expect((await confirm().expect(409)).body.error.code).toBe('INVALID_TRANSACTION_STATE');
  });

  it('TC15: actual free sale settles internally with invoice0 and membership, never payment0; confirm stays forbidden', async () => {
    const free = await createSale('PT', '0');
    expect((await confirm(cash({ amount: '0' }), free.transactionId).expect(409)).body.error.code).toBe('TRANSACTION_ALREADY_SETTLED');
    const invoice = (await get(`/invoices/${free.invoiceId}`).expect(200)).body;
    expect(invoice.totalAmount).toBe('0'); expect(invoice.payment).toBeUndefined(); expect(free.membershipId).toBeDefined();
    expect(await db.collection('payments').countDocuments()).toBe(0);
  });

  it('TC16: a retryable callback error after payment writes retries real session and commits once', async () => {
    const repository = apps[0].get(SettlementRepository), original = repository.insertInvoice.bind(repository);
    const error = new MongoServerError({ message: 'injected transient' }); error.addErrorLabel('TransientTransactionError');
    const spy = jest.spyOn(repository, 'insertInvoice').mockRejectedValueOnce(error).mockImplementation(original);
    await confirm().expect(200); expect(spy).toHaveBeenCalledTimes(2);
    expect(await db.collection('payments').countDocuments()).toBe(1); expect(await db.collection('invoices').countDocuments()).toBe(1);
  });

  it('TC16: committed but lost response returns unknown; same key lookup/replay recovers the exact result', async () => {
    const original = ClientSession.prototype.commitTransaction;
    const unknown = new MongoServerError({ message: 'injected lost commit reply' }); unknown.addErrorLabel('UnknownTransactionCommitResult');
    jest.spyOn(ClientSession.prototype, 'commitTransaction').mockImplementation(async function (this: ClientSession, ...args) {
      await original.apply(this, args); throw unknown;
    });
    const key = randomUUID();
    expect((await confirm(cash(), sale.transactionId, key).expect(503)).body.error.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    jest.restoreAllMocks();
    const lookup = (await get(`/operations/PAYMENT_CONFIRM/${key}`).expect(200)).body.responseBody;
    expect((await confirm(cash(), sale.transactionId, key).expect(200)).body).toEqual(lookup);
    expect(await db.collection('payments').countDocuments()).toBe(1);
  }, 30000);

  it('TC16: infrastructure failure does not fabricate FAILED payments or leak raw DB errors', async () => {
    jest.spyOn(apps[0].get(PaymentsQueryRepository), 'transaction').mockRejectedValueOnce(new MongoNetworkError('private connection URI'));
    const response = await confirm().expect(503);
    expect(response.body.error.code).toBe('DATABASE_UNAVAILABLE'); expect(JSON.stringify(response.body)).not.toContain('private');
    await untouched();
  });
});
