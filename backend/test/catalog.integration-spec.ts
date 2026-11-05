// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ): US-13 bước 1.
// Kiểm tra API public GET /api/catalog/plans và GET /api/catalog/plans/:id (TC01, TC02, TC04, TC05, TC07, TC08, TC09 phần backend).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Int32, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { RoleCode } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us13_catalog';
const password = 'MậtKhẩuUS-13-123';

// Đúng 9 field của PublicPlanDto theo US-13-F02.
const PUBLIC_FIELDS = ['benefits', 'code', 'durationDays', 'id', 'kind', 'name', 'price', 'sessionsQuota', 'version'];

type PlanInput = {
  code: string; name: string; kind?: 'GYM' | 'PT'; price?: string; status?: 'ACTIVE' | 'INACTIVE';
  durationDays?: number; sessionsQuota?: number; benefits?: string; version?: number; createdAt?: Date;
};

describe('US-13 bước 1: API public danh mục gói', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName } });
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
      SMTP_USER: 'us13-test', SMTP_PASS: 'us13-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http');
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Chỉ xóa dữ liệu, giữ index.
    for (const collection of await connection.db!.collections()) await collection.deleteMany({});
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  // Ghi thẳng một gói vào collection plans theo schema US-12 mục 2 (DB snake_case, price Decimal128).
  // Ghi trực tiếp để test không phụ thuộc API quản trị US-12 (chưa có).
  async function insertPlan(input: PlanInput): Promise<string> {
    const now = input.createdAt ?? new Date();
    const kind = input.kind ?? 'GYM';
    const adminId = new ObjectId();
    const result = await connection.db!.collection('plans').insertOne({
      code: input.code,
      name: input.name,
      kind,
      duration_days: input.durationDays ?? 30,
      session_quota: input.sessionsQuota ?? (kind === 'PT' ? 10 : 0),
      price: Decimal128.fromString(input.price ?? '500000'),
      benefits: input.benefits ?? 'Tập không giới hạn giờ hành chính',
      status: input.status ?? 'ACTIVE',
      version: new Int32(input.version ?? 0),
      guard_revision: Long.fromNumber(7),
      created_at: now, updated_at: now, created_by: adminId, updated_by: adminId,
    });
    return result.insertedId.toHexString();
  }

  const listPlans = (query: Record<string, string> = {}) =>
    request(app.getHttpServer()).get('/api/catalog/plans').query(query).set('Origin', origin);
  const getPlan = (id: string) => request(app.getHttpServer()).get(`/api/catalog/plans/${id}`).set('Origin', origin);
  const codesOf = (body: { items: Array<{ code: string }> }) => body.items.map(item => item.code);

  // Tạo tài khoản và đăng nhập thật để lấy access token (dùng cho ca Member).
  async function loginAs(code: RoleCode, phone: string): Promise<string> {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(code, code);
    const passwordHash = await app.get(PasswordService).hash(password);
    await users.createAccount({ roleId: role.id.toHexString(), phone, fullName: `US13 ${code}`, passwordHash });
    const login = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return login.body.accessToken as string;
  }

  // ---------- US-13-TC01: Guest/Member xem list/detail ACTIVE không cần login ----------
  it('US-13-TC01: Guest (không token) xem danh sách gói ACTIVE được 200', async () => {
    await insertPlan({ code: 'GYM1M', name: 'Gym 1 tháng' });

    const res = await listPlans().expect(200);

    expect(codesOf(res.body)).toEqual(['GYM1M']);
  });

  it('US-13-TC01: Guest (không token) xem chi tiết gói ACTIVE được 200', async () => {
    const id = await insertPlan({ code: 'GYM1M', name: 'Gym 1 tháng' });

    const res = await getPlan(id).expect(200);

    expect(res.body.id).toBe(id);
    expect(res.body.code).toBe('GYM1M');
  });

  it('US-13-TC01: Member đã đăng nhập cũng xem được danh sách và chi tiết', async () => {
    const id = await insertPlan({ code: 'GYM1M', name: 'Gym 1 tháng' });
    const token = await loginAs('MEMBER', '0913000001');

    const list = await listPlans().set('Authorization', `Bearer ${token}`).expect(200);
    const detail = await getPlan(id).set('Authorization', `Bearer ${token}`).expect(200);

    expect(codesOf(list.body)).toEqual(['GYM1M']);
    expect(detail.body.id).toBe(id);
  });

  // ---------- US-13-TC02: ID gói INACTIVE và ID không tồn tại cùng 404 ----------
  it('US-13-TC02: chi tiết gói INACTIVE trả 404 PLAN_NOT_FOUND', async () => {
    const id = await insertPlan({ code: 'OLD1M', name: 'Gói cũ', status: 'INACTIVE' });

    const res = await getPlan(id).expect(404);

    expect(res.body.error.code).toBe('PLAN_NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toContain('OLD1M');
  });

  it('US-13-TC02: ID hợp lệ nhưng không tồn tại trả 404 PLAN_NOT_FOUND giống hệt gói INACTIVE', async () => {
    const inactiveId = await insertPlan({ code: 'OLD1M', name: 'Gói cũ', status: 'INACTIVE' });

    const inactive = await getPlan(inactiveId).expect(404);
    const missing = await getPlan(new ObjectId().toHexString()).expect(404);

    expect(missing.body.error.code).toBe('PLAN_NOT_FOUND');
    // Cùng mã và cùng thông báo, để không đoán được ID nào là gói ngừng bán.
    expect(missing.body.error).toEqual(inactive.body.error);
  });

  it('US-13-TC02: ID không phải ObjectId trả 400 VALIDATION_ERROR', async () => {
    const res = await getPlan('khong-phai-id').expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('US-13-TC02: danh sách public không trả gói INACTIVE', async () => {
    await insertPlan({ code: 'GYM1M', name: 'Gym 1 tháng' });
    await insertPlan({ code: 'OLD1M', name: 'Gói cũ', status: 'INACTIVE' });

    const res = await listPlans().expect(200);

    expect(codesOf(res.body)).toEqual(['GYM1M']);
    expect(res.body.total).toBe(1);
  });

  // ---------- US-13-TC04: PublicPlanDto không có field nội bộ ----------
  it('US-13-TC04: chi tiết chỉ có đúng 9 field PublicPlanDto, giá là chuỗi VND chính xác', async () => {
    const id = await insertPlan({
      code: 'PT10', name: 'PT 10 buổi', kind: 'PT', price: '3500000', durationDays: 60, sessionsQuota: 10,
      benefits: '10 buổi với PT', version: 3,
    });

    const res = await getPlan(id).expect(200);

    expect(Object.keys(res.body).sort()).toEqual(PUBLIC_FIELDS);
    expect(res.body).toEqual({
      id, code: 'PT10', name: 'PT 10 buổi', kind: 'PT', durationDays: 60, sessionsQuota: 10,
      price: '3500000', benefits: '10 buổi với PT', version: 3,
    });
  });

  it('US-13-TC04: mỗi phần tử danh sách cũng chỉ có đúng 9 field, không lộ status/guard_revision/người tạo', async () => {
    await insertPlan({ code: 'GYM1M', name: 'Gym 1 tháng', price: '500000' });

    const res = await listPlans().expect(200);

    expect(Object.keys(res.body.items[0]).sort()).toEqual(PUBLIC_FIELDS);
    expect(res.body.items[0].price).toBe('500000');
    expect(res.body.items[0].id).toMatch(/^[0-9a-f]{24}$/);
    const text = JSON.stringify(res.body);
    for (const internal of ['status', 'guard_revision', 'guardRevision', 'created_by', 'createdBy', 'updated_by', 'updatedBy', '_id']) {
      expect(text).not.toContain(`"${internal}"`);
    }
  });

  it('US-13-TC04: gói GYM có sessionsQuota 0, gói PT có số buổi', async () => {
    await insertPlan({ code: 'GYM1M', name: 'Gym 1 tháng', kind: 'GYM' });
    await insertPlan({ code: 'PT10', name: 'PT 10 buổi', kind: 'PT', sessionsQuota: 10 });

    const res = await listPlans().expect(200);
    const byCode = Object.fromEntries(res.body.items.map((item: { code: string; sessionsQuota: number }) => [item.code, item.sessionsQuota]));

    expect(byCode).toEqual({ GYM1M: 0, PT10: 10 });
  });

  // ---------- US-13-TC05: lọc GYM/PT, min/max giá và từ khóa ----------
  async function seedFilterPlans() {
    await insertPlan({ code: 'GYM1M', name: 'Gym Basic', kind: 'GYM', price: '500000' });
    await insertPlan({ code: 'GYM12M', name: 'Gym Premium', kind: 'GYM', price: '5000000' });
    await insertPlan({ code: 'PT10', name: 'PT Starter', kind: 'PT', price: '3000000' });
    await insertPlan({ code: 'GYMOLD', name: 'Gym Basic Cu', kind: 'GYM', price: '400000', status: 'INACTIVE' });
  }

  it('US-13-TC05: kind=GYM chỉ trả gói GYM đang ACTIVE', async () => {
    await seedFilterPlans();

    const res = await listPlans({ kind: 'GYM' }).expect(200);

    expect(codesOf(res.body).sort()).toEqual(['GYM12M', 'GYM1M']);
  });

  it('US-13-TC05: kind=PT chỉ trả gói PT', async () => {
    await seedFilterPlans();

    const res = await listPlans({ kind: 'PT' }).expect(200);

    expect(codesOf(res.body)).toEqual(['PT10']);
  });

  it('US-13-TC05: minPrice và maxPrice lọc theo khoảng giá (tính cả hai đầu)', async () => {
    await seedFilterPlans();

    const res = await listPlans({ minPrice: '500000', maxPrice: '3000000' }).expect(200);

    expect(codesOf(res.body).sort()).toEqual(['GYM1M', 'PT10']);
  });

  it('US-13-TC05: chỉ minPrice hoặc chỉ maxPrice cũng lọc đúng', async () => {
    await seedFilterPlans();

    const fromMin = await listPlans({ minPrice: '3000001' }).expect(200);
    const toMax = await listPlans({ maxPrice: '499999' }).expect(200);

    expect(codesOf(fromMin.body)).toEqual(['GYM12M']);
    expect(codesOf(toMax.body)).toEqual([]); // GYMOLD rẻ hơn nhưng INACTIVE nên không được trả
  });

  it('US-13-TC05: từ khóa q tìm theo tên gói', async () => {
    await seedFilterPlans();

    const res = await listPlans({ q: 'Premium' }).expect(200);

    expect(codesOf(res.body)).toEqual(['GYM12M']);
  });

  it('US-13-TC05: từ khóa q tìm theo mã gói', async () => {
    await seedFilterPlans();

    const res = await listPlans({ q: 'PT10' }).expect(200);

    expect(codesOf(res.body)).toEqual(['PT10']);
  });

  it('US-13-TC05: q có khoảng trắng đầu/cuối được trim, gói INACTIVE trùng từ khóa vẫn không trả', async () => {
    await seedFilterPlans();

    const res = await listPlans({ q: '  Basic  ' }).expect(200);

    expect(codesOf(res.body)).toEqual(['GYM1M']);
  });

  it('US-13-TC05: kết hợp kind, khoảng giá và từ khóa', async () => {
    await seedFilterPlans();

    const res = await listPlans({ kind: 'GYM', minPrice: '1000000', q: 'Gym' }).expect(200);

    expect(codesOf(res.body)).toEqual(['GYM12M']);
  });

  // ---------- US-13-TC07: không kết quả; nhiều gói trùng tên ----------
  it('US-13-TC07: không có kết quả trả 200 items rỗng, total 0, totalPages 0', async () => {
    await seedFilterPlans();

    const res = await listPlans({ q: 'KhongCoGoiNay' }).expect(200);

    expect(res.body).toEqual({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
  });

  it('US-13-TC07: mặc định page 1, limit 20 và trả đủ total, totalPages', async () => {
    for (let i = 0; i < 21; i++) await insertPlan({ code: `GYM${String(i).padStart(2, '0')}`, name: `Gym ${String(i).padStart(2, '0')}` });

    const res = await listPlans().expect(200);

    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(20);
    expect(res.body.items).toHaveLength(20);
    expect(res.body.total).toBe(21);
    expect(res.body.totalPages).toBe(2);
  });

  it('US-13-TC07: sắp theo name tăng dần (không theo ngày tạo)', async () => {
    await insertPlan({ code: 'C1', name: 'Charlie', createdAt: new Date('2026-10-01') });
    await insertPlan({ code: 'A1', name: 'Alpha', createdAt: new Date('2026-10-03') });
    await insertPlan({ code: 'B1', name: 'Bravo', createdAt: new Date('2026-10-02') });

    const res = await listPlans().expect(200);

    expect(codesOf(res.body)).toEqual(['A1', 'B1', 'C1']);
  });

  it('US-13-TC07: nhiều gói trùng tên thì sắp tiếp theo _id tăng dần', async () => {
    // insertPlan chạy lần lượt nên _id tăng dần theo thứ tự chèn.
    const first = await insertPlan({ code: 'SAME1', name: 'Gym Standard' });
    const second = await insertPlan({ code: 'SAME2', name: 'Gym Standard' });
    const third = await insertPlan({ code: 'SAME3', name: 'Gym Standard' });

    const res = await listPlans().expect(200);

    expect(res.body.items.map((item: { id: string }) => item.id)).toEqual([first, second, third]);
  });

  it('US-13-TC07: phân trang các gói trùng tên ổn định, không lặp và không sót giữa các trang', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await insertPlan({ code: `SAME${i}`, name: 'Gym Standard' }));

    const pages: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await listPlans({ page: String(page), limit: '2' }).expect(200);
      expect(res.body.totalPages).toBe(3);
      pages.push(...res.body.items.map((item: { id: string }) => item.id));
    }

    expect(pages).toEqual(ids);
  });

  // ---------- US-13-TC08 (phần backend): từ khóa có ký tự regex được tìm literal ----------
  it('US-13-TC08: q=".*" chỉ khớp tên chứa đúng chuỗi ".*", không khớp tất cả', async () => {
    await insertPlan({ code: 'GYM1M', name: 'Gym Basic' });
    await insertPlan({ code: 'STAR', name: 'Gym .* Special' });

    const res = await listPlans({ q: '.*' }).expect(200);

    expect(codesOf(res.body)).toEqual(['STAR']);
  });

  it('US-13-TC08: q có ký tự regex không hợp lệ như "(" hoặc "[" không gây lỗi 500', async () => {
    await insertPlan({ code: 'GYM1M', name: 'Gym (Basic)' });

    const paren = await listPlans({ q: '(' }).expect(200);
    const bracket = await listPlans({ q: '[' }).expect(200);

    expect(codesOf(paren.body)).toEqual(['GYM1M']);
    expect(codesOf(bracket.body)).toEqual([]);
  });

  it('US-13-TC08: benefits có HTML được API trả nguyên dạng chuỗi (UI tự render text)', async () => {
    const id = await insertPlan({ code: 'GYM1M', name: 'Gym Basic', benefits: '<b>Tập</b><script>alert(1)</script>' });

    const res = await getPlan(id).expect(200);

    expect(res.body.benefits).toBe('<b>Tập</b><script>alert(1)</script>');
  });

  // ---------- US-13-TC09 (phần backend): đổi giá / ngừng bán sau khi người dùng đã xem ----------
  it('US-13-TC09: đổi giá sau khi đã xem thì chi tiết lần sau trả giá và version mới', async () => {
    const id = await insertPlan({ code: 'GYM1M', name: 'Gym Basic', price: '500000', version: 0 });
    const before = await getPlan(id).expect(200);

    await connection.db!.collection('plans').updateOne(
      { _id: new ObjectId(id) },
      { $set: { price: Decimal128.fromString('600000'), version: new Int32(1), updated_at: new Date() } },
    );
    const after = await getPlan(id).expect(200);

    expect(before.body.price).toBe('500000');
    expect(after.body.price).toBe('600000');
    expect(after.body.version).toBe(1);
  });

  it('US-13-TC09: ngừng bán sau khi đã xem thì chi tiết trả 404 PLAN_NOT_FOUND và danh sách không còn gói', async () => {
    const id = await insertPlan({ code: 'GYM1M', name: 'Gym Basic' });
    await getPlan(id).expect(200);

    await connection.db!.collection('plans').updateOne({ _id: new ObjectId(id) }, { $set: { status: 'INACTIVE', version: new Int32(1) } });
    const detail = await getPlan(id).expect(404);
    const list = await listPlans().expect(200);

    expect(detail.body.error.code).toBe('PLAN_NOT_FOUND');
    expect(list.body.items).toEqual([]);
  });
});
