// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-17 bước 1.
// Kiểm tra API cá nhân /api/me/*: Member lấy từ principal, chỉ thấy dữ liệu của mình, không tự nối hồ sơ, đúng role (TC01–TC04).
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
// Hợp đồng test đặt ra cho Builder (US-17 bước 1, theo mục 2 của spec):
//   Mọi route: role MEMBER; member lấy từ members.account_id = principal (US-09 chưa có → test ghi thẳng hồ sơ mẫu
//   vào collection 'members' theo mục 4.2.7). US-14/22 chưa có → test ghi thẳng plans, transactions, service_sales,
//   memberships, payments, invoices theo mục 4.2.9–4.2.12, 4.2.23, 4.2.24.
//   Chủ sở hữu: service_sales.member_id; membership qua service_sale_id; invoice qua transaction_id; transaction qua member_id.
//   GET /api/me/memberships         -> 200 {memberLinked, items, page, limit, total, totalPages, asOf}
//   GET /api/me/memberships/:id     -> 200 MembershipDto của mình; của người khác/không có -> 404
//   GET /api/me/service-sales       -> 200 {memberLinked, items, page, limit, total, totalPages, asOf?}
//   GET /api/me/service-sales/:id   -> 200 sale của mình; người khác/không link -> 404
//   GET /api/me/transactions/:id    -> 200 {id, code, status, amountDue, ...}; người khác -> 404
//   GET /api/me/invoices/:id        -> 200 chứng từ của transaction của mình; người khác -> 404
//   API camelCase, tiền là chuỗi số nguyên VND (EN02-D02). Lỗi theo EN01-D03 {error:{code,message,details?},requestId}.
//   Non-MEMBER 403; không token / account LOCKED / phiên revoked / auth_version đổi -> 401.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us17_api';
const password = 'MậtKhẩuUS-17-123';

type Auth = { accessToken: string };
type Owned = { memberId: ObjectId; planId: ObjectId; transactionId: ObjectId; saleId: ObjectId; membershipId: ObjectId; invoiceId: ObjectId };

