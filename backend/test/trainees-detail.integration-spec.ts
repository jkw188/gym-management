// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-30 bước 2.
// Kiểm tra hồ sơ tối thiểu, lịch riêng PT và gói tập liên quan của một học viên (TC02–TC08, TC10, TC11 phần chi tiết).
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
// Hợp đồng test đặt ra cho Builder (US-30 bước 2, theo F02–F04 và mục 2 của spec):
//   Mọi endpoint chỉ TRAINER (vai trò khác 403). Quan hệ = có ít nhất một booking BOOKED/COMPLETED của chính PT với member,
//   kiểm lại ở MỖI request. Không có quan hệ / memberId không tồn tại / PT chưa link -> 404; memberId sai định dạng -> 400.
//   GET /api/me/trainees/:memberId
//        -> 200 đúng các field {memberId, memberCode, fullName, hasUpcoming}; không phone/email/address/tài khoản/tiền.
//   GET /api/me/trainees/:memberId/bookings?fromDate&toDate&status?&page?&limit?
//        -> chỉ buổi do chính PT dạy (kể cả CANCELLED cũ khi vẫn còn quan hệ); {items,page,limit,total,totalPages};
//        ngày VN YYYY-MM-DD bao gồm hai đầu, tối đa 31 ngày, mặc định tuần hiện tại từ thứ Hai; sắp startAt rồi id ASC.
//   GET /api/me/trainees/:memberId/memberships?page?&limit?
//        -> chỉ membership có booking BOOKED/COMPLETED giữa member và chính PT; {items,page,limit,total,totalPages} + asOf.
//        Mỗi item {id, kind, storedStatus, startDate, endDate, quota, sessionsUsed, reserved, available}.
//        quota lấy từ sale đã bán (sessions_snapshot); sessionsUsed = memberships.sessions_used;
//        reserved = số BOOKED của TOÀN membership (gồm PT khác); available = quota - sessionsUsed - reserved.
//        Không trả tên/lịch/id của PT khác. GET không sửa membership.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us30_detail';
const password = 'MậtKhẩuUS-30-123';
const base = '/api/me/trainees';
const DETAIL_FIELDS = ['fullName', 'hasUpcoming', 'memberCode', 'memberId'];
const MEMBERSHIP_FIELDS = ['available', 'endDate', 'id', 'kind', 'quota', 'reserved', 'sessionsUsed', 'startDate', 'storedStatus'];

type Auth = { accessToken: string };
type Pt = Auth & { trainerId: ObjectId };
type Trainee = { memberId: ObjectId; membershipId: ObjectId; memberCode: string; fullName: string };
type Status = 'BOOKED' | 'COMPLETED' | 'CANCELLED';

