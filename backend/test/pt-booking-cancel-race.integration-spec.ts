// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật, hai app instance): US-29 bước 4.
// Kiểm tra ngưỡng hủy 2 giờ bằng đồng hồ server giả có kiểm soát (không sleep), giờ đọc lại ở mỗi lần retry transaction,
// và race thật: nhiều lệnh hủy cùng lúc, hủy với đặt lại slot vừa trống, hủy với writer nâng cấp/hoàn tất có khóa member (TC01, TC02, TC09–TC11).
// Hợp đồng test đặt ra cho Builder (US-29 bước 4, theo F01, F04 và EN-05 mục "Đồng hồ", TC11, TC14, TC20):
//   Lệnh hủy lấy giờ từ ServerClock.now() (src/common/utils/business-date.ts) BÊN TRONG callback transaction, mỗi lần retry đọc lại.
//   Dùng API bước 3: POST /api/me/pt-bookings/:id/cancel (MEMBER) và POST /api/pt-bookings/:id/cancel (STAFF/ADMIN), body {version, reason},
//     header Idempotency-Key; đặt lịch mới qua POST /api/me/pt-bookings (US-28).
//   Writer US-16 (nâng cấp) và S07 (hoàn tất) chưa có: test dùng fixture transaction tăng members.service_revision (khóa member)
//     rồi CAS booking, như spec TC11 ghi "fixture completion S07".
//   Ngoài phạm vi (EN-05 làm riêng): hai Nest process riêng, 20 request × 10 vòng cho mọi race, báo cáo lưu file.
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
const databaseName = 'gym_management_test_us29_race';
const password = 'MậtKhẩuUS-29-999';
const REASON = 'Bận việc gia đình đột xuất';
const MINUTE = 60 * 1000;
const ROUNDS = 10;

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Auth = { accessToken: string };

