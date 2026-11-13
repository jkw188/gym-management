// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-09 bước 1.
// Kiểm tra schema/index members và API tạo hồ sơ hội viên tại quầy POST /api/members: quyền, dữ liệu, mã, trùng phone, key (TC01–TC07).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { ACCOUNT_ADMINISTRATION } from '../src/modules/users/schemas/security-state.schema';
// Hợp đồng test đặt ra cho Builder (US-09 bước 1, theo mục 2–3 của spec):
//   MembersModule sở hữu collection 'members' (field snake_case như bảng "Collection và field").
//   POST /api/members: role STAFF/ADMIN; header Idempotency-Key (UUID v4, operation MEMBER_CREATE theo EN-02);
//     body {fullName, phone, birthDate?, address?} → 201 MemberDto {id, memberCode, fullName, phone, birthDate?, address?,
//     accountId?, version, createdAt, updatedAt}. memberCode = 'HV-' + id (24 hex), phone đã chuẩn hóa EN01-D01 (+84…).
//   Lỗi EN01-D03 {error:{code,message,details?},requestId}: 400 VALIDATION_ERROR (details[].field), 401, 403,
//     409 MEMBER_PHONE_EXISTS, 409 IDEMPOTENCY_CONFLICT.
//   Tra cứu sau mất response: GET /api/operations/MEMBER_CREATE/:key → 200 {status:'COMMITTED', responseStatus, responseBody}.
//   Phần link (POST /api/members/:id/link, link-candidates) thuộc bước 2–3, chưa test ở đây.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us09_create';
const password = 'MậtKhẩuUS-09-123';
const base = '/api/members';

type Auth = { accessToken: string };
type IndexInfo = { key: Record<string, number>; unique?: boolean; partialFilterExpression?: Record<string, unknown> };

