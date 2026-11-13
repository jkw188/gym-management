// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-30 bước 4.
// Quan hệ PT – học viên thay đổi qua API THẬT của US-29 (hủy buổi) và US-64 (xác nhận đã dạy); API US-30 phải đọc lại ở mỗi request (TC05, TC06, TC09, TC11).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng dùng lại (đã có từ US-29, US-64, US-30 bước 1–2; test KHÔNG ghi thẳng trạng thái booking, chỉ đổi qua API):
//   POST /api/me/pt-bookings/:id/cancel   – MEMBER owner, Idempotency-Key, body {version, reason}; buổi còn ≥ 2 giờ mới hủy được.
//   POST /api/pt-bookings/:id/cancel      – STAFF/ADMIN hỗ trợ hủy, cùng body.
//   POST /api/me/pt-bookings/:id/complete – TRAINER dạy buổi đó, Idempotency-Key, body {version}; buổi đã kết thúc.
//   GET /api/me/trainees, /:memberId, /:memberId/bookings, /:memberId/memberships – US-30, quan hệ kiểm lại ở mỗi request.
//   Dữ liệu ban đầu (PT, hội viên, gói, buổi BOOKED) ghi thẳng DB vì US-23/US-14 chưa có API tạo (dùng dữ liệu mẫu như các bước trước).

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us30_relation';
const password = 'MậtKhẩuUS-30-123';
const REASON = 'Bận việc gia đình đột xuất';
const MINUTE = 60 * 1000;

type Auth = { accessToken: string };
type Pt = Auth & { trainerId: ObjectId };
type Member = Auth & { memberId: ObjectId; membershipId: ObjectId; fullName: string };

