// Tầng kiểm thử backend (Jest + MongoDB replica set thật + Supertest, hai app instance): US-64 bước 2.
// Kiểm tra PT xác nhận buổi đã dạy qua POST /api/me/pt-bookings/:id/complete: đúng owner, đủ giờ, quota trừ đúng một lần,
// khóa lịch rồi khóa member, gói lấy lại từ booking lúc ghi (sau nâng cấp), idempotency và rollback (TC01–TC09).
// Hợp đồng test đặt ra cho Builder (US-64 bước 2, theo F01–F05, mục 2 và bảng API mục 3 của spec):
//   POST /api/me/pt-bookings/:id/complete – chỉ TRAINER; header Idempotency-Key (UUID v4); operation PT_BOOKING_COMPLETE; body {version}.
//     200 {id, status:'COMPLETED', version, completedAt, completionRevision, membershipId, sessionsUsed, ...}.
//   Giờ lấy từ ServerClock.now() (src/common/utils/business-date.ts) bên trong transaction; được xác nhận khi now ≥ endAt.
//   Trong CÙNG transaction: schedule_guards 'global'.revision +1 → members.service_revision của member chủ booking +1 (F04);
//     đọc lại booking và gói ĐANG được booking tham chiếu (membership_id lúc ghi, không lấy từ client);
//     gói phải: tồn tại, sale cùng member với booking, plan kind PT, transaction SETTLED, có sessions_used,
//       và sessions_used + số BOOKED ≤ sales.sessions_snapshot; sai → 409 DATA_INTEGRITY_ERROR, không tự chữa (TC05).
//       KHÔNG bắt gói còn hạn ngày xác nhận (TC04).
//     CAS booking BOOKED + version → COMPLETED, version+1, completed_at = giờ server, completed_by = account PT,
//       completed_actor_type 'TRAINER', completion_membership_id = gói bị trừ, completion_revision +1, updated_at.
//     memberships.sessions_used +1; booking_events một dòng COMPLETE (actor_role TRAINER, completion_revision, used/version trước–sau,
//       request_key băm hex 64); operation_requests một dòng.
//   Lỗi (EN01-D03): 400 key/version/id sai; 401 phiên/account khóa; 403 sai vai trò; 404 booking không có hoặc của PT khác;
//     409 chưa tới endAt hoặc không còn BOOKED; 409 VERSION_CONFLICT; 409 BOOKING_ALREADY_COMPLETED (key mới trên COMPLETED);
//     409 IDEMPOTENCY_CONFLICT (cùng key khác payload); 503 khi DB lỗi, không lộ lỗi MongoDB thô.
//   Để bước sau: thông báo PT_BOOKING_COMPLETED/outbox/notificationState và UI (bước 4), Admin correction (bước 3),
//     cạnh tranh với nâng cấp US-16/20 thật (chờ US-16), 10 vòng race (bước 5).
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
const databaseName = 'gym_management_test_us64_complete';
const password = 'MậtKhẩuUS-64-123';
const CANCEL_REASON = 'Học viên báo ốm, nhân viên hủy hộ';
const MINUTE = 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * MINUTE;

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Auth = { accessToken: string; accountId: string };