describe('US-09 bước 1: tạo hồ sơ hội viên tại quầy', () => {
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
      SMTP_USER: 'us09-test', SMTP_PASS: 'us09-test', SMTP_FROM: 'no-reply@gym.test',
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
    // Khóa quản trị US-07 (lệnh ensure-indexes tạo sẵn trong môi trường thật): từ fix/us09, tạo hồ sơ cũng lấy khóa này.
    await connection.db!.collection<{ _id: string; revision: Long }>('security_state').insertOne({ _id: ACCOUNT_ADMINISTRATION, revision: Long.fromNumber(0) });
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
  const count = (name: string, filter: Record<string, unknown> = {}) => db().collection(name).countDocuments(filter);

  // ---------- Chuẩn bị: account thật theo role, đăng nhập thật qua API US-02 ----------
  let phoneSeq = 0;
  async function login(roleCode: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN') {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `09109000${String(phoneSeq).padStart(2, '0')}`;
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName: `US09 ${roleCode} ${phoneSeq}`, passwordHash });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { accountId: account.id as ObjectId, accessToken: response.body.accessToken as string };
  }

  function create(user: Auth | undefined, body: Record<string, unknown>, key: string | null = randomUUID()) {
    let call = http().post(base).set('Origin', origin);
    if (user) call = call.set('Authorization', `Bearer ${user.accessToken}`);
    if (key !== null) call = call.set('Idempotency-Key', key);
    return call.send(body);
  }

  const validInput = (overrides: Record<string, unknown> = {}) => ({
    fullName: 'Nguyễn Văn Hội Viên', phone: '0901234567', birthDate: '1995-05-20', address: '12 Lê Lợi, Quận 1', ...overrides,
  });

  // Ngày Việt Nam (YYYY-MM-DD) cách hôm nay `days` ngày.
  function vnDay(days: number): string {
    return new Date(Date.now() + 7 * 60 * 60 * 1000 + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function expectErrorShape(body: Record<string, any>, code?: string) {
    expect(typeof body.error?.code).toBe('string');
    expect(typeof body.error?.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
    if (code) expect(body.error.code).toBe(code);
  }

  // Các collection mà việc tạo hồ sơ KHÔNG được ghi vào (không tạo account, gói, giao dịch, buổi PT).
  async function sideEffectCounts() {
    return {
      accounts: await count('accounts'),
      memberships: await count('memberships'),
      serviceSales: await count('service_sales'),
      transactions: await count('transactions'),
      ptBookings: await count('pt_bookings'),
    };
  }

  async function membersIndexes(): Promise<IndexInfo[]> {
    return (await db().collection('members').indexes()) as IndexInfo[];
  }
  const sameKey = (a: Record<string, number>, b: Record<string, number>) => JSON.stringify(a) === JSON.stringify(b);

  // =====================================================================
  // AC01 – Tạo hồ sơ đúng quyền, mã và dữ liệu (TC01–TC04)
  // =====================================================================

  describe('US-09-AC01', () => {
    it.each(['STAFF', 'ADMIN'] as const)('US-09-TC01: %s tạo hồ sơ đủ dữ liệu → 201 MemberDto, memberCode HV-<id>, version 0, chưa có accountId', async roleCode => {
      const staff = await login(roleCode);

      const response = await create(staff, validInput()).expect(201);

      const body = response.body;
      expect(body.id).toMatch(/^[0-9a-f]{24}$/);
      expect(body.memberCode).toBe(`HV-${body.id}`);
      expect(body.memberCode).toHaveLength(27);
      expect(body).toMatchObject({
        fullName: 'Nguyễn Văn Hội Viên', phone: '+84901234567', birthDate: '1995-05-20', address: '12 Lê Lợi, Quận 1', version: 0,
      });
      expect(body.accountId ?? undefined).toBeUndefined();
      expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(body.updatedAt))).toBe(false);
    });

    it('US-09-TC01: dữ liệu lưu trong DB đúng: id = _id, mã unique, không có field account_id, người tạo lấy từ phiên', async () => {
      const staff = await login('STAFF');

      const response = await create(staff, validInput()).expect(201);

      const doc = await db().collection('members').findOne({ _id: new ObjectId(response.body.id) });
      expect(doc).not.toBeNull();
      expect(doc!.id.toHexString()).toBe(response.body.id);
      expect(doc!.member_code).toBe(`HV-${response.body.id}`);
      expect(doc!.phone).toBe('+84901234567');
      expect(doc!.version).toBe(0);
      expect('account_id' in doc!).toBe(false);
      expect(doc!.created_by.toHexString()).toBe(staff.accountId.toHexString());
      expect(doc!.created_at).toBeInstanceOf(Date);
      expect(doc!.updated_at).toBeInstanceOf(Date);
      // service_revision mặc định 0 (khóa bán gói/link dùng sau này).
      expect(Number(doc!.service_revision)).toBe(0);
    });

    it('US-09-TC01: hai hồ sơ có memberCode khác nhau', async () => {
      const staff = await login('STAFF');

      const first = await create(staff, validInput({ phone: '0901111111' })).expect(201);
      const second = await create(staff, validInput({ phone: '0902222222' })).expect(201);

      expect(first.body.memberCode).not.toBe(second.body.memberCode);
    });

    it('US-09-TC01: tạo hồ sơ không tự sinh account, gói, giao dịch hay buổi PT', async () => {
      const staff = await login('STAFF');
      const before = await sideEffectCounts();

      await create(staff, validInput()).expect(201);

      expect(await sideEffectCounts()).toEqual(before);
    });

    it('US-09-TC01: chỉ gửi trường bắt buộc (không birthDate/address) → 201', async () => {
      const staff = await login('STAFF');

      const response = await create(staff, { fullName: 'Trần Thị B', phone: '0903333333' }).expect(201);

      expect(response.body.birthDate ?? undefined).toBeUndefined();
      expect(response.body.address ?? undefined).toBeUndefined();
    });

    it.each(['MEMBER', 'TRAINER'] as const)('US-09-TC02: role %s tạo hồ sơ → 403, không ghi', async roleCode => {
      const user = await login(roleCode);

      const response = await create(user, validInput());

      expect(response.status).toBe(403);
      expectErrorShape(response.body);
      expect(await count('members')).toBe(0);
    });

    it('US-09-TC02: không có token → 401, không ghi', async () => {
      const response = await create(undefined, validInput());

      expect(response.status).toBe(401);
      expectErrorShape(response.body);
      expect(await count('members')).toBe(0);
    });

    it('US-09-TC02: Staff có phiên đã bị thu hồi (revoked_at) → 401, không ghi', async () => {
      const staff = await login('STAFF');
      await db().collection('auth_sessions').updateMany({ account_id: staff.accountId }, { $set: { revoked_at: new Date() } });

      const response = await create(staff, validInput());

      expect(response.status).toBe(401);
      expectErrorShape(response.body);
      expect(await count('members')).toBe(0);
    });

    it('US-09-TC02: Staff bị khóa (LOCKED) dùng token cũ → 401, không ghi', async () => {
      const staff = await login('STAFF');
      await db().collection('accounts').updateOne({ _id: staff.accountId }, { $set: { status: 'LOCKED' } });

      const response = await create(staff, validInput());

      expect(response.status).toBe(401);
      expectErrorShape(response.body);
      expect(await count('members')).toBe(0);
    });

    const invalidCases: Array<[string, Record<string, unknown>, string]> = [
      ['thiếu fullName', { fullName: undefined }, 'fullName'],
      ['fullName 1 ký tự', { fullName: 'A' }, 'fullName'],
      ['fullName 121 ký tự', { fullName: 'A'.repeat(121) }, 'fullName'],
      ['thiếu phone', { phone: undefined }, 'phone'],
      ['phone không hợp lệ', { phone: 'abc-xyz' }, 'phone'],
      ['birthDate ngày không tồn tại', { birthDate: '2001-02-30' }, 'birthDate'],
      ['birthDate sai định dạng', { birthDate: '20/05/1995' }, 'birthDate'],
      ['birthDate ở tương lai', { birthDate: vnDay(1) }, 'birthDate'],
      ['address 256 ký tự', { address: 'x'.repeat(256) }, 'address'],
      ['field gói thừa planId', { planId: new ObjectId().toHexString() }, 'planId'],
      ['field gói thừa sessionsQuota', { sessionsQuota: 10 }, 'sessionsQuota'],
      ['client tự gửi memberCode', { memberCode: 'HV-TU-DAT' }, 'memberCode'],
      ['client tự gửi id', { id: new ObjectId().toHexString() }, 'id'],
      ['client tự gửi version', { version: 5 }, 'version'],
      ['client tự gửi accountId', { accountId: new ObjectId().toHexString() }, 'accountId'],
    ];

    it.each(invalidCases)('US-09-TC03: %s → 400 VALIDATION_ERROR đúng field, không ghi', async (_name, overrides, field) => {
      const staff = await login('STAFF');

      const response = await create(staff, validInput(overrides));

      expect(response.status).toBe(400);
      expectErrorShape(response.body, 'VALIDATION_ERROR');
      expect(JSON.stringify(response.body.error.details ?? [])).toContain(field);
      expect(await count('members')).toBe(0);
    });

    it('US-09-TC03: biên hợp lệ fullName 2 và 120 ký tự, address 255 ký tự, birthDate hôm nay → 201', async () => {
      const staff = await login('STAFF');

      await create(staff, validInput({ fullName: 'AB', phone: '0904444441', address: 'x'.repeat(255), birthDate: vnDay(0) })).expect(201);
      await create(staff, validInput({ fullName: 'A'.repeat(120), phone: '0904444442' })).expect(201);

      expect(await count('members')).toBe(2);
    });

    it('US-09-TC04: tạo hai hồ sơ đều chưa có account → cả hai 201, DB không lưu account_id null', async () => {
      const staff = await login('STAFF');

      await create(staff, validInput({ phone: '0905555551' })).expect(201);
      await create(staff, validInput({ phone: '0905555552' })).expect(201);

      expect(await count('members')).toBe(2);
      expect(await count('members', { account_id: null })).toBe(2); // khớp cả khi thiếu field
      expect(await count('members', { account_id: { $exists: true } })).toBe(0);
    });

    it('US-09-TC04: account_id có partial unique index chỉ áp dụng cho ObjectId', async () => {
      // Đối chứng: API phải tạo được hồ sơ, để chắc collection do MembersModule quản lý.
      const staff = await login('STAFF');
      await create(staff, validInput()).expect(201);

      const index = (await membersIndexes()).find(item => sameKey(item.key, { account_id: 1 }));
      expect(index?.unique).toBe(true);
      expect(index?.partialFilterExpression).toEqual({ account_id: { $type: 'objectId' } });
    });

    it('US-09-TC04: members có index unique phone, member_code và index created_at DESC, _id DESC', async () => {
      const staff = await login('STAFF');
      await create(staff, validInput()).expect(201);

      const indexes = await membersIndexes();
      expect(indexes.find(item => sameKey(item.key, { phone: 1 }))?.unique).toBe(true);
      expect(indexes.find(item => sameKey(item.key, { member_code: 1 }))?.unique).toBe(true);
      expect(indexes.some(item => sameKey(item.key, { created_at: -1, _id: -1 }))).toBe(true);
    });
  });

  // =====================================================================
  // AC02 – Unique và key bảo vệ retry/đồng thời (TC05–TC07)
  // =====================================================================

  describe('US-09-AC02', () => {
    it('US-09-TC05: phone 0901234567 rồi +84 901 234 567 với hai key khác nhau → một 201, một 409 MEMBER_PHONE_EXISTS', async () => {
      const staff = await login('STAFF');

      await create(staff, validInput({ phone: '0901234567' })).expect(201);
      const duplicate = await create(staff, validInput({ fullName: 'Người khác', phone: '+84 901 234 567' }));

      expect(duplicate.status).toBe(409);
      expectErrorShape(duplicate.body, 'MEMBER_PHONE_EXISTS');
      expect(await count('members')).toBe(1);
    });

    it('US-09-TC05: hai request đồng thời cùng phone tương đương, khác key → đúng một 201, một 409', async () => {
      const staff = await login('STAFF');

      const responses = await Promise.all([
        create(staff, validInput({ phone: '0907777777' })),
        create(staff, validInput({ fullName: 'Người khác', phone: '+84907777777' })),
      ]);

      expect(responses.map(item => item.status).sort()).toEqual([201, 409]);
      const conflict = responses.find(item => item.status === 409)!;
      expectErrorShape(conflict.body, 'MEMBER_PHONE_EXISTS');
      expect(await count('members')).toBe(1);
    });

    it('US-09-TC06: gửi lại cùng key và cùng payload → cùng kết quả gốc, chỉ một hồ sơ', async () => {
      const staff = await login('STAFF');
      const key = randomUUID();

      const first = await create(staff, validInput(), key).expect(201);
      const retry = await create(staff, validInput(), key);

      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(first.body);
      expect(await count('members')).toBe(1);
    });

    it('US-09-TC06: mất response → tra cứu GET /api/operations/MEMBER_CREATE/:key trả kết quả đã commit', async () => {
      const staff = await login('STAFF');
      const key = randomUUID();
      const original = await create(staff, validInput(), key).expect(201);

      const lookup = await http().get(`/api/operations/MEMBER_CREATE/${key}`)
        .set('Origin', origin).set('Authorization', `Bearer ${staff.accessToken}`).expect(200);

      expect(lookup.body).toMatchObject({ status: 'COMMITTED', responseStatus: 201 });
      expect(lookup.body.responseBody.id).toBe(original.body.id);
      expect(await count('members')).toBe(1);
    });

    it('US-09-TC06: hai request đồng thời cùng key và cùng payload → cùng một hồ sơ, không tạo trùng', async () => {
      const staff = await login('STAFF');
      const key = randomUUID();

      const responses = await Promise.all([create(staff, validInput(), key), create(staff, validInput(), key)]);

      const succeeded = responses.filter(item => item.status === 201);
      expect(succeeded.length).toBeGreaterThanOrEqual(1);
      for (const item of succeeded) expect(item.body.id).toBe(succeeded[0].body.id);
      expect(await count('members')).toBe(1);
    });

    it('US-09-TC07: cùng key nhưng đổi fullName → 409 IDEMPOTENCY_CONFLICT, không ghi thêm', async () => {
      const staff = await login('STAFF');
      const key = randomUUID();
      const first = await create(staff, validInput(), key).expect(201);

      const changed = await create(staff, validInput({ fullName: 'Tên Đã Đổi' }), key);

      expect(changed.status).toBe(409);
      expectErrorShape(changed.body, 'IDEMPOTENCY_CONFLICT');
      expect(await count('members')).toBe(1);
      const doc = await db().collection('members').findOne({ _id: new ObjectId(first.body.id) });
      expect(doc!.full_name).toBe('Nguyễn Văn Hội Viên');
    });

    it('US-09-TC07: cùng key nhưng đổi phone → 409 IDEMPOTENCY_CONFLICT (không phải tạo hồ sơ mới)', async () => {
      const staff = await login('STAFF');
      const key = randomUUID();
      await create(staff, validInput(), key).expect(201);

      const changed = await create(staff, validInput({ phone: '0908888888' }), key);

      expect(changed.status).toBe(409);
      expectErrorShape(changed.body, 'IDEMPOTENCY_CONFLICT');
      expect(await count('members')).toBe(1);
      expect(await count('members', { phone: '+84908888888' })).toBe(0);
    });
  });
});
