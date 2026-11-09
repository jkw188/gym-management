// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-17 bước 4.
// Ownership xuyên các join khi dữ liệu lệch chủ, biên ngày VN của bộ lọc, snapshot qua chuỗi gia hạn/nâng cấp (TC02, TC05, TC08).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng test (spec US-17 mục 2): "Owner check và query lọc member_id ngay backend trước join/projection…
//   Một ID không thuộc chủ thể trả 404 đồng nhất không tồn tại; các liên kết kế tiếp sale→transaction→invoice đều phải giữ
//   cùng owner." Dữ liệu lệch chủ (do lỗi nhập liệu/hỏng) không được làm lộ dữ liệu của member khác qua bất kỳ endpoint nào.
//   Bộ lọc timeState và nhãn timeState dùng CÙNG ngày Việt Nam. Mỗi kỳ trong chuỗi gia hạn/nâng cấp giữ snapshot của sale riêng.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us17_hardening';
const password = 'MậtKhẩuUS-17-000';

const realTimers = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout'] as const;

type Auth = { accessToken: string };
type Kind = 'GYM' | 'PT';

describe('US-17 bước 4: ownership xuyên join, biên ngày và snapshot', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName },
    });
    Object.assign(process.env, {
      NODE_ENV: 'test',
      PORT: '3000',
      FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'us17-test', SMTP_PASS: 'us17-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http');
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await connection.db!.collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());
  const money = (vnd: number) => Decimal128.fromString(String(vnd));

  let seq = 0;
  async function linkedMember() {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole('MEMBER', 'MEMBER');
    seq += 1;
    const phone = `09117300${String(seq).padStart(2, '0')}`;
    const account = await users.createAccount({
      roleId: role.id.toHexString(), phone, fullName: `US17 Member ${seq}`, passwordHash: await app.get(PasswordService).hash(password),
    });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, account_id: account.id, member_code: `HV-${memberId.toHexString()}`,
      full_name: `Hội viên US17 ${seq}`, phone, version: 0, service_revision: 0n, created_by: staffId, updated_by: staffId,
    });
    return { accessToken: response.body.accessToken as string, memberId };
  }

  // Từng mảnh dữ liệu ghi riêng để dựng được chuỗi lệch chủ (thay cho US-14/16/22).
  async function insertTransaction(memberId: ObjectId, kind: Kind = 'GYM', amount = 1500000) {
    seq += 1;
    const id = new ObjectId();
    const code = `GD-US17B4-${seq}`;
    await db().collection('transactions').insertOne({
      _id: id, id, member_id: memberId, created_by: new ObjectId(), code, kind, amount_due: money(amount), status: 'SETTLED',
      request_key: `us17-b4-${id.toHexString()}`, created_at: new Date(), guard_revision: 0n,
    });
    return { id, code };
  }

  async function insertSale(memberId: ObjectId, transactionId: ObjectId, options: {
    planName?: string; benefits?: string; amount?: number; sessions?: number; startDate?: string; endDate?: string;
    operation?: 'REGISTER' | 'RENEW' | 'UPGRADE'; previousSaleId?: ObjectId;
  } = {}) {
    seq += 1;
    const id = new ObjectId();
    const planId = new ObjectId();
    const planName = options.planName ?? `Gói US17B4 ${seq}`;
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `US17B4-${seq}`, name: planName, kind: 'GYM', duration_days: 30,
      session_quota: options.sessions ?? 0, price: money(options.amount ?? 1500000), benefits: options.benefits ?? 'Quyền lợi', status: 'ACTIVE',
    });
    const sale: Record<string, unknown> = {
      _id: id, id, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: options.operation ?? 'REGISTER',
      start_date: options.startDate ?? '2026-11-01', end_date: options.endDate ?? '2026-11-30', plan_name_snapshot: planName,
      benefits_snapshot: options.benefits ?? 'Quyền lợi', list_price_snapshot: money(options.amount ?? 1500000), credit_amount: money(0),
      sessions_snapshot: options.sessions ?? 0, policy_snapshot: 'Giá niêm yết', created_at: new Date(),
    };
    if (options.previousSaleId) sale.previous_sale_id = options.previousSaleId;
    await db().collection('service_sales').insertOne(sale);
    return { id, planId, planName };
  }

  async function insertMembership(saleId: ObjectId, status: 'ACTIVE' | 'SUPERSEDED' | 'CANCELLED' = 'ACTIVE', sessionsUsed = 0) {
    const id = new ObjectId();
    await db().collection('memberships').insertOne({ _id: id, id, service_sale_id: saleId, status, sessions_used: sessionsUsed });
    return id;
  }

  async function insertInvoice(transactionId: ObjectId, buyer: string) {
    seq += 1;
    const id = new ObjectId();
    await db().collection('invoices').insertOne({
      _id: id, id, transaction_id: transactionId, invoice_no: `HD-US17B4-${seq}`, issued_at: new Date(), total_amount: money(1500000),
      buyer_snapshot: buyer,
    });
    return id;
  }

  function get(user: Auth, path: string, query: Record<string, string | number> = {}) {
    return http().get(path).query(query).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }

  const ids = (body: { items: Array<{ id: string }> }) => body.items.map(item => item.id);

  // =====================================================================
  // TC02 – ownership xuyên các join khi dữ liệu lệch chủ
  // =====================================================================

  describe('US-17-AC01 (bước 4)', () => {
    it('US-17-TC02: membership trỏ tới sale của người khác → không nằm trong danh sách của tôi, chi tiết 404', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const otherTx = await insertTransaction(other.memberId);
      const otherSale = await insertSale(other.memberId, otherTx.id, { planName: 'Gói bí mật của người khác' });
      const otherMembership = await insertMembership(otherSale.id);
      // Đối chứng: tôi có một gói hợp lệ.
      const myTx = await insertTransaction(me.memberId);
      const mySale = await insertSale(me.memberId, myTx.id);
      const myMembership = await insertMembership(mySale.id);

      const list = await get(me, '/api/me/memberships').expect(200);
      expect(ids(list.body)).toEqual([myMembership.toHexString()]);
      expect(JSON.stringify(list.body)).not.toContain('Gói bí mật của người khác');
      const detail = await get(me, `/api/me/memberships/${otherMembership.toHexString()}`);
      expect(detail.status).toBe(404);
      expect(JSON.stringify(detail.body)).not.toContain('Gói bí mật của người khác');
    });

    it('US-17-TC02: sale của tôi nhưng transaction_id trỏ sang giao dịch của người khác → không lộ mã/số tiền giao dịch đó', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const otherTx = await insertTransaction(other.memberId, 'GYM', 7777000);
      const brokenSale = await insertSale(me.memberId, otherTx.id, { planName: 'Sale lệch chủ' });

      const list = await get(me, '/api/me/service-sales').expect(200);
      const detail = await get(me, `/api/me/service-sales/${brokenSale.id.toHexString()}`);
      expect([200, 404]).toContain(detail.status);
      for (const body of [list.body, detail.body]) {
        const text = JSON.stringify(body);
        expect(text).not.toContain(otherTx.code);
        expect(text).not.toContain('7777000');
      }
      // Giao dịch của người khác vẫn 404 khi gọi thẳng.
      expect((await get(me, `/api/me/transactions/${otherTx.id.toHexString()}`)).status).toBe(404);
    });

    it('US-17-TC02: giao dịch của tôi nhưng sale/membership gắn với nó thuộc người khác → không lộ membershipId của người khác', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const myTx = await insertTransaction(me.memberId);
      const otherSale = await insertSale(other.memberId, myTx.id, { planName: 'Gói người khác gắn nhầm' });
      const otherMembership = await insertMembership(otherSale.id);

      const response = await get(me, `/api/me/transactions/${myTx.id.toHexString()}`).expect(200);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(otherMembership.toHexString());
      expect(text).not.toContain(otherSale.id.toHexString());
      expect(text).not.toContain('Gói người khác gắn nhầm');
    });

    it('US-17-TC02: chứng từ của giao dịch người khác → 404 dù sale trỏ tới giao dịch đó là của tôi', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const otherTx = await insertTransaction(other.memberId);
      await insertSale(me.memberId, otherTx.id);
      const otherInvoice = await insertInvoice(otherTx.id, 'Người mua khác - 0988000111');

      const response = await get(me, `/api/me/invoices/${otherInvoice.toHexString()}`);
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('0988000111');
    });

    it('US-17-TC02: ID của người khác viết HOA vẫn 404 giống không tồn tại', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const otherTx = await insertTransaction(other.memberId);
      const otherSale = await insertSale(other.memberId, otherTx.id);
      const otherMembership = await insertMembership(otherSale.id);
      const missing = new ObjectId().toHexString().toUpperCase();

      for (const [base, id] of [
        ['/api/me/memberships', otherMembership], ['/api/me/service-sales', otherSale.id], ['/api/me/transactions', otherTx.id],
      ] as Array<[string, ObjectId]>) {
        const foreign = await get(me, `${base}/${id.toHexString().toUpperCase()}`);
        const notFound = await get(me, `${base}/${missing}`);
        expect(foreign.status).toBe(notFound.status);
        expect(foreign.body.error?.code).toBe(notFound.body.error?.code);
        expect(foreign.status).not.toBe(200);
      }
    });

    it.each(['abc', '123', 'zzzzzzzzzzzzzzzzzzzzzzzz', '6a0000000000000000000000x'])(
      'US-17-TC02: ID sai định dạng "%s" → 400, không phải lỗi 500', async badId => {
        const me = await linkedMember();

        for (const base of ['/api/me/memberships', '/api/me/service-sales', '/api/me/transactions', '/api/me/invoices']) {
          const response = await get(me, `${base}/${badId}`);
          expect(response.status).toBe(400);
          expect(typeof response.body.error?.code).toBe('string');
          expect(typeof response.body.requestId).toBe('string');
        }
      });
  });

  // =====================================================================
  // TC05, TC08 – biên ngày của bộ lọc và snapshot qua chuỗi kỳ
  // =====================================================================

  describe('US-17-AC02 (bước 4)', () => {
    it('US-17-TC05: 00:30 ngày 05/11 giờ VN → lọc CURRENT có gói bắt đầu 05/11, lọc EXPIRED có gói kết thúc 04/11 (bộ lọc khớp nhãn)', async () => {
      jest.useFakeTimers({ doNotFake: [...realTimers], now: new Date('2026-11-04T17:30:00.000Z') });
      const me = await linkedMember();
      const startsToday = await insertMembership((await insertSale(me.memberId, (await insertTransaction(me.memberId)).id,
        { startDate: '2026-11-05', endDate: '2026-12-04' })).id);
      const endedYesterday = await insertMembership((await insertSale(me.memberId, (await insertTransaction(me.memberId)).id,
        { startDate: '2026-10-06', endDate: '2026-11-04' })).id);

      const current = await get(me, '/api/me/memberships', { timeState: 'CURRENT' }).expect(200);
      const expired = await get(me, '/api/me/memberships', { timeState: 'EXPIRED' }).expect(200);
      const scheduled = await get(me, '/api/me/memberships', { timeState: 'SCHEDULED' }).expect(200);
      expect(ids(current.body)).toEqual([startsToday.toHexString()]);
      expect(ids(expired.body)).toEqual([endedYesterday.toHexString()]);
      expect(scheduled.body.items).toEqual([]);
      // Nhãn của từng gói trùng với bộ lọc đã trả nó về.
      expect(current.body.items[0].timeState).toBe('CURRENT');
      expect(expired.body.items[0].timeState).toBe('EXPIRED');
    });

    it('US-17-TC05: 23:59 ngày 05/11 giờ VN → gói kết thúc 05/11 vẫn trong CURRENT, gói bắt đầu 06/11 nằm ở SCHEDULED', async () => {
      jest.useFakeTimers({ doNotFake: [...realTimers], now: new Date('2026-11-05T16:59:00.000Z') });
      const me = await linkedMember();
      const endsToday = await insertMembership((await insertSale(me.memberId, (await insertTransaction(me.memberId)).id,
        { startDate: '2026-10-07', endDate: '2026-11-05' })).id);
      const startsTomorrow = await insertMembership((await insertSale(me.memberId, (await insertTransaction(me.memberId)).id,
        { startDate: '2026-11-06', endDate: '2026-12-05' })).id);

      expect(ids((await get(me, '/api/me/memberships', { timeState: 'CURRENT' }).expect(200)).body)).toEqual([endsToday.toHexString()]);
      expect(ids((await get(me, '/api/me/memberships', { timeState: 'SCHEDULED' }).expect(200)).body)).toEqual([startsTomorrow.toHexString()]);
    });

    it('US-17-TC08: chuỗi đăng ký → gia hạn → nâng cấp, sau đó sửa danh mục: mỗi kỳ giữ đúng snapshot của sale riêng', async () => {
      const me = await linkedMember();
      const first = await insertSale(me.memberId, (await insertTransaction(me.memberId, 'PT', 2000000)).id, {
        planName: 'PT 10 buổi kỳ 1', benefits: 'Kỳ 1: 10 buổi', amount: 2000000, sessions: 10, startDate: '2026-09-01', endDate: '2026-09-30',
      });
      const renew = await insertSale(me.memberId, (await insertTransaction(me.memberId, 'PT', 2100000)).id, {
        planName: 'PT 10 buổi kỳ 2', benefits: 'Kỳ 2: 10 buổi', amount: 2100000, sessions: 10, startDate: '2026-10-01', endDate: '2026-10-30',
        operation: 'RENEW', previousSaleId: first.id,
      });
      const upgrade = await insertSale(me.memberId, (await insertTransaction(me.memberId, 'PT', 3500000)).id, {
        planName: 'PT 20 buổi kỳ 3', benefits: 'Kỳ 3: 20 buổi', amount: 3500000, sessions: 20, startDate: '2026-10-15', endDate: '2026-12-14',
        operation: 'UPGRADE', previousSaleId: renew.id,
      });
      const m1 = await insertMembership(first.id, 'ACTIVE', 10);
      const m2 = await insertMembership(renew.id, 'SUPERSEDED', 4);
      const m3 = await insertMembership(upgrade.id, 'ACTIVE', 4);
      // Admin sửa cả 3 gói trong danh mục sau khi bán.
      await db().collection('plans').updateMany({ _id: { $in: [first.planId, renew.planId, upgrade.planId] } },
        { $set: { name: 'TÊN DANH MỤC MỚI', benefits: 'QUYỀN LỢI MỚI', price: money(9999000), session_quota: 99 } });

      const expected: Array<[ObjectId, string, string, number, string]> = [
        [m1, 'PT 10 buổi kỳ 1', 'Kỳ 1: 10 buổi', 10, '2026-09-30'],
        [m2, 'PT 10 buổi kỳ 2', 'Kỳ 2: 10 buổi', 10, '2026-10-30'],
        [m3, 'PT 20 buổi kỳ 3', 'Kỳ 3: 20 buổi', 20, '2026-12-14'],
      ];
      for (const [membershipId, name, benefits, quota, endDate] of expected) {
        const detail = await get(me, `/api/me/memberships/${membershipId.toHexString()}`).expect(200);
        const text = JSON.stringify(detail.body);
        expect(text).toContain(name);
        expect(text).toContain(benefits);
        expect(text).toContain(endDate);
        expect(detail.body.sessionsQuota).toBe(quota);
        expect(text).not.toContain('TÊN DANH MỤC MỚI');
        expect(text).not.toContain('QUYỀN LỢI MỚI');
      }
      // Kỳ sau trỏ về sale trước (nhãn nguồn), giá từng lần mua giữ đúng snapshot.
      expect(JSON.stringify((await get(me, `/api/me/memberships/${m3.toHexString()}`).expect(200)).body)).toContain(renew.id.toHexString());
      const sales = await get(me, '/api/me/service-sales').expect(200);
      const text = JSON.stringify(sales.body);
      for (const price of ['"2000000"', '"2100000"', '"3500000"']) expect(text).toContain(price);
      expect(text).not.toContain('9999000');
    });
  });
});