describe('US-29 bước 4: ngưỡng 2 giờ theo đồng hồ giả và race thật', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let second: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      // enableTestCommands=1 để dùng failpoint failCommand giả lập lỗi tạm thời buộc transaction retry (TC02).
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
    // Instance thứ hai (kết nối DB riêng) mô phỏng hai app server chạy song song (TC09–TC11).
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
  const VN_OFFSET_MS = 7 * 60 * MINUTE;
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * MINUTE).toISOString().slice(0, 10);
  const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+07:00`);
  // Mốc buổi tập cho test đồng hồ giả: giờ thật làm tròn phút + 2 giờ, để giờ server giả chỉ lệch giờ thật vài giây
  // (phiên đăng nhập, token vẫn hợp lệ). Tính lại ở mỗi test.
  const fixedStart = () => new Date(Math.floor(Date.now() / MINUTE) * MINUTE + 120 * MINUTE);

  // Đồng hồ server giả: mọi instance ServerClock trả giờ do test quyết định.
  const freezeClock = (now: Date) => jest.spyOn(ServerClock.prototype, 'now').mockImplementation(() => new Date(now.getTime()));

  // ---------- Tài khoản và dữ liệu mẫu (khuôn US-28) ----------
  let phoneSeq = 0;
  async function user(roleCode: Role, fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0916900${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { accountId: String(created.id), phone, accessToken: response.body.accessToken as string };
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

  async function linkedMember(name: string) {
    const owner = await user('MEMBER', name);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: name, phone: owner.phone,
      account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { memberId, ...owner };
  }

  let saleSeq = 0;
  async function insertPlan(memberId: ObjectId, quota = 10) {
    saleSeq += 1;
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const staffId = new ObjectId();
    const now = new Date();
    const money = Decimal128.fromString('3000000');
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US29B4-${saleSeq}`, name: `Gói PT ${saleSeq}`, kind: 'PT', duration_days: 30,
      session_quota: quota, price: money, benefits: 'Quyền lợi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US29B4-${saleSeq}`, kind: 'PT', amount_due: money,
      status: 'SETTLED', request_key: randomBytes(32).toString('hex'), created_at: now, guard_revision: Long.ZERO,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: vnDay(-5), end_date: vnDay(30), plan_name_snapshot: `Gói PT ${saleSeq}`,
      benefits_snapshot: 'Quyền lợi', list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: quota,
      policy_snapshot: 'Giá niêm yết', created_at: now,
    });
    await db().collection('memberships').insertOne({ _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: 2 });
    return membershipId;
  }

  async function insertBooking(memberId: ObjectId, membershipId: ObjectId, trainerId: ObjectId, start: Date) {
    const id = new ObjectId();
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: membershipId, member_id: memberId, trainer_id: trainerId, shift_id: new ObjectId(),
      start_at: start, end_at: new Date(start.getTime() + 60 * MINUTE), status: 'BOOKED', request_key: randomBytes(32).toString('hex'),
      version: 0, trainer_name_snapshot: 'PT Lê Văn Cường', location_snapshot: 'Phòng PT 1', created_at: new Date(), updated_at: new Date(),
    });
    return id;
  }

  async function ready(start: Date) {
    const me = await linkedMember('Hội viên US29 B4');
    const membershipId = await insertPlan(me.memberId);
    const pt = await trainer();
    const bookingId = await insertBooking(me.memberId, membershipId, pt.trainerId, start);
    return { me, membershipId, pt, bookingId };
  }

  async function insertShift(trainerId: ObjectId, day: string) {
    const id = new ObjectId();
    const now = new Date();
    await db().collection('work_shifts').insertOne({
      _id: id, id, trainer_id: trainerId, start_at: at(day, '08:00'), end_at: at(day, '11:00'), location: 'Phòng PT 2', status: 'CONFIRMED', version: 1,
      created_by: new ObjectId(), updated_by: new ObjectId(), created_at: now, updated_at: now, confirmed_at: now,
    });
    return id;
  }

  // ---------- Gọi API ----------
  function post(instance: INestApplication, path: string, auth: Auth, body: Record<string, unknown>, key: string) {
    return http(instance).post(path).set('Origin', origin).set('Authorization', `Bearer ${auth.accessToken}`).set('Idempotency-Key', key).send(body);
  }
  const cancelOwn = (auth: Auth, bookingId: ObjectId, version = 0, key: string = randomUUID(), instance = app) =>
    post(instance, `/api/me/pt-bookings/${bookingId.toHexString()}/cancel`, auth, { version, reason: REASON }, key);
  const cancelSupport = (auth: Auth, bookingId: ObjectId, version = 0, key: string = randomUUID(), instance = app) =>
    post(instance, `/api/pt-bookings/${bookingId.toHexString()}/cancel`, auth, { version, reason: REASON }, key);
  const book = (auth: Auth, body: Record<string, unknown>, key: string = randomUUID(), instance = app) => post(instance, '/api/me/pt-bookings', auth, body, key);

  const bookingDoc = (id: ObjectId) => db().collection('pt_bookings').findOne({ _id: id });
  const count = (collection: string, filter: Record<string, unknown> = {}) => db().collection(collection).countDocuments(filter);
  const memberRevision = async (memberId: ObjectId) => Number(String((await db().collection('members').findOne({ _id: memberId }, { promoteLongs: false }))?.service_revision));
  const usedOf = async (membershipId: ObjectId) => (await db().collection('memberships').findOne({ _id: membershipId }))?.sessions_used as number;
  const reservedOf = (membershipId: ObjectId) => count('pt_bookings', { membership_id: membershipId, status: 'BOOKED' });

  // =====================================================================
  // AC01 – Ngưỡng 2 giờ theo đồng hồ server giả (TC01, TC02)
  // =====================================================================

  describe('US-29-TC01: Member hủy khi còn đúng 2 giờ theo giờ server', () => {
    it('US-29-TC01: giờ server = startAt − 120 phút đúng → 200 CANCELLED; cancelledAt và cancelled_at là giờ server giả', async () => {
      const FIXED_START = fixedStart();
      const { me, bookingId } = await ready(FIXED_START);
      const serverNow = new Date(FIXED_START.getTime() - 120 * MINUTE);
      freezeClock(serverNow);

      const response = await cancelOwn(me, bookingId);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('CANCELLED');
      expect(new Date(response.body.cancelledAt).getTime()).toBe(serverNow.getTime());
      expect(((await bookingDoc(bookingId))?.cancelled_at as Date).getTime()).toBe(serverNow.getTime());
    });

    it('US-29-TC01: giờ server = startAt − 120 phút 1 giây (trên 2 giờ) → 200 CANCELLED', async () => {
      const FIXED_START = fixedStart();
      const { me, bookingId } = await ready(FIXED_START);
      freezeClock(new Date(FIXED_START.getTime() - 120 * MINUTE - 1000));

      expect((await cancelOwn(me, bookingId)).status).toBe(200);
    });
  });

  describe('US-29-TC02: còn 1:59:59 hoặc retry vượt mốc → 409, giờ server quyết định', () => {
    it('US-29-TC02: giờ server = startAt − 119 phút 59 giây → 409 CANCELLATION_WINDOW_CLOSED, booking giữ nguyên', async () => {
      const FIXED_START = fixedStart();
      const { me, bookingId } = await ready(FIXED_START);
      freezeClock(new Date(FIXED_START.getTime() - 119 * MINUTE - 59 * 1000));
      const before = await bookingDoc(bookingId);

      const response = await cancelOwn(me, bookingId);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CANCELLATION_WINDOW_CLOSED');
      expect(await bookingDoc(bookingId)).toEqual(before);
    });

    it('US-29-TC02: header Date của client lùi 1 ngày nhưng giờ server còn 1:59:59 → vẫn 409 (không tin đồng hồ client)', async () => {
      const FIXED_START = fixedStart();
      const { me, bookingId } = await ready(FIXED_START);
      freezeClock(new Date(FIXED_START.getTime() - 119 * MINUTE - 59 * 1000));

      const response = await http().post(`/api/me/pt-bookings/${bookingId.toHexString()}/cancel`).set('Origin', origin)
        .set('Authorization', `Bearer ${me.accessToken}`).set('Idempotency-Key', randomUUID())
        .set('Date', new Date(FIXED_START.getTime() - 24 * 60 * MINUTE).toUTCString()).send({ version: 0, reason: REASON });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CANCELLATION_WINDOW_CLOSED');
    });

    it('US-29-TC02: lần chạy đầu còn trên 2 giờ nhưng transaction bị retry sau khi qua mốc → 409 theo giờ của lần retry, không hủy', async () => {
      const FIXED_START = fixedStart();
      const { me, bookingId } = await ready(FIXED_START);
      // Đồng hồ giả chạy theo thời gian thật nhưng lệch sao cho lúc gửi còn 2 giờ + 1 giây.
      // Lần ghi audit đầu bị giữ 3 giây rồi báo lỗi tạm thời (TransientTransactionError) → driver chạy lại callback
      // khi đồng hồ giả đã qua mốc khoảng 2 giây. Service phải đọc lại giờ trong lần retry.
      const offset = FIXED_START.getTime() - 120 * MINUTE - 1000 - Date.now();
      jest.spyOn(ServerClock.prototype, 'now').mockImplementation(() => new Date(Date.now() + offset));
      await db().admin().command({
        configureFailPoint: 'failCommand', mode: { times: 1 },
        data: {
          failCommands: ['insert'], namespace: `${databaseName}.booking_events`, blockConnection: true, blockTimeMS: 3000,
          errorCode: 112, errorLabels: ['TransientTransactionError'], errmsg: 'Giả lập WriteConflict US-29-TC02',
        },
      });

      const response = await cancelOwn(me, bookingId);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CANCELLATION_WINDOW_CLOSED');
      expect((await bookingDoc(bookingId))?.status).toBe('BOOKED');
      expect(await count('booking_events')).toBe(0);
    }, 30000);
  });

  // =====================================================================
  // AC03 – Race thật trên hai app instance (TC09, TC10, TC11)
  // =====================================================================

  describe('US-29-TC09: 20 lệnh hủy cùng/khác key và actor trên hai instance', () => {
    it('US-29-TC09: một booking BOOKED nhận 20 lệnh hủy đồng thời → một transition, một audit, một thông báo; used giữ, reserved giảm đúng 1', async () => {
      const { me, membershipId, bookingId } = await ready(at(vnDay(10), '09:00'));
      const staff = await user('STAFF', 'Nhân viên Quầy');
      const admin = await user('ADMIN', 'Quản trị viên');
      const memberKey = randomUUID();
      const staffKey = randomUUID();
      const usedBefore = await usedOf(membershipId);
      const reservedBefore = await reservedOf(membershipId);

      // 20 lệnh chia đều hai instance: Member cùng key (6), Member khác key (4), Staff cùng key (5), Admin khác key (5).
      const calls: { send: () => request.Test; key: string; kind: 'own' | 'support'; auth: Auth }[] = [];
      for (let i = 0; i < 20; i += 1) {
        const instance = i % 2 === 0 ? app : second;
        if (i < 6) calls.push({ send: () => cancelOwn(me, bookingId, 0, memberKey, instance), key: memberKey, kind: 'own', auth: me });
        else if (i < 10) { const key = randomUUID(); calls.push({ send: () => cancelOwn(me, bookingId, 0, key, instance), key, kind: 'own', auth: me }); }
        else if (i < 15) calls.push({ send: () => cancelSupport(staff, bookingId, 0, staffKey, instance), key: staffKey, kind: 'support', auth: staff });
        else { const key = randomUUID(); calls.push({ send: () => cancelSupport(admin, bookingId, 0, key, instance), key, kind: 'support', auth: admin }); }
      }

      const responses = await Promise.all(calls.map(call => call.send()));

      // 503 do hết hạn retry phải được giải quyết bằng cùng key (EN-05 mục 42), không coi là "thua hợp lệ".
      const finals = await Promise.all(responses.map(async (response, index) => {
        if (response.status !== 503) return response;
        const call = calls[index];
        return call.kind === 'own' ? cancelOwn(call.auth, bookingId, 0, call.key) : cancelSupport(call.auth, bookingId, 0, call.key);
      }));
      for (const response of finals) expect([200, 409]).toContain(response.status);
      const successes = finals.filter(response => response.status === 200);
      expect(successes.length).toBeGreaterThanOrEqual(1);
      for (const response of successes) expect(response.body).toEqual(successes[0].body);
      for (const response of finals.filter(item => item.status === 409)) {
        expect(['VERSION_CONFLICT', 'INVALID_BOOKING_STATE']).toContain(response.body.error.code);
      }
      expect((await bookingDoc(bookingId))?.version).toBe(1);
      expect(await count('booking_events', { booking_id: bookingId })).toBe(1);
      expect(await count('notifications', { event_key: `BOOKING_CANCELLED:${bookingId.toHexString()}` })).toBe(1);
      expect(await usedOf(membershipId)).toBe(usedBefore);
      expect(await reservedOf(membershipId)).toBe(reservedBefore - 1);
    }, 120000);
  });

  describe('US-29-TC10: hủy và đặt slot vừa giải phóng cạnh tranh', () => {
    // Member A đã đặt slot 09:00 qua API US-28; Member B có gói riêng, cùng PT/ca.
    async function slotScenario() {
      const day = vnDay(10);
      const pt = await trainer();
      const shiftId = await insertShift(pt.trainerId, day);
      const memberA = await linkedMember('Hội viên A');
      const membershipA = await insertPlan(memberA.memberId);
      const memberB = await linkedMember('Hội viên B');
      const membershipB = await insertPlan(memberB.memberId);
      const startAt = `${day}T09:00:00+07:00`;
      const bodyFor = (membershipId: ObjectId) => ({
        membershipId: membershipId.toHexString(), trainerId: pt.trainerId.toHexString(), shiftId: shiftId.toHexString(), startAt,
      });
      const created = await book(memberA, bodyFor(membershipA)).expect(201);
      return { pt, memberA, membershipA, memberB, membershipB, bookingA: new ObjectId(created.body.id as string), bodyB: bodyFor(membershipB), start: at(day, '09:00') };
    }

    it('US-29-TC10: hủy xong rồi Member B đặt đúng slot đó (ý định mới, kiểm đủ điều kiện US-28) → 201', async () => {
      const { memberA, memberB, bookingA, bodyB } = await slotScenario();

      await cancelOwn(memberA, bookingA).expect(200);
      const response = await book(memberB, bodyB);

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('BOOKED');
    });

    it(`US-29-TC10: ${ROUNDS} vòng A hủy và B đặt cùng slot đồng thời trên hai instance (đảo thứ tự gửi) → thứ tự commit hợp lệ, không giữ chỗ kép, quota không âm`, async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        await db().collection('pt_bookings').deleteMany({});
        const { pt, memberA, membershipA, memberB, membershipB, bookingA, bodyB, start } = await slotScenario();
        const usedA = await usedOf(membershipA);
        const usedB = await usedOf(membershipB);

        const cancelCall = () => cancelOwn(memberA, bookingA, 0, randomUUID(), round % 2 === 0 ? app : second);
        const bookCall = () => book(memberB, bodyB, randomUUID(), round % 2 === 0 ? second : app);
        const [cancelResponse, bookResponse] = round % 2 === 0
          ? await Promise.all([cancelCall(), bookCall()])
          : await Promise.all([bookCall(), cancelCall()]).then(([b, c]) => [c, b]);

        expect(cancelResponse.status).toBe(200);
        expect([201, 409]).toContain(bookResponse.status);
        if (bookResponse.status === 409) expect(bookResponse.body.error.code).toBe('SLOT_UNAVAILABLE');
        expect(await count('pt_bookings', { trainer_id: pt.trainerId, start_at: start, status: 'BOOKED' })).toBe(bookResponse.status === 201 ? 1 : 0);
        expect(await reservedOf(membershipA)).toBe(0);
        expect(await reservedOf(membershipB)).toBe(bookResponse.status === 201 ? 1 : 0);
        expect(await usedOf(membershipA)).toBe(usedA);
        expect(await usedOf(membershipB)).toBe(usedB);
      }
    }, 300000);
  });

  describe('US-29-TC11: hủy cạnh tranh với nâng cấp hoặc fixture hoàn tất S07, giữ khóa member', () => {
    // Fixture writer S07 (chưa có): trong transaction lấy khóa member rồi CAS BOOKED → COMPLETED và tăng used đúng 1.
    async function completeFixture(memberId: ObjectId, bookingId: ObjectId, membershipId: ObjectId) {
      const session = connection.getClient().startSession();
      try {
        let completed = false;
        await session.withTransaction(async () => {
          completed = false;
          await db().collection('members').updateOne({ _id: memberId }, { $inc: { service_revision: Long.ONE } }, { session });
          const result = await db().collection('pt_bookings').updateOne(
            { _id: bookingId, status: 'BOOKED' }, { $set: { status: 'COMPLETED', completed_at: new Date(), updated_at: new Date() }, $inc: { version: 1 } }, { session });
          if (result.modifiedCount === 1) {
            await db().collection('memberships').updateOne({ _id: membershipId }, { $inc: { sessions_used: 1 } }, { session });
            completed = true;
          }
        });
        return completed;
      } finally {
        await session.endSession();
      }
    }

    // Fixture writer US-16 (chưa có): trong transaction lấy khóa member rồi chuyển booking BOOKED version 0 sang gói mới, version+1.
    async function upgradeFixture(memberId: ObjectId, bookingId: ObjectId, newMembershipId: ObjectId) {
      const session = connection.getClient().startSession();
      try {
        let moved = false;
        await session.withTransaction(async () => {
          moved = false;
          await db().collection('members').updateOne({ _id: memberId }, { $inc: { service_revision: Long.ONE } }, { session });
          const result = await db().collection('pt_bookings').updateOne(
            { _id: bookingId, status: 'BOOKED', version: 0 }, { $set: { membership_id: newMembershipId, updated_at: new Date() }, $inc: { version: 1 } }, { session });
          moved = result.modifiedCount === 1;
        });
        return moved;
      } finally {
        await session.endSession();
      }
    }

    it(`US-29-TC11: ${ROUNDS} vòng hủy và fixture hoàn tất đồng thời → một status cuối; used tăng đúng 1 khi hoàn tất thắng, không tăng khi hủy thắng`, async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const { me, membershipId, bookingId } = await ready(at(vnDay(10), '09:00'));
        const staff = await user('STAFF', 'Nhân viên Quầy');
        const usedBefore = await usedOf(membershipId);
        const revisionBefore = await memberRevision(me.memberId);

        const cancelCall = () => cancelSupport(staff, bookingId, 0, randomUUID(), round % 2 === 0 ? app : second);
        const [cancelResponse, completed] = round % 2 === 0
          ? await Promise.all([cancelCall(), completeFixture(me.memberId, bookingId, membershipId)])
          : await Promise.all([completeFixture(me.memberId, bookingId, membershipId), cancelCall()]).then(([c, r]) => [r, c] as const);

        const final = await bookingDoc(bookingId);
        if (cancelResponse.status === 200) {
          expect(completed).toBe(false);
          expect(final?.status).toBe('CANCELLED');
          expect(await usedOf(membershipId)).toBe(usedBefore);
          expect(await count('booking_events', { booking_id: bookingId })).toBe(1);
        } else {
          expect(cancelResponse.status).toBe(409);
          expect(['INVALID_BOOKING_STATE', 'VERSION_CONFLICT']).toContain(cancelResponse.body.error.code);
          expect(completed).toBe(true);
          expect(final?.status).toBe('COMPLETED');
          expect(await usedOf(membershipId)).toBe(usedBefore + 1);
          expect(await count('booking_events', { booking_id: bookingId })).toBe(0);
        }
        expect(final?.version).toBe(1);
        // Khóa member: fixture luôn tăng 1; lệnh hủy chỉ tăng khi thành công.
        expect(await memberRevision(me.memberId)).toBe(revisionBefore + 1 + (cancelResponse.status === 200 ? 1 : 0));
      }
    }, 300000);

    it(`US-29-TC11: ${ROUNDS} vòng Member hủy (version 0) và fixture nâng cấp đồng thời → hoặc hủy trên gói cũ, hoặc 409 và booking BOOKED ở gói mới; member_id không đổi`, async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const { me, membershipId, bookingId } = await ready(at(vnDay(10), '09:00'));
        const newMembershipId = await insertPlan(me.memberId);

        const cancelCall = () => cancelOwn(me, bookingId, 0, randomUUID(), round % 2 === 0 ? app : second);
        const [cancelResponse, moved] = round % 2 === 0
          ? await Promise.all([cancelCall(), upgradeFixture(me.memberId, bookingId, newMembershipId)])
          : await Promise.all([upgradeFixture(me.memberId, bookingId, newMembershipId), cancelCall()]).then(([m, r]) => [r, m] as const);

        const final = await bookingDoc(bookingId);
        expect(String(final?.member_id)).toBe(me.memberId.toHexString());
        if (cancelResponse.status === 200) {
          expect(moved).toBe(false);
          expect(final?.status).toBe('CANCELLED');
          expect(String(final?.membership_id)).toBe(membershipId.toHexString());
          const event = await db().collection('booking_events').findOne({ booking_id: bookingId });
          expect(String(event?.membership_id)).toBe(membershipId.toHexString());
          expect(await reservedOf(membershipId)).toBe(0);
          expect(await reservedOf(newMembershipId)).toBe(0);
        } else {
          expect(cancelResponse.status).toBe(409);
          expect(cancelResponse.body.error.code).toBe('VERSION_CONFLICT');
          expect(moved).toBe(true);
          expect(final?.status).toBe('BOOKED');
          expect(String(final?.membership_id)).toBe(newMembershipId.toHexString());
          expect(await reservedOf(membershipId)).toBe(0);
          expect(await reservedOf(newMembershipId)).toBe(1);
          expect(await count('booking_events', { booking_id: bookingId })).toBe(0);
        }
      }
    }, 300000);
  });
});
