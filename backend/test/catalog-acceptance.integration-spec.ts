// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ): US-13 bước 4 – nghiệm thu tổng hợp.
// Dữ liệu tạo/đổi qua API quản trị THẬT của US-12 (không ghi thẳng DB), rồi kiểm danh mục public US-13 phản ánh đúng:
// mọi vai trò đọc được nhưng chỉ thấy ACTIVE (TC01, TC02, TC04), đổi giá/ngừng bán/bán lại (TC09),
// backend bán US-14 kiểm planVersion (TC09), Guest/Member không gọi được API bán (TC10), mất DB trả 503 (TC11).
// File riêng vì ca TC11 tắt hẳn MongoDB nên phải chạy CUỐI.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { RoleCode } from '../src/modules/users/schemas/role.schema';
import { ACCOUNT_ADMINISTRATION } from '../src/modules/users/schemas/security-state.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us13_acceptance';
const password = 'MậtKhẩuUS-13-456';

// Đúng 9 field của PublicPlanDto theo US-13-F02.
const PUBLIC_FIELDS = ['benefits', 'code', 'durationDays', 'id', 'kind', 'name', 'price', 'sessionsQuota', 'version'];

type AdminPlan = { id: string; code: string; version: number; price: string; status: string };

// Ngày mai theo giờ Việt Nam (YYYY-MM-DD) để ngày bắt đầu gói luôn hợp lệ.
function tomorrowInVietnam(): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(tomorrow);
}

