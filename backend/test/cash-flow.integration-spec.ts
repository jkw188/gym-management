import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Document, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { UsersRepository } from '../src/modules/users/users.repository';
import { CashFlowRepository } from '../src/modules/reports/cash-flow.repository';

describe('US-51 / UC-38 / S08-C01 (MongoDB replica set + real JWT)', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };
  const auth: Record<string, { token: string; id: ObjectId }> = {};
  const db = () => connection.db!;
  const password = 'US51-Password-123!';
  const origin = 'http://localhost:5173';
  const base = '/api/reports/cash-flow';
  const observedAt = '2026-11-17T05:00:00.000Z';
  const get = (path = '/summary', role = 'ADMIN') => request(app.getHttpServer()).get(base + path).set('Authorization', `Bearer ${auth[role].token}`);
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_us51', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
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
      const account = await users.createAccount({ roleId: String(role.id), fullName: `US51 ${code}`, phone: `098500000${++sequence}`, passwordHash: hash });
      const response = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
      auth[code] = { token: response.body.accessToken, id: new ObjectId(String(account.id)) };
    }
  }, 600000);

  const range = { fromDate: '2026-11-01', toDate: '2026-11-03' };
  const fixture = require('./fixtures/en08-reports.cjs');
  let ids: Map<string, ObjectId>;
  const oid = (key: string) => { if (!ids.has(key)) ids.set(key, new ObjectId()); return ids.get(key)!; };
  const report = (path = '/summary') => get(path).query(range);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(ServerClock.prototype, 'now').mockReturnValue(new Date(observedAt));
    ids = new Map();
    for (const name of ['payments', 'refunds', 'transactions', 'orders', 'invoices', 'invoice_items', 'return_items', 'refund_attempts', 'service_sales']) await db().collection(name).deleteMany({});
    for (const name of ['transactions', 'payments', 'refunds'] as const) {
      const rows = fixture.cash[name].map((source: Document) => {
        const row: Document = { ...source };
        for (const [key, value] of Object.entries(row)) {
          if (key === '_id' || key.endsWith('_id')) row[key] = oid(value as string);
          if (key.endsWith('_at')) row[key] = new Date(value as string);
        }
        if (name === 'transactions') Object.assign(row, { code: `TX-${row._id}`, request_key: String(row._id) });
        else Object.assign(row, { amount: Decimal128.fromString(source.amount), reference: `${name}:${row._id}` });
        if (name === 'payments') row.receipt_purpose = source._id.endsWith('late') ? 'LATE_CANCELLED_ORDER' : 'ORDER_SETTLEMENT';
        if (name === 'refunds') Object.assign(row, { obligation_key: String(row._id), order_id: oid('order'), created_at: new Date('2026-10-20Z') });
        return row;
      });
      await db().collection(name).insertMany(rows);
    }
    await db().collection('orders').insertOne({ _id: oid('order'), transaction_id: oid('test_tx_late'), code: 'ORDER-LATE' });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = savedEnv; });

  it('TC01-05: compares committed cash sources against the independent EN08 oracle; no invoice/credit/child multiplication', async () => {
    await db().collection('invoices').insertOne({ transaction_id: oid('test_tx_gym'), invoice_no: 'ZERO', total_amount: Decimal128.fromString('0') });
    for (const name of ['invoice_items', 'return_items', 'refund_attempts']) await db().collection(name).insertMany(Array.from({ length: 4 }, () => ({
      payment_id: oid('test_payment_gym'), refund_id: oid('test_refund_old'), return_id: oid('return'), order_item_id: new ObjectId(), operation_id: String(new ObjectId()) })));
    await db().collection('service_sales').insertOne({ transaction_id: oid('test_tx_gym'), credit_amount: Decimal128.fromString('400000') });
    const result = (await report('/events').expect(200)).body;
    const source: Record<string, Document[]> = {};
    for (const name of ['payments', 'refunds', 'transactions']) {
      source[name] = (await db().collection(name).find().toArray()).map(row => Object.fromEntries(Object.entries(row).map(([k, v]) =>
        [k, v instanceof ObjectId || v instanceof Decimal128 ? v.toString() : v instanceof Date ? v.toISOString() : v])));
    }
    const oracle = require('./helpers/en08-report-oracle.cjs').cashOracle(source, range.fromDate, range.toDate, observedAt);
    expect(result.totals).toEqual({ grossReceipts: oracle.grossReceipts, refundPaid: oracle.refundPaid, netCash: oracle.netCash });
    expect(result).toMatchObject({ dataQuality: 'COMPLETE', metricVersion: 'S08-V1', observedAt, total: 5,
      totals: { grossReceipts: '2000000', refundPaid: '100000', netCash: '1900000' },
      currentOutstandingRefunds: { outstandingRefundAmount: '70000', count: 2, dateFilterApplied: false, methodFiltersApplied: false } });
    for (const kind of ['GYM', 'PT', 'RETAIL']) expect(result.byKind[kind].totals.netCash).toBe(fixture.expected.cash.byKind[kind].net);
    expect(result.byMethod.receipts.CASH.totals.grossReceipts).toBe('2000000');
    expect(result.byMethod.refunds.TRANSFER.totals.refundPaid).toBe('100000');
    expect(result.items.map((row: Document) => row.eventId)).toContain(`RECEIPT:${oid('test_payment_late')}`);
  });
  it('TC06: negative net and empty days remain exact; outstanding is current even for a previous period', async () => {
    const result = (await get().query({ fromDate: '2026-11-04', toDate: '2026-11-06' }).expect(200)).body;
    expect(result.totals).toEqual({ grossReceipts: '0', refundPaid: '300000', netCash: '-300000' });
    expect(result.byDate).toHaveLength(3);
    expect(result.byDate[1].totals).toEqual({ grossReceipts: '0', refundPaid: '0', netCash: '0' });
    expect(result.currentOutstandingRefunds.outstandingRefundAmount).toBe('70000');
  });
  it('TC07: VN midnight, receivedAt rather than verification; rerun includes late verification and clips at observedAt', async () => {
    const target = oid('test_payment_gym');
    await db().collection('payments').updateOne({ _id: target }, { $set: { paid_at: new Date('2026-11-01T16:59:59.999Z'), verified_at: new Date('2026-11-02T05:00Z') } });
    let result = (await report().expect(200)).body;
    expect(result.byDate[0].totals.grossReceipts).toBe('1000000');
    await db().collection('payments').updateOne({ _id: target }, { $set: { paid_at: new Date('2026-11-01T17:00:00.000Z') } });
    result = (await report().expect(200)).body;
    expect(result.byDate[0].totals.grossReceipts).toBe('0'); expect(result.byDate[1].totals.grossReceipts).toBe('1500000');
    for (const [at, expected] of [[observedAt, '1000000'], ['2026-11-17T05:00:00.001Z', '0']] as const) {
      await db().collection('payments').updateOne({ _id: target }, { $set: { paid_at: new Date(at) } });
      const current = (await get().query({ fromDate: '2026-11-17', toDate: '2026-11-17' }).expect(200)).body;
      expect(current.totals.grossReceipts).toBe(expected); expect(current.range.effectiveTo).toBe(observedAt);
      expect(current.byDate[0].isComplete).toBe(false);
    }
  });
  it('TC08: receipt/payout filters are independent, kind applies to both and current outstanding ignores dates/method', async () => {
    const result = (await report().query({ paymentMethod: 'TRANSFER', payoutMethod: 'TRANSFER' }).expect(200)).body;
    expect(result.totals).toEqual({ grossReceipts: '0', refundPaid: '100000', netCash: '-100000' });
    expect(result.filter).toMatchObject({ paymentMethodScope: 'RECEIPTS_ONLY', payoutMethodScope: 'SUCCEEDED_REFUNDS_ONLY' });
    expect(result.currentOutstandingRefunds.outstandingRefundAmount).toBe('70000');
    const gym = (await report().query({ kind: 'GYM' }).expect(200)).body;
    expect(gym.totals.netCash).toBe('1000000'); expect(gym.currentOutstandingRefunds.outstandingRefundAmount).toBe('0');
  });
  it('TC09: exact totals above 2^53 from individually valid Decimal128 values', async () => {
    await db().collection('payments').deleteMany({}); await db().collection('refunds').deleteMany({});
    const txs = Array.from({ length: 10000 }, () => { const _id = new ObjectId(); return { _id, code: `TX-${_id}`, request_key: String(_id), kind: 'GYM' }; });
    await db().collection('transactions').insertMany(txs);
    await db().collection('payments').insertMany(txs.map(tx => ({ transaction_id: tx._id, status: 'SUCCEEDED',
      reference: String(tx._id), method: 'CASH', amount: Decimal128.fromString('999999999999'), paid_at: new Date('2026-11-01T05:00Z') })));
    const response = await report();
    if (response.status !== 200) throw new Error(JSON.stringify(response.body));
    expect(response.body.totals.netCash).toBe('9999999999990000');
  });
  it('TC10: orphan/invalid amount/missing timestamp return warnings, null and labeled known totals instead of losing sources', async () => {
    await db().collection('payments').updateOne({ _id: oid('test_payment_gym') }, { $unset: { paid_at: '' } });
    let result = (await report('/events').expect(200)).body;
    expect(result).toMatchObject({ dataQuality: 'PARTIAL', invalidRecordCount: 1, totals: { grossReceipts: null, refundPaid: '100000', netCash: null },
      knownTotals: { label: 'PARTIAL', grossReceipts: '1000000', refundPaid: '100000', netCash: '900000' } });
    expect(result.items.at(-1).occurredAt).toBeNull(); expect(result.byDate.every((day: Document) => day.totals.grossReceipts === null)).toBe(true);
    await db().collection('transactions').deleteOne({ _id: oid('test_tx_pt') });
    await db().collection('payments').updateOne({ _id: oid('test_payment_retail') }, { $set: { amount: Decimal128.fromString('NaN') } });
    result = (await report().expect(200)).body;
    expect(result.warningCodes).toEqual(expect.arrayContaining(['SOURCE_KIND_UNKNOWN', 'INVALID_AMOUNT', 'EVENT_TIMESTAMP_INVALID']));
    expect(result.invalidRecordCount).toBe(3); expect(result.byKind.UNKNOWN.knownTotals.grossReceipts).toBe('500000');
  });
  it('TC10: legacy missing payout method groups UNKNOWN without guessing from receipt', async () => {
    await db().collection('refunds').updateOne({ _id: oid('test_refund_old') }, { $unset: { method: '' } });
    const result = (await report().expect(200)).body;
    expect(result.dataQuality).toBe('PARTIAL'); expect(result.totals.refundPaid).toBe('100000');
    expect(result.byMethod.refunds.UNKNOWN.knownTotals.refundPaid).toBe('100000');
    expect(result.warningCodes).toContain('PAYOUT_METHOD_UNKNOWN');
    expect((await report().query({ payoutMethod: 'CASH' }).expect(200)).body.totals.refundPaid).toBeNull();
  });
  it('TC11: all endpoints check current JWT role/session/account; projections exclude bank/evidence', async () => {
    const paths = ['/summary', '/events', `/events/RECEIPT/${oid('test_payment_late')}`];
    for (const path of paths) {
      for (const role of ['STAFF', 'TRAINER', 'MEMBER']) await get(path, role).expect(403);
      await request(app.getHttpServer()).get(base + path).expect(401);
    }
    await db().collection('auth_sessions').updateMany({ account_id: auth.ADMIN.id }, { $set: { revoked_at: new Date() } });
    try { for (const path of paths) await get(path).expect(401); }
    finally { await db().collection('auth_sessions').updateMany({ account_id: auth.ADMIN.id }, { $unset: { revoked_at: '' } }); }
    await db().collection('accounts').updateOne({ _id: auth.ADMIN.id }, { $set: { status: 'LOCKED' } });
    try { await get().expect(401); } finally { await db().collection('accounts').updateOne({ _id: auth.ADMIN.id }, { $set: { status: 'ACTIVE' } }); }
    await db().collection('payments').updateMany({}, { $set: { evidence_note: 'PRIVATE_EVIDENCE', bank_reference: 'PRIVATE_BANK' } });
    await db().collection('refunds').updateMany({}, { $set: { payout_evidence: { evidenceNote: 'PRIVATE_EVIDENCE', bankReference: 'PRIVATE_BANK' } } });
    const result = JSON.stringify((await report('/events').expect(200)).body);
    expect(result).not.toMatch(/PRIVATE_|evidence|bankReference/);
  });
  it('TC12: late receipt without invoice drills down with valid IDs; old event works without period', async () => {
    const result = (await report(`/events/RECEIPT/${String(oid('test_payment_late')).toUpperCase()}`).expect(200)).body;
    expect(result.event).toMatchObject({ lateReceipt: true, invoiceId: null, paymentId: String(oid('test_payment_late')),
      transactionId: String(oid('test_tx_late')), orderCode: 'ORDER-LATE', amount: '300000' });
    const old = (await get(`/events/RECEIPT/${oid('test_payment_old')}`).expect(200)).body;
    expect(old.range.fromDate).toBe('2026-10-20');
    await report(`/events/REFUND/${new ObjectId()}`).expect(404);
  });
  it('TC13: concurrent refund commit after the first read does not mix KPI/day/list snapshot', async () => {
    const repo = app.get(CashFlowRepository), original = repo.receipts.bind(repo);
    jest.spyOn(repo, 'receipts').mockImplementationOnce(async session => {
      const rows = await original(session);
      await db().collection('refunds').updateOne({ _id: oid('test_refund_pending') }, { $set: { status: 'SUCCEEDED', method: 'CASH', refunded_at: new Date('2026-11-02T10:00+07:00') } });
      return rows;
    });
    const first = (await report('/events').expect(200)).body;
    expect(first.totals.refundPaid).toBe('100000'); expect(first.byDate[1].totals.refundPaid).toBe('100000'); expect(first.total).toBe(5);
    expect(first.currentOutstandingRefunds.outstandingRefundAmount).toBe('70000');
    const second = (await report('/events').expect(200)).body;
    expect(second.totals.refundPaid).toBe('150000'); expect(second.total).toBe(6); expect(second.currentOutstandingRefunds.outstandingRefundAmount).toBe('20000');
  });
  it('TC14: strict query/ID/date/pagination validation, defaults, 366-day cap, literal q and stable sorting', async () => {
    for (const query of [{ fromDate: '2026-02-30' }, { fromDate: '2026-11-04', toDate: '2026-11-03' }, { toDate: '2026-11-18' },
      { fromDate: '2025-01-01' }, { kind: 'BAD' }, { paymentMethod: 'UNKNOWN' }, { payoutMethod: 'BAD' }, { extra: 'oops' }]) await get().query(query).expect(400);
    for (const query of [{ limit: 101 }, { page: 0 }, { page: '1.1' }, { eventType: 'BAD' }, { q: 'x'.repeat(121) }, { page: Number.MAX_SAFE_INTEGER }]) await report('/events').query(query).expect(400);
    await get('/events/RECEIPT/invalid').expect(400); await get(`/events/BAD/${new ObjectId()}`).expect(400);
    expect((await get().expect(200)).body.range).toMatchObject({ fromDate: '2026-11-01', toDate: '2026-11-17' });
    const literal = (await report('/events').query({ q: ' .* ' }).expect(200)).body;
    expect(literal).toMatchObject({ total: 0, totalPages: 0, eventFilter: { q: '.*' }, totals: { grossReceipts: '2000000' } });
    const page = (await report('/events').query({ limit: 1, page: 2, eventType: 'RECEIPT' }).expect(200)).body;
    expect(page).toMatchObject({ total: 4, totalPages: 4 }); expect(page.items).toHaveLength(1);
  });
  it('TC14/15: repeated GET has no business writes, empty periods are zero and DB failure is sanitized 503', async () => {
    const read = async () => { const result = []; for (const name of ['payments', 'refunds', 'orders', 'transactions', 'invoices']) result.push(await db().collection(name).find().toArray()); return result; };
    const before = await read(); await report().expect(200); await report('/events').expect(200);
    await report(`/events/REFUND/${oid('test_refund_old')}`).expect(200); expect(await read()).toEqual(before);
    const empty = (await get('/events').query({ fromDate: '2026-10-01', toDate: '2026-10-03' }).expect(200)).body;
    expect(empty).toMatchObject({ dataQuality: 'COMPLETE', total: 0, totalPages: 0, totals: { grossReceipts: '0', refundPaid: '0', netCash: '0' } });
    const error = new Error('mongodb://private-secret'); error.name = 'MongoNetworkError';
    jest.spyOn(app.get(CashFlowRepository), 'sources').mockRejectedValueOnce(error);
    const failed = await report().expect(503); expect(failed.body.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(failed.body.requestId).toBeTruthy(); expect(JSON.stringify(failed.body)).not.toContain('private-secret'); expect(failed.body.totals).toBeUndefined();
  });
  it('payment/refund source indexes support status/date scans (explain) and preserve source uniqueness', async () => {
    for (const [name, field, index] of [['payments', 'paid_at', 'payments_status_paid'], ['refunds', 'refunded_at', 'refunds_status_refunded']]) {
      const explain = await db().collection(name).find({ status: 'SUCCEEDED', [field]: { $gte: new Date('2026-11-01Z') } }).sort({ [field]: -1, _id: -1 }).hint(index).explain('executionStats');
      expect(JSON.stringify(explain.queryPlanner.winningPlan)).toContain('IXSCAN');
    }
    expect(await db().collection('payments').indexes()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'payments_succeeded_transaction_unique', unique: true })]));
    expect(await db().collection('refunds').indexes()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'refunds_obligation_unique', unique: true })]));
  });
});

