// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-17 bước 3 – phần API.
// Kiểm tra lịch sử/chứng từ an toàn (TC09), phân trang ổn định (TC10), GET lặp không gây biến động (TC11).
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
// Hợp đồng test (US-17 mục 2 và F04, F05):
//   Chứng từ: người mua lấy từ invoices.buyer_snapshot, không theo hồ sơ hiện tại.
//   Giao dịch: khoản thu chỉ expose method, amount, paidAt; KHÔNG có reference, verified_by, request_key, created_by,
//   evidence note hay khóa idempotency (kể cả dưới dạng camelCase).
//   Phân trang: page mặc định 1, limit mặc định 20, tối đa 100; {items,page,limit,total,totalPages}; rỗng totalPages=0;
//   thứ tự ổn định khi nhiều bản ghi cùng ngày tạo; query ngoài allowlist → 400.
//   GET không ghi gì vào DB (kể cả thông báo, trạng thái gói).

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us17_history';
const password = 'MậtKhẩuUS-17-789';

type Auth = { accessToken: string };

describe('US-17 bước 3: lịch sử, chứng từ và phân trang API cá nhân', () => {
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

  afterEach(() => jest.restoreAllMocks());

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
    const phone = `09117200${String(seq).padStart(2, '0')}`;
    const account = await users.createAccount({
      roleId: role.id.toHexString(), phone, fullName: `US17 Member ${seq}`, passwordHash: await app.get(PasswordService).hash(password),
    });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, account_id: account.id, member_code: `HV-${memberId.toHexString()}`,
      full_name: `Nguyễn Văn Lúc Mua ${seq}`, phone, version: 0, service_revision: 0n, created_by: staffId, updated_by: staffId,
    });
    return { accessToken: response.body.accessToken as string, memberId, accountId: account.id, phone };
  }

  // Một lần mua gói đã thu tiền (thay cho US-14/22). Trả các id và dữ liệu nội bộ để kiểm không bị lộ.
  async function insertPurchase(memberId: ObjectId, options: { createdAt?: Date; buyer?: string } = {}) {
    seq += 1;
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const paymentId = new ObjectId();
    const invoiceId = new ObjectId();
    const staffId = new ObjectId();
    const createdAt = options.createdAt ?? new Date();
    const internal = {
      reference: `VCB-NOI-BO-${seq}-998877`,
      requestKey: `khoa-noi-bo-${seq}-${transactionId.toHexString()}`,
      staffId,
    };
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `GYM-US17H-${seq}`, name: `Gói GYM ${seq}`, kind: 'GYM', duration_days: 30,
      session_quota: 0, price: money(1500000), benefits: 'Tập gym', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US17H-${seq}`, kind: 'GYM',
      amount_due: money(1500000), status: 'SETTLED', request_key: internal.requestKey, created_at: createdAt, guard_revision: 0n,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: '2026-11-01', end_date: '2026-11-30', plan_name_snapshot: `Gói GYM ${seq}`, benefits_snapshot: 'Tập gym',
      list_price_snapshot: money(1500000), credit_amount: money(0), sessions_snapshot: 0, policy_snapshot: 'Giá niêm yết',
      created_at: createdAt,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: 0,
    });
    await db().collection('payments').insertOne({
      _id: paymentId, id: paymentId, transaction_id: transactionId, method: 'TRANSFER', reference: internal.reference,
      amount: money(1500000), status: 'SUCCEEDED', verified_by: staffId, paid_at: new Date('2026-11-01T03:15:00.000Z'),
      // Ghi chú đối chiếu nội bộ của Staff (nếu US-22 lưu): không bao giờ được trả cho Member.
      evidence_note: 'Ảnh chụp sao kê nội bộ #12',
    });
    await db().collection('invoices').insertOne({
      _id: invoiceId, id: invoiceId, transaction_id: transactionId, invoice_no: `HD-US17H-${seq}`,
      issued_at: new Date('2026-11-01T03:16:00.000Z'), total_amount: money(1500000),
      buyer_snapshot: options.buyer ?? `Nguyễn Văn Lúc Mua ${seq} - 0901234567`,
    });
    return { transactionId, saleId, membershipId, invoiceId, internal };
  }

  function get(user: Auth, path: string, query: Record<string, string | number> = {}) {
    return http().get(path).query(query).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }

  // Tìm mọi key (ở mọi tầng lồng nhau) của body JSON.
  function allKeys(value: unknown, keys: string[] = []): string[] {
    if (Array.isArray(value)) value.forEach(item => allKeys(item, keys));
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) { keys.push(key); allKeys(child, keys); }
    }
    return keys;
  }
  const forbiddenKeys = ['reference', 'verified_by', 'verifiedBy', 'request_key', 'requestKey', 'created_by', 'createdBy',
    'evidence_note', 'evidenceNote', 'evidence', 'member_id', 'memberId', 'account_id', 'accountId', 'idempotencyKey'];

  async function wholeDatabase() {
    const result: Record<string, unknown[]> = {};
    for (const collection of await db().collections()) {
      result[collection.collectionName] = await collection.find({}).sort({ _id: 1 }).toArray();
    }
    return result;
  }

  // =====================================================================
  // AC03 – Lịch sử/chứng từ an toàn (TC09), phân trang (TC10), không side effect (TC11)
  // =====================================================================

  describe('US-17-AC03', () => {
    // ---------- TC09 ----------

    it('US-17-TC09: sửa hồ sơ sau khi mua → chứng từ vẫn hiện người mua theo snapshot lúc lập', async () => {
      const me = await linkedMember();
      const bought = await insertPurchase(me.memberId, { buyer: 'Nguyễn Văn Lúc Mua - 0901234567' });
      // Hội viên đổi tên và số điện thoại sau khi mua (US-04/US-09).
      await db().collection('members').updateOne({ _id: me.memberId }, { $set: { full_name: 'Tên Mới Sau Khi Sửa', phone: '0999888777' } });
      await db().collection('accounts').updateOne({ _id: me.accountId }, { $set: { full_name: 'Tên Mới Sau Khi Sửa' } });

      const response = await get(me, `/api/me/invoices/${bought.invoiceId.toHexString()}`).expect(200);

      const text = JSON.stringify(response.body);
      expect(text).toContain('Nguyễn Văn Lúc Mua - 0901234567');
      expect(text).not.toContain('Tên Mới Sau Khi Sửa');
      expect(text).not.toContain('0999888777');
      expect(text).toContain('"1500000"');
    });

    it('US-17-TC09: chứng từ và giao dịch không có reference ngân hàng, người xác minh, ghi chú đối chiếu, khóa chống trùng', async () => {
      const me = await linkedMember();
      const bought = await insertPurchase(me.memberId);

      for (const path of [`/api/me/invoices/${bought.invoiceId.toHexString()}`, `/api/me/transactions/${bought.transactionId.toHexString()}`]) {
        const response = await get(me, path).expect(200);
        const text = JSON.stringify(response.body);
        expect(text).not.toContain(bought.internal.reference);
        expect(text).not.toContain('998877');
        expect(text).not.toContain(bought.internal.requestKey);
        expect(text).not.toContain(bought.internal.staffId.toHexString());
        expect(text).not.toContain('sao kê nội bộ');
        const keys = allKeys(response.body);
        for (const key of forbiddenKeys) expect(keys).not.toContain(key);
      }
    });

    it('US-17-TC09: giao dịch đã thu chỉ cho biết method, amount, paidAt của khoản thu của mình', async () => {
      const me = await linkedMember();
      const bought = await insertPurchase(me.memberId);

      const response = await get(me, `/api/me/transactions/${bought.transactionId.toHexString()}`).expect(200);

      const text = JSON.stringify(response.body);
      expect(text).toContain('TRANSFER');
      expect(text).toContain('"1500000"');
      expect(text).toContain('2026-11-01T03:15:00.000Z');
      expect(text).toContain(bought.invoiceId.toHexString());
    });

    it('US-17-TC09: danh sách và chi tiết lần mua cũng không lộ field nội bộ', async () => {
      const me = await linkedMember();
      const bought = await insertPurchase(me.memberId);

      const list = await get(me, '/api/me/service-sales').expect(200);
      const detail = await get(me, `/api/me/service-sales/${bought.saleId.toHexString()}`).expect(200);
      const memberships = await get(me, '/api/me/memberships').expect(200);
      for (const body of [list.body, detail.body, memberships.body]) {
        const text = JSON.stringify(body);
        expect(text).not.toContain(bought.internal.reference);
        expect(text).not.toContain(bought.internal.requestKey);
        expect(text).not.toContain(me.memberId.toHexString());
        const keys = allKeys(body);
        for (const key of forbiddenKeys) expect(keys).not.toContain(key);
      }
    });

    // ---------- TC10 ----------

    it('US-17-TC10: 25 lần mua cùng thời điểm tạo → 3 trang limit 10 không trùng, không sót, total/totalPages đúng', async () => {
      const me = await linkedMember();
      const sameTime = new Date('2026-11-01T02:00:00.000Z');
      const saleIds: string[] = [];
      for (let index = 0; index < 25; index += 1) saleIds.push((await insertPurchase(me.memberId, { createdAt: sameTime })).saleId.toHexString());

      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const response = await get(me, '/api/me/service-sales', { page, limit: 10 }).expect(200);
        expect(response.body).toMatchObject({ page, limit: 10, total: 25, totalPages: 3 });
        expect(response.body.items).toHaveLength(page === 3 ? 5 : 10);
        seen.push(...response.body.items.map((item: { id: string }) => item.id));
      }
      expect(new Set(seen).size).toBe(25);
      expect([...seen].sort()).toEqual([...saleIds].sort());
    });

    it('US-17-TC10: gọi lại cùng trang hai lần → cùng thứ tự (ổn định khi trùng ngày tạo)', async () => {
      const me = await linkedMember();
      const sameTime = new Date('2026-11-01T02:00:00.000Z');
      for (let index = 0; index < 12; index += 1) await insertPurchase(me.memberId, { createdAt: sameTime });

      for (const path of ['/api/me/service-sales', '/api/me/memberships']) {
        const first = await get(me, path, { page: 2, limit: 5 }).expect(200);
        const second = await get(me, path, { page: 2, limit: 5 }).expect(200);
        expect(second.body.items.map((item: { id: string }) => item.id)).toEqual(first.body.items.map((item: { id: string }) => item.id));
      }
    });

    it('US-17-TC10: danh sách kỳ gói phân trang không trùng, không sót', async () => {
      const me = await linkedMember();
      const ids: string[] = [];
      for (let index = 0; index < 7; index += 1) ids.push((await insertPurchase(me.memberId)).membershipId.toHexString());

      const first = await get(me, '/api/me/memberships', { page: 1, limit: 4 }).expect(200);
      const second = await get(me, '/api/me/memberships', { page: 2, limit: 4 }).expect(200);
      expect(first.body).toMatchObject({ total: 7, totalPages: 2 });
      const seen = [...first.body.items, ...second.body.items].map((item: { id: string }) => item.id);
      expect([...seen].sort()).toEqual([...ids].sort());
    });

    it('US-17-TC10: Member đã link nhưng chưa mua gì → items rỗng, total 0, totalPages 0, memberLinked=true', async () => {
      const me = await linkedMember();

      for (const path of ['/api/me/memberships', '/api/me/service-sales']) {
        const response = await get(me, path).expect(200);
        expect(response.body).toMatchObject({ memberLinked: true, items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
      }
    });

    it('US-17-TC10: trang vượt quá số trang → items rỗng nhưng total/totalPages vẫn đúng', async () => {
      const me = await linkedMember();
      for (let index = 0; index < 3; index += 1) await insertPurchase(me.memberId);

      const response = await get(me, '/api/me/service-sales', { page: 5, limit: 2 }).expect(200);
      expect(response.body).toMatchObject({ items: [], page: 5, limit: 2, total: 3, totalPages: 2 });
    });

    it.each([
      ['limit=101 (quá tối đa 100)', { limit: 101 }],
      ['limit=0', { limit: 0 }],
      ['page=0', { page: 0 }],
      ['page không phải số', { page: 'abc' }],
      ['tham số ngoài allowlist', { sort: 'created_at' }],
    ])('US-17-TC10: %s → 400', async (_label, query) => {
      const me = await linkedMember();

      for (const path of ['/api/me/memberships', '/api/me/service-sales']) {
        const response = await get(me, path, query as Record<string, string | number>);
        expect(response.status).toBe(400);
        expect(typeof response.body.error?.code).toBe('string');
      }
    });

    it('US-17-TC10: limit=100 (đúng tối đa) → 200', async () => {
      const me = await linkedMember();
      await insertPurchase(me.memberId);

      const response = await get(me, '/api/me/service-sales', { limit: 100 }).expect(200);
      expect(response.body).toMatchObject({ limit: 100, total: 1, totalPages: 1 });
    });

    // ---------- TC11 (phần server) ----------

    it('US-17-TC11: gọi lặp mọi GET cá nhân nhiều lần → toàn bộ DB không đổi (không tạo/sửa gói, giao dịch, thông báo)', async () => {
      const me = await linkedMember();
      const bought = await insertPurchase(me.memberId);
      const before = await wholeDatabase();
      const paths = [
        '/api/me/memberships',
        `/api/me/memberships/${bought.membershipId.toHexString()}`,
        '/api/me/service-sales',
        `/api/me/service-sales/${bought.saleId.toHexString()}`,
        `/api/me/transactions/${bought.transactionId.toHexString()}`,
        `/api/me/invoices/${bought.invoiceId.toHexString()}`,
      ];

      for (let round = 0; round < 3; round += 1) {
        for (const path of paths) await get(me, path).expect(200);
      }

      const after = await wholeDatabase();
      // auth_sessions có thể cập nhật thời điểm dùng phiên (US-02); các collection nghiệp vụ phải giữ nguyên.
      delete before.auth_sessions;
      delete after.auth_sessions;
      expect(after).toEqual(before);
    });
  });
});
