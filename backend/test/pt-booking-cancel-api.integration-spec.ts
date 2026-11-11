// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật): US-29 bước 3.
// Kiểm tra API hủy buổi PT của Member (own) và của Staff/Admin (support), API tra cứu/chi tiết hỗ trợ, quyền cố định/Guard,
// Idempotency-Key + operation_requests (gửi lại cùng key, khác payload, tra cứu khi mất response) và lỗi theo EN01-D03 (TC01–TC09, TC12).
// Hợp đồng test đặt ra cho Builder (US-29 bước 3, theo mục 2 của spec; sinh viên chốt replay/operation_requests ở bước 3):
//   Quyền cố định trong ACCESS_POLICY: ptBookings.cancelOwn = [MEMBER]; ptBookings.readSupport, ptBookings.cancelSupport = [STAFF, ADMIN].
//   POST /api/me/pt-bookings/:id/cancel – MEMBER owner; header Idempotency-Key (UUID); operation PT_BOOKING_CANCEL_OWN;
//     body CHỈ {version, reason} (field khác → 400). 200 {id, status:'CANCELLED', version, cancelledAt, notificationState}.
//   POST /api/pt-bookings/:id/cancel – STAFF/ADMIN; operation PT_BOOKING_CANCEL_SUPPORT; cùng body, cùng CancelBookingService.
//   GET /api/pt-bookings – STAFF/ADMIN; query fromDate, toDate (YYYY-MM-DD ngày VN), memberId?, trainerId?, status?, page?, limit?;
//     mặc định page 1, limit 20; limit ≤ 100; khoảng ngày ≤ 31 ngày; sắp startAt rồi id tăng dần.
//     Trả {items, page, limit, total, totalPages}; mỗi item {id, memberId, memberCode, memberName, trainerId, trainerName,
//     startAt, endAt, location, status, version}. Không có mật khẩu, request_key hay số tiền/giao dịch.
//   GET /api/pt-bookings/:id – STAFF/ADMIN; cùng field như item ở trên (có version và memberId để hủy).
//   Cùng key + cùng payload đã commit → trả lại HTTP/body gốc, không hủy/thông báo lần hai; khác payload → 409 IDEMPOTENCY_CONFLICT;
//     key mới trên booking đã CANCELLED → 409 INVALID_BOOKING_STATE. Tra cứu: GET /api/operations/<operation>/<key> (EN-02, như US-28).
//   Lỗi: {error:{code,message,details?},requestId}; 400 VALIDATION_ERROR; 401; 403; 404 NOT_FOUND; 409; 503 không lộ lỗi MongoDB thô.
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
import { ACCESS_POLICY } from '../src/modules/users/access.policy';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us29_api';
const password = 'MậtKhẩuUS-29-789';
const REASON = 'Bận việc gia đình đột xuất';
const MINUTE = 60 * 1000;
const CANCEL_FIELDS = ['cancelledAt', 'id', 'notificationState', 'status', 'version'];
const SUPPORT_FIELDS = ['endAt', 'id', 'location', 'memberCode', 'memberId', 'memberName', 'startAt', 'status', 'trainerId', 'trainerName', 'version'];

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Auth = { accessToken: string };

