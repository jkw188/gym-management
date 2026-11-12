// Tầng kiểm thử backend (Jest + MongoDB replica set thật + Supertest): US-64 bước 3.
// Kiểm tra Admin xử lý sai qua POST /api/admin/pt-bookings/:id/corrections: COMPLETE hỗ trợ có lý do, REOPEN rút xác nhận
// khi chưa review/chưa nâng cấp, chặn REOPEN sau review hoặc nâng cấp, xác nhận lại sau REOPEN và lịch sử append-only (TC10–TC14).
// Hợp đồng test đặt ra cho Builder (US-64 bước 3, theo C01–C04 và bảng API mục 3 của spec):
//   POST /api/admin/pt-bookings/:id/corrections – chỉ ADMIN (quyền ptBookings.correct); header Idempotency-Key (UUID v4);
//     operation PT_BOOKING_CORRECT; body {version, action: 'COMPLETE' | 'REOPEN', reason (10–500 ký tự sau trim)}.
//     200 {id, status, version, completionRevision, membershipId (gói bị trừ/được hoàn), sessionsUsed}.
//   COMPLETE (C01): cùng điều kiện với PT (BOOKED, giờ server ≥ endAt, gói/quota hợp lệ, khóa lịch → khóa member);
//     completed_actor_type 'ADMIN_SUPPORT', completed_by = account Admin; audit COMPLETE actor_role ADMIN có reason.
//   REOPEN (C02): COMPLETED → BOOKED khi: chưa có trainer_reviews của booking, membership nguồn chưa SUPERSEDED,
//     booking.membership_id vẫn bằng completion_membership_id, sessions_used ≥ 1.
//     Tác động cùng transaction: sessions_used −1 của completion_membership_id, version+1, completion_revision+1,
//     bỏ completed_at/completed_by hiện tại; audit REOPEN (actor ADMIN, reason, revision, used/version trước–sau).
//   Lỗi: 400 reason/action/version/key sai; 403 không phải ADMIN; 404 booking không có;
//     409 COMPLETION_RECONCILIATION_REQUIRED (đã review, SUPERSEDED, booking đã chuyển gói) – C03;
//     409 INVALID_BOOKING_STATE (REOPEN khi không COMPLETED, COMPLETE khi CANCELLED); 409 BOOKING_ALREADY_COMPLETED;
//     409 BOOKING_NOT_ENDED; 409 DATA_INTEGRITY_ERROR (gói sai, used = 0 khi REOPEN); 409 IDEMPOTENCY_CONFLICT.
//   GET /api/admin/pt-bookings/:id – ADMIN; chi tiết có events [{action, completionRevision, reason?, ...}] theo thứ tự xảy ra.
//   Để sau: review cạnh tranh REOPEN (TC13, chờ US-65), UI Admin (bước 4).
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
import { ServerClock } from '../src/common/utils/business-date';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us64_correction';
const password = 'MậtKhẩuUS-64-456';
const REASON = 'PT đã dạy, có xác nhận chữ ký học viên tại quầy';
const MINUTE = 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * MINUTE;

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Auth = { accessToken: string; accountId: string };

