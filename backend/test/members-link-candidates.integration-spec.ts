// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-09 bước 2.
// Kiểm tra API tra cứu account để liên kết GET /api/members/link-candidates: đúng quyền, khớp đúng cả số phone, canLink (TC02, TC08, TC09).
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
// Hợp đồng test đặt ra cho Builder (US-09 bước 2, theo mục 3 của spec):
//   GET /api/members/link-candidates?phone=<số đầy đủ>: role STAFF/ADMIN. Server chuẩn hóa phone theo EN01-D01
//     (0901234567, +84 901 234 567 là cùng một số) rồi so KHỚP CHÍNH XÁC, không tìm theo tên hay một phần số.
//     200 {items:[{id, fullName, phone, canLink}]}: tối đa một account, chỉ account role MEMBER và status ACTIVE.
//     Không có thì items = []. canLink = false khi account đã được một hồ sơ members tham chiếu (account_id)
//     hoặc đã gắn hồ sơ trainers (US-09-F05). Không trả email, status, role, hash hay field nội bộ.
//   Lỗi EN01-D03: 400 VALIDATION_ERROR (thiếu/sai phone, query lạ), 401, 403.
//   Staff vẫn KHÔNG được xem danh sách account quản trị US-06 (GET /api/users → 403).
//   Tra cứu chỉ đọc: không ghi gì vào DB.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us09_lookup';
const password = 'MậtKhẩuUS-09-123';
const base = '/api/members/link-candidates';

type Auth = { accessToken: string };
type RoleCode = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';

