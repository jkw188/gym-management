// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-18 bước 1.
// Member tự xem trước/tạo yêu cầu mua gói qua /api/me/service-registrations, dùng chung REGISTER_V1 của US-14 (TC01–TC04).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
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
import { Plan } from '../src/modules/plans/schemas/plan.schema';
import { RoleCode } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

// Hợp đồng test đặt ra cho Builder (US-18 bước 1, theo mục 1 và 2 của spec):
//   POST /api/me/service-registrations/preview  MEMBER; {planId,planVersion,startDate,preferredPaymentMethod}
//        -> 200 quote giống hệt POST /api/service-sales/preview của US-14 cho cùng member; không tạo gì.
//   POST /api/me/service-registrations          MEMBER; Idempotency-Key; cùng input -> 201 SaleResult của US-14.
//   Member lấy từ members.account_id = principal (resolver US-17); chưa liên kết -> 409 MEMBER_PROFILE_REQUIRED.
//   Body không nhận memberId/accountId/createdBy/role/channel (400). Sai role -> 403, không token -> 401.
//   Lỗi nghiệp vụ dùng lại REGISTER_V1 của US-14: PLAN_CHANGED, PLAN_NOT_AVAILABLE, CURRENT_SERVICE_EXISTS,
//   PENDING_SALE_EXISTS, ngày trước hôm nay 400. channel SELF_SERVICE / preferred_payment_method thuộc bước 2.

const origin = 'http://localhost:5173';
const password = 'US18 test password 123';