describe('US-29 bước 3: API hủy own/support, tra cứu hỗ trợ, quyền và idempotency', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      // enableTestCommands=1 để dùng failpoint failCommand giả lập lỗi insert trước commit (TC12).
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName, args: ['--setParameter', 'enableTestCommands=1'] },
    });
    Object.assign(process.env, {
      NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(), MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'us29-test', SMTP_PASS: 'us29-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await db().collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    await db().collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
  });

  afterEach(async () => {
    await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());

  // ---------- Thời gian ----------
  const minutesAhead = (minutes: number) => new Date(Math.ceil((Date.now() + minutes * MINUTE) / MINUTE) * MINUTE);
  const minutesAgo = (minutes: number) => new Date(Math.floor((Date.now() - minutes * MINUTE) / MINUTE) * MINUTE);
  const VN_OFFSET_MS = 7 * 60 * MINUTE;
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * MINUTE).toISOString().slice(0, 10);
  const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+07:00`);

  // ---------- Tài khoản và dữ liệu mẫu (khuôn US-28) ----------
  let phoneSeq = 0;
  async function account(roleCode: Role, fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0915900${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: String(created.id), phone };
  }
  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }
  async function user(roleCode: Role, fullName: string) {
    const created = await account(roleCode, fullName);
    return { ...created, accessToken: await loginAs(created.phone) };
  }

  async function trainer(fullName = 'PT Lê Văn Cường') {
    const owner = await user('TRAINER', fullName);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: new ObjectId(owner.accountId), specialty: 'Thể hình', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, ...owner };
  }

  async function linkedMember(name = 'Hội viên US29 B3') {
    const owner = await user('MEMBER', name);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: name, phone: owner.phone,
      account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { memberId, memberCode: `HV-${memberId.toHexString()}`, ...owner };
  }

  let saleSeq = 0;
  async function insertPlan(memberId: ObjectId) {
    saleSeq += 1;
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const staffId = new ObjectId();
    const now = new Date();
    const money = Decimal128.fromString('3000000');
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US29B3-${saleSeq}`, name: `Gói PT ${saleSeq}`, kind: 'PT', duration_days: 30,
      session_quota: 10, price: money, benefits: 'Quyền lợi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US29B3-${saleSeq}`, kind: 'PT', amount_due: money,
      status: 'SETTLED', request_key: randomBytes(32).toString('hex'), created_at: now, guard_revision: Long.ZERO,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: vnDay(-5), end_date: vnDay(30), plan_name_snapshot: `Gói PT ${saleSeq}`,
      benefits_snapshot: 'Quyền lợi', list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: 10,
      policy_snapshot: 'Giá niêm yết', created_at: now,
    });
    await db().collection('memberships').insertOne({ _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: 2 });
    return membershipId;
  }

  async function insertBooking(memberId: ObjectId, membershipId: ObjectId, trainerId: ObjectId, start: Date, extra: Record<string, unknown> = {}) {
    const id = new ObjectId();
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: membershipId, member_id: memberId, trainer_id: trainerId, shift_id: new ObjectId(),
      start_at: start, end_at: new Date(start.getTime() + 60 * MINUTE), status: 'BOOKED', request_key: randomBytes(32).toString('hex'),
      version: 0, trainer_name_snapshot: 'PT Lê Văn Cường', location_snapshot: 'Phòng PT 1', created_at: new Date(), updated_at: new Date(),
      ...extra,
    });
    return id;
  }

  async function ready(start: Date = minutesAhead(180)) {
    const me = await linkedMember();
    const membershipId = await insertPlan(me.memberId);
    const pt = await trainer();
    const bookingId = await insertBooking(me.memberId, membershipId, pt.trainerId, start);
    return { me, membershipId, pt, bookingId };
  }

  // ---------- Gọi API ----------
  function post(path: string, auth: Auth | undefined, body: Record<string, unknown>, key: string | null = randomUUID()) {
    let call = http().post(path).set('Origin', origin);
    if (auth) call = call.set('Authorization', `Bearer ${auth.accessToken}`);
    if (key !== null) call = call.set('Idempotency-Key', key);
    return call.send(body);
  }
  const cancelOwn = (auth: Auth | undefined, bookingId: ObjectId | string, body: Record<string, unknown> = { version: 0, reason: REASON }, key?: string | null) =>
    post(`/api/me/pt-bookings/${String(bookingId)}/cancel`, auth, body, key);
  const cancelSupport = (auth: Auth | undefined, bookingId: ObjectId | string, body: Record<string, unknown> = { version: 0, reason: REASON }, key?: string | null) =>
    post(`/api/pt-bookings/${String(bookingId)}/cancel`, auth, body, key);
  const get = (path: string, auth: Auth, query: Record<string, string | number> = {}) =>
    http().get(path).query(query).set('Origin', origin).set('Authorization', `Bearer ${auth.accessToken}`);

  function expectError(response: request.Response, status: number, code?: string) {
    expect(response.status).toBe(status);
    expect(typeof response.body.error?.code).toBe('string');
    expect(typeof response.body.error?.message).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
    if (code) expect(response.body.error.code).toBe(code);
  }

  const bookingDoc = (id: ObjectId) => db().collection('pt_bookings').findOne({ _id: id });
  const count = (collection: string, filter: Record<string, unknown> = {}) => db().collection(collection).countDocuments(filter);
  async function quotaOf(auth: Auth, membershipId: ObjectId) {
    const response = await get(`/api/me/memberships/${membershipId.toHexString()}`, auth).expect(200);
    const { sessionsUsed, sessionsReserved, sessionsAvailable } = response.body as Record<string, number>;
    return { sessionsUsed, sessionsReserved, sessionsAvailable };
  }

  async function failInsertsOn(collection: string, work: () => Promise<void>) {
    await db().admin().command({
      configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: ['insert'], namespace: `${databaseName}.${collection}`, errorCode: 1, errmsg: 'Giả lập DB lỗi US-29-TC12 bước 3' },
    });
    try {
      await work();
    } finally {
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
  }

  // =====================================================================
  // AC01 – Ownership và ranh giới 2 giờ qua API (TC01–TC04)
  // =====================================================================

  describe('US-29-TC01: Member hủy BOOKED khi còn trên 2 giờ qua API', () => {
    it('US-29-TC01: POST /api/me/pt-bookings/:id/cancel → 200 đúng field {id, status CANCELLED, version 1, cancelledAt ISO, notificationState STORED}', async () => {
      const { me, bookingId } = await ready();

      const response = await cancelOwn(me, bookingId);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(CANCEL_FIELDS);
      expect(response.body).toMatchObject({ id: bookingId.toHexString(), status: 'CANCELLED', version: 1, notificationState: 'STORED' });
      expect(response.body.cancelledAt).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
    });

    it('US-29-TC01: sau khi hủy, quota của gói có reserved giảm 1, used giữ nguyên; lịch riêng US-27 thấy CANCELLED, cancelAllowed false', async () => {
      const { me, membershipId, bookingId } = await ready();
      const before = await quotaOf(me, membershipId);

      await cancelOwn(me, bookingId).expect(200);

      const after = await quotaOf(me, membershipId);
      expect(after.sessionsReserved).toBe(before.sessionsReserved - 1);
      expect(after.sessionsUsed).toBe(before.sessionsUsed);
      const detail = await get(`/api/me/pt-bookings/${bookingId.toHexString()}`, me).expect(200);
      expect(detail.body).toMatchObject({ status: 'CANCELLED', version: 1, cancelAllowed: false });
    });

    it('US-29-TC01: chưa đăng nhập → 401, booking giữ nguyên', async () => {
      const { bookingId } = await ready();

      expectError(await cancelOwn(undefined, bookingId), 401);
      expect((await bookingDoc(bookingId))?.status).toBe('BOOKED');
    });
  });

  describe('US-29-TC02: còn dưới 2 giờ, đã qua giờ hoặc sửa clock client → 409, server clock quyết định', () => {
    it('US-29-TC02: còn 1 giờ 59 phút 59 giây → 409 CANCELLATION_WINDOW_CLOSED đúng khuôn lỗi', async () => {
      const { me, bookingId } = await ready(new Date(Date.now() + 119 * MINUTE + 59 * 1000));

      expectError(await cancelOwn(me, bookingId), 409, 'CANCELLATION_WINDOW_CLOSED');
      expect((await bookingDoc(bookingId))?.status).toBe('BOOKED');
    });

    it('US-29-TC02: header Date của client lùi 1 ngày (giả vờ còn sớm) → vẫn 409 theo giờ server', async () => {
      const { me, bookingId } = await ready(minutesAhead(30));

      const response = await http().post(`/api/me/pt-bookings/${bookingId.toHexString()}/cancel`).set('Origin', origin)
        .set('Authorization', `Bearer ${me.accessToken}`).set('Idempotency-Key', randomUUID())
        .set('Date', new Date(Date.now() - 24 * 60 * MINUTE).toUTCString()).send({ version: 0, reason: REASON });

      expectError(response, 409, 'CANCELLATION_WINDOW_CLOSED');
    });

    it.each(['now', 'clientNow', 'requestedAt'])('US-29-TC02: body gửi kèm giờ client "%s" (field ngoài allowlist) → 400, không dùng giờ client', async field => {
      const { me, bookingId } = await ready(minutesAhead(30));

      expectError(await cancelOwn(me, bookingId, { version: 0, reason: REASON, [field]: new Date(Date.now() - 24 * 60 * MINUTE).toISOString() }), 400, 'VALIDATION_ERROR');
      expect((await bookingDoc(bookingId))?.status).toBe('BOOKED');
    });
  });

  describe('US-29-TC03: hủy booking người khác hoặc PT gọi own/support → 404/403, không lộ dữ liệu', () => {
    it('US-29-TC03: Member B hủy booking của Member A → 404 NOT_FOUND, body không có id/tên/mã của A hay tên PT', async () => {
      const { me, bookingId } = await ready();
      const other = await linkedMember('Hội viên Khác');

      const response = await cancelOwn(other, bookingId);

      expectError(response, 404, 'NOT_FOUND');
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(me.memberId.toHexString());
      expect(text).not.toContain(me.memberCode);
      expect(text).not.toContain('Hội viên US29 B3');
      expect(text).not.toContain('PT Lê Văn Cường');
      expect((await bookingDoc(bookingId))?.status).toBe('BOOKED');
    });

    it('US-29-TC03: booking không tồn tại → cùng 404 NOT_FOUND', async () => {
      const me = await linkedMember();

      expectError(await cancelOwn(me, new ObjectId()), 404, 'NOT_FOUND');
    });

    it('US-29-TC03: PT của buổi gọi API own → 403; gọi API support → 403; booking giữ nguyên', async () => {
      const { pt, bookingId } = await ready();

      expectError(await cancelOwn(pt, bookingId), 403);
      expectError(await cancelSupport(pt, bookingId), 403);
      expect((await bookingDoc(bookingId))?.status).toBe('BOOKED');
    });

    it('US-29-TC03: PT gọi GET /api/pt-bookings và GET /api/pt-bookings/:id → 403, không thấy dữ liệu hỗ trợ', async () => {
      const { pt, bookingId } = await ready();

      expectError(await get('/api/pt-bookings', pt, { fromDate: vnDay(0), toDate: vnDay(1) }), 403);
      expectError(await get(`/api/pt-bookings/${bookingId.toHexString()}`, pt), 403);
    });

    it('US-29-TC03: quyền cố định: ptBookings.cancelOwn chỉ MEMBER; readSupport và cancelSupport chỉ STAFF, ADMIN', () => {
      const policy = ACCESS_POLICY as unknown as Record<string, { roles: string[] }>;

      expect([...policy['ptBookings.cancelOwn'].roles].sort()).toEqual(['MEMBER']);
      expect([...policy['ptBookings.readSupport'].roles].sort()).toEqual(['ADMIN', 'STAFF']);
      expect([...policy['ptBookings.cancelSupport'].roles].sort()).toEqual(['ADMIN', 'STAFF']);
    });
  });

  describe('US-29-TC04: membership đổi sau nâng cấp; version cũ 409 và tải lại trước hủy', () => {
    it('US-29-TC04: booking đã sang gói mới (version 1), client gửi version 0 → 409 VERSION_CONFLICT; tải lại lịch riêng lấy version 1 rồi hủy → 200', async () => {
      const { me, bookingId } = await ready();
      const newMembershipId = await insertPlan(me.memberId);
      await db().collection('pt_bookings').updateOne({ _id: bookingId }, { $set: { membership_id: newMembershipId, version: 1 } });

      expectError(await cancelOwn(me, bookingId, { version: 0, reason: REASON }), 409, 'VERSION_CONFLICT');

      const reloaded = await get(`/api/me/pt-bookings/${bookingId.toHexString()}`, me).expect(200);
      expect(reloaded.body.version).toBe(1);
      const response = await cancelOwn(me, bookingId, { version: reloaded.body.version, reason: REASON });
      expect(response.status).toBe(200);
      expect(response.body.version).toBe(2);
    });
  });

  // =====================================================================
  // AC02 – Hỗ trợ: tra cứu, chi tiết, hủy có lý do (TC05–TC08)
  // =====================================================================

  describe('US-29-TC05: Staff/Admin tra cứu, xem chi tiết và hủy hỗ trợ sát giờ/đã qua giờ có lý do', () => {
    it('US-29-TC05: STAFF hủy buổi còn 30 phút qua POST /api/pt-bookings/:id/cancel → 200 CANCELLED; audit actor_role STAFF, lý do đã trim', async () => {
      const { bookingId } = await ready(minutesAhead(30));
      const staff = await user('STAFF', 'Nhân viên Quầy');

      const response = await cancelSupport(staff, bookingId, { version: 0, reason: `  ${REASON}  ` });

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(CANCEL_FIELDS);
      expect(response.body).toMatchObject({ status: 'CANCELLED', version: 1 });
      const event = await db().collection('booking_events').findOne({ booking_id: bookingId });
      expect(event).toMatchObject({ actor_role: 'STAFF', reason: REASON });
    });

    it('US-29-TC05: ADMIN hủy buổi đã qua giờ (no show) → 200 CANCELLED, audit actor_role ADMIN', async () => {
      const { bookingId } = await ready(minutesAgo(24 * 60));
      const admin = await user('ADMIN', 'Quản trị viên');

      await cancelSupport(admin, bookingId).expect(200);

      expect((await db().collection('booking_events').findOne({ booking_id: bookingId }))?.actor_role).toBe('ADMIN');
    });

    it('US-29-TC05: GET /api/pt-bookings/:id → chi tiết đúng field, có version hiện tại, memberId, mã/tên Member và tên PT; không lộ mật khẩu, request_key, tiền', async () => {
      const { me, pt, bookingId } = await ready();
      await db().collection('pt_bookings').updateOne({ _id: bookingId }, { $set: { version: 4 } });
      const staff = await user('STAFF', 'Nhân viên Quầy');

      const response = await get(`/api/pt-bookings/${bookingId.toHexString()}`, staff).expect(200);

      expect(Object.keys(response.body).sort()).toEqual(SUPPORT_FIELDS);
      expect(response.body).toMatchObject({
        id: bookingId.toHexString(), memberId: me.memberId.toHexString(), memberCode: me.memberCode, memberName: 'Hội viên US29 B3',
        trainerId: pt.trainerId.toHexString(), trainerName: 'PT Lê Văn Cường', status: 'BOOKED', version: 4, location: 'Phòng PT 1',
      });
      expect(JSON.stringify(response.body)).not.toMatch(/password|request_?key|requestKey|3000000|amount/i);
    });

    it('US-29-TC05: GET /api/pt-bookings/:id không tồn tại → 404 NOT_FOUND', async () => {
      const staff = await user('STAFF', 'Nhân viên Quầy');

      expectError(await get(`/api/pt-bookings/${new ObjectId().toHexString()}`, staff), 404, 'NOT_FOUND');
    });

    it('US-29-TC05: GET /api/pt-bookings lọc theo ngày + memberId + status → chỉ buổi khớp, sắp startAt rồi id, đúng field, mặc định page 1 limit 20', async () => {
      const day = vnDay(10);
      const { me, membershipId, pt } = await ready(at(day, '10:00'));
      const early = await insertBooking(me.memberId, membershipId, pt.trainerId, at(day, '08:00'));
      await insertBooking(me.memberId, membershipId, pt.trainerId, at(day, '12:00'), { status: 'CANCELLED' });
      const other = await linkedMember('Hội viên Khác');
      await insertBooking(other.memberId, await insertPlan(other.memberId), pt.trainerId, at(day, '09:00'));
      const staff = await user('STAFF', 'Nhân viên Quầy');

      const response = await get('/api/pt-bookings', staff, { fromDate: day, toDate: day, memberId: me.memberId.toHexString(), status: 'BOOKED' }).expect(200);

      expect(response.body).toMatchObject({ page: 1, limit: 20, total: 2 });
      const items = response.body.items as Record<string, unknown>[];
      expect(items.map(item => item.startAt).map(value => new Date(String(value)).toISOString()))
        .toEqual([at(day, '08:00').toISOString(), at(day, '10:00').toISOString()]);
      expect(items[0].id).toBe(early.toHexString());
      expect(Object.keys(items[0]).sort()).toEqual(SUPPORT_FIELDS);
      expect(items[0]).toMatchObject({ memberCode: me.memberCode, memberName: 'Hội viên US29 B3', trainerName: 'PT Lê Văn Cường' });
      expect(JSON.stringify(response.body)).not.toMatch(/password|request_?key|requestKey|3000000|amount/i);
    });

    it('US-29-TC05: GET /api/pt-bookings lọc theo trainerId → chỉ buổi của PT đó', async () => {
      const day = vnDay(10);
      const { me, membershipId } = await ready(at(day, '10:00'));
      const otherPt = await trainer('PT Phạm Thị Dung');
      const theirs = await insertBooking(me.memberId, membershipId, otherPt.trainerId, at(day, '14:00'));
      const staff = await user('STAFF', 'Nhân viên Quầy');

      const response = await get('/api/pt-bookings', staff, { fromDate: day, toDate: day, trainerId: otherPt.trainerId.toHexString() }).expect(200);

      expect((response.body.items as { id: string }[]).map(item => item.id)).toEqual([theirs.toHexString()]);
    });

    it.each([
      ['limit 101', { limit: 101 }],
      ['khoảng ngày 32 ngày', { toDate: vnDay(31) }],
      ['fromDate sau toDate', { fromDate: vnDay(2), toDate: vnDay(1) }],
      ['ngày sai định dạng', { fromDate: '2026/11/20' }],
    ])('US-29-TC05: GET /api/pt-bookings %s → 400 VALIDATION_ERROR', async (_name, override) => {
      const staff = await user('STAFF', 'Nhân viên Quầy');

      expectError(await get('/api/pt-bookings', staff, { fromDate: vnDay(0), toDate: vnDay(0), ...override }), 400, 'VALIDATION_ERROR');
    });
  });

  describe('US-29-TC06: support lý do sai hoặc thiếu quyền → 400/403, không vượt policy', () => {
    it.each([
      ['thiếu reason', { version: 0 }],
      ['reason rỗng', { version: 0, reason: '' }],
      ['reason chỉ khoảng trắng', { version: 0, reason: '          ' }],
      ['reason 9 ký tự sau trim', { version: 0, reason: '  123456789  ' }],
      ['reason 501 ký tự', { version: 0, reason: 'a'.repeat(501) }],
      ['thiếu version', { reason: REASON }],
      ['version không phải số nguyên', { version: '0', reason: REASON }],
      ['version âm', { version: -1, reason: REASON }],
      ['field ngoài allowlist (status)', { version: 0, reason: REASON, status: 'COMPLETED' }],
    ])('US-29-TC06: %s → 400 VALIDATION_ERROR, booking giữ nguyên', async (_name, body) => {
      const { bookingId } = await ready(minutesAhead(30));
      const staff = await user('STAFF', 'Nhân viên Quầy');
      const before = await bookingDoc(bookingId);

      expectError(await cancelSupport(staff, bookingId, body as Record<string, unknown>), 400, 'VALIDATION_ERROR');
      expect(await bookingDoc(bookingId)).toEqual(before);
    });

    it.each([
      ['thiếu Idempotency-Key', null],
      ['Idempotency-Key không phải UUID', 'khong-phai-uuid'],
    ])('US-29-TC06: %s → 400, không hủy', async (_name, key) => {
      const { bookingId } = await ready(minutesAhead(30));
      const staff = await user('STAFF', 'Nhân viên Quầy');

      const response = await cancelSupport(staff, bookingId, { version: 0, reason: REASON }, key);

      expectError(response, 400);
      expect((await bookingDoc(bookingId))?.status).toBe('BOOKED');
    });

    it('US-29-TC06: MEMBER (kể cả chủ booking) gọi API support, tra cứu hoặc chi tiết hỗ trợ → 403', async () => {
      const { me, bookingId } = await ready(minutesAhead(30));

      expectError(await cancelSupport(me, bookingId), 403);
      expectError(await get('/api/pt-bookings', me, { fromDate: vnDay(0), toDate: vnDay(1) }), 403);
      expectError(await get(`/api/pt-bookings/${bookingId.toHexString()}`, me), 403);
      expect((await bookingDoc(bookingId))?.status).toBe('BOOKED');
    });

    it('US-29-TC06: STAFF gọi API own của Member → 403, không dùng đường own để hủy', async () => {
      const { bookingId } = await ready();
      const staff = await user('STAFF', 'Nhân viên Quầy');

      expectError(await cancelOwn(staff, bookingId), 403);
    });

    it('US-29-TC06: reason hợp lệ với Member own (10 ký tự sau trim) → 200; 9 ký tự → 400', async () => {
      const { me, bookingId } = await ready();

      expectError(await cancelOwn(me, bookingId, { version: 0, reason: '123456789' }), 400, 'VALIDATION_ERROR');
      await cancelOwn(me, bookingId, { version: 0, reason: '  1234567890  ' }).expect(200);
    });
  });

  describe('US-29-TC07: CANCELLED hoặc COMPLETED gửi key mới → 409', () => {
    it('US-29-TC07: booking đã CANCELLED, Member gửi key mới → 409 INVALID_BOOKING_STATE, không thêm event/thông báo', async () => {
      const { me, bookingId } = await ready();
      await cancelOwn(me, bookingId).expect(200);

      expectError(await cancelOwn(me, bookingId, { version: 1, reason: REASON }), 409, 'INVALID_BOOKING_STATE');
      expect(await count('booking_events', { booking_id: bookingId })).toBe(1);
      expect(await count('notifications', { event_key: `BOOKING_CANCELLED:${bookingId.toHexString()}` })).toBe(1);
    });

    it('US-29-TC07: booking COMPLETED, Staff hủy hỗ trợ → 409 INVALID_BOOKING_STATE, used và booking giữ nguyên', async () => {
      const { me, membershipId, pt } = await ready();
      const bookingId = await insertBooking(me.memberId, membershipId, pt.trainerId, minutesAgo(24 * 60), { status: 'COMPLETED', version: 2 });
      const staff = await user('STAFF', 'Nhân viên Quầy');
      const before = await bookingDoc(bookingId);
      const quotaBefore = await quotaOf(me, membershipId);

      expectError(await cancelSupport(staff, bookingId, { version: 2, reason: REASON }), 409, 'INVALID_BOOKING_STATE');
      expect(await bookingDoc(bookingId)).toEqual(before);
      expect((await quotaOf(me, membershipId)).sessionsUsed).toBe(quotaBefore.sessionsUsed);
    });
  });

  describe('US-29-TC08: Member/PT bị khóa nhưng hỗ trợ staff vẫn hợp lệ', () => {
    it('US-29-TC08: account Member và PT LOCKED, trainer INACTIVE → STAFF hủy qua API → 200, thông báo vẫn lưu cho hai account', async () => {
      const { me, pt, bookingId } = await ready(minutesAhead(30));
      await db().collection('accounts').updateMany({ _id: { $in: [new ObjectId(me.accountId), new ObjectId(pt.accountId)] } }, { $set: { status: 'LOCKED' } });
      await db().collection('trainers').updateOne({ _id: pt.trainerId }, { $set: { status: 'INACTIVE' } });
      const staff = await user('STAFF', 'Nhân viên Quầy');

      const response = await cancelSupport(staff, bookingId).expect(200);

      expect(response.body.notificationState).toBe('STORED');
    });
  });

  // =====================================================================
  // AC03 – Replay, mất response, lỗi hạ tầng (TC09, TC12)
  // =====================================================================

  describe('US-29-TC09: hai cancel cùng key hoặc hai actor cùng version', () => {
    it('US-29-TC09: gửi lại cùng key + cùng payload sau commit → 200 cùng body gốc; vẫn một event, một thông báo, một operation_requests', async () => {
      const { me, bookingId } = await ready();
      const key = randomUUID();
      const first = await cancelOwn(me, bookingId, { version: 0, reason: REASON }, key).expect(200);

      const replay = await cancelOwn(me, bookingId, { version: 0, reason: REASON }, key);

      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect(await count('booking_events', { booking_id: bookingId })).toBe(1);
      expect(await count('notifications', { event_key: `BOOKING_CANCELLED:${bookingId.toHexString()}` })).toBe(1);
      expect(await count('operation_requests', { operation: 'PT_BOOKING_CANCEL_OWN' })).toBe(1);
    });

    it('US-29-TC09: cùng key gửi cùng lúc hai lần → cả hai 200 cùng body, đúng một lần chuyển trạng thái và một event', async () => {
      const { me, bookingId } = await ready();
      const key = randomUUID();

      const [one, two] = await Promise.all([
        cancelOwn(me, bookingId, { version: 0, reason: REASON }, key),
        cancelOwn(me, bookingId, { version: 0, reason: REASON }, key),
      ]);

      expect(one.status).toBe(200);
      expect(two.status).toBe(200);
      expect(two.body).toEqual(one.body);
      expect((await bookingDoc(bookingId))?.version).toBe(1);
      expect(await count('booking_events', { booking_id: bookingId })).toBe(1);
    });

    it('US-29-TC09: cùng key nhưng đổi lý do → 409 IDEMPOTENCY_CONFLICT, không thêm event', async () => {
      const { me, bookingId } = await ready();
      const key = randomUUID();
      await cancelOwn(me, bookingId, { version: 0, reason: REASON }, key).expect(200);

      expectError(await cancelOwn(me, bookingId, { version: 0, reason: 'Một lý do hoàn toàn khác' }, key), 409, 'IDEMPOTENCY_CONFLICT');
      expect(await count('booking_events', { booking_id: bookingId })).toBe(1);
    });

    it('US-29-TC09: Member (own) và Staff (support) cùng gửi version 0 cùng lúc → một 200, một 409; một event', async () => {
      const { me, bookingId } = await ready();
      const staff = await user('STAFF', 'Nhân viên Quầy');

      const responses = await Promise.all([cancelOwn(me, bookingId), cancelSupport(staff, bookingId)]);

      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const loser = responses.find(response => response.status === 409)!;
      expect(['VERSION_CONFLICT', 'INVALID_BOOKING_STATE']).toContain(loser.body.error.code);
      expect(await count('booking_events', { booking_id: bookingId })).toBe(1);
    });
  });

  describe('US-29-TC12: lỗi audit/outbox hoặc mất response sau commit', () => {
    it.each(['booking_events', 'notification_outbox', 'operation_requests'])(
      'US-29-TC12: insert vào %s lỗi → 503 không lộ lỗi MongoDB; booking vẫn BOOKED, không event/operation',
      async collection => {
        const { me, bookingId } = await ready();
        const before = await bookingDoc(bookingId);

        let response!: request.Response;
        await failInsertsOn(collection, async () => {
          response = await cancelOwn(me, bookingId);
        });

        expectError(response, 503);
        expect(JSON.stringify(response.body)).not.toMatch(/Giả lập DB lỗi|MongoServerError/);
        expect(await bookingDoc(bookingId)).toEqual(before);
        expect(await count('booking_events')).toBe(0);
        expect(await count('operation_requests')).toBe(0);
      },
    );

    it('US-29-TC12: mất response sau commit → tra cứu GET /api/operations/PT_BOOKING_CANCEL_OWN/:key trả kết quả gốc; gửi lại đúng key không hủy lần hai', async () => {
      const { me, bookingId } = await ready();
      const key = randomUUID();
      const first = await cancelOwn(me, bookingId, { version: 0, reason: REASON }, key).expect(200);

      const lookup = await get(`/api/operations/PT_BOOKING_CANCEL_OWN/${key}`, me).expect(200);
      expect(lookup.body.responseBody).toEqual(first.body);
      const replay = await cancelOwn(me, bookingId, { version: 0, reason: REASON }, key).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(await count('booking_events', { booking_id: bookingId })).toBe(1);
    });

    it('US-29-TC12: Staff tra cứu key hủy hỗ trợ của chính mình → 200; Staff khác tra cứu key đó → 404', async () => {
      const { bookingId } = await ready(minutesAhead(30));
      const staff = await user('STAFF', 'Nhân viên Quầy');
      const key = randomUUID();
      const first = await cancelSupport(staff, bookingId, { version: 0, reason: REASON }, key).expect(200);

      const lookup = await get(`/api/operations/PT_BOOKING_CANCEL_SUPPORT/${key}`, staff).expect(200);
      expect(lookup.body.responseBody).toEqual(first.body);
      const otherStaff = await user('STAFF', 'Nhân viên Ca Chiều');
      expectError(await get(`/api/operations/PT_BOOKING_CANCEL_SUPPORT/${key}`, otherStaff), 404);
    });
  });
});