describe('US-13 bước 4: nghiệm thu danh mục public với dữ liệu từ API quản trị thật', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };
  const tokens = {} as Record<RoleCode, string>;
  let phoneSeq = 0;

  // Tạo tài khoản đúng vai trò rồi đăng nhập thật để lấy access token.
  async function loginAs(code: RoleCode): Promise<string> {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(code, code);
    const passwordHash = await app.get(PasswordService).hash(password);
    const phone = `09130000${String(++phoneSeq).padStart(2, '0')}`;
    await users.createAccount({ roleId: role.id.toHexString(), phone, fullName: `US13 ${code}`, passwordHash });
    const login = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return login.body.accessToken as string;
  }

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
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    // Khóa quản trị US-07 (lệnh ensure-indexes tạo sẵn trong môi trường thật): tạo hồ sơ hội viên US-09 cần khóa này.
    await connection.db!.collection<{ _id: string; revision: Long }>('security_state').insertOne({ _id: ACCOUNT_ADMINISTRATION, revision: Long.fromNumber(0) });
    for (const role of ['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as RoleCode[]) tokens[role] = await loginAs(role);
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Xóa gói và dữ liệu bán giữa các test; giữ tài khoản/phiên đăng nhập và index.
    for (const name of ['plans', 'plan_conversion_policies', 'members', 'service_sales', 'transactions', 'memberships', 'invoices', 'payments', 'operation_requests']) {
      await connection.db!.collection(name).deleteMany({});
    }
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  // ---------- Gọi API ----------
  const server = () => app.getHttpServer();
  const auth = (role: RoleCode) => `Bearer ${tokens[role]}`;
  const listPlans = (query: Record<string, string> = {}, role?: RoleCode) => {
    const call = request(server()).get('/api/catalog/plans').query(query).set('Origin', origin);
    return role ? call.set('Authorization', auth(role)) : call;
  };
  const getPlan = (id: string, role?: RoleCode) => {
    const call = request(server()).get(`/api/catalog/plans/${id}`).set('Origin', origin);
    return role ? call.set('Authorization', auth(role)) : call;
  };
  const codesOf = (body: { items: Array<{ code: string }> }) => body.items.map(item => item.code);

  // US-12: Admin tạo gói qua API thật (POST /api/admin/plans → 201 PlanDto).
  let codeSeq = 0;
  async function adminCreate(overrides: Record<string, unknown> = {}): Promise<AdminPlan> {
    const body = {
      code: `US13_${++codeSeq}`, name: `Gói ${codeSeq}`, kind: 'GYM', durationDays: 30, sessionsQuota: 0,
      price: '500000', benefits: 'Tập không giới hạn trong giờ mở cửa', ...overrides,
    };
    const res = await request(server()).post('/api/admin/plans').set('Origin', origin).set('Authorization', auth('ADMIN')).send(body).expect(201);
    return res.body as AdminPlan;
  }

  // US-12: Admin sửa gói qua API thật (PATCH /api/admin/plans/:id {version,...} → 200 {plan,changed}).
  async function adminPatch(plan: AdminPlan, changes: Record<string, unknown>): Promise<AdminPlan> {
    const res = await request(server()).patch(`/api/admin/plans/${plan.id}`).set('Origin', origin).set('Authorization', auth('ADMIN'))
      .send({ version: plan.version, ...changes }).expect(200);
    return res.body.plan as AdminPlan;
  }

  // US-09: Staff tạo hồ sơ hội viên thật để dùng cho preview bán gói US-14.
  async function staffCreateMember(): Promise<string> {
    const res = await request(server()).post('/api/members').set('Origin', origin).set('Authorization', auth('STAFF'))
      .set('Idempotency-Key', randomUUID()).send({ fullName: 'Hội Viên US13', phone: '0987654321' });
    if (res.status !== 201) throw new Error(`MEMBER_CREATE ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  }

  // US-14: preview bán gói (chỉ tính, không tạo sale).
  const salePreview = (body: Record<string, unknown>, role?: RoleCode) => {
    const call = request(server()).post('/api/service-sales/preview').set('Origin', origin).set('Idempotency-Key', randomUUID());
    return (role ? call.set('Authorization', auth(role)) : call).send(body);
  };

  // Đếm tài liệu ở các collection liên quan bán hàng/thanh toán (kiểm "không tạo sale/payment").
  async function saleDocuments(): Promise<number> {
    let total = 0;
    for (const name of ['service_sales', 'transactions', 'memberships', 'invoices', 'payments']) total += await connection.db!.collection(name).countDocuments();
    return total;
  }

  // =====================================================================
  // TC01, TC02, TC04 – mọi vai trò đọc được dữ liệu đã công bố, chỉ ACTIVE, đúng 9 field
  // =====================================================================
  describe('TC01/TC02/TC04: mọi vai trò đọc danh mục public', () => {
    it.each(['STAFF', 'TRAINER', 'ADMIN'] as RoleCode[])('US-13-TC01: %s có token xem danh sách và chi tiết gói ACTIVE được 200', async role => {
      const plan = await adminCreate({ name: 'Gym 1 tháng' });

      const list = await listPlans({}, role).expect(200);
      const detail = await getPlan(plan.id, role).expect(200);

      expect(codesOf(list.body)).toEqual([plan.code]);
      expect(detail.body.id).toBe(plan.id);
    });

    it('US-13-TC02: Admin xem qua API public vẫn KHÔNG thấy gói INACTIVE (danh sách) – muốn xem phải dùng /api/admin/plans', async () => {
      const active = await adminCreate({ name: 'Gym đang bán' });
      const created = await adminCreate({ name: 'Gym ngừng bán' });
      await adminPatch(created, { status: 'INACTIVE' });

      const res = await listPlans({}, 'ADMIN').expect(200);

      expect(codesOf(res.body)).toEqual([active.code]);
    });

    it('US-13-TC02: Admin/Staff mở chi tiết public của gói INACTIVE vẫn nhận 404 PLAN_NOT_FOUND', async () => {
      const created = await adminCreate();
      await adminPatch(created, { status: 'INACTIVE' });

      for (const role of ['ADMIN', 'STAFF'] as RoleCode[]) {
        const res = await getPlan(created.id, role).expect(404);
        expect(res.body.error.code).toBe('PLAN_NOT_FOUND');
      }
    });

    it('US-13-TC04: Admin gọi API public vẫn chỉ nhận đúng 9 field PublicPlanDto, không có status/createdAt/updatedAt', async () => {
      const plan = await adminCreate({ kind: 'PT', sessionsQuota: 10, price: '3000000', name: 'PT 10 buổi' });

      const detail = await getPlan(plan.id, 'ADMIN').expect(200);
      const list = await listPlans({}, 'ADMIN').expect(200);

      expect(Object.keys(detail.body).sort()).toEqual(PUBLIC_FIELDS);
      expect(Object.keys(list.body.items[0]).sort()).toEqual(PUBLIC_FIELDS);
      expect(detail.body).toMatchObject({ price: '3000000', sessionsQuota: 10, kind: 'PT' });
    });
  });

  // =====================================================================
  // TC05 – lọc trên dữ liệu thật do Admin tạo
  // =====================================================================
  describe('TC05: lọc trên dữ liệu tạo qua API quản trị', () => {
    it('US-13-TC05: lọc kind + khoảng giá + từ khóa chỉ trả gói ACTIVE khớp, không trả gói INACTIVE trùng điều kiện', async () => {
      const match = await adminCreate({ kind: 'PT', sessionsQuota: 10, price: '3000000', name: 'PT cơ bản' });
      await adminCreate({ kind: 'PT', sessionsQuota: 20, price: '9000000', name: 'PT nâng cao' });
      await adminCreate({ kind: 'GYM', price: '3000000', name: 'Gym PT kèm' });
      const stopped = await adminCreate({ kind: 'PT', sessionsQuota: 10, price: '3000000', name: 'PT cơ bản cũ' });
      await adminPatch(stopped, { status: 'INACTIVE' });

      const res = await listPlans({ kind: 'PT', minPrice: '1000000', maxPrice: '5000000', q: 'cơ bản' }).expect(200);

      expect(codesOf(res.body)).toEqual([match.code]);
    });
  });

  // =====================================================================
  // TC09 – đổi giá/ngừng bán/bán lại qua API quản trị; backend bán kiểm version
  // =====================================================================
  describe('TC09: dữ liệu thay đổi sau khi người dùng đã xem', () => {
    it('US-13-TC09: Admin đổi giá qua API quản trị thì danh sách và chi tiết public trả giá và version mới ngay', async () => {
      const plan = await adminCreate({ price: '500000' });
      const seen = await getPlan(plan.id).expect(200);

      const updated = await adminPatch(plan, { price: '650000' });
      const detail = await getPlan(plan.id).expect(200);
      const list = await listPlans().expect(200);

      expect(seen.body.price).toBe('500000');
      expect(detail.body.price).toBe('650000');
      expect(detail.body.version).toBe(updated.version);
      expect(detail.body.version).toBeGreaterThan(seen.body.version);
      expect(list.body.items[0].price).toBe('650000');
    });

    it('US-13-TC09: Admin ngừng bán qua API quản trị thì chi tiết public 404 PLAN_NOT_FOUND và danh sách không còn gói', async () => {
      const plan = await adminCreate();
      await getPlan(plan.id).expect(200);

      await adminPatch(plan, { status: 'INACTIVE' });
      const detail = await getPlan(plan.id).expect(404);
      const list = await listPlans().expect(200);

      expect(detail.body.error.code).toBe('PLAN_NOT_FOUND');
      expect(list.body.items).toEqual([]);
      expect(list.body.totalPages).toBe(0);
    });

    it('US-13-TC09: Admin bán lại (INACTIVE → ACTIVE) thì gói xuất hiện lại ở public với version mới', async () => {
      const plan = await adminCreate();
      const stopped = await adminPatch(plan, { status: 'INACTIVE' });

      const resumed = await adminPatch(stopped, { status: 'ACTIVE' });
      const detail = await getPlan(plan.id).expect(200);

      expect(detail.body.version).toBe(resumed.version);
      expect(codesOf((await listPlans().expect(200)).body)).toEqual([plan.code]);
    });

    it('US-13-TC09: nhân viên bán theo planVersion cũ đã xem ở danh mục → backend US-14 trả 409 PLAN_CHANGED', async () => {
      const plan = await adminCreate({ price: '500000' });
      const memberId = await staffCreateMember();
      const seen = await getPlan(plan.id).expect(200);
      await adminPatch(plan, { price: '650000' });

      const res = await salePreview({ memberId, planId: plan.id, planVersion: seen.body.version, startDate: tomorrowInVietnam() }, 'STAFF');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAN_CHANGED');
    });

    it('US-13-TC09: đọc lại danh mục lấy version mới rồi preview thì backend tính đúng giá mới từ DB', async () => {
      const plan = await adminCreate({ price: '500000' });
      const memberId = await staffCreateMember();
      await adminPatch(plan, { price: '650000' });
      const fresh = await getPlan(plan.id).expect(200);

      const res = await salePreview({ memberId, planId: plan.id, planVersion: fresh.body.version, startDate: tomorrowInVietnam() }, 'STAFF').expect(200);

      expect(res.body.planVersion).toBe(fresh.body.version);
      expect(res.body.amountDue).toBe('650000');
    });

    it('US-13-TC09: gói đã ngừng bán thì preview bán bằng version đã xem bị từ chối 409, không tạo sale', async () => {
      const plan = await adminCreate();
      const memberId = await staffCreateMember();
      const seen = await getPlan(plan.id).expect(200);
      await adminPatch(plan, { status: 'INACTIVE' });

      const res = await salePreview({ memberId, planId: plan.id, planVersion: seen.body.version, startDate: tomorrowInVietnam() }, 'STAFF');

      expect(res.status).toBe(409);
      expect(['PLAN_CHANGED', 'PLAN_NOT_AVAILABLE']).toContain(res.body.error.code);
      expect(await saleDocuments()).toBe(0);
    });
  });

  // =====================================================================
  // TC10 – Guest/Member không gọi được API bán của nhân viên
  // =====================================================================
  describe('TC10: xem danh mục không tạo sale/payment', () => {
    it('US-13-TC10: Guest gọi preview/tạo sale của nhân viên bị 401, không tạo dữ liệu bán', async () => {
      const plan = await adminCreate();
      const body = { memberId: '650000000000000000000001', planId: plan.id, planVersion: plan.version, startDate: tomorrowInVietnam() };

      const preview = await salePreview(body);
      const create = await request(server()).post('/api/service-sales').set('Origin', origin).set('Idempotency-Key', randomUUID()).send(body);

      expect(preview.status).toBe(401);
      expect(create.status).toBe(401);
      expect(await saleDocuments()).toBe(0);
    });

    it('US-13-TC10: Member có token gọi preview/tạo sale của nhân viên bị 403, không tạo dữ liệu bán', async () => {
      const plan = await adminCreate();
      const body = { memberId: '650000000000000000000001', planId: plan.id, planVersion: plan.version, startDate: tomorrowInVietnam() };

      const preview = await salePreview(body, 'MEMBER');
      const create = await request(server()).post('/api/service-sales').set('Origin', origin).set('Authorization', auth('MEMBER'))
        .set('Idempotency-Key', randomUUID()).send(body);

      expect(preview.status).toBe(403);
      expect(create.status).toBe(403);
      expect(await saleDocuments()).toBe(0);
    });

    it('US-13-TC10: xem danh sách và chi tiết nhiều lần không ghi gì vào plans (version giữ nguyên) và không tạo dữ liệu bán', async () => {
      const plan = await adminCreate();

      for (let i = 0; i < 3; i += 1) {
        await listPlans().expect(200);
        await getPlan(plan.id).expect(200);
      }

      expect((await getPlan(plan.id).expect(200)).body.version).toBe(plan.version);
      expect(await saleDocuments()).toBe(0);
    });
  });

  // =====================================================================
  // TC11 – mất DB: 503 rõ ràng, không giả danh mục rỗng (CHẠY CUỐI vì tắt MongoDB)
  // =====================================================================
  describe('TC11: mất kết nối DB', () => {
    it('US-13-TC11: DB ngừng thì list và detail trả 503 SERVICE_UNAVAILABLE có requestId, không trả 200 rỗng hay lỗi thô MongoDB', async () => {
      const plan = await adminCreate();
      await mongo.stop();

      for (const call of [() => listPlans(), () => getPlan(plan.id)]) {
        const res = await call();
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
        expect(res.body.requestId).toBeTruthy();
        expect(res.body.items).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toMatch(/mongodb:|ECONNREFUSED|ServerSelection|MongoNetworkError/);
      }
    }, 120000);
  });
});