describe('US-64 bước 2: PT xác nhận buổi đã dạy', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let second: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      // enableTestCommands=1 để dùng failpoint failCommand giả lập lỗi insert trước commit (TC09), giống US-29-TC12.
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName, args: ['--setParameter', 'enableTestCommands=1'] },
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
    // Instance thứ hai (kết nối DB riêng) mô phỏng hai app server chạy song song (TC06, TC07).
    second = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(second);
    await second.init();
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const instance of [app, second]) {
      const limiter = new LoginLimiter();
      jest.spyOn(instance.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    }
    for (const collection of await db().collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    // Khóa lịch global (lệnh ensure-indexes tạo trong môi trường thật).
    await db().collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
  });

  afterEach(async () => {
    await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await second?.close();
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = (instance: INestApplication = app) => request(instance.getHttpServer());

  // ---------- Thời gian ----------
  // Mốc kết thúc buổi = giờ thật làm tròn phút; đồng hồ server giả chỉ lệch giờ thật vài giây nên token vẫn hợp lệ.
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
    const phone = `0914600${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: String(created.id), phone };
  }
  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }
  async function staffOf(role: 'STAFF' | 'ADMIN'): Promise<Auth> {
    const created = await account(role, `${role} US64`);
    return { accountId: created.accountId, accessToken: await loginAs(created.phone) };
  }

  // PT mẫu (thay US-23): account TRAINER + hồ sơ trainers; đăng nhập sẵn.
  async function trainer(fullName = 'PT Lê Văn Cường') {
    const owner = await account('TRAINER', fullName);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: new ObjectId(owner.accountId), specialty: 'Thể hình', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: owner.accountId, accessToken: await loginAs(owner.phone) };
  }

  // Member có tài khoản đã liên kết hồ sơ (khuôn US-09/US-28). Không đăng nhập trừ khi cần.
  async function linkedMember(name = 'Hội viên US64', withLogin = false) {
    const owner = await account('MEMBER', name);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: name, phone: owner.phone,
      account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { memberId, accountId: owner.accountId, accessToken: withLogin ? await loginAs(owner.phone) : '' };
  }

  // Một gói PT (thay US-14/22): plan → transaction → sale → membership. Quota 10, used mặc định 2.
  let saleSeq = 0;
  async function insertPlan(memberId: ObjectId, options: {
    used?: number | null; quota?: number; kind?: string; transactionStatus?: string; endDate?: string; saleMemberId?: ObjectId;
  } = {}) {
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
    const kind = options.kind ?? 'PT';
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US64-${saleSeq}`, name: `Gói PT ${saleSeq}`, kind, duration_days: 30,
      session_quota: options.quota ?? 10, price: money, benefits: 'Quyền lợi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US64-${saleSeq}`, kind, amount_due: money,
      status: options.transactionStatus ?? 'SETTLED', request_key: randomBytes(32).toString('hex'), created_at: now, guard_revision: Long.ZERO,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: options.saleMemberId ?? memberId, plan_id: planId, operation: 'REGISTER',
      start_date: shiftDays(-10), end_date: options.endDate ?? shiftDays(30), plan_name_snapshot: `Gói PT ${saleSeq}`,
      benefits_snapshot: 'Quyền lợi', list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: options.quota ?? 10,
      policy_snapshot: 'Giá niêm yết', created_at: now,
    });
    const membership: Record<string, unknown> = { _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE' };
    if (options.used !== null) membership.sessions_used = options.used ?? 2;
    await db().collection('memberships').insertOne(membership);
    return membershipId;
  }

  // Buổi PT có sẵn (đặt qua US-28 trước đó), dài 60 phút, đã có field của US-64 bước 1.
  async function insertBooking(memberId: ObjectId, membershipId: ObjectId, trainerId: ObjectId, end: Date, extra: Record<string, unknown> = {}) {
    const id = new ObjectId();
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: membershipId, member_id: memberId, trainer_id: trainerId, shift_id: new ObjectId(),
      start_at: new Date(end.getTime() - 60 * MINUTE), end_at: end, status: 'BOOKED', request_key: randomBytes(32).toString('hex'),
      version: 0, completion_revision: 0, trainer_name_snapshot: 'PT Lê Văn Cường', location_snapshot: 'Phòng PT 1',
      created_at: new Date(), updated_at: new Date(), ...extra,
    });
    return id;
  }

  // Bộ dữ liệu sẵn: Member có gói PT, một buổi BOOKED của PT kết thúc lúc `end` (mặc định = giờ thật làm tròn phút).
  async function ready(options: { end?: Date; plan?: Parameters<typeof insertPlan>[1] } = {}) {
    const end = options.end ?? roundedNow();
    const me = await linkedMember();
    const membershipId = await insertPlan(me.memberId, options.plan);
    const pt = await trainer();
    const bookingId = await insertBooking(me.memberId, membershipId, pt.trainerId, end);
    return { me, membershipId, pt, bookingId, end };
  }

  // ---------- Gọi API ----------
  function complete(auth: Auth | undefined, bookingId: ObjectId | string, body: Record<string, unknown> = { version: 0 },
    key: string | null = randomUUID(), instance: INestApplication = app) {
    let call = http(instance).post(`/api/me/pt-bookings/${String(bookingId)}/complete`).set('Origin', origin);
    if (auth) call = call.set('Authorization', `Bearer ${auth.accessToken}`);
    if (key !== null) call = call.set('Idempotency-Key', key);
    return call.send(body);
  }
  const cancelSupport = (auth: Auth, bookingId: ObjectId, instance: INestApplication) =>
    http(instance).post(`/api/pt-bookings/${String(bookingId)}/cancel`).set('Origin', origin)
      .set('Authorization', `Bearer ${auth.accessToken}`).set('Idempotency-Key', randomUUID()).send({ version: 0, reason: CANCEL_REASON });
  const get = (path: string, auth: Auth) =>
    http().get(path).set('Origin', origin).set('Authorization', `Bearer ${auth.accessToken}`);

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
  const guardRevision = async () => Number((await db().collection<{ _id: string; revision: Long }>('schedule_guards').findOne({ _id: 'global' }))?.revision);
  const memberRevision = async (memberId: ObjectId) => Number((await db().collection('members').findOne({ _id: memberId }))?.service_revision);
  const completeEvents = (bookingId: ObjectId) => db().collection('booking_events').find({ booking_id: bookingId, action: 'COMPLETE' }).toArray();

  // Lỗi thì không có gì được ghi: booking, gói, audit, khóa lịch giữ nguyên.
  async function expectNothingWritten(bookingId: ObjectId, membershipId: ObjectId, work: () => Promise<void>) {
    const before = { booking: await bookingDoc(bookingId), used: await usedOf(membershipId), guard: await guardRevision() };
    await work();
    expect(await bookingDoc(bookingId)).toEqual(before.booking);
    expect(await usedOf(membershipId)).toEqual(before.used);
    expect(await guardRevision()).toBe(before.guard);
    expect(await count('booking_events', { booking_id: bookingId })).toBe(0);
  }

  // Bật lỗi giả lập khi insert vào một collection, chạy work, rồi tắt (giống US-29-TC12).
  async function failInsertsOn(collection: string, work: () => Promise<void>) {
    await db().admin().command({
      configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: ['insert'], namespace: `${databaseName}.${collection}`, errorCode: 1, errmsg: 'Giả lập DB lỗi US-64-TC09' },
    });
    try {
      await work();
    } finally {
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
  }

  // =====================================================================
  // AC01 – Owner, thời gian và quota (TC01–TC05)
  // =====================================================================
  describe('US-64-AC01: owner, thời gian và quota', () => {
    it('US-64-TC01: PT đúng owner xác nhận lúc now = endAt → 200 đủ field; used+1, BOOKED−1, số buổi còn trống giữ nguyên', async () => {
      const { me, membershipId, pt, bookingId, end } = await ready();
      // Một buổi BOOKED khác trong tương lai để thấy rõ BOOKED giảm đúng 1.
      await insertBooking(me.memberId, membershipId, pt.trainerId, new Date(end.getTime() + 3 * 24 * 60 * MINUTE));
      const quota = 10;
      const availableBefore = quota - (await usedOf(membershipId)) - (await bookedOf(membershipId));
      freezeClock(end);

      const response = await complete(pt, bookingId).expect(200);

      expect(response.body).toMatchObject({
        id: bookingId.toHexString(), status: 'COMPLETED', version: 1, completionRevision: 1,
        membershipId: membershipId.toHexString(), sessionsUsed: 3,
      });
      expect(new Date(response.body.completedAt).getTime()).toBe(end.getTime());
      expect(await usedOf(membershipId)).toBe(3);
      expect(await bookedOf(membershipId)).toBe(1);
      expect(quota - (await usedOf(membershipId)) - (await bookedOf(membershipId))).toBe(availableBefore);
    });

    it('US-64-TC01: booking lưu completed_by = account PT, TRAINER, completion_membership_id, revision 1, version+1; completed_at là giờ xác nhận, không phải endAt', async () => {
      const { membershipId, pt, bookingId, end } = await ready({ end: new Date(roundedNow().getTime() - 45 * MINUTE) });
      const confirmedAt = roundedNow();
      freezeClock(confirmedAt);

      await complete(pt, bookingId).expect(200);

      const doc = await bookingDoc(bookingId);
      expect(doc).toMatchObject({ status: 'COMPLETED', version: 1, completed_actor_type: 'TRAINER', completion_revision: 1 });
      expect(String(doc!.completed_by)).toBe(pt.accountId);
      expect(String(doc!.completion_membership_id)).toBe(membershipId.toHexString());
      expect((doc!.completed_at as Date).getTime()).toBe(confirmedAt.getTime());
      expect((doc!.completed_at as Date).getTime()).not.toBe(end.getTime());
    });

    it('US-64-TC01: đúng một booking_events COMPLETE đủ field (actor TRAINER, revision 1, used 2→3, version 0→1, request_key băm)', async () => {
      const { me, membershipId, pt, bookingId, end } = await ready();
      freezeClock(end);
      const key = randomUUID();

      await complete(pt, bookingId, { version: 0 }, key).expect(200);

      const events = await completeEvents(bookingId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor_role: 'TRAINER', before_status: 'BOOKED', after_status: 'COMPLETED', completion_revision: 1,
        used_before: 2, used_after: 3, version_before: 0, version_after: 1,
      });
      expect(String(events[0].actor_id)).toBe(pt.accountId);
      expect(String(events[0].member_id)).toBe(me.memberId.toHexString());
      expect(String(events[0].membership_id)).toBe(membershipId.toHexString());
      expect(events[0].request_key).toMatch(/^[0-9a-f]{64}$/);
      expect(events[0].request_key).not.toContain(key);
    });

    it('US-64-TC01 (F04): khóa lịch global và members.service_revision của member chủ booking mỗi cái tăng đúng 1', async () => {
      const { me, pt, bookingId, end } = await ready();
      freezeClock(end);

      await complete(pt, bookingId).expect(200);

      expect(await guardRevision()).toBe(1);
      expect(await memberRevision(me.memberId)).toBe(1);
    });

    it('US-64-TC01 (F03): không tạo transaction/payment; giờ, PT, ca, member_id, membership_id của booking giữ nguyên', async () => {
      const { pt, bookingId, end } = await ready();
      const before = await bookingDoc(bookingId);
      const transactionsBefore = await count('transactions');
      freezeClock(end);

      await complete(pt, bookingId).expect(200);

      const after = await bookingDoc(bookingId);
      for (const field of ['start_at', 'end_at', 'trainer_id', 'shift_id', 'member_id', 'membership_id']) {
        expect(after![field]).toEqual(before![field]);
      }
      expect(await count('transactions')).toBe(transactionsBefore);
    });

    it('US-64-TC02: PT khác (không phải owner) → 404, không ghi gì', async () => {
      const { membershipId, bookingId, end } = await ready();
      const otherPt = await trainer('PT Trần Thị Dung');
      freezeClock(end);
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await complete(otherPt, bookingId), 404);
      });
    });

    it.each(['STAFF', 'ADMIN'] as const)('US-64-TC02: %s gọi lệnh của PT → 403, không ghi gì', async role => {
      const { membershipId, bookingId, end } = await ready();
      const actor = await staffOf(role);
      freezeClock(end);
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await complete(actor, bookingId), 403);
      });
    });

    it('US-64-TC02: Member chủ buổi tự gọi → 403, không ghi gì', async () => {
      const end = roundedNow();
      const me = await linkedMember('Hội viên tự xác nhận', true);
      const membershipId = await insertPlan(me.memberId);
      const pt = await trainer();
      const bookingId = await insertBooking(me.memberId, membershipId, pt.trainerId, end);
      freezeClock(end);
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await complete(me, bookingId), 403);
      });
    });

    it('US-64-TC02: chưa đăng nhập → 401, không ghi gì', async () => {
      const { membershipId, bookingId, end } = await ready();
      freezeClock(end);
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await complete(undefined, bookingId), 401);
      });
    });

    it('US-64-TC02: account PT bị khóa (LOCKED) dùng token cũ → 401, không ghi gì', async () => {
      const { membershipId, pt, bookingId, end } = await ready();
      await db().collection('accounts').updateOne({ _id: new ObjectId(pt.accountId) }, { $set: { status: 'LOCKED' } });
      freezeClock(end);
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await complete(pt, bookingId), 401);
      });
    });

    it('US-64-TC02: booking không tồn tại → 404; id sai định dạng → 400', async () => {
      const pt = await trainer();
      expectError(await complete(pt, new ObjectId()), 404);
      expectError(await complete(pt, 'khong-phai-id'), 400);
    });

    it('US-64-TC03: now = endAt − 1 giây → 409, không trừ quota, không event', async () => {
      const { membershipId, pt, bookingId, end } = await ready();
      freezeClock(new Date(end.getTime() - 1000));
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await complete(pt, bookingId), 409);
      });
    });

    it('US-64-TC03: buổi chưa bắt đầu (endAt còn 2 giờ nữa) → 409, không ghi gì', async () => {
      const { membershipId, pt, bookingId } = await ready({ end: new Date(roundedNow().getTime() + 120 * MINUTE) });
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await complete(pt, bookingId), 409);
      });
    });

    it('US-64-TC03: booking đã CANCELLED → 409, không trừ quota, không event', async () => {
      const { membershipId, pt, bookingId, end } = await ready();
      await db().collection('pt_bookings').updateOne({ _id: bookingId }, { $set: { status: 'CANCELLED', cancelled_at: new Date() } });
      freezeClock(end);
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await complete(pt, bookingId), 409);
      });
    });

    it('US-64-TC03 (F04 CAS version): version gửi lên cũ → 409 VERSION_CONFLICT, không ghi gì', async () => {
      const { membershipId, pt, bookingId, end } = await ready();
      await db().collection('pt_bookings').updateOne({ _id: bookingId }, { $set: { version: 1 } });
      freezeClock(end);
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await complete(pt, bookingId, { version: 0 }), 409, 'VERSION_CONFLICT');
      });
    });

    it('US-64-TC04: buổi trong hạn nhưng xác nhận muộn sau end_date của gói → 200, used+1', async () => {
      // Buổi kết thúc 26 giờ trước; gói hết hạn đúng ngày (giờ VN) của buổi đó.
      const end = new Date(roundedNow().getTime() - 26 * 60 * MINUTE);
      const { membershipId, pt, bookingId } = await ready({ end, plan: { endDate: vnDate(new Date(end.getTime() - 60 * MINUTE)) } });

      const response = await complete(pt, bookingId).expect(200);

      expect(response.body).toMatchObject({ status: 'COMPLETED', sessionsUsed: 3 });
      expect(await usedOf(membershipId)).toBe(3);
    });

    it.each([
      ['gói của booking không tồn tại', 'missing-membership'],
      ['gói thuộc member khác', 'foreign-sale'],
      ['giao dịch của gói chưa SETTLED', 'unsettled'],
      ['gói không phải loại PT', 'not-pt'],
      ['membership thiếu sessions_used', 'no-used'],
      ['used + BOOKED > quota (used 10 + 1 BOOKED > 10)', 'over-quota'],
    ])('US-64-TC05: %s → 409 DATA_INTEGRITY_ERROR, không tự chữa, không ghi gì', async (_label, scenario) => {
      const end = roundedNow();
      const me = await linkedMember();
      const pt = await trainer();
      const plan: Parameters<typeof insertPlan>[1] = {};
      if (scenario === 'foreign-sale') plan.saleMemberId = new ObjectId();
      if (scenario === 'unsettled') plan.transactionStatus = 'PENDING';
      if (scenario === 'not-pt') plan.kind = 'GYM';
      if (scenario === 'no-used') plan.used = null;
      if (scenario === 'over-quota') plan.used = 10;
      const membershipId = scenario === 'missing-membership' ? new ObjectId() : await insertPlan(me.memberId, plan);
      const bookingId = await insertBooking(me.memberId, membershipId, pt.trainerId, end);
      freezeClock(end);

      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await complete(pt, bookingId), 409, 'DATA_INTEGRITY_ERROR');
      });
    });
  });

  // =====================================================================
  // AC02 – Idempotency, đồng thời, nâng cấp, rollback (TC06–TC09)
  // =====================================================================
  describe('US-64-AC02: idempotency, đồng thời và nâng cấp', () => {
    it('US-64-TC06: gửi lại cùng key cùng body → 200 body gốc; used chỉ tăng 1, một event, một operation_requests', async () => {
      const { membershipId, pt, bookingId, end } = await ready();
      freezeClock(end);
      const key = randomUUID();

      const first = await complete(pt, bookingId, { version: 0 }, key).expect(200);
      const replay = await complete(pt, bookingId, { version: 0 }, key).expect(200);

      expect(replay.body).toEqual(first.body);
      expect(await usedOf(membershipId)).toBe(3);
      expect(await completeEvents(bookingId)).toHaveLength(1);
      expect(await count('operation_requests', { operation: 'PT_BOOKING_COMPLETE' })).toBe(1);
    });

    it('US-64-TC06: cùng key nhưng khác payload → 409 IDEMPOTENCY_CONFLICT, used không tăng thêm', async () => {
      const { membershipId, pt, bookingId, end } = await ready();
      freezeClock(end);
      const key = randomUUID();
      await complete(pt, bookingId, { version: 0 }, key).expect(200);

      expectError(await complete(pt, bookingId, { version: 1 }, key), 409, 'IDEMPOTENCY_CONFLICT');
      expect(await usedOf(membershipId)).toBe(3);
    });

    it('US-64-TC06 (F05): key mới trên booking đã COMPLETED → 409 BOOKING_ALREADY_COMPLETED, used không tăng lần hai', async () => {
      const { membershipId, pt, bookingId, end } = await ready();
      freezeClock(end);
      await complete(pt, bookingId, { version: 0 }).expect(200);

      expectError(await complete(pt, bookingId, { version: 1 }), 409, 'BOOKING_ALREADY_COMPLETED');
      expect(await usedOf(membershipId)).toBe(3);
      expect(await completeEvents(bookingId)).toHaveLength(1);
    });

    it('US-64-TC06: mất response → GET /api/operations/PT_BOOKING_COMPLETE/:key trả kết quả gốc; PT khác tra cứu → 404', async () => {
      const { pt, bookingId, end } = await ready();
      const otherPt = await trainer('PT Trần Thị Dung');
      freezeClock(end);
      const key = randomUUID();
      const first = await complete(pt, bookingId, { version: 0 }, key).expect(200);

      const lookup = await get(`/api/operations/PT_BOOKING_COMPLETE/${key}`, pt).expect(200);
      expect(JSON.stringify(lookup.body)).toContain(first.body.id);
      expectError(await get(`/api/operations/PT_BOOKING_COMPLETE/${key}`, otherPt), 404);
    });

    it.each([
      ['thiếu Idempotency-Key', null, { version: 0 }],
      ['Idempotency-Key không phải UUID', 'khong-phai-uuid', { version: 0 }],
      ['thiếu version', 'uuid', {}],
      ['version âm', 'uuid', { version: -1 }],
      ['version không phải số nguyên', 'uuid', { version: 'mot' }],
    ])('US-64-TC06: %s → 400, không ghi gì', async (_label, keyKind, body) => {
      const { membershipId, pt, bookingId, end } = await ready();
      freezeClock(end);
      const key = keyKind === 'uuid' ? randomUUID() : keyKind;
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await complete(pt, bookingId, body as Record<string, unknown>, key), 400);
      });
    });

    it('US-64-TC06: 20 request cùng key cùng body chia đều hai instance → một booking COMPLETED, used+1, một event, một operation; mọi 200 cùng body', async () => {
      const { membershipId, pt, bookingId, end } = await ready();
      freezeClock(end);
      const key = randomUUID();

      const responses = await Promise.all(Array.from({ length: 20 }, (_unused, index) =>
        complete(pt, bookingId, { version: 0 }, key, index % 2 === 0 ? app : second)));

      const ok = responses.filter(response => response.status === 200);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const response of ok) expect(response.body).toEqual(ok[0].body);
      for (const response of responses) expect([200, 409, 503]).toContain(response.status);
      expect(await usedOf(membershipId)).toBe(3);
      expect(await completeEvents(bookingId)).toHaveLength(1);
      expect(await count('operation_requests', { operation: 'PT_BOOKING_COMPLETE' })).toBe(1);
      expect((await bookingDoc(bookingId))?.status).toBe('COMPLETED');
    });

    it('US-64-TC06: 20 request khác key chia đều hai instance → đúng một 200, còn lại 409; used+1 đúng một lần, một event', async () => {
      const { membershipId, pt, bookingId, end } = await ready();
      freezeClock(end);
      const keys = Array.from({ length: 20 }, () => randomUUID());

      const responses = await Promise.all(keys.map((key, index) =>
        complete(pt, bookingId, { version: 0 }, key, index % 2 === 0 ? app : second)));

      // 503 (chưa rõ kết quả) phải tra cứu lại bằng chính key đó trước khi kết luận (EN-02).
      const statuses: number[] = [];
      for (const [index, response] of responses.entries()) {
        if (response.status !== 503) { statuses.push(response.status); continue; }
        const lookup = await get(`/api/operations/PT_BOOKING_COMPLETE/${keys[index]}`, pt);
        statuses.push(lookup.status === 200 ? 200 : 409);
      }
      expect(statuses.filter(status => status === 200)).toHaveLength(1);
      for (const response of responses.filter(item => item.status === 409)) {
        expect(['BOOKING_ALREADY_COMPLETED', 'VERSION_CONFLICT']).toContain(response.body.error.code);
      }
      expect(await usedOf(membershipId)).toBe(3);
      expect(await completeEvents(bookingId)).toHaveLength(1);
    });

    it('US-64-TC07: PT xác nhận và Staff hủy hỗ trợ cùng lúc trên hai instance (5 vòng, đổi thứ tự) → đúng một bên thắng, không vừa dùng vừa nhả', async () => {
      const staff = await staffOf('STAFF');
      const me = await linkedMember();
      const pt = await trainer();
      for (let round = 0; round < 5; round += 1) {
        const end = roundedNow();
        const membershipId = await insertPlan(me.memberId);
        const bookingId = await insertBooking(me.memberId, membershipId, pt.trainerId, end);
        const clock = freezeClock(end);

        const [completeResponse, cancelResponse] = round % 2 === 0
          ? await Promise.all([complete(pt, bookingId, { version: 0 }, randomUUID(), app), cancelSupport(staff, bookingId, second)])
          : await Promise.all([cancelSupport(staff, bookingId, app), complete(pt, bookingId, { version: 0 }, randomUUID(), second)]).then(([c, d]) => [d, c]);

        expect([completeResponse.status, cancelResponse.status].filter(status => status === 200)).toHaveLength(1);
        const doc = await bookingDoc(bookingId);
        if (doc!.status === 'COMPLETED') {
          expect(completeResponse.status).toBe(200);
          expect(await usedOf(membershipId)).toBe(3);
        } else {
          expect(doc!.status).toBe('CANCELLED');
          expect(cancelResponse.status).toBe(200);
          expect(await usedOf(membershipId)).toBe(2);
        }
        expect(await bookedOf(membershipId)).toBe(0);
        expect(await count('booking_events', { booking_id: bookingId })).toBe(1);
        clock.mockRestore();
      }
    });

    it('US-64-TC08: nâng cấp đã commit trước (booking chuyển sang gói đích) → xác nhận trừ gói đích, gói cũ giữ nguyên used', async () => {
      const { me, membershipId: sourceId, pt, bookingId, end } = await ready();
      const targetId = await insertPlan(me.memberId, { used: 4 });
      // Giả lập kết quả nâng cấp US-16 đã commit: booking BOOKED đổi membership_id sang gói đích, version tăng.
      await db().collection('pt_bookings').updateOne({ _id: bookingId }, { $set: { membership_id: targetId, version: 1 } });
      freezeClock(end);

      const response = await complete(pt, bookingId, { version: 1 }).expect(200);

      expect(response.body).toMatchObject({ membershipId: targetId.toHexString(), sessionsUsed: 5 });
      expect(await usedOf(targetId)).toBe(5);
      expect(await usedOf(sourceId)).toBe(2);
      expect(String((await bookingDoc(bookingId))?.completion_membership_id)).toBe(targetId.toHexString());
    });

    it.todo('US-64-TC08: xác nhận cạnh tranh với nâng cấp US-16/20 thật – chờ US-16 (Cường) có service nâng cấp');

    it.each(['booking_events', 'operation_requests'])(
      'US-64-TC09: insert vào %s lỗi trước commit → 503 không lộ lỗi MongoDB; booking vẫn BOOKED, used và khóa giữ nguyên',
      async collection => {
        const { membershipId, pt, bookingId, end } = await ready();
        freezeClock(end);
        await expectNothingWritten(bookingId, membershipId, async () => {
          await failInsertsOn(collection, async () => {
            const response = await complete(pt, bookingId);
            expectError(response, 503);
            expect(JSON.stringify(response.body)).not.toContain('Giả lập DB lỗi');
          });
        });
        expect(await memberRevision((await bookingDoc(bookingId))!.member_id as ObjectId)).toBe(0);
      });

    it.todo('US-64-TC09: lỗi insert notifications/notification_outbox trước commit thì rollback; offline sau commit REST vẫn còn – bước 4');
  });
});