describe('US-64 bước 3: Admin xác nhận hỗ trợ và rút xác nhận', () => {
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
      NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(), MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'us64-test', SMTP_PASS: 'us64-test', SMTP_FROM: 'no-reply@gym.test',
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

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());

  // ---------- Thời gian ----------
  const roundedNow = () => new Date(Math.floor(Date.now() / MINUTE) * MINUTE);
  const vnDate = (instant: Date) => new Date(instant.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
  const freezeClock = (now: Date) => jest.spyOn(ServerClock.prototype, 'now').mockImplementation(() => new Date(now.getTime()));

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: Role, fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0914700${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: String(created.id), phone };
  }
  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }
  async function userOf(role: Role): Promise<Auth> {
    const created = await account(role, `${role} US64`);
    return { accountId: created.accountId, accessToken: await loginAs(created.phone) };
  }

  // PT mẫu (thay US-23): account TRAINER + hồ sơ trainers; đăng nhập sẵn.
  async function trainer() {
    const owner = await account('TRAINER', 'PT Lê Văn Cường');
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: new ObjectId(owner.accountId), specialty: 'Thể hình', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: owner.accountId, accessToken: await loginAs(owner.phone) };
  }

  async function linkedMember() {
    const owner = await account('MEMBER', 'Hội viên US64');
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: 'Hội viên US64', phone: owner.phone,
      account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { memberId, accountId: owner.accountId };
  }

  // Một gói PT (thay US-14/22): quota 10, used mặc định 2.
  let saleSeq = 0;
  async function insertPlan(memberId: ObjectId, options: { used?: number; transactionStatus?: string } = {}) {
    saleSeq += 1;
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const staffId = new ObjectId();
    const now = new Date();
    const money = Decimal128.fromString('3000000');
    const today = vnDate(new Date());
    const shiftDays = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 24 * 60 * MINUTE).toISOString().slice(0, 10);
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US64C-${saleSeq}`, name: `Gói PT ${saleSeq}`, kind: 'PT', duration_days: 30,
      session_quota: 10, price: money, benefits: 'Quyền lợi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US64C-${saleSeq}`, kind: 'PT', amount_due: money,
      status: options.transactionStatus ?? 'SETTLED', request_key: randomBytes(32).toString('hex'), created_at: now, guard_revision: Long.ZERO,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: shiftDays(-10), end_date: shiftDays(30), plan_name_snapshot: `Gói PT ${saleSeq}`,
      benefits_snapshot: 'Quyền lợi', list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: 10,
      policy_snapshot: 'Giá niêm yết', created_at: now,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: options.used ?? 2,
    });
    return membershipId;
  }

  async function insertBooking(memberId: ObjectId, membershipId: ObjectId, trainerId: ObjectId, end: Date) {
    const id = new ObjectId();
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: membershipId, member_id: memberId, trainer_id: trainerId, shift_id: new ObjectId(),
      start_at: new Date(end.getTime() - 60 * MINUTE), end_at: end, status: 'BOOKED', request_key: randomBytes(32).toString('hex'),
      version: 0, completion_revision: 0, trainer_name_snapshot: 'PT Lê Văn Cường', location_snapshot: 'Phòng PT 1',
      created_at: new Date(), updated_at: new Date(),
    });
    return id;
  }

  // Buổi BOOKED đã hết giờ, kèm Admin đăng nhập sẵn.
  async function ready(options: { end?: Date; plan?: Parameters<typeof insertPlan>[1] } = {}) {
    const end = options.end ?? roundedNow();
    const me = await linkedMember();
    const membershipId = await insertPlan(me.memberId, options.plan);
    const pt = await trainer();
    const admin = await userOf('ADMIN');
    const bookingId = await insertBooking(me.memberId, membershipId, pt.trainerId, end);
    return { me, membershipId, pt, admin, bookingId, end };
  }

  // Buổi đã được PT xác nhận qua API thật (US-64 bước 2): COMPLETED, version 1, revision 1, used 2 → 3.
  async function completedByPt() {
    const fixture = await ready();
    const clock = freezeClock(fixture.end);
    await completeAsPt(fixture.pt, fixture.bookingId, 0).expect(200);
    clock.mockRestore();
    return fixture;
  }

  // ---------- Gọi API ----------
  function correct(auth: Auth | undefined, bookingId: ObjectId | string, body: Record<string, unknown>, key: string | null = randomUUID()) {
    let call = http().post(`/api/admin/pt-bookings/${String(bookingId)}/corrections`).set('Origin', origin);
    if (auth) call = call.set('Authorization', `Bearer ${auth.accessToken}`);
    if (key !== null) call = call.set('Idempotency-Key', key);
    return call.send(body);
  }
  const reopen = (auth: Auth, bookingId: ObjectId, version: number, key?: string) =>
    correct(auth, bookingId, { version, action: 'REOPEN', reason: REASON }, key);
  const completeAsPt = (auth: Auth, bookingId: ObjectId, version: number, key: string = randomUUID()) =>
    http().post(`/api/me/pt-bookings/${String(bookingId)}/complete`).set('Origin', origin)
      .set('Authorization', `Bearer ${auth.accessToken}`).set('Idempotency-Key', key).send({ version });
  const get = (path: string, auth: Auth) => http().get(path).set('Origin', origin).set('Authorization', `Bearer ${auth.accessToken}`);

  function expectError(response: request.Response, status: number, code?: string) {
    expect(response.status).toBe(status);
    expect(typeof response.body.error?.code).toBe('string');
    expect(typeof response.body.error?.message).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
    if (code) expect(response.body.error.code).toBe(code);
  }

  // ---------- Đọc DB ----------
  const bookingDoc = (id: ObjectId) => db().collection('pt_bookings').findOne({ _id: id });
  const usedOf = async (membershipId: ObjectId) => (await db().collection('memberships').findOne({ _id: membershipId }))?.sessions_used as number;
  const count = (collection: string, filter: Record<string, unknown> = {}) => db().collection(collection).countDocuments(filter);
  const bookedOf = (membershipId: ObjectId) => count('pt_bookings', { membership_id: membershipId, status: 'BOOKED' });
  const eventsOf = (bookingId: ObjectId) => db().collection('booking_events').find({ booking_id: bookingId }).sort({ completion_revision: 1 }).toArray();

  // Lỗi thì không có gì được ghi: booking, gói và audit giữ nguyên.
  async function expectNothingWritten(bookingId: ObjectId, membershipId: ObjectId, work: () => Promise<void>) {
    const before = { booking: await bookingDoc(bookingId), used: await usedOf(membershipId), events: await count('booking_events', { booking_id: bookingId }) };
    await work();
    expect(await bookingDoc(bookingId)).toEqual(before.booking);
    expect(await usedOf(membershipId)).toEqual(before.used);
    expect(await count('booking_events', { booking_id: bookingId })).toBe(before.events);
  }

  // =====================================================================
  // TC10 – Admin COMPLETE hỗ trợ có lý do (C01)
  // =====================================================================
  describe('US-64-TC10: Admin COMPLETE hỗ trợ', () => {
    it('US-64-TC10: Admin COMPLETE có lý do sau endAt → 200; COMPLETED, ADMIN_SUPPORT, completed_by = Admin, used+1, revision 1', async () => {
      const { membershipId, admin, bookingId, end } = await ready();
      freezeClock(end);

      const response = await correct(admin, bookingId, { version: 0, action: 'COMPLETE', reason: REASON }).expect(200);

      expect(response.body).toMatchObject({
        id: bookingId.toHexString(), status: 'COMPLETED', version: 1, completionRevision: 1,
        membershipId: membershipId.toHexString(), sessionsUsed: 3,
      });
      const doc = await bookingDoc(bookingId);
      expect(doc).toMatchObject({ status: 'COMPLETED', completed_actor_type: 'ADMIN_SUPPORT', completion_revision: 1 });
      expect(String(doc!.completed_by)).toBe(admin.accountId);
      expect(await usedOf(membershipId)).toBe(3);
    });

    it('US-64-TC10: audit COMPLETE actor_role ADMIN, reason đã trim, used 2→3, version 0→1', async () => {
      const { admin, bookingId, end } = await ready();
      freezeClock(end);

      await correct(admin, bookingId, { version: 0, action: 'COMPLETE', reason: `   ${REASON}   ` }).expect(200);

      const events = await eventsOf(bookingId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'COMPLETE', actor_role: 'ADMIN', reason: REASON, completion_revision: 1,
        used_before: 2, used_after: 3, version_before: 0, version_after: 1,
      });
      expect(String(events[0].actor_id)).toBe(admin.accountId);
    });

    it('US-64-TC10: lý do đúng 10 ký tự sau trim → 200', async () => {
      const { admin, bookingId, end } = await ready();
      freezeClock(end);
      await correct(admin, bookingId, { version: 0, action: 'COMPLETE', reason: '  0123456789  ' }).expect(200);
    });

    it.each([
      ['thiếu reason', undefined],
      ['reason toàn khoảng trắng', '          '],
      ['reason 9 ký tự sau trim', '  012345678  '],
      ['reason 501 ký tự', 'a'.repeat(501)],
    ])('US-64-TC10: %s → 400, không ghi gì', async (_label, reason) => {
      const { membershipId, admin, bookingId, end } = await ready();
      freezeClock(end);
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await correct(admin, bookingId, { version: 0, action: 'COMPLETE', reason }), 400);
      });
    });

    it.each([
      ['action ngoài danh sách', { version: 0, action: 'DELETE', reason: REASON }, 'uuid'],
      ['thiếu version', { action: 'COMPLETE', reason: REASON }, 'uuid'],
      ['field lạ (status)', { version: 0, action: 'COMPLETE', reason: REASON, status: 'COMPLETED' }, 'uuid'],
      ['thiếu Idempotency-Key', { version: 0, action: 'COMPLETE', reason: REASON }, null],
    ])('US-64-TC10: %s → 400, không ghi gì', async (_label, body, keyKind) => {
      const { membershipId, admin, bookingId, end } = await ready();
      freezeClock(end);
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await correct(admin, bookingId, body, keyKind === 'uuid' ? randomUUID() : null), 400);
      });
    });

    it.each(['STAFF', 'TRAINER', 'MEMBER'] as const)('US-64-TC10: %s gọi corrections → 403, không ghi gì', async role => {
      const { membershipId, bookingId, end } = await ready();
      const actor = await userOf(role);
      freezeClock(end);
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await correct(actor, bookingId, { version: 0, action: 'COMPLETE', reason: REASON }), 403);
      });
    });

    it('US-64-TC10: chưa đăng nhập → 401; booking không tồn tại → 404', async () => {
      const admin = await userOf('ADMIN');
      expectError(await correct(undefined, new ObjectId(), { version: 0, action: 'COMPLETE', reason: REASON }), 401);
      expectError(await correct(admin, new ObjectId(), { version: 0, action: 'COMPLETE', reason: REASON }), 404);
    });

    it('US-64-TC10 (C01 cùng điều kiện với PT): Admin COMPLETE trước endAt → 409 BOOKING_NOT_ENDED, không ghi gì', async () => {
      const { membershipId, admin, bookingId, end } = await ready();
      freezeClock(new Date(end.getTime() - 1000));
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await correct(admin, bookingId, { version: 0, action: 'COMPLETE', reason: REASON }), 409, 'BOOKING_NOT_ENDED');
      });
    });

    it('US-64-TC10 (C01 cùng điều kiện với PT): gói chưa SETTLED → 409 DATA_INTEGRITY_ERROR, không ghi gì', async () => {
      const { membershipId, admin, bookingId, end } = await ready({ plan: { transactionStatus: 'PENDING' } });
      freezeClock(end);
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await correct(admin, bookingId, { version: 0, action: 'COMPLETE', reason: REASON }), 409, 'DATA_INTEGRITY_ERROR');
      });
    });

    it('US-64-TC10: Admin COMPLETE buổi đã COMPLETED → 409 BOOKING_ALREADY_COMPLETED, used không tăng lần hai', async () => {
      const { membershipId, admin, bookingId } = await completedByPt();
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await correct(admin, bookingId, { version: 1, action: 'COMPLETE', reason: REASON }), 409, 'BOOKING_ALREADY_COMPLETED');
      });
    });
  });

  // =====================================================================
  // TC11 – Admin REOPEN khi chưa review / chưa nâng cấp (C02, C04)
  // =====================================================================
  describe('US-64-TC11: Admin REOPEN', () => {
    it('US-64-TC11: REOPEN buổi COMPLETED → 200; BOOKED, used−1, BOOKED+1, số buổi còn trống giữ nguyên; revision 2, version+1', async () => {
      const { membershipId, admin, bookingId } = await completedByPt();
      const availableBefore = 10 - (await usedOf(membershipId)) - (await bookedOf(membershipId));

      const response = await reopen(admin, bookingId, 1).expect(200);

      expect(response.body).toMatchObject({
        id: bookingId.toHexString(), status: 'BOOKED', version: 2, completionRevision: 2,
        membershipId: membershipId.toHexString(), sessionsUsed: 2,
      });
      expect(await usedOf(membershipId)).toBe(2);
      expect(await bookedOf(membershipId)).toBe(1);
      expect(10 - (await usedOf(membershipId)) - (await bookedOf(membershipId))).toBe(availableBefore);
      expect(await bookingDoc(bookingId)).toMatchObject({ status: 'BOOKED', version: 2, completion_revision: 2 });
    });

    it('US-64-TC11 (C04): REOPEN bỏ completed_at/completed_by hiện tại; audit REOPEN đủ field; dòng COMPLETE cũ vẫn còn', async () => {
      const { pt, admin, bookingId } = await completedByPt();

      await reopen(admin, bookingId, 1).expect(200);

      const doc = await bookingDoc(bookingId);
      expect(doc!.completed_at).toBeUndefined();
      expect(doc!.completed_by).toBeUndefined();
      const events = await eventsOf(bookingId);
      expect(events.map(event => [event.action, event.completion_revision])).toEqual([['COMPLETE', 1], ['REOPEN', 2]]);
      expect(String(events[0].actor_id)).toBe(pt.accountId);
      expect(events[1]).toMatchObject({
        actor_role: 'ADMIN', reason: REASON, before_status: 'COMPLETED', after_status: 'BOOKED',
        used_before: 3, used_after: 2, version_before: 1, version_after: 2,
      });
      expect(String(events[1].actor_id)).toBe(admin.accountId);
    });

    it('US-64-TC11: REOPEN buổi đang BOOKED → 409 INVALID_BOOKING_STATE, không ghi gì', async () => {
      const { membershipId, admin, bookingId } = await ready();
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await reopen(admin, bookingId, 0), 409, 'INVALID_BOOKING_STATE');
      });
    });

    it('US-64-TC11: REOPEN buổi CANCELLED → 409 INVALID_BOOKING_STATE, không ghi gì', async () => {
      const { membershipId, admin, bookingId } = await ready();
      await db().collection('pt_bookings').updateOne({ _id: bookingId }, { $set: { status: 'CANCELLED', cancelled_at: new Date() } });
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await reopen(admin, bookingId, 0), 409, 'INVALID_BOOKING_STATE');
      });
    });

    it('US-64-TC11 (C02 sessions_used ≥ 1): gói nguồn có sessions_used = 0 → 409 DATA_INTEGRITY_ERROR, không ghi gì', async () => {
      const { membershipId, admin, bookingId } = await completedByPt();
      await db().collection('memberships').updateOne({ _id: membershipId }, { $set: { sessions_used: 0 } });
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await reopen(admin, bookingId, 1), 409, 'DATA_INTEGRITY_ERROR');
      });
    });

    it('US-64-TC11: version cũ → 409 VERSION_CONFLICT, không ghi gì', async () => {
      const { membershipId, admin, bookingId } = await completedByPt();
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await reopen(admin, bookingId, 0), 409, 'VERSION_CONFLICT');
      });
    });

    it('US-64-TC11: gửi lại cùng key REOPEN → 200 body gốc, used chỉ giảm 1; cùng key khác payload → 409 IDEMPOTENCY_CONFLICT', async () => {
      const { membershipId, admin, bookingId } = await completedByPt();
      const key = randomUUID();

      const first = await reopen(admin, bookingId, 1, key).expect(200);
      const replay = await reopen(admin, bookingId, 1, key).expect(200);

      expect(replay.body).toEqual(first.body);
      expect(await usedOf(membershipId)).toBe(2);
      expect(await count('booking_events', { booking_id: bookingId, action: 'REOPEN' })).toBe(1);
      expect(await count('operation_requests', { operation: 'PT_BOOKING_CORRECT' })).toBe(1);
      expectError(await correct(admin, bookingId, { version: 2, action: 'REOPEN', reason: REASON }, key), 409, 'IDEMPOTENCY_CONFLICT');
    });
  });

  // =====================================================================
  // TC12 – Chặn REOPEN sau review hoặc chuỗi nâng cấp (C03)
  // =====================================================================
  describe('US-64-TC12: REOPEN bị chặn sau review hoặc nâng cấp', () => {
    it('US-64-TC12: booking đã có đánh giá (trainer_reviews) → 409 COMPLETION_RECONCILIATION_REQUIRED; review và used giữ nguyên', async () => {
      const { me, membershipId, pt, admin, bookingId } = await completedByPt();
      // Đánh giá mẫu theo bảng trainer_reviews (US-65 chưa có API).
      const reviewId = new ObjectId();
      await db().collection('trainer_reviews').insertOne({
        _id: reviewId, id: reviewId, booking_id: bookingId, trainer_id: pt.trainerId, member_id: me.memberId,
        created_by: new ObjectId(me.accountId), rating: 5, comment: 'PT nhiệt tình', created_at: new Date(),
      });

      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await reopen(admin, bookingId, 1), 409, 'COMPLETION_RECONCILIATION_REQUIRED');
      });
      expect(await count('trainer_reviews', { _id: reviewId })).toBe(1);
    });

    it('US-64-TC12: gói nguồn đã SUPERSEDED (used đã mang sang gói đích) → 409 COMPLETION_RECONCILIATION_REQUIRED, used giữ nguyên', async () => {
      const { membershipId, admin, bookingId } = await completedByPt();
      await db().collection('memberships').updateOne({ _id: membershipId }, { $set: { status: 'SUPERSEDED' } });
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await reopen(admin, bookingId, 1), 409, 'COMPLETION_RECONCILIATION_REQUIRED');
      });
    });

    it('US-64-TC12: booking không còn tham chiếu completion_membership_id gốc → 409 COMPLETION_RECONCILIATION_REQUIRED, hai gói giữ nguyên', async () => {
      const { me, membershipId, admin, bookingId } = await completedByPt();
      const targetId = await insertPlan(me.memberId, { used: 4 });
      await db().collection('pt_bookings').updateOne({ _id: bookingId }, { $set: { membership_id: targetId } });

      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await reopen(admin, bookingId, 1), 409, 'COMPLETION_RECONCILIATION_REQUIRED');
      });
      expect(await usedOf(targetId)).toBe(4);
    });
  });

  it.todo('US-64-TC13: gửi đánh giá cạnh tranh REOPEN – chờ US-65 có API tạo review');

  // =====================================================================
  // TC14 – Xác nhận lại sau REOPEN hợp lệ (C04)
  // =====================================================================
  describe('US-64-TC14: xác nhận lại sau REOPEN', () => {
    it('US-64-TC14: PT xác nhận lại sau REOPEN → revision 3, used 3; booking_events COMPLETE(1), REOPEN(2), COMPLETE(3)', async () => {
      const { membershipId, pt, admin, bookingId, end } = await completedByPt();
      await reopen(admin, bookingId, 1).expect(200);
      freezeClock(new Date(end.getTime() + 30 * MINUTE));

      const response = await completeAsPt(pt, bookingId, 2).expect(200);

      expect(response.body).toMatchObject({ status: 'COMPLETED', version: 3, completionRevision: 3, sessionsUsed: 3 });
      expect(await usedOf(membershipId)).toBe(3);
      const events = await eventsOf(bookingId);
      expect(events.map(event => [event.action, event.completion_revision])).toEqual([['COMPLETE', 1], ['REOPEN', 2], ['COMPLETE', 3]]);
    });

    it('US-64-TC14: sau REOPEN, gửi lại key của lần xác nhận đầu → trả body gốc (revision 1), booking vẫn BOOKED, used không đổi', async () => {
      const fixture = await ready();
      const firstKey = randomUUID();
      const clock = freezeClock(fixture.end);
      const first = await completeAsPt(fixture.pt, fixture.bookingId, 0, firstKey).expect(200);
      clock.mockRestore();
      await reopen(fixture.admin, fixture.bookingId, 1).expect(200);

      const replay = await completeAsPt(fixture.pt, fixture.bookingId, 0, firstKey).expect(200);

      expect(replay.body).toEqual(first.body);
      expect(await bookingDoc(fixture.bookingId)).toMatchObject({ status: 'BOOKED', completion_revision: 2 });
      expect(await usedOf(fixture.membershipId)).toBe(2);
      expect(await count('booking_events', { booking_id: fixture.bookingId, action: 'COMPLETE' })).toBe(1);
    });
  });

  // =====================================================================
  // Chi tiết Admin (bảng API mục 3, C04)
  // =====================================================================
  describe('US-64-C04: GET /api/admin/pt-bookings/:id', () => {
    it('US-64-C04: Admin xem chi tiết có events COMPLETE rồi REOPEN theo thứ tự, REOPEN có lý do', async () => {
      const { admin, bookingId } = await completedByPt();
      await reopen(admin, bookingId, 1).expect(200);

      const response = await get(`/api/admin/pt-bookings/${bookingId.toHexString()}`, admin).expect(200);

      expect(response.body).toMatchObject({ id: bookingId.toHexString(), status: 'BOOKED' });
      const events = response.body.events as { action: string; completionRevision: number; reason?: string }[];
      expect(events.map(event => [event.action, event.completionRevision])).toEqual([['COMPLETE', 1], ['REOPEN', 2]]);
      expect(events[1].reason).toBe(REASON);
    });

    it.each(['STAFF', 'TRAINER'] as const)('US-64-C04: %s xem chi tiết Admin → 403', async role => {
      const { bookingId } = await ready();
      const actor = await userOf(role);
      expectError(await get(`/api/admin/pt-bookings/${bookingId.toHexString()}`, actor), 403);
    });
  });
});