describe('US-30 bước 2: hồ sơ, lịch và gói liên quan của học viên', () => {
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
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());

  // ---------- Thời gian theo lịch Việt Nam ----------
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  // Ngày VN (YYYY-MM-DD) cách hôm nay `days` ngày (âm = quá khứ).
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const at = (days: number, hhmm = '08:00') => new Date(`${vnDay(days)}T${hhmm}:00+07:00`);

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN', fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0913100${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: created.id, phone };
  }

  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }

  // PT mẫu (thay US-23): tài khoản TRAINER + hồ sơ trainers liên kết qua account_id.
  async function trainer(name = 'PT Tran Van Binh'): Promise<Pt> {
    const owner = await account('TRAINER', name);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: owner.accountId, specialty: 'The hinh', status: 'ACTIVE',
      version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accessToken: await loginAs(owner.phone) };
  }

  // Hồ sơ hội viên mẫu (khuôn US-09) có tài khoản riêng + một gói PT ACTIVE mặc định (thay US-14/22).
  let memberSeq = 0;
  async function trainee(fullName = 'Anh Nguyen'): Promise<Trainee> {
    memberSeq += 1;
    const memberId = new ObjectId();
    const code = `HV30D-${String(memberSeq).padStart(4, '0')}`;
    const staffId = new ObjectId();
    const owner = await account('MEMBER', fullName);
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: code, full_name: fullName, account_id: owner.accountId,
      phone: `0988${String(memberSeq).padStart(6, '0')}`, email: `hv${memberSeq}@gym.test`, address: '12 Nguyen Trai',
      birth_date: '1995-05-20', health_note: 'Dau lung nhe',
      version: 0, service_revision: 0n, created_by: staffId, updated_by: staffId,
    });
    const membershipId = await insertMembership(memberId);
    return { memberId, membershipId, memberCode: code, fullName };
  }

  // Một gói đã thu tiền: plan → transaction SETTLED → sale (snapshot) → membership.
  async function insertMembership(memberId: ObjectId, options: {
    kind?: 'PT' | 'GYM'; quota?: number; used?: number; status?: 'ACTIVE' | 'SUPERSEDED'; operation?: 'REGISTER' | 'UPGRADE';
    startDate?: string; endDate?: string; planQuota?: number;
  } = {}) {
    const kind = options.kind ?? 'PT';
    const quota = options.quota ?? (kind === 'PT' ? 10 : 0);
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const staffId = new ObjectId();
    const now = new Date();
    const money = Decimal128.fromString('3456789');
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `${kind}-US30D-${planId.toHexString()}`, name: `Goi ${kind} ${quota}`, kind, duration_days: 60,
      // planQuota khác quota: kiểm quota lấy từ snapshot của sale, không lấy từ plan hiện tại.
      session_quota: options.planQuota ?? quota, price: money, benefits: `Goi ${kind}`, status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US30D-${transactionId.toHexString()}`, kind,
      amount_due: money, status: 'SETTLED', request_key: `us30d-key-${transactionId.toHexString()}`, created_at: now,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: options.operation ?? 'REGISTER',
      start_date: options.startDate ?? vnDay(-30), end_date: options.endDate ?? vnDay(30), plan_name_snapshot: `Goi ${kind} ${quota}`,
      benefits_snapshot: `Goi ${kind}`, list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: quota,
      policy_snapshot: 'Gia niem yet, 60 ngay', created_at: now,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, id: membershipId, service_sale_id: saleId, status: options.status ?? 'ACTIVE', sessions_used: options.used ?? 0,
    });
    return membershipId;
  }

  // Buổi PT mẫu (thay US-28): khuôn mục 4.2.13 + phần US-28 bổ sung (member_id, snapshot, version).
  async function insertBooking(member: Trainee, trainerId: ObjectId, start: Date, status: Status = 'BOOKED', options: {
    membershipId?: ObjectId; trainerName?: string; location?: string;
  } = {}) {
    const id = new ObjectId();
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const doc: Record<string, unknown> = {
      _id: id, id, membership_id: options.membershipId ?? member.membershipId, member_id: member.memberId, trainer_id: trainerId,
      shift_id: new ObjectId(), start_at: start, end_at: end, status,
      request_key: `us30d-booking-${id.toHexString()}`, version: 0,
      trainer_name_snapshot: options.trainerName ?? 'PT Tran Van Binh', location_snapshot: options.location ?? 'Phong PT 1',
      created_by: new ObjectId(), created_at: new Date(), updated_at: new Date(),
    };
    if (status === 'COMPLETED') doc.completed_at = end;
    if (status === 'CANCELLED') Object.assign(doc, { cancelled_at: new Date(), cancelled_by: new ObjectId(), cancelled_reason: 'Hoc vien ban viec' });
    await db().collection('pt_bookings').insertOne(doc);
    return id.toHexString();
  }

  function get(user: Auth, path: string, query: Record<string, string | number> = {}) {
    return http().get(`${base}${path}`).query(query).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }
  const detail = (user: Auth, member: Trainee | string) => get(user, `/${typeof member === 'string' ? member : member.memberId.toHexString()}`);
  const bookings = (user: Auth, member: Trainee, query: Record<string, string | number> = {}) =>
    get(user, `/${member.memberId.toHexString()}/bookings`, query);
  const memberships = (user: Auth, member: Trainee, query: Record<string, string | number> = {}) =>
    get(user, `/${member.memberId.toHexString()}/memberships`, query);
  // Khoảng ngày rộng (31 ngày) chứa mọi buổi mẫu từ -15 đến +15 ngày.
  const wide = { fromDate: vnDay(-15), toDate: vnDay(15) };
  const ids = (body: { items: { id: string }[] }) => body.items.map(item => item.id);
  const membershipOf = (body: { items: Record<string, unknown>[] }, id: ObjectId) => body.items.find(item => item.id === id.toHexString());

  function expectError(response: request.Response, status: number) {
    expect(response.status).toBe(status);
    expect(typeof response.body.error?.code).toBe('string');
    expect(typeof response.body.error?.message).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
  }

  // =====================================================================
  // AC01 – phần chi tiết: quan hệ quyết định quyền mở hồ sơ (TC02–TC04)
  // =====================================================================

  describe('US-30-TC02: không có quan hệ hoặc chỉ có CANCELLED (phần chi tiết)', () => {
    it('US-30-TC02: member chưa từng có booking với PT → detail, bookings, memberships đều 404', async () => {
      const pt = await trainer();
      const an = await trainee();

      expectError(await detail(pt, an), 404);
      expectError(await bookings(pt, an, wide), 404);
      expectError(await memberships(pt, an), 404);
    });

    it('US-30-TC02: member chỉ có booking CANCELLED với PT → detail, bookings, memberships đều 404', async () => {
      const pt = await trainer();
      const an = await trainee();
      await insertBooking(an, pt.trainerId, at(3), 'CANCELLED');

      expectError(await detail(pt, an), 404);
      expectError(await bookings(pt, an, wide), 404);
      expectError(await memberships(pt, an), 404);
    });
  });

  describe('US-30-TC03: memberId của người khác hoặc giả', () => {
    it('US-30-TC03: member chỉ có booking với PT khác → 404 giống memberId không tồn tại, không lộ tên', async () => {
      const me = await trainer('PT Mot');
      const other = await trainer('PT Hai');
      const theirs = await trainee('Ten Bi Mat');
      await insertBooking(theirs, other.trainerId, at(3), 'BOOKED');

      const foreign = await detail(me, theirs);
      const missing = await detail(me, new ObjectId().toHexString());

      expectError(foreign, 404);
      expectError(missing, 404);
      expect(foreign.body.error.code).toBe(missing.body.error.code);
      expect(JSON.stringify(foreign.body)).not.toContain('Ten Bi Mat');
      expectError(await bookings(me, theirs, wide), 404);
      expectError(await memberships(me, theirs), 404);
    });

    it.each([
      ['detail', ''],
      ['bookings', '/bookings'],
      ['memberships', '/memberships'],
    ])('US-30-TC03: memberId sai định dạng ở %s → 400, không phải 500', async (_name, suffix) => {
      const pt = await trainer();
      expectError(await get(pt, `/khong-phai-objectid${suffix}`, suffix === '/bookings' ? wide : {}), 400);
    });

    it('US-30-TC03: truyền trainerId của PT khác vào query bookings → 400, không xem được lịch PT kia', async () => {
      const me = await trainer('PT Mot');
      const other = await trainer('PT Hai');
      const an = await trainee();
      await insertBooking(an, me.trainerId, at(2), 'BOOKED');
      const theirs = await insertBooking(an, other.trainerId, at(3), 'BOOKED');

      const response = await bookings(me, an, { ...wide, trainerId: other.trainerId.toHexString() });

      expectError(response, 400);
      expect(JSON.stringify(response.body)).not.toContain(theirs);
    });
  });

  describe('US-30-TC04: sai role hoặc PT chưa link (phần chi tiết)', () => {
    it.each(['MEMBER', 'STAFF', 'ADMIN'] as const)('US-30-TC04: %s gọi detail, bookings, memberships → 403', async role => {
      const pt = await trainer();
      const an = await trainee();
      await insertBooking(an, pt.trainerId, at(3), 'BOOKED');
      const owner = await account(role, `Nguoi dung ${role}`);
      const actor = { accessToken: await loginAs(owner.phone) };

      expectError(await detail(actor, an), 403);
      expectError(await bookings(actor, an, wide), 403);
      expectError(await memberships(actor, an), 403);
    });

    it('US-30-TC04: không gửi token → 401', async () => {
      expectError(await http().get(`${base}/${new ObjectId().toHexString()}`).set('Origin', origin), 401);
    });

    it('US-30-TC04: tài khoản TRAINER chưa có hồ sơ trainers → 404 cho mọi memberId', async () => {
      const pt = await trainer();
      const an = await trainee();
      await insertBooking(an, pt.trainerId, at(3), 'BOOKED');
      const owner = await account('TRAINER', 'PT Chua Lien Ket');
      const unlinked = { accessToken: await loginAs(owner.phone) };

      expectError(await detail(unlinked, an), 404);
      expectError(await bookings(unlinked, an, wide), 404);
      expectError(await memberships(unlinked, an), 404);
    });
  });

  // =====================================================================
  // AC02 – Privacy và quota liên quan (TC05–TC08)
  // =====================================================================

  describe('US-30-TC05: member có lịch với hai PT', () => {
    it('US-30-TC05: mỗi PT chỉ thấy buổi của mình trong /bookings, không thấy buổi hay tên PT kia', async () => {
      const ptA = await trainer('PT Mot');
      const ptB = await trainer('PT Hai');
      const an = await trainee();
      const aBooked = await insertBooking(an, ptA.trainerId, at(2), 'BOOKED', { trainerName: 'PT Mot' });
      const aDone = await insertBooking(an, ptA.trainerId, at(-2), 'COMPLETED', { trainerName: 'PT Mot' });
      const bBooked = await insertBooking(an, ptB.trainerId, at(3), 'BOOKED', { trainerName: 'PT Hai Bi Mat', location: 'Phong VIP Hai' });

      const forA = await bookings(ptA, an, wide).expect(200);
      const forB = await bookings(ptB, an, wide).expect(200);

      expect(ids(forA.body).sort()).toEqual([aBooked, aDone].sort());
      expect(forA.body.total).toBe(2);
      const textA = JSON.stringify(forA.body);
      expect(textA).not.toContain(bBooked);
      expect(textA).not.toContain('PT Hai Bi Mat');
      expect(textA).not.toContain('Phong VIP Hai');
      expect(textA).not.toContain(ptB.trainerId.toHexString());
      expect(ids(forB.body)).toEqual([bBooked]);
    });

    it('US-30-TC05: /bookings sắp startAt tăng dần và có phân trang', async () => {
      const pt = await trainer();
      const an = await trainee();
      const third = await insertBooking(an, pt.trainerId, at(5), 'BOOKED');
      const first = await insertBooking(an, pt.trainerId, at(-5), 'COMPLETED');
      const second = await insertBooking(an, pt.trainerId, at(1), 'BOOKED');

      const page1 = await bookings(pt, an, { ...wide, page: 1, limit: 2 }).expect(200);
      const page2 = await bookings(pt, an, { ...wide, page: 2, limit: 2 }).expect(200);

      expect(page1.body).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(ids(page1.body)).toEqual([first, second]);
      expect(ids(page2.body)).toEqual([third]);
      expect(page1.body.items[0]).toMatchObject({ status: 'COMPLETED', startAt: at(-5).toISOString() });
    });

    it('US-30-TC05: CANCELLED cũ vẫn được xem khi còn quan hệ hợp lệ; lọc status chỉ trả đúng trạng thái', async () => {
      const pt = await trainer();
      const an = await trainee();
      const booked = await insertBooking(an, pt.trainerId, at(4), 'BOOKED');
      const cancelled = await insertBooking(an, pt.trainerId, at(-4), 'CANCELLED');

      const all = await bookings(pt, an, wide).expect(200);
      const onlyCancelled = await bookings(pt, an, { ...wide, status: 'CANCELLED' }).expect(200);

      expect(ids(all.body)).toEqual([cancelled, booked]);
      expect(ids(onlyCancelled.body)).toEqual([cancelled]);
    });

    it('US-30-TC05: fromDate và toDate bao gồm cả hai ngày đầu và cuối', async () => {
      const pt = await trainer();
      const an = await trainee();
      const onFrom = await insertBooking(an, pt.trainerId, at(2, '00:00'), 'BOOKED');
      const onTo = await insertBooking(an, pt.trainerId, at(4, '23:00'), 'BOOKED');
      await insertBooking(an, pt.trainerId, at(5, '00:30'), 'BOOKED');

      const response = await bookings(pt, an, { fromDate: vnDay(2), toDate: vnDay(4) }).expect(200);

      expect(ids(response.body)).toEqual([onFrom, onTo]);
    });

    it('US-30-TC05: không truyền ngày → mặc định tuần hiện tại, có buổi của hôm nay', async () => {
      const pt = await trainer();
      const an = await trainee();
      const today = await insertBooking(an, pt.trainerId, at(0, '12:00'), 'BOOKED');
      await insertBooking(an, pt.trainerId, at(-20), 'COMPLETED');

      const response = await bookings(pt, an).expect(200);

      expect(ids(response.body)).toEqual([today]);
    });

    it.each([
      ['khoảng 32 ngày', { fromDate: vnDay(0), toDate: vnDay(31) }],
      ['fromDate sau toDate', { fromDate: vnDay(5), toDate: vnDay(1) }],
      ['ngày sai định dạng', { fromDate: '20/11/2026', toDate: vnDay(1) }],
      ['ngày không có thật', { fromDate: '2026-02-30', toDate: '2026-03-02' }],
      ['status lạ', { ...{ fromDate: vnDay(0), toDate: vnDay(1) }, status: 'DONE' }],
      ['limit vượt 100', { ...{ fromDate: vnDay(0), toDate: vnDay(1) }, limit: 101 }],
    ])('US-30-TC05: /bookings %s → 400', async (_name, query) => {
      const pt = await trainer();
      const an = await trainee();
      await insertBooking(an, pt.trainerId, at(1), 'BOOKED');
      expectError(await bookings(pt, an, query), 400);
    });

    it('US-30-TC05: /bookings khoảng đúng 31 ngày → 200', async () => {
      const pt = await trainer();
      const an = await trainee();
      await insertBooking(an, pt.trainerId, at(1), 'BOOKED');
      await bookings(pt, an, { fromDate: vnDay(0), toDate: vnDay(30) }).expect(200);
    });
  });

  describe('US-30-TC06: quota shared 10, used 3, BOOKED 4 thuộc hai PT', () => {
    it('US-30-TC06: reserved=4 (đếm cả buổi của PT khác), available=3, quota lấy từ sale', async () => {
      const ptA = await trainer('PT Mot');
      const ptB = await trainer('PT Hai');
      const an = await trainee();
      const shared = await insertMembership(an.memberId, { quota: 10, used: 3, planQuota: 99 });
      await insertBooking(an, ptA.trainerId, at(1), 'BOOKED', { membershipId: shared });
      await insertBooking(an, ptA.trainerId, at(2), 'BOOKED', { membershipId: shared });
      await insertBooking(an, ptB.trainerId, at(3), 'BOOKED', { membershipId: shared, trainerName: 'PT Hai Bi Mat' });
      await insertBooking(an, ptB.trainerId, at(4), 'BOOKED', { membershipId: shared, trainerName: 'PT Hai Bi Mat' });
      // Buổi CANCELLED không giữ chỗ quota.
      await insertBooking(an, ptB.trainerId, at(5), 'CANCELLED', { membershipId: shared });

      const response = await memberships(ptA, an).expect(200);

      expect(membershipOf(response.body, shared)).toMatchObject({
        id: shared.toHexString(), kind: 'PT', storedStatus: 'ACTIVE', quota: 10, sessionsUsed: 3, reserved: 4, available: 3,
      });
      const text = JSON.stringify(response.body);
      expect(text).not.toContain('PT Hai Bi Mat');
      expect(text).not.toContain(ptB.trainerId.toHexString());
    });

    it('US-30-TC06: mỗi item gói đúng các field trong hợp đồng, có startDate/endDate từ sale và có asOf', async () => {
      const pt = await trainer();
      const an = await trainee();
      const membershipId = await insertMembership(an.memberId, { startDate: '2026-10-01', endDate: '2026-12-31' });
      await insertBooking(an, pt.trainerId, at(2), 'BOOKED', { membershipId });

      const response = await memberships(pt, an).expect(200);

      expect(response.body).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
      expect(Object.keys(response.body.items[0]).sort()).toEqual(MEMBERSHIP_FIELDS);
      expect(response.body.items[0]).toMatchObject({ startDate: '2026-10-01', endDate: '2026-12-31' });
      const asOf = response.body.asOf ?? response.body.items[0].asOf;
      expect(Number.isNaN(Date.parse(String(asOf)))).toBe(false);
    });

    it('US-30-TC06: GET memberships không sửa sessions_used hay trạng thái gói', async () => {
      const pt = await trainer();
      const an = await trainee();
      const membershipId = await insertMembership(an.memberId, { quota: 10, used: 3 });
      await insertBooking(an, pt.trainerId, at(2), 'BOOKED', { membershipId });
      const before = await db().collection('memberships').findOne({ _id: membershipId });

      await memberships(pt, an).expect(200);

      expect(await db().collection('memberships').findOne({ _id: membershipId })).toEqual(before);
    });
  });

  describe('US-30-TC07: member có GYM và một gói PT không liên quan', () => {
    it('US-30-TC07: chỉ trả gói có booking BOOKED/COMPLETED với chính PT; không trả GYM, gói PT khác hay gói chỉ có CANCELLED', async () => {
      const me = await trainer('PT Mot');
      const other = await trainer('PT Hai');
      const an = await trainee();
      const related = an.membershipId;
      const gym = await insertMembership(an.memberId, { kind: 'GYM' });
      const otherPtOnly = await insertMembership(an.memberId);
      const cancelledOnly = await insertMembership(an.memberId);
      const unused = await insertMembership(an.memberId);
      await insertBooking(an, me.trainerId, at(2), 'BOOKED', { membershipId: related });
      await insertBooking(an, other.trainerId, at(3), 'BOOKED', { membershipId: otherPtOnly });
      await insertBooking(an, me.trainerId, at(4), 'CANCELLED', { membershipId: cancelledOnly });

      const response = await memberships(me, an).expect(200);

      expect(ids(response.body)).toEqual([related.toHexString()]);
      expect(response.body.total).toBe(1);
      const text = JSON.stringify(response.body);
      for (const hidden of [gym, otherPtOnly, cancelledOnly, unused]) expect(text).not.toContain(hidden.toHexString());
    });
  });

  describe('US-30-TC08: payload detail không có contact/tiền/credentials', () => {
    it('US-30-TC08: detail trả đúng 4 field {memberId, memberCode, fullName, hasUpcoming}', async () => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen');
      await insertBooking(an, pt.trainerId, at(2), 'BOOKED');

      const response = await detail(pt, an).expect(200);

      expect(Object.keys(response.body).sort()).toEqual(DETAIL_FIELDS);
      expect(response.body).toEqual({
        memberId: an.memberId.toHexString(), memberCode: an.memberCode, fullName: 'Anh Nguyen', hasUpcoming: true,
      });
    });

    it('US-30-TC08: detail, bookings, memberships không chứa phone/email/địa chỉ/ngày sinh/sức khỏe/tài khoản/tiền', async () => {
      const pt = await trainer();
      const an = await trainee();
      await insertBooking(an, pt.trainerId, at(2), 'BOOKED');
      const member = await db().collection('members').findOne({ _id: an.memberId });

      const responses = await Promise.all([detail(pt, an), bookings(pt, an, wide), memberships(pt, an)]);

      for (const response of responses) {
        expect(response.status).toBe(200);
        const text = JSON.stringify(response.body);
        expect(text).not.toContain(String(member?.phone));
        expect(text).not.toContain('@gym.test');
        expect(text).not.toContain('Nguyen Trai');
        expect(text).not.toContain('1995-05-20');
        expect(text).not.toContain('Dau lung nhe');
        expect(text).not.toContain(String(member?.account_id));
        expect(text).not.toContain('3456789');
        expect(text).not.toMatch(/price|amount|credit|password|phone|email|address|birth/i);
      }
    });

    it('US-30-TC08: tên chứa HTML được trả nguyên văn như chuỗi trong detail', async () => {
      const pt = await trainer();
      const html = await trainee('<img src=x onerror=alert(1)>');
      await insertBooking(html, pt.trainerId, at(2), 'BOOKED');

      const response = await detail(pt, html).expect(200);

      expect(response.body.fullName).toBe('<img src=x onerror=alert(1)>');
    });
  });

  // =====================================================================
  // AC03 – phần chi tiết: nâng cấp (TC10), COMPLETED lịch sử và BOOKED quá giờ (TC11)
  // =====================================================================

  describe('US-30-TC10: upgrade chuyển BOOKED sang gói mới, COMPLETED giữ gói cũ', () => {
    it('US-30-TC10: trả cả gói cũ SUPERSEDED và gói mới, mỗi gói số liệu riêng, không cộng used của gói cũ vào gói mới', async () => {
      const pt = await trainer();
      const an = await trainee();
      const oldPack = await insertMembership(an.memberId, { quota: 10, used: 4, status: 'SUPERSEDED' });
      // Gói mới sau nâng cấp: quota mang sang đã nằm trong sessions_snapshot của sale UPGRADE (20), used bắt đầu từ 0.
      const newPack = await insertMembership(an.memberId, { quota: 20, used: 0, operation: 'UPGRADE' });
      await insertBooking(an, pt.trainerId, at(-10), 'COMPLETED', { membershipId: oldPack });
      await insertBooking(an, pt.trainerId, at(3), 'BOOKED', { membershipId: newPack });
      await insertBooking(an, pt.trainerId, at(5), 'BOOKED', { membershipId: newPack });

      const response = await memberships(pt, an).expect(200);

      expect(response.body.total).toBe(2);
      expect(membershipOf(response.body, oldPack)).toMatchObject({ storedStatus: 'SUPERSEDED', quota: 10, sessionsUsed: 4, reserved: 0 });
      expect(membershipOf(response.body, newPack)).toMatchObject({ storedStatus: 'ACTIVE', quota: 20, sessionsUsed: 0, reserved: 2, available: 18 });
    });

    it('US-30-TC10: /bookings theo member_id: buổi gắn gói cũ và gói mới đều hiện', async () => {
      const pt = await trainer();
      const an = await trainee();
      const oldPack = await insertMembership(an.memberId, { status: 'SUPERSEDED' });
      const newPack = await insertMembership(an.memberId, { operation: 'UPGRADE' });
      const done = await insertBooking(an, pt.trainerId, at(-3), 'COMPLETED', { membershipId: oldPack });
      const booked = await insertBooking(an, pt.trainerId, at(3), 'BOOKED', { membershipId: newPack });

      const response = await bookings(pt, an, wide).expect(200);

      expect(ids(response.body)).toEqual([done, booked]);
    });
  });

  describe('US-30-TC11: chỉ còn COMPLETED lịch sử hoặc BOOKED quá giờ (phần chi tiết)', () => {
    it('US-30-TC11: chỉ còn COMPLETED → detail 200 hasUpcoming=false, xem được lịch sử và gói của buổi đó', async () => {
      const pt = await trainer();
      const an = await trainee();
      const done = await insertBooking(an, pt.trainerId, at(-10), 'COMPLETED');
      await insertBooking(an, pt.trainerId, at(3), 'CANCELLED');

      const profile = await detail(pt, an).expect(200);
      const history = await bookings(pt, an, wide).expect(200);
      const packs = await memberships(pt, an).expect(200);

      expect(profile.body.hasUpcoming).toBe(false);
      expect(ids(history.body)).toContain(done);
      expect(ids(packs.body)).toEqual([an.membershipId.toHexString()]);
    });

    it('US-30-TC11: chỉ còn COMPLETED với gói cũ → không tự có quyền xem gói mới chưa có booking với PT', async () => {
      const pt = await trainer();
      const an = await trainee();
      await insertBooking(an, pt.trainerId, at(-10), 'COMPLETED');
      const newPack = await insertMembership(an.memberId, { quota: 12 });

      const response = await memberships(pt, an).expect(200);

      expect(ids(response.body)).toEqual([an.membershipId.toHexString()]);
      expect(JSON.stringify(response.body)).not.toContain(newPack.toHexString());
    });

    it('US-30-TC11: BOOKED quá giờ chưa xử lý → detail 200; GET không tự hoàn tất hay đổi version', async () => {
      const pt = await trainer();
      const an = await trainee();
      const overdue = await insertBooking(an, pt.trainerId, at(-2), 'BOOKED');

      await detail(pt, an).expect(200);
      const history = await bookings(pt, an, wide).expect(200);
      await memberships(pt, an).expect(200);

      expect(history.body.items[0]).toMatchObject({ id: overdue, status: 'BOOKED' });
      const stored = await db().collection('pt_bookings').findOne({ _id: new ObjectId(overdue) });
      expect(stored).toMatchObject({ status: 'BOOKED', version: 0 });
      expect(stored?.completed_at).toBeUndefined();
    });
  });
});