describe('US-17 bước 1: API cá nhân /api/me/* của Member', () => {
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
      // Ứng dụng bắt buộc có cấu hình SMTP/pepper khi khởi động (US-05); test này không gửi thư.
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
    // Bộ giới hạn đăng nhập (US-02) lưu trong bộ nhớ: mỗi test dùng bộ mới để không bị 429 khi đăng nhập nhiều lần.
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    // Chỉ xóa dữ liệu, giữ index.
    for (const collection of await connection.db!.collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
  });

  afterEach(() => {
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

  // ---------- Chuẩn bị: account thật theo role, đăng nhập thật qua API US-02 ----------
  let phoneSeq = 0;
  async function login(roleCode: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN') {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `09117000${String(phoneSeq).padStart(2, '0')}`;
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName: `US17 ${roleCode} ${phoneSeq}`, passwordHash });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { accountId: account.id, phone, accessToken: response.body.accessToken as string };
  }

  // Hồ sơ hội viên mẫu (thay cho US-09). accountId = null nghĩa là hội viên ngoại tuyến, chưa liên kết tài khoản.
  let memberSeq = 0;
  async function insertMember(accountId: ObjectId | null, phone: string) {
    memberSeq += 1;
    const id = new ObjectId();
    const doc: Record<string, unknown> = {
      _id: id, id, member_code: `HV-US17-${memberSeq}`, full_name: `Hội viên US17 ${memberSeq}`, phone, version: 0,
    };
    if (accountId) doc.account_id = accountId;
    await db().collection('members').insertOne(doc);
    return id;
  }

  // Một lần mua gói đã thu tiền xong (thay cho US-14/22): plan → transaction SETTLED → sale → membership ACTIVE → payment → invoice.
  let saleSeq = 0;
  async function insertPurchase(memberId: ObjectId, amount = 1500000): Promise<Owned> {
    saleSeq += 1;
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const paymentId = new ObjectId();
    const invoiceId = new ObjectId();
    const staffId = new ObjectId();
    const now = new Date();
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `GYM-US17-${saleSeq}`, name: `Gói GYM ${saleSeq}`, kind: 'GYM', duration_days: 30,
      session_quota: 0, price: money(amount), benefits: 'Tập gym không giới hạn', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US17-${saleSeq}`, kind: 'GYM',
      amount_due: money(amount), status: 'SETTLED', request_key: `us17-key-${saleSeq}-${transactionId.toHexString()}`, created_at: now,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: '2026-11-01', end_date: '2026-11-30', plan_name_snapshot: `Gói GYM ${saleSeq}`,
      benefits_snapshot: 'Tập gym không giới hạn', list_price_snapshot: money(amount), credit_amount: money(0),
      sessions_snapshot: 0, policy_snapshot: 'Giá niêm yết, 30 ngày', created_at: now,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: 0,
    });
    await db().collection('payments').insertOne({
      _id: paymentId, id: paymentId, transaction_id: transactionId, method: 'CASH', reference: `BN-US17-${saleSeq}`,
      amount: money(amount), status: 'SUCCEEDED', verified_by: staffId, paid_at: now,
    });
    await db().collection('invoices').insertOne({
      _id: invoiceId, id: invoiceId, transaction_id: transactionId, invoice_no: `HD-US17-${saleSeq}`, issued_at: now,
      total_amount: money(amount), buyer_snapshot: `Hội viên US17 - ${saleSeq}`,
    });
    return { memberId, planId, transactionId, saleId, membershipId, invoiceId };
  }

  // Member có tài khoản đã liên kết hồ sơ và có một lần mua gói.
  async function linkedMember(amount = 1500000) {
    const account = await login('MEMBER');
    const memberId = await insertMember(account.accountId, account.phone);
    const owned = await insertPurchase(memberId, amount);
    return { ...account, ...owned };
  }

  function get(user: Auth | undefined, path: string, query: Record<string, string | number> = {}) {
    const call = http().get(path).query(query).set('Origin', origin);
    return user ? call.set('Authorization', `Bearer ${user.accessToken}`) : call;
  }

  // Sáu endpoint của bước 1 ứng với dữ liệu của một Member (dùng cho các test kiểm tra quyền).
  function allPaths(owned: Owned) {
    return [
      '/api/me/memberships',
      `/api/me/memberships/${owned.membershipId.toHexString()}`,
      '/api/me/service-sales',
      `/api/me/service-sales/${owned.saleId.toHexString()}`,
      `/api/me/transactions/${owned.transactionId.toHexString()}`,
      `/api/me/invoices/${owned.invoiceId.toHexString()}`,
    ];
  }

  function expectErrorShape(body: Record<string, any>, code?: string) {
    expect(typeof body.error?.code).toBe('string');
    expect(typeof body.error?.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
    if (code) expect(body.error.code).toBe(code);
  }

  // Ảnh chụp các collection dữ liệu gói, để chứng minh GET không ghi gì.
  async function snapshot() {
    const names = ['members', 'transactions', 'service_sales', 'memberships', 'payments', 'invoices'];
    const result: Record<string, unknown[]> = {};
    for (const name of names) result[name] = await db().collection(name).find({}).sort({ _id: 1 }).toArray();
    return result;
  }

  // =====================================================================
  // AC01 – Chỉ dữ liệu của Member hiện hành và không tự liên kết (TC01–TC04)
  // =====================================================================

  describe('US-17-AC01', () => {
    it('US-17-TC01: Member có link xem danh sách gói → 200, memberLinked=true, chỉ gói của mình, có asOf', async () => {
      const me = await linkedMember();
      const other = await linkedMember();

      const response = await get(me, '/api/me/memberships').expect(200);

      expect(response.body.memberLinked).toBe(true);
      expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([me.membershipId.toHexString()]);
      expect(response.body).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
      expect(Number.isNaN(Date.parse(response.body.asOf))).toBe(false);
      expect(JSON.stringify(response.body)).not.toContain(other.membershipId.toHexString());
      expect(JSON.stringify(response.body)).not.toContain(other.memberId.toHexString());
    });

    it('US-17-TC01: Member có link xem chi tiết gói của mình → 200 đúng gói, có id sale nguồn', async () => {
      const me = await linkedMember();

      const response = await get(me, `/api/me/memberships/${me.membershipId.toHexString()}`).expect(200);

      expect(response.body.id).toBe(me.membershipId.toHexString());
      expect(JSON.stringify(response.body)).toContain(me.saleId.toHexString());
    });

    it('US-17-TC01: Member có link xem danh sách và chi tiết sale của mình → 200 chỉ sale của mình', async () => {
      const me = await linkedMember();
      const other = await linkedMember();

      const list = await get(me, '/api/me/service-sales').expect(200);
      expect(list.body.memberLinked).toBe(true);
      expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([me.saleId.toHexString()]);
      expect(list.body).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
      expect(JSON.stringify(list.body)).not.toContain(other.saleId.toHexString());

      const detail = await get(me, `/api/me/service-sales/${me.saleId.toHexString()}`).expect(200);
      expect(detail.body.id).toBe(me.saleId.toHexString());
    });

    it('US-17-TC01: Member có link xem giao dịch của mình → 200 code/status/amountDue dạng chuỗi VND', async () => {
      const me = await linkedMember(1500000);

      const response = await get(me, `/api/me/transactions/${me.transactionId.toHexString()}`).expect(200);

      expect(response.body).toMatchObject({ id: me.transactionId.toHexString(), status: 'SETTLED', amountDue: '1500000' });
      expect(typeof response.body.code).toBe('string');
    });

    it('US-17-TC01: Member có link xem chứng từ của mình → 200 đúng chứng từ', async () => {
      const me = await linkedMember();

      const response = await get(me, `/api/me/invoices/${me.invoiceId.toHexString()}`).expect(200);

      expect(response.body.id).toBe(me.invoiceId.toHexString());
    });

    it('US-17-TC02: đổi ID sang gói/sale/giao dịch/chứng từ của người khác → 404 giống hệt ID không tồn tại', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const missing = new ObjectId().toHexString();
      const cases: Array<[string, ObjectId]> = [
        ['/api/me/memberships', other.membershipId],
        ['/api/me/service-sales', other.saleId],
        ['/api/me/transactions', other.transactionId],
        ['/api/me/invoices', other.invoiceId],
      ];

      // Đối chứng: tài nguyên của chính mình phải 200, để chắc 404 bên dưới không phải do route chưa tồn tại.
      for (const path of allPaths(me)) expect((await get(me, path)).status).toBe(200);

      for (const [base, foreignId] of cases) {
        const foreign = await get(me, `${base}/${foreignId.toHexString()}`);
        const notFound = await get(me, `${base}/${missing}`);
        expect(foreign.status).toBe(404);
        expect(notFound.status).toBe(404);
        expectErrorShape(foreign.body);
        // Cùng mã lỗi và thông điệp: người gọi không phân biệt được "của người khác" với "không tồn tại".
        expect(foreign.body.error.code).toBe(notFound.body.error.code);
        expect(foreign.body.error.message).toBe(notFound.body.error.message);
        expect(JSON.stringify(foreign.body)).not.toContain(other.memberId.toHexString());
      }
    });

    it('US-17-TC02: chứng từ và giao dịch phải cùng chủ với sale (chuỗi sale→transaction→invoice không lọt sang người khác)', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      // Chứng từ của người khác nhưng giao dịch gốc của mình đã có chứng từ riêng: vẫn chỉ thấy đúng chứng từ của mình.
      const mine = await get(me, `/api/me/invoices/${me.invoiceId.toHexString()}`).expect(200);
      expect(JSON.stringify(mine.body)).not.toContain(other.transactionId.toHexString());

      const foreignInvoice = await get(me, `/api/me/invoices/${other.invoiceId.toHexString()}`);
      expect(foreignInvoice.status).toBe(404);
      const foreignTransaction = await get(me, `/api/me/transactions/${other.transactionId.toHexString()}`);
      expect(foreignTransaction.status).toBe(404);
    });

    it('US-17-TC02: gửi memberId/accountId trên query để chọn chủ thể khác → 400, không trả dữ liệu người khác', async () => {
      const me = await linkedMember();
      const other = await linkedMember();

      const queries: Array<Record<string, string>> = [{ memberId: other.memberId.toHexString() }, { accountId: other.accountId.toHexString() }];
      for (const query of queries) {
        for (const path of ['/api/me/memberships', '/api/me/service-sales']) {
          const response = await get(me, path, query);
          expect(response.status).toBe(400);
          expectErrorShape(response.body);
          expect(JSON.stringify(response.body)).not.toContain(other.membershipId.toHexString());
          expect(JSON.stringify(response.body)).not.toContain(other.saleId.toHexString());
        }
      }
    });

    it('US-17-TC03: account MEMBER chưa link dù phone khớp hội viên ngoại tuyến → danh sách 200 memberLinked=false, items rỗng', async () => {
      const account = await login('MEMBER');
      // Hội viên ngoại tuyến cùng số điện thoại, chưa có account_id.
      const offlineMemberId = await insertMember(null, account.phone);
      const offline = await insertPurchase(offlineMemberId);

      for (const path of ['/api/me/memberships', '/api/me/service-sales']) {
        const response = await get(account, path).expect(200);
        expect(response.body).toMatchObject({ memberLinked: false, items: [], total: 0, totalPages: 0 });
        const text = JSON.stringify(response.body);
        expect(text).not.toContain(offlineMemberId.toHexString());
        expect(text).not.toContain(offline.saleId.toHexString());
        expect(text).not.toContain(offline.membershipId.toHexString());
      }
    });

    it('US-17-TC03: chưa link → chi tiết gói/sale/giao dịch/chứng từ của hội viên ngoại tuyến trùng phone đều 404', async () => {
      const account = await login('MEMBER');
      const offlineMemberId = await insertMember(null, account.phone);
      const offline = await insertPurchase(offlineMemberId);
      // Đối chứng: một Member có link xem chi tiết của mình được 200, để chắc 404 bên dưới không phải do route chưa tồn tại.
      const linked = await linkedMember();
      for (const path of allPaths(linked)) expect((await get(linked, path)).status).toBe(200);

      for (const path of allPaths(offline).filter(path => /\/[0-9a-f]{24}$/.test(path))) {
        const response = await get(account, path);
        expect(response.status).toBe(404);
        expectErrorShape(response.body);
      }
    });

    it('US-17-TC03: GET không tự nối hồ sơ theo phone và không ghi gì vào DB', async () => {
      const account = await login('MEMBER');
      const offlineMemberId = await insertMember(null, account.phone);
      const offline = await insertPurchase(offlineMemberId);
      const before = await snapshot();

      for (const path of allPaths(offline)) await get(account, path);
      // Đối chứng: API đã thực sự trả lời trạng thái "chưa link", không phải route chưa tồn tại.
      expect((await get(account, '/api/me/memberships').expect(200)).body.memberLinked).toBe(false);

      const member = await db().collection('members').findOne({ _id: offlineMemberId });
      expect(member?.account_id).toBeUndefined();
      expect(await db().collection('members').countDocuments({ account_id: account.accountId })).toBe(0);
      expect(await snapshot()).toEqual(before);
    });

    it.each(['TRAINER', 'STAFF', 'ADMIN'] as const)('US-17-TC04: role %s gọi API cá nhân → 403, không lộ dữ liệu', async roleCode => {
      const owner = await linkedMember();
      const user = await login(roleCode);

      for (const path of allPaths(owner)) {
        const response = await get(user, path);
        expect(response.status).toBe(403);
        expectErrorShape(response.body);
        expect(JSON.stringify(response.body)).not.toContain(owner.memberId.toHexString());
      }
    });

    it('US-17-TC04: không gửi token → 401 ở mọi endpoint', async () => {
      const owner = await linkedMember();

      for (const path of allPaths(owner)) {
        const response = await get(undefined, path);
        expect(response.status).toBe(401);
        expectErrorShape(response.body);
      }
    });

    it('US-17-TC04: account Member bị khóa (LOCKED) dùng access token cũ → 401', async () => {
      const me = await linkedMember();
      await db().collection('accounts').updateOne({ _id: me.accountId }, { $set: { status: 'LOCKED' } });

      for (const path of allPaths(me)) {
        const response = await get(me, path);
        expect(response.status).toBe(401);
        expectErrorShape(response.body);
      }
    });

    it('US-17-TC04: phiên đã bị thu hồi (revoked_at) → 401', async () => {
      const me = await linkedMember();
      await db().collection('auth_sessions').updateMany({ account_id: me.accountId }, { $set: { revoked_at: new Date() } });

      for (const path of allPaths(me)) {
        const response = await get(me, path);
        expect(response.status).toBe(401);
        expectErrorShape(response.body);
      }
    });

    it('US-17-TC04: auth_version của account đã tăng (đổi quyền/danh tính) → token cũ bị 401', async () => {
      const me = await linkedMember();
      await db().collection('accounts').updateOne({ _id: me.accountId }, { $inc: { auth_version: 1 } });

      for (const path of allPaths(me)) {
        const response = await get(me, path);
        expect(response.status).toBe(401);
        expectErrorShape(response.body);
      }
    });
  });
});