describe('US-18 bước 1: Member tự đăng ký gói qua REGISTER_V1 dùng chung', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };
  let hash: string;
  let tokens: Record<RoleCode, string>;
  let accountIds: Record<RoleCode, Types.ObjectId>;
  let unlinkedToken: string;
  let adminId: Types.ObjectId;
  let staffId: Types.ObjectId;
  let memberId: string; // hồ sơ hội viên đã liên kết với account MEMBER
  let otherMemberId: string; // hồ sơ hội viên của người khác
  let plan: Plan;
  // Đồng hồ server cố định: hôm nay theo giờ Việt Nam là 2026-11-01.
  let now = new Date('2026-11-01T03:00:00Z');
  const clock = { now: () => now, today: () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now) };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, {
      NODE_ENV: 'test', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(),
      MONGODB_DB: 'gym_management_test_us18', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      // Ứng dụng bắt buộc có cấu hình SMTP/pepper khi khởi động (US-05); test này không gửi thư.
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'), SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525',
      SMTP_SECURE: 'false', SMTP_USER: 'us18', SMTP_PASS: 'us18', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    configureHttp(app);
    connection = app.get<Connection>(getConnectionToken());
    await ensureFinancialIntegrity(connection);
    await app.init();
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    hash = await app.get(PasswordService).hash(password);
  }, 600000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  beforeEach(async () => {
    now = new Date('2026-11-01T03:00:00Z');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Bộ giới hạn đăng nhập lưu trong bộ nhớ: mỗi test dùng bộ mới để không bị 429.
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await connection.db!.collections()) await collection.deleteMany({});

    // Account thật theo role, đăng nhập thật qua API US-02.
    const users = app.get(UsersRepository);
    tokens = {} as Record<RoleCode, string>;
    accountIds = {} as Record<RoleCode, Types.ObjectId>;
    for (const [index, code] of (['ADMIN', 'STAFF', 'MEMBER', 'TRAINER'] as const).entries()) {
      const role = await users.ensureRole(code, code);
      const account = await users.createAccount({ roleId: role.id.toHexString(), fullName: `US18 ${code}`,
        phone: `+8491234568${index}`, passwordHash: hash });
      accountIds[code] = account._id;
      if (code === 'ADMIN') adminId = account._id;
      if (code === 'STAFF') staffId = account._id;
      tokens[code] = await login(account.phone);
    }
    // Account MEMBER thứ hai chưa liên kết hồ sơ hội viên nào.
    const memberRole = await users.ensureRole('MEMBER', 'MEMBER');
    const unlinked = await users.createAccount({ roleId: memberRole.id.toHexString(), fullName: 'US18 MEMBER chưa liên kết',
      phone: '+84912345689', passwordHash: hash });
    unlinkedToken = await login(unlinked.phone);

    // Hồ sơ hội viên tạo đúng như quầy (US-09), rồi gắn account_id cho hồ sơ của account MEMBER.
    const members = app.get(MembersRepository);
    const mine = await app.get(TransactionRunner).run(session => members.insert({ fullName: 'Hội viên US18', phone: '+84908888881' }, staffId, session));
    const other = await app.get(TransactionRunner).run(session => members.insert({ fullName: 'Hội viên khác US18', phone: '+84908888882' }, staffId, session));
    memberId = mine._id.toHexString();
    otherMemberId = other._id.toHexString();
    await connection.collection('members').updateOne({ _id: mine._id }, { $set: { account_id: accountIds.MEMBER } });

    plan = (await plans().create({ code: 'GYM30', name: 'Gym 30 ngày', kind: 'GYM', duration_days: 30,
      session_quota: 0, price: toVndDecimal('300000'), benefits: 'Tập Gym trong giờ mở cửa', status: 'ACTIVE',
      created_by: adminId, updated_by: adminId })).toObject();
  });

  afterEach(() => jest.restoreAllMocks());

  async function login(phone: string) {
    const response = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }

  const plans = () => app.get<Model<Plan>>(getModelToken('Plan'));
  const count = (collection: string) => connection.collection(collection).countDocuments();
  // Body đúng hợp đồng của Member: không có memberId.
  const selfInput = (extra: Record<string, unknown> = {}) => ({ planId: plan._id.toHexString(), planVersion: 0,
    startDate: '2026-11-01', preferredPaymentMethod: 'CASH', ...extra });
  // Body của quầy (US-14) cho cùng hội viên, dùng để so sánh hai kênh cho kết quả như nhau.
  const counterInput = (extra: Record<string, unknown> = {}) => ({ memberId, planId: plan._id.toHexString(), planVersion: 0,
    startDate: '2026-11-01', ...extra });
  const self = (path: string, body: Record<string, unknown>, token: string = tokens.MEMBER, key: string = randomUUID()) =>
    request(app.getHttpServer()).post(`/api/me/service-registrations${path}`).set('Origin', origin)
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
  const counter = (path: string, body: Record<string, unknown>, key: string = randomUUID()) =>
    request(app.getHttpServer()).post(`/api/service-sales${path}`).set('Origin', origin)
      .set('Authorization', `Bearer ${tokens.STAFF}`).set('Idempotency-Key', key).send(body);
  const meGet = (path: string) => request(app.getHttpServer()).get(`/api/me${path}`).set('Authorization', `Bearer ${tokens.MEMBER}`);

  // ---------------- TC01 ----------------
  it('US-18-TC01: preview của Member trả đúng quote như quầy (US-14) cho chính hồ sơ của mình và không tạo dữ liệu', async () => {
    const mine = await self('/preview', selfInput()).expect(200);
    expect(mine.body).toMatchObject({ planVersion: 0, amountDue: '300000', kind: 'GYM', requestedStartDate: '2026-11-01',
      expectedEndDate: '2026-11-30', canProceed: true });
    // Cùng công thức REGISTER_V1: quote của quầy cho đúng hồ sơ này phải giống hệt.
    const atCounter = await counter('/preview', counterInput()).expect(200);
    expect(mine.body).toEqual(atCounter.body);
    for (const collection of ['transactions', 'service_sales', 'memberships', 'operation_requests']) expect(await count(collection)).toBe(0);
  });

  it('US-18-TC01: tạo yêu cầu 201 gắn đúng hồ sơ lấy từ principal, created_by là account Member, PENDING chưa có gói', async () => {
    const sale = await self('', selfInput()).expect(201);
    expect(sale.body).toMatchObject({ transactionStatus: 'PENDING', amountDue: '300000', requestedStartDate: '2026-11-01' });
    expect(sale.body.saleId).toBeDefined();
    expect(sale.body.transactionId).toBeDefined();
    expect(sale.body.membershipId).toBeUndefined();

    const savedSale = await connection.collection('service_sales').findOne({ _id: new Types.ObjectId(sale.body.saleId) });
    expect(savedSale!.member_id.toHexString()).toBe(memberId);
    expect(savedSale!.operation).toBe('REGISTER');
    const transaction = await connection.collection('transactions').findOne({ _id: new Types.ObjectId(sale.body.transactionId) });
    expect(transaction!.member_id.toHexString()).toBe(memberId);
    expect(transaction!.created_by.toHexString()).toBe(accountIds.MEMBER.toHexString());
    expect(transaction!.status).toBe('PENDING');
    for (const collection of ['memberships', 'payments', 'invoices']) expect(await count(collection)).toBe(0);

    // Member đọc lại được kết quả qua API cá nhân của US-17.
    await meGet(`/service-sales/${sale.body.saleId}`).expect(200);
    expect((await meGet(`/transactions/${sale.body.transactionId}`).expect(200)).body).toMatchObject({ status: 'PENDING', amountDue: '300000' });
  });

  // ---------------- TC02 ----------------
  it('US-18-TC02: account MEMBER chưa liên kết hồ sơ bị 409 MEMBER_PROFILE_REQUIRED ở preview và tạo, không tạo sale', async () => {
    for (const path of ['/preview', '']) {
      const response = await self(path, selfInput(), unlinkedToken).expect(409);
      expect(response.body.error.code).toBe('MEMBER_PROFILE_REQUIRED');
    }
    expect(await count('transactions')).toBe(0);
    expect(await count('service_sales')).toBe(0);
  });

  it('US-18-TC02: chưa liên kết mà có hồ sơ trùng số điện thoại vẫn 409, không tự nối hồ sơ', async () => {
    // Hồ sơ ngoại tuyến có cùng số điện thoại với account chưa liên kết.
    const sameRow = await app.get(TransactionRunner).run(session => app.get(MembersRepository)
      .insert({ fullName: 'Trùng số điện thoại', phone: '+84912345689' }, staffId, session));
    const response = await self('', selfInput(), unlinkedToken).expect(409);
    expect(response.body.error.code).toBe('MEMBER_PROFILE_REQUIRED');
    const after = await connection.collection('members').findOne({ _id: sameRow._id });
    expect(after!.account_id).toBeUndefined();
    expect(await count('service_sales')).toBe(0);
  });

  it.each(['STAFF', 'ADMIN', 'TRAINER'] as const)('US-18-TC02: role %s gọi API cá nhân bị 403, không tạo sale', async role => {
    await self('/preview', selfInput(), tokens[role]).expect(403);
    await self('', selfInput(), tokens[role]).expect(403);
    expect(await count('service_sales')).toBe(0);
  });

  it('US-18-TC02: không có token bị 401', async () => {
    await request(app.getHttpServer()).post('/api/me/service-registrations/preview').set('Origin', origin).send(selfInput()).expect(401);
    await request(app.getHttpServer()).post('/api/me/service-registrations').set('Origin', origin)
      .set('Idempotency-Key', randomUUID()).send(selfInput()).expect(401);
    expect(await count('service_sales')).toBe(0);
  });

  it.each([
    ['memberId', () => ({ memberId: otherMemberId })],
    ['accountId', () => ({ accountId: new Types.ObjectId().toHexString() })],
    ['createdBy', () => ({ createdBy: new Types.ObjectId().toHexString() })],
    ['role', () => ({ role: 'STAFF' })],
    ['channel', () => ({ channel: 'COUNTER' })],
  ])('US-18-TC02: body có %s bị 400, không tạo sale cho ai', async (_field, extra) => {
    await self('/preview', selfInput(extra())).expect(400);
    await self('', selfInput(extra())).expect(400);
    expect(await count('service_sales')).toBe(0);
    expect(await count('transactions')).toBe(0);
  });

  // ---------------- TC03 ----------------
  it.each([
    ['planVersion cũ', () => selfInput({ planVersion: 1 }), () => counterInput({ planVersion: 1 })],
    ['ngày trước hôm nay', () => selfInput({ startDate: '2026-10-31' }), () => counterInput({ startDate: '2026-10-31' })],
  ])('US-18-TC03: %s bị từ chối giống hệt quầy (cùng status và mã lỗi)', async (_case, mine, atCounter) => {
    const fromSelf = await self('', mine());
    const fromCounter = await counter('', atCounter());
    expect(fromSelf.status).toBe(fromCounter.status);
    expect([400, 409]).toContain(fromSelf.status);
    expect(fromSelf.body.error.code).toBe(fromCounter.body.error.code);
    expect(await count('service_sales')).toBe(0);
  });

  it('US-18-TC03: planVersion cũ trả 409 PLAN_CHANGED', async () => {
    expect((await self('', selfInput({ planVersion: 1 })).expect(409)).body.error.code).toBe('PLAN_CHANGED');
  });

  it('US-18-TC03: ngày bắt đầu trước hôm nay (giờ Việt Nam) bị 400', async () => {
    await self('', selfInput({ startDate: '2026-10-31' })).expect(400);
    expect(await count('service_sales')).toBe(0);
  });

  it('US-18-TC03: gói ngừng bán trả 409 PLAN_NOT_AVAILABLE giống quầy', async () => {
    await plans().updateOne({ _id: plan._id }, { $set: { status: 'INACTIVE' } });
    expect((await self('', selfInput()).expect(409)).body.error.code).toBe('PLAN_NOT_AVAILABLE');
    expect((await counter('', counterInput()).expect(409)).body.error.code).toBe('PLAN_NOT_AVAILABLE');
    expect(await count('service_sales')).toBe(0);
  });

  it('US-18-TC03: đã có gói cùng loại hiện tại/tương lai thì 409 CURRENT_SERVICE_EXISTS, preview canProceed=false', async () => {
    // Quầy bán gói miễn phí cho hội viên -> SETTLED, có membership GYM từ 05/11.
    await plans().updateOne({ _id: plan._id }, { $set: { price: toVndDecimal('0') } });
    await counter('', counterInput({ startDate: '2026-11-05' })).expect(201);
    await plans().updateOne({ _id: plan._id }, { $set: { price: toVndDecimal('300000') } });

    expect((await self('/preview', selfInput()).expect(200)).body).toMatchObject({ canProceed: false, blockingCode: 'CURRENT_SERVICE_EXISTS' });
    expect((await self('', selfInput()).expect(409)).body.error.code).toBe('CURRENT_SERVICE_EXISTS');
    expect(await count('service_sales')).toBe(1);
  });

  it('US-18-TC03: đang có sale PENDING cùng loại (tạo tại quầy) thì Member bị 409 PENDING_SALE_EXISTS', async () => {
    await counter('', counterInput()).expect(201);
    expect((await self('', selfInput()).expect(409)).body.error.code).toBe('PENDING_SALE_EXISTS');
    expect(await count('service_sales')).toBe(1);
  });

  it('US-18-TC03: có gói GYM vẫn tự đăng ký được gói PT khác loại', async () => {
    await counter('', counterInput()).expect(201);
    const pt = await plans().create({ code: 'PT30', name: 'PT 30 ngày', kind: 'PT', duration_days: 30,
      session_quota: 10, price: toVndDecimal('1000000'), benefits: '10 buổi PT', status: 'ACTIVE',
      created_by: adminId, updated_by: adminId });
    const sale = await self('', selfInput({ planId: pt._id.toHexString() })).expect(201);
    expect(sale.body).toMatchObject({ transactionStatus: 'PENDING', amountDue: '1000000' });
    expect(await count('service_sales')).toBe(2);
  });

  it.each([{ price: '0' }, { amountDue: '0' }, { sessions: 999 }, { durationDays: 365 }])(
    'US-18-TC03: client tự gửi giá/quota %p bị 400, không bỏ qua kiểm tra', async extra => {
      await self('', selfInput(extra)).expect(400);
      expect(await count('service_sales')).toBe(0);
    });

  // ---------------- TC04 ----------------
  it('US-18-TC04: đổi giá và thời hạn gói sau khi tạo sale, giao dịch của Member vẫn giữ snapshot cũ', async () => {
    const sale = await self('', selfInput()).expect(201);
    await plans().updateOne({ _id: plan._id }, { $set: { price: toVndDecimal('500000'), duration_days: 60 }, $inc: { version: 1 } });

    const transaction = await meGet(`/transactions/${sale.body.transactionId}`).expect(200);
    expect(transaction.body.amountDue).toBe('300000');
    const ownSale = await meGet(`/service-sales/${sale.body.saleId}`).expect(200);
    expect(JSON.stringify(ownSale.body)).not.toContain('500000');

    const savedTransaction = await connection.collection('transactions').findOne({ _id: new Types.ObjectId(sale.body.transactionId) });
    expect(savedTransaction!.amount_due.toString()).toBe('300000');
    const savedSale = await connection.collection('service_sales').findOne({ _id: new Types.ObjectId(sale.body.saleId) });
    expect(savedSale!.duration_days_snapshot).toBe(30);
    expect(savedSale!.end_date).toBe('2026-11-30');
  });
});