describe('US-09 bước 2: tra cứu account để liên kết hồ sơ', () => {
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

  // ---------- Chuẩn bị ----------
  // Account thật (không đăng nhập), phone lưu ở dạng chuẩn hóa +84… như US-06.
  async function createAccount(roleCode: RoleCode, phone: string, fullName = `US09 ${roleCode} ${phone}`) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: account.id as ObjectId, phone, fullName };
  }

  // Nhân viên đăng nhập thật qua API US-02.
  let staffSeq = 0;
  async function login(roleCode: RoleCode) {
    staffSeq += 1;
    const phone = `+8491090${String(staffSeq).padStart(4, '0')}`;
    const account = await createAccount(roleCode, phone);
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { ...account, accessToken: response.body.accessToken as string };
  }

  function lookup(user: Auth | undefined, query: Record<string, string> = {}) {
    const call = http().get(base).query(query).set('Origin', origin);
    return user ? call.set('Authorization', `Bearer ${user.accessToken}`) : call;
  }

  // Hồ sơ hội viên tạo qua API bước 1; muốn "đã liên kết" thì gắn account_id thẳng vào DB (API link là bước 3).
  async function createMember(staff: Auth, phone: string, linkedAccountId?: ObjectId) {
    const response = await http().post('/api/members').set('Origin', origin)
      .set('Authorization', `Bearer ${staff.accessToken}`).set('Idempotency-Key', randomUUID())
      .send({ fullName: 'Hội viên tại quầy', phone }).expect(201);
    if (linkedAccountId) {
      await db().collection('members').updateOne({ _id: new ObjectId(response.body.id) }, { $set: { account_id: linkedAccountId } });
    }
    return response.body.id as string;
  }

  // Hồ sơ PT mẫu (US-23 chưa có): ghi thẳng collection trainers theo mục 4.2.8.
  async function insertTrainerProfile(accountId: ObjectId) {
    const id = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: id, id, account_id: accountId, specialty: 'Thể hình', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
  }

  function expectErrorShape(body: Record<string, any>, code?: string) {
    expect(typeof body.error?.code).toBe('string');
    expect(typeof body.error?.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
    if (code) expect(body.error.code).toBe(code);
  }

  async function snapshot() {
    const result: Record<string, unknown[]> = {};
    for (const name of ['accounts', 'members', 'trainers']) {
      result[name] = await db().collection(name).find({}).sort({ _id: 1 }).toArray();
    }
    return result;
  }

  // =====================================================================
  // TC02 – Quyền ở bước tra cứu của luồng liên kết
  // =====================================================================

  describe('US-09-TC02 (bước tra cứu)', () => {
    it.each(['STAFF', 'ADMIN'] as const)('US-09-TC02: %s tra cứu được → 200', async roleCode => {
      const staff = await login(roleCode);
      await createAccount('MEMBER', '+84901234567');

      const response = await lookup(staff, { phone: '0901234567' });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.items)).toBe(true);
    });

    it.each(['MEMBER', 'TRAINER'] as const)('US-09-TC02: role %s tra cứu → 403, không lộ account', async roleCode => {
      const user = await login(roleCode);
      const target = await createAccount('MEMBER', '+84901234567');

      const response = await lookup(user, { phone: '0901234567' });

      expect(response.status).toBe(403);
      expectErrorShape(response.body);
      expect(JSON.stringify(response.body)).not.toContain(target.accountId.toHexString());
    });

    it('US-09-TC02: không có token → 401', async () => {
      await createAccount('MEMBER', '+84901234567');

      const response = await lookup(undefined, { phone: '0901234567' });

      expect(response.status).toBe(401);
      expectErrorShape(response.body);
    });

    it('US-09-TC02: Staff có phiên đã bị thu hồi → 401', async () => {
      const staff = await login('STAFF');
      await createAccount('MEMBER', '+84901234567');
      await db().collection('auth_sessions').updateMany({ account_id: staff.accountId }, { $set: { revoked_at: new Date() } });

      const response = await lookup(staff, { phone: '0901234567' });

      expect(response.status).toBe(401);
      expectErrorShape(response.body);
    });

    it('US-09-TC02: Staff vẫn không xem được danh sách account quản trị US-06 (GET /api/users → 403)', async () => {
      const staff = await login('STAFF');
      // Đối chứng: Staff gọi được API tra cứu của bước này.
      expect((await lookup(staff, { phone: '0901234567' })).status).toBe(200);

      const response = await http().get('/api/users').set('Origin', origin).set('Authorization', `Bearer ${staff.accessToken}`);

      expect(response.status).toBe(403);
      expectErrorShape(response.body);
    });
  });

  // =====================================================================
  // TC08 – Account MEMBER ACTIVE, phone khớp: là ứng viên liên kết được
  // =====================================================================

  describe('US-09-TC08 (bước tra cứu)', () => {
    it('US-09-TC08: account MEMBER ACTIVE chưa gắn hồ sơ, phone khớp → một item {id, fullName, phone, canLink:true}', async () => {
      const staff = await login('STAFF');
      const target = await createAccount('MEMBER', '+84901234567', 'Lê Thị Khách');

      const response = await lookup(staff, { phone: '0901234567' }).expect(200);

      expect(response.body.items).toEqual([
        { id: target.accountId.toHexString(), fullName: 'Lê Thị Khách', phone: '+84901234567', canLink: true },
      ]);
    });

    it.each(['0901234567', '+84901234567', '+84 901 234 567', '84901234567'])(
      'US-09-TC08: phone nhập dạng "%s" được chuẩn hóa và tìm ra cùng account', async phone => {
        const staff = await login('STAFF');
        const target = await createAccount('MEMBER', '+84901234567');

        const response = await lookup(staff, { phone }).expect(200);

        expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([target.accountId.toHexString()]);
      },
    );

    it('US-09-TC08: không có account khớp → 200, items rỗng', async () => {
      const staff = await login('STAFF');
      await createAccount('MEMBER', '+84901234567');

      const response = await lookup(staff, { phone: '0909999999' }).expect(200);

      expect(response.body).toEqual({ items: [] });
    });

    it('US-09-TC08: chỉ khớp chính xác cả số, không tìm theo một phần số', async () => {
      const staff = await login('STAFF');
      await createAccount('MEMBER', '+84901234567');
      // Đối chứng: số đầy đủ tìm ra account.
      expect((await lookup(staff, { phone: '0901234567' }).expect(200)).body.items).toHaveLength(1);

      for (const partial of ['090123456', '01234567', '+849012345']) {
        const response = await lookup(staff, { phone: partial });
        // Số thiếu chữ số có thể bị coi là sai định dạng (400) hoặc không khớp (200 rỗng); không được trả account.
        if (response.status === 200) expect(response.body.items).toEqual([]);
        else expect(response.status).toBe(400);
      }
    });

    it('US-09-TC08: không tìm theo tên (query name hoặc phone là chữ) → 400, không trả account', async () => {
      const staff = await login('STAFF');
      const target = await createAccount('MEMBER', '+84901234567', 'Lê Thị Khách');

      const queries: Array<Record<string, string>> = [{ name: 'Lê Thị Khách' }, { phone: 'Lê Thị Khách' }, { phone: '0901234567', name: 'Lê' }];
      for (const query of queries) {
        const response = await lookup(staff, query);
        expect(response.status).toBe(400);
        expectErrorShape(response.body, 'VALIDATION_ERROR');
        expect(JSON.stringify(response.body)).not.toContain(target.accountId.toHexString());
      }
    });

    it('US-09-TC08: kết quả không chứa email, status, role, hash hay field nội bộ', async () => {
      const staff = await login('STAFF');
      await createAccount('MEMBER', '+84901234567');
      await db().collection('accounts').updateOne({ phone: '+84901234567' }, { $set: { email: 'khach@gym.test' } });

      const response = await lookup(staff, { phone: '0901234567' }).expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(Object.keys(response.body.items[0]).sort()).toEqual(['canLink', 'fullName', 'id', 'phone']);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain('khach@gym.test');
      expect(text).not.toMatch(/argon2|password|auth_?version|authVersion/i);
    });

    it('US-09-TC08: tra cứu chỉ đọc, không ghi gì vào DB và không tự liên kết hồ sơ trùng phone', async () => {
      const staff = await login('STAFF');
      await createAccount('MEMBER', '+84901234567');
      // Hồ sơ ngoại tuyến cùng số: tra cứu KHÔNG được tự nối (US-09-F03, F04).
      const memberId = await createMember(staff, '0901234567');
      const before = await snapshot();

      await lookup(staff, { phone: '0901234567' }).expect(200);

      expect(await snapshot()).toEqual(before);
      const member = await db().collection('members').findOne({ _id: new ObjectId(memberId) });
      expect('account_id' in member!).toBe(false);
    });
  });

  // =====================================================================
  // TC09 – Account không đủ điều kiện: không liên kết được
  // =====================================================================

  describe('US-09-TC09 (bước tra cứu)', () => {
    it.each(['STAFF', 'TRAINER', 'ADMIN'] as const)('US-09-TC09: account role %s trùng phone → items rỗng (chỉ trả account MEMBER)', async roleCode => {
      const staff = await login('STAFF');
      const target = await createAccount(roleCode, '+84901234567');
      // Đối chứng: account MEMBER ở số khác vẫn tra ra được, để chắc API đã hoạt động.
      await createAccount('MEMBER', '+84902222222');
      expect((await lookup(staff, { phone: '0902222222' }).expect(200)).body.items).toHaveLength(1);

      const response = await lookup(staff, { phone: '0901234567' }).expect(200);

      expect(response.body).toEqual({ items: [] });
      expect(JSON.stringify(response.body)).not.toContain(target.accountId.toHexString());
    });

    it('US-09-TC09: account MEMBER bị khóa (LOCKED) → items rỗng', async () => {
      const staff = await login('STAFF');
      const target = await createAccount('MEMBER', '+84901234567');
      await db().collection('accounts').updateOne({ _id: target.accountId }, { $set: { status: 'LOCKED' } });
      await createAccount('MEMBER', '+84902222222');
      expect((await lookup(staff, { phone: '0902222222' }).expect(200)).body.items).toHaveLength(1);

      const response = await lookup(staff, { phone: '0901234567' }).expect(200);

      expect(response.body).toEqual({ items: [] });
    });

    it('US-09-TC09: account MEMBER đã được một hồ sơ khác tham chiếu → canLink=false', async () => {
      const staff = await login('STAFF');
      const target = await createAccount('MEMBER', '+84901234567');
      await createMember(staff, '0903333333', target.accountId);

      const response = await lookup(staff, { phone: '0901234567' }).expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({ id: target.accountId.toHexString(), canLink: false });
    });

    it('US-09-TC09: account MEMBER đã gắn hồ sơ PT (trainers) → canLink=false', async () => {
      const staff = await login('STAFF');
      const target = await createAccount('MEMBER', '+84901234567');
      await insertTrainerProfile(target.accountId);

      const response = await lookup(staff, { phone: '0901234567' }).expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({ id: target.accountId.toHexString(), canLink: false });
    });

    it.each([
      ['thiếu phone', {}],
      ['phone rỗng', { phone: '' }],
      ['phone sai định dạng', { phone: 'abc-xyz' }],
    ] as Array<[string, Record<string, string>]>)('US-09-TC09: %s → 400 VALIDATION_ERROR đúng field phone', async (_name, query) => {
      const staff = await login('STAFF');

      const response = await lookup(staff, query);

      expect(response.status).toBe(400);
      expectErrorShape(response.body, 'VALIDATION_ERROR');
      expect(JSON.stringify(response.body.error.details ?? [])).toContain('phone');
    });
  });
});