describe('US-30 bước 4: quan hệ thay đổi qua API thật', () => {
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
      SMTP_USER: 'us30-test', SMTP_PASS: 'us30-test', SMTP_FROM: 'no-reply@gym.test',
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
    // Bộ giới hạn đăng nhập (US-02) lưu trong bộ nhớ: mỗi test dùng bộ mới để không bị 429.
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await connection.db!.collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    // Khóa lịch toàn cục của EN-02/US-28: API hủy (US-29) và xác nhận (US-64) cần bản ghi này, như trong test của hai US đó.
    await db().collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());

  // ---------- Thời gian ----------
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // Buổi sắp tới: còn nhiều ngày nên luôn hủy được (≥ 2 giờ).
  const ahead = (days: number) => new Date(`${vnDay(days)}T08:00:00+07:00`);
  // Buổi đã kết thúc: bắt đầu `minutes` phút trước, dài 60 phút.
  const startedAgo = (minutes: number) => new Date(Math.floor(Date.now() / MINUTE) * MINUTE - minutes * MINUTE);
  const wide = { fromDate: vnDay(-15), toDate: vnDay(15) };

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN', fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0913200${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: created.id, phone };
  }

  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }

  async function staff(): Promise<Auth> {
    const owner = await account('STAFF', 'Nhan vien quay');
    return { accessToken: await loginAs(owner.phone) };
  }

  // PT mẫu (thay US-23).
  async function trainer(name: string): Promise<Pt> {
    const owner = await account('TRAINER', name);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: new ObjectId(String(owner.accountId)), specialty: 'The hinh', status: 'ACTIVE',
      version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accessToken: await loginAs(owner.phone) };
  }

  // Hội viên có tài khoản đã liên kết (khuôn US-09) + một gói PT ACTIVE đã thu tiền (khuôn US-14/22), đăng nhập sẵn để tự hủy.
  let seq = 0;
  async function member(fullName = 'Nguyen Thi Hoa', quota = 10, used = 2): Promise<Member> {
    seq += 1;
    const owner = await account('MEMBER', fullName);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV30R-${seq}`, full_name: fullName, phone: owner.phone,
      account_id: new ObjectId(String(owner.accountId)), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const now = new Date();
    const money = Decimal128.fromString('3000000');
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US30R-${seq}`, name: `Goi PT ${seq}`, kind: 'PT', duration_days: 60,
      session_quota: quota, price: money, benefits: 'Quyen loi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US30R-${seq}`, kind: 'PT', amount_due: money,
      status: 'SETTLED', request_key: randomBytes(32).toString('hex'), created_at: now, guard_revision: Long.ZERO,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: vnDay(-20), end_date: vnDay(40), plan_name_snapshot: `Goi PT ${seq}`, benefits_snapshot: 'Quyen loi',
      list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: quota, policy_snapshot: 'Gia niem yet', created_at: now,
    });
    await db().collection('memberships').insertOne({ _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: used });
    return { memberId, membershipId, fullName, accessToken: await loginAs(owner.phone) };
  }

  // Buổi BOOKED có sẵn (đã đặt qua US-28 trước đó), dài 60 phút, có field của US-64.
  async function booked(who: Member, pt: Pt, start: Date, trainerName = 'PT Mot') {
    const id = new ObjectId();
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: who.membershipId, member_id: who.memberId, trainer_id: pt.trainerId, shift_id: new ObjectId(),
      start_at: start, end_at: new Date(start.getTime() + 60 * MINUTE), status: 'BOOKED', request_key: randomBytes(32).toString('hex'),
      version: 0, completion_revision: 0, trainer_name_snapshot: trainerName, location_snapshot: 'Phong PT 1',
      created_by: new ObjectId(), created_at: new Date(), updated_at: new Date(),
    });
    return id;
  }

  // ---------- Gọi API ----------
  function post(path: string, auth: Auth, body: Record<string, unknown>) {
    return http().post(path).set('Origin', origin).set('Authorization', `Bearer ${auth.accessToken}`).set('Idempotency-Key', randomUUID()).send(body);
  }
  const cancelOwn = (who: Member, bookingId: ObjectId) => post(`/api/me/pt-bookings/${bookingId.toHexString()}/cancel`, who, { version: 0, reason: REASON });
  const cancelSupport = (auth: Auth, bookingId: ObjectId) => post(`/api/pt-bookings/${bookingId.toHexString()}/cancel`, auth, { version: 0, reason: REASON });
  const complete = (pt: Pt, bookingId: ObjectId) => post(`/api/me/pt-bookings/${bookingId.toHexString()}/complete`, pt, { version: 0 });

  function get(auth: Auth, path: string, query: Record<string, string | number> = {}) {
    return http().get(`/api/me/trainees${path}`).query(query).set('Origin', origin).set('Authorization', `Bearer ${auth.accessToken}`);
  }
  const detail = (pt: Pt, who: Member) => get(pt, `/${who.memberId.toHexString()}`);
  const bookings = (pt: Pt, who: Member) => get(pt, `/${who.memberId.toHexString()}/bookings`, wide);
  const memberships = (pt: Pt, who: Member) => get(pt, `/${who.memberId.toHexString()}/memberships`);
  const listIds = async (pt: Pt) => ((await get(pt, '').expect(200)).body.items as { memberId: string }[]).map(item => item.memberId);
  const packOf = (body: { items: Record<string, unknown>[] }, id: ObjectId) => body.items.find(item => item.id === id.toHexString());

  function expectError(response: request.Response, status: number) {
    expect(response.status).toBe(status);
    expect(typeof response.body.error?.code).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
  }

  // =====================================================================
  // TC09 – hủy booking cuối trong lúc PT đang mở chi tiết
  // =====================================================================

  describe('US-30-TC09: hủy booking cuối trong lúc PT mở detail', () => {
    it('US-30-TC09: Member tự hủy buổi BOOKED duy nhất → lần GET tiếp theo của PT: detail, bookings, memberships 404; list không còn học viên', async () => {
      const pt = await trainer('PT Mot');
      const hoa = await member();
      const only = await booked(hoa, pt, ahead(3));
      // PT đang mở hồ sơ: lúc này còn quan hệ.
      await detail(pt, hoa).expect(200);
      expect(await listIds(pt)).toEqual([hoa.memberId.toHexString()]);

      await cancelOwn(hoa, only).expect(200);

      const after = await detail(pt, hoa);
      expectError(after, 404);
      expect(JSON.stringify(after.body)).not.toContain(hoa.fullName);
      expectError(await bookings(pt, hoa), 404);
      expectError(await memberships(pt, hoa), 404);
      expect(await listIds(pt)).toEqual([]);
    });

    it('US-30-TC09: còn hai buổi BOOKED → hủy một vẫn 200; hủy nốt buổi cuối mới 404', async () => {
      const pt = await trainer('PT Mot');
      const hoa = await member();
      const first = await booked(hoa, pt, ahead(2));
      const second = await booked(hoa, pt, ahead(4));

      await cancelOwn(hoa, first).expect(200);
      await detail(pt, hoa).expect(200);

      await cancelOwn(hoa, second).expect(200);
      expectError(await detail(pt, hoa), 404);
    });

    it('US-30-TC09: Staff hỗ trợ hủy buổi cuối → PT cũng mất quyền mở hồ sơ ngay lần GET sau', async () => {
      const pt = await trainer('PT Mot');
      const hoa = await member();
      const only = await booked(hoa, pt, ahead(3));
      await detail(pt, hoa).expect(200);

      await cancelSupport(await staff(), only).expect(200);

      expectError(await detail(pt, hoa), 404);
      expectError(await memberships(pt, hoa), 404);
    });

    it('US-30-TC09: hủy buổi với PT khác không làm PT này mất quan hệ', async () => {
      const ptA = await trainer('PT Mot');
      const ptB = await trainer('PT Hai');
      const hoa = await member();
      await booked(hoa, ptA, ahead(2));
      const withB = await booked(hoa, ptB, ahead(3), 'PT Hai');

      await cancelOwn(hoa, withB).expect(200);

      await detail(ptA, hoa).expect(200);
      expectError(await detail(ptB, hoa), 404);
    });
  });

  // =====================================================================
  // TC11 – còn COMPLETED lịch sử sau khi xác nhận thật qua US-64
  // =====================================================================

  describe('US-30-TC11: chỉ còn COMPLETED lịch sử (xác nhận qua API thật)', () => {
    it('US-30-TC11: PT xác nhận một buổi, Member hủy buổi BOOKED còn lại → PT vẫn xem hồ sơ, hasUpcoming=false, thấy lịch sử của mình', async () => {
      const pt = await trainer('PT Mot');
      const hoa = await member();
      const past = await booked(hoa, pt, startedAgo(120));
      const future = await booked(hoa, pt, ahead(3));

      await complete(pt, past).expect(200);
      await cancelOwn(hoa, future).expect(200);

      const profile = await detail(pt, hoa).expect(200);
      expect(profile.body.hasUpcoming).toBe(false);
      const history = await bookings(pt, hoa).expect(200);
      const statuses = Object.fromEntries((history.body.items as { id: string; status: string }[]).map(item => [item.id, item.status]));
      expect(statuses).toEqual({ [past.toHexString()]: 'COMPLETED', [future.toHexString()]: 'CANCELLED' });
      expect(await listIds(pt)).toEqual([hoa.memberId.toHexString()]);
    });

    it('US-30-TC11: BOOKED đã quá giờ nhưng PT chưa xác nhận → vẫn là học viên; các GET của US-30 không tự hoàn tất', async () => {
      const pt = await trainer('PT Mot');
      const hoa = await member();
      const overdue = await booked(hoa, pt, startedAgo(180));

      await detail(pt, hoa).expect(200);
      await bookings(pt, hoa).expect(200);
      await memberships(pt, hoa).expect(200);
      await get(pt, '').expect(200);

      const stored = await db().collection('pt_bookings').findOne({ _id: overdue });
      expect(stored).toMatchObject({ status: 'BOOKED', version: 0 });
      const pack = await db().collection('memberships').findOne({ _id: hoa.membershipId });
      expect(pack?.sessions_used).toBe(2);
    });
  });

  // =====================================================================
  // TC06 – quota theo dữ liệu mới nhất sau hủy/xác nhận thật (nguồn quota dùng chung US-17)
  // =====================================================================

  describe('US-30-TC06: quota liên quan cập nhật theo thay đổi thật', () => {
    it('US-30-TC06: PT xác nhận một buổi → sessionsUsed +1, reserved −1, available không đổi', async () => {
      const pt = await trainer('PT Mot');
      const hoa = await member('Nguyen Thi Hoa', 10, 2);
      const past = await booked(hoa, pt, startedAgo(120));
      await booked(hoa, pt, ahead(3));
      const before = packOf((await memberships(pt, hoa).expect(200)).body, hoa.membershipId);
      expect(before).toMatchObject({ quota: 10, sessionsUsed: 2, reserved: 2, available: 6 });

      await complete(pt, past).expect(200);

      const after = packOf((await memberships(pt, hoa).expect(200)).body, hoa.membershipId);
      expect(after).toMatchObject({ quota: 10, sessionsUsed: 3, reserved: 1, available: 6 });
    });

    it('US-30-TC06: Member hủy buổi với PT khác trên gói dùng chung → reserved của PT này giảm, không lộ PT kia', async () => {
      const ptA = await trainer('PT Mot');
      const ptB = await trainer('PT Hai');
      const hoa = await member('Nguyen Thi Hoa', 10, 3);
      await booked(hoa, ptA, ahead(1));
      await booked(hoa, ptA, ahead(2));
      const b1 = await booked(hoa, ptB, ahead(3), 'PT Hai Bi Mat');
      await booked(hoa, ptB, ahead(4), 'PT Hai Bi Mat');
      expect(packOf((await memberships(ptA, hoa).expect(200)).body, hoa.membershipId)).toMatchObject({ reserved: 4, available: 3 });

      await cancelOwn(hoa, b1).expect(200);

      const response = await memberships(ptA, hoa).expect(200);
      expect(packOf(response.body, hoa.membershipId)).toMatchObject({ sessionsUsed: 3, reserved: 3, available: 4 });
      const text = JSON.stringify(response.body);
      expect(text).not.toContain('PT Hai Bi Mat');
      expect(text).not.toContain(ptB.trainerId.toHexString());
    });
  });

  // =====================================================================
  // TC05 – hai PT, sau thay đổi thật mỗi PT vẫn chỉ thấy buổi của mình
  // =====================================================================

  describe('US-30-TC05: member có lịch với hai PT (sau thay đổi thật)', () => {
    it('US-30-TC05: PT B xác nhận buổi của mình → PT A không thấy buổi đó trong /bookings, số buổi của PT A không đổi', async () => {
      const ptA = await trainer('PT Mot');
      const ptB = await trainer('PT Hai');
      const hoa = await member();
      const withA = await booked(hoa, ptA, ahead(2));
      const withB = await booked(hoa, ptB, startedAgo(120), 'PT Hai Bi Mat');

      await complete(ptB, withB).expect(200);

      const forA = await bookings(ptA, hoa).expect(200);
      expect((forA.body.items as { id: string }[]).map(item => item.id)).toEqual([withA.toHexString()]);
      expect(JSON.stringify(forA.body)).not.toContain(withB.toHexString());
      const row = ((await get(ptA, '').expect(200)).body.items as { memberId: string; relatedBookingCount: number }[])[0];
      expect(row).toMatchObject({ memberId: hoa.memberId.toHexString(), relatedBookingCount: 1 });
    });
  });
});
