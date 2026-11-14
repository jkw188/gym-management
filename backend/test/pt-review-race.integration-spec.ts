// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật, hai app instance): US-65 bước 4.
// Kiểm tra gửi đánh giá trùng qua hai instance (cùng key / key khác / cùng key khác payload) và đánh giá cạnh tranh
// với Admin REOPEN của US-64: luôn đúng một bên thắng, không bao giờ có review của buổi đã bị mở lại (TC09, TC10).
// Hợp đồng test đặt ra cho Builder (US-65 bước 4, theo F03, F05 và S07-P01; dùng API đã có):
//   POST /api/me/pt-bookings/:id/review (US-65 bước 2): MEMBER, Idempotency-Key, body {rating, comment?}.
//   POST /api/admin/pt-bookings/:id/corrections (US-64 bước 3): ADMIN, Idempotency-Key, body {version, action: 'REOPEN', reason}.
//   Buổi COMPLETED được tạo bằng API thật PT xác nhận (POST /api/me/pt-bookings/:id/complete, US-64 bước 2): used 2 → 3, version 1.
//   TC09: dù hai instance chạy song song – đúng một trainer_reviews, một booking_events REVIEW_SUBMITTED, một operation_requests;
//     cùng key cùng payload: mọi phản hồi là 201 cùng id hoặc 409; key khác: đúng một 201, còn lại 409 REVIEW_ALREADY_EXISTS.
//   TC10: review thắng → REOPEN 409 COMPLETION_RECONCILIATION_REQUIRED, booking COMPLETED, used giữ 3;
//     REOPEN thắng → review 409 BOOKING_NOT_COMPLETED, booking BOOKED, used 2, không có review và audit REVIEW_SUBMITTED.
//   TC12 (tổng điểm US-31/33) CHƯA viết: US-31 chưa cài đặt, US-33 chưa có spec trong kit/specs (đã báo sinh viên).
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
const databaseName = 'gym_management_test_us65_race';
const password = 'MậtKhẩuUS-65-789';
const REASON = 'PT báo nhầm, học viên vắng buổi này';
const MINUTE = 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * MINUTE;
// Số vòng lặp lại mỗi kịch bản race: mỗi vòng một buổi mới, để thứ tự hai request đổi ngẫu nhiên.
const ROUNDS = 5;
const RACE_TIMEOUT = 240000;

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Auth = { accessToken: string; accountId: string };

describe('US-65 bước 4: đánh giá trùng qua hai instance và cạnh tranh Admin REOPEN', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let second: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      // enableTestCommands=1 để dùng failpoint failCommand làm chậm một lệnh, ép hai request chồng lên nhau (TC10).
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName, args: ['--setParameter', 'enableTestCommands=1'] },
    });
    Object.assign(process.env, {
      NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(), MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'us65-test', SMTP_PASS: 'us65-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    // Instance thứ hai (kết nối DB riêng) mô phỏng hai app server chạy song song (TC09 "qua hai app").
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
  const roundedNow = () => new Date(Math.floor(Date.now() / MINUTE) * MINUTE);
  const vnDate = (instant: Date) => new Date(instant.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
  const freezeClock = (now: Date) => jest.spyOn(ServerClock.prototype, 'now').mockImplementation(() => new Date(now.getTime()));

  // ---------- Tài khoản (khuôn test US-64) ----------
  let phoneSeq = 0;
  async function account(roleCode: Role, fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0914659${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: String(created.id), phone };
  }
  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }
  async function userOf(role: Role): Promise<Auth> {
    const created = await account(role, `${role} US65`);
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

  // Member đã liên kết account, đăng nhập sẵn.
  async function linkedMember() {
    const owner = await account('MEMBER', 'Hội viên US65');
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: 'Hội viên US65', phone: owner.phone,
      account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { memberId, accountId: owner.accountId, accessToken: await loginAs(owner.phone) };
  }

  // Gói PT (thay US-14/22): quota 10, used 2.
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
    const today = vnDate(new Date());
    const shiftDays = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 24 * 60 * MINUTE).toISOString().slice(0, 10);
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US65R-${saleSeq}`, name: `Gói PT ${saleSeq}`, kind: 'PT', duration_days: 30,
      session_quota: 10, price: money, benefits: 'Quyền lợi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US65R-${saleSeq}`, kind: 'PT', amount_due: money,
      status: 'SETTLED', request_key: randomBytes(32).toString('hex'), created_at: now, guard_revision: Long.ZERO,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: shiftDays(-10), end_date: shiftDays(30), plan_name_snapshot: `Gói PT ${saleSeq}`,
      benefits_snapshot: 'Quyền lợi', list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: 10,
      policy_snapshot: 'Giá niêm yết', created_at: now,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: 2,
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

  // Người dùng dùng chung cho một test (đăng nhập tốn thời gian): một Member, một PT, một Admin.
  async function people() {
    return { me: await linkedMember(), pt: await trainer(), admin: await userOf('ADMIN') };
  }
  type People = Awaited<ReturnType<typeof people>>;

  // Một buổi mới của Member, được PT xác nhận qua API thật: COMPLETED, version 1, used 2 → 3.
  async function completedBooking(who: People) {
    const end = roundedNow();
    const membershipId = await insertPlan(who.me.memberId);
    const bookingId = await insertBooking(who.me.memberId, membershipId, who.pt.trainerId, end);
    const clock = freezeClock(end);
    await http().post(`/api/me/pt-bookings/${bookingId.toHexString()}/complete`).set('Origin', origin)
      .set('Authorization', `Bearer ${who.pt.accessToken}`).set('Idempotency-Key', randomUUID()).send({ version: 0 }).expect(200);
    clock.mockRestore();
    return { membershipId, bookingId };
  }

  // ---------- Gọi API ----------
  function submit(instance: INestApplication, auth: Auth, bookingId: ObjectId, body: Record<string, unknown> = { rating: 4 },
    key: string = randomUUID()) {
    return http(instance).post(`/api/me/pt-bookings/${bookingId.toHexString()}/review`).set('Origin', origin)
      .set('Authorization', `Bearer ${auth.accessToken}`).set('Idempotency-Key', key).send(body);
  }
  function reopen(instance: INestApplication, admin: Auth, bookingId: ObjectId, version = 1, key: string = randomUUID()) {
    return http(instance).post(`/api/admin/pt-bookings/${bookingId.toHexString()}/corrections`).set('Origin', origin)
      .set('Authorization', `Bearer ${admin.accessToken}`).set('Idempotency-Key', key).send({ version, action: 'REOPEN', reason: REASON });
  }
  const codeOf = (response: request.Response) => response.body?.error?.code as string | undefined;

  // ---------- Đọc DB ----------
  const count = (collection: string, filter: Record<string, unknown> = {}) => db().collection(collection).countDocuments(filter);
  const bookingDoc = (id: ObjectId) => db().collection('pt_bookings').findOne({ _id: id });
  const usedOf = async (membershipId: ObjectId) => (await db().collection('memberships').findOne({ _id: membershipId }))?.sessions_used as number;
  const reviewsOf = (bookingId: ObjectId) => count('trainer_reviews', { booking_id: bookingId });
  const reviewEventsOf = (bookingId: ObjectId) => count('booking_events', { booking_id: bookingId, action: 'REVIEW_SUBMITTED' });
  const reopenEventsOf = (bookingId: ObjectId) => count('booking_events', { booking_id: bookingId, action: 'REOPEN' });

  // Làm chậm lần chạy KẾ TIẾP của một lệnh ghi vào collection (giữ nguyên transaction đang mở) – ép hai request chồng nhau.
  async function slowNext(collection: string, commands: string[], ms: number) {
    await db().admin().command({
      configureFailPoint: 'failCommand', mode: { times: 1 },
      data: { failCommands: commands, namespace: `${databaseName}.${collection}`, blockConnection: true, blockTimeMS: ms },
    });
  }
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  // Gửi request ngay (supertest chỉ gửi khi được then) và ghi lại thời điểm có phản hồi.
  const start = (call: request.Test) => call.then(response => ({ response, doneAt: Date.now() }));

  // Đúng một review và một audit REVIEW_SUBMITTED cho buổi này.
  async function expectExactlyOneReview(bookingId: ObjectId) {
    expect(await reviewsOf(bookingId)).toBe(1);
    expect(await reviewEventsOf(bookingId)).toBe(1);
  }

  // =====================================================================
  // TC09 – gửi trùng qua hai instance
  // =====================================================================
  describe('US-65-AC03: đồng thời và replay qua hai instance', () => {
    it('US-65-TC09: instance A tạo xong, instance B gửi lại cùng key cùng payload → 201 body gốc giống hệt, vẫn một review', async () => {
      const who = await people();
      const { bookingId } = await completedBooking(who);
      const key = randomUUID();

      const first = await submit(app, who.me, bookingId, { rating: 5, comment: 'Rất tốt' }, key).expect(201);
      const replay = await submit(second, who.me, bookingId, { rating: 5, comment: 'Rất tốt' }, key).expect(201);

      expect(replay.body).toEqual(first.body);
      await expectExactlyOneReview(bookingId);
      expect(await count('operation_requests', { operation: 'PT_REVIEW_CREATE' })).toBe(1);
    }, RACE_TIMEOUT);

    it(`US-65-TC09: hai instance gửi CÙNG key cùng payload đồng thời (${ROUNDS} vòng) → một review/audit/key; phản hồi 201 cùng id hoặc 409`, async () => {
      const who = await people();
      for (let round = 0; round < ROUNDS; round += 1) {
        const { bookingId } = await completedBooking(who);
        const key = randomUUID();
        const body = { rating: 4, comment: `Vòng ${round}` };

        const responses = await Promise.all([
          submit(app, who.me, bookingId, body, key), submit(second, who.me, bookingId, body, key),
          submit(app, who.me, bookingId, body, key), submit(second, who.me, bookingId, body, key),
        ]);

        const created = responses.filter(response => response.status === 201);
        expect(created.length).toBeGreaterThanOrEqual(1);
        for (const response of responses) expect([201, 409]).toContain(response.status);
        expect(new Set(created.map(response => response.body.id)).size).toBe(1);
        await expectExactlyOneReview(bookingId);
        // Sau khi xong, gửi lại cùng key ở cả hai instance vẫn trả đúng bản gốc.
        for (const instance of [app, second]) {
          const replay = await submit(instance, who.me, bookingId, body, key).expect(201);
          expect(replay.body.id).toBe(created[0].body.id);
        }
      }
      expect(await count('operation_requests', { operation: 'PT_REVIEW_CREATE' })).toBe(ROUNDS);
    }, RACE_TIMEOUT);

    it(`US-65-TC09: hai instance gửi key KHÁC nhau đồng thời (${ROUNDS} vòng) → đúng một 201, còn lại 409 REVIEW_ALREADY_EXISTS`, async () => {
      const who = await people();
      for (let round = 0; round < ROUNDS; round += 1) {
        const { bookingId } = await completedBooking(who);

        const responses = await Promise.all([
          submit(app, who.me, bookingId, { rating: 1 }), submit(second, who.me, bookingId, { rating: 2 }),
          submit(app, who.me, bookingId, { rating: 3 }), submit(second, who.me, bookingId, { rating: 4 }),
        ]);

        expect(responses.filter(response => response.status === 201)).toHaveLength(1);
        for (const response of responses.filter(item => item.status !== 201)) {
          expect(response.status).toBe(409);
          expect(codeOf(response)).toBe('REVIEW_ALREADY_EXISTS');
        }
        await expectExactlyOneReview(bookingId);
        // Điểm lưu là điểm của đúng request thắng.
        const winner = responses.find(response => response.status === 201)!;
        expect((await db().collection('trainer_reviews').findOne({ booking_id: bookingId }))?.rating).toBe(winner.body.rating);
      }
    }, RACE_TIMEOUT);

    it('US-65-TC09: cùng key nhưng payload khác trên hai instance đồng thời → chỉ một review; gửi lại payload còn lại → 409 IDEMPOTENCY_CONFLICT', async () => {
      const who = await people();
      const { bookingId } = await completedBooking(who);
      const key = randomUUID();

      const responses = await Promise.all([
        submit(app, who.me, bookingId, { rating: 5 }, key), submit(second, who.me, bookingId, { rating: 1 }, key),
      ]);

      const created = responses.filter(response => response.status === 201);
      expect(created).toHaveLength(1);
      expect(responses.find(response => response.status !== 201)?.status).toBe(409);
      await expectExactlyOneReview(bookingId);
      const loserRating = created[0].body.rating === 5 ? 1 : 5;
      const again = await submit(second, who.me, bookingId, { rating: loserRating }, key);
      expect(again.status).toBe(409);
      expect(codeOf(again)).toBe('IDEMPOTENCY_CONFLICT');
    }, RACE_TIMEOUT);
  });

  // =====================================================================
  // TC10 – cạnh tranh Admin REOPEN (US-64)
  // =====================================================================
  describe('US-65-AC03: đánh giá cạnh tranh Admin REOPEN', () => {
    it('US-65-TC10: Admin REOPEN commit trước rồi Member gửi đánh giá → 409 BOOKING_NOT_COMPLETED, không có review', async () => {
      const who = await people();
      const { membershipId, bookingId } = await completedBooking(who);

      await reopen(second, who.admin, bookingId).expect(200);
      const response = await submit(app, who.me, bookingId);

      expect(response.status).toBe(409);
      expect(codeOf(response)).toBe('BOOKING_NOT_COMPLETED');
      expect(await reviewsOf(bookingId)).toBe(0);
      expect(await reviewEventsOf(bookingId)).toBe(0);
      expect(await usedOf(membershipId)).toBe(2);
    }, RACE_TIMEOUT);

    it('US-65-TC10: đánh giá commit trước rồi Admin REOPEN → 409 COMPLETION_RECONCILIATION_REQUIRED, review và used giữ nguyên', async () => {
      const who = await people();
      const { membershipId, bookingId } = await completedBooking(who);

      await submit(app, who.me, bookingId).expect(201);
      const response = await reopen(second, who.admin, bookingId);

      expect(response.status).toBe(409);
      expect(codeOf(response)).toBe('COMPLETION_RECONCILIATION_REQUIRED');
      expect(await bookingDoc(bookingId)).toMatchObject({ status: 'COMPLETED', version: 1 });
      expect(await usedOf(membershipId)).toBe(3);
      await expectExactlyOneReview(bookingId);
      expect(await reopenEventsOf(bookingId)).toBe(0);
    }, RACE_TIMEOUT);

    it('US-65-TC10: đánh giá đang trong transaction (insert trainer_reviews chậm 1,5 giây) thì Admin REOPEN chen vào → REOPEN chờ rồi 409 COMPLETION_RECONCILIATION_REQUIRED', async () => {
      const who = await people();
      const { membershipId, bookingId } = await completedBooking(who);
      await slowNext('trainer_reviews', ['insert'], 1500);

      const review = start(submit(app, who.me, bookingId));
      await pause(400);
      const reopenStartedAt = Date.now();
      const correction = await reopen(second, who.admin, bookingId);
      const reviewResult = await review;

      // Hai request thật sự chồng nhau: review chỉ xong sau khi REOPEN đã bắt đầu.
      expect(reviewResult.doneAt).toBeGreaterThan(reopenStartedAt);
      expect(reviewResult.response.status).toBe(201);
      expect(correction.status).toBe(409);
      expect(codeOf(correction)).toBe('COMPLETION_RECONCILIATION_REQUIRED');
      expect(await bookingDoc(bookingId)).toMatchObject({ status: 'COMPLETED', version: 1 });
      expect(await usedOf(membershipId)).toBe(3);
      await expectExactlyOneReview(bookingId);
      expect(await reopenEventsOf(bookingId)).toBe(0);
    }, RACE_TIMEOUT);

    it('US-65-TC10: Admin REOPEN đang trong transaction (cập nhật memberships chậm 1,5 giây) thì Member gửi đánh giá chen vào → đánh giá chờ rồi 409 BOOKING_NOT_COMPLETED', async () => {
      const who = await people();
      const { membershipId, bookingId } = await completedBooking(who);
      await slowNext('memberships', ['update', 'findAndModify'], 1500);

      const correction = start(reopen(second, who.admin, bookingId));
      await pause(400);
      const reviewStartedAt = Date.now();
      const review = await submit(app, who.me, bookingId);
      const correctionResult = await correction;

      // Hai request thật sự chồng nhau: REOPEN chỉ xong sau khi đánh giá đã bắt đầu.
      expect(correctionResult.doneAt).toBeGreaterThan(reviewStartedAt);
      expect(correctionResult.response.status).toBe(200);
      expect(review.status).toBe(409);
      expect(codeOf(review)).toBe('BOOKING_NOT_COMPLETED');
      expect(await bookingDoc(bookingId)).toMatchObject({ status: 'BOOKED', version: 2 });
      expect(await usedOf(membershipId)).toBe(2);
      expect(await reviewsOf(bookingId)).toBe(0);
      expect(await reviewEventsOf(bookingId)).toBe(0);
    }, RACE_TIMEOUT);

    it(`US-65-TC10: đánh giá và Admin REOPEN chạy đồng thời trên hai instance (${ROUNDS} vòng) → đúng một bên thắng, không có review của buổi BOOKED`, async () => {
      const who = await people();
      let reviewWins = 0;
      let reopenWins = 0;
      for (let round = 0; round < ROUNDS; round += 1) {
        const { membershipId, bookingId } = await completedBooking(who);
        // Đổi instance mỗi vòng để không bên nào luôn được đi trước.
        const [reviewApp, reopenApp] = round % 2 === 0 ? [app, second] : [second, app];

        const [review, correction] = await Promise.all([submit(reviewApp, who.me, bookingId), reopen(reopenApp, who.admin, bookingId)]);

        const booking = await bookingDoc(bookingId);
        if (review.status === 201) {
          reviewWins += 1;
          expect(correction.status).toBe(409);
          expect(codeOf(correction)).toBe('COMPLETION_RECONCILIATION_REQUIRED');
          expect(booking).toMatchObject({ status: 'COMPLETED', version: 1 });
          expect(await usedOf(membershipId)).toBe(3);
          await expectExactlyOneReview(bookingId);
          expect(await reopenEventsOf(bookingId)).toBe(0);
        } else {
          reopenWins += 1;
          expect(review.status).toBe(409);
          expect(codeOf(review)).toBe('BOOKING_NOT_COMPLETED');
          expect(correction.status).toBe(200);
          expect(booking).toMatchObject({ status: 'BOOKED', version: 2 });
          expect(await usedOf(membershipId)).toBe(2);
          expect(await reviewsOf(bookingId)).toBe(0);
          expect(await reviewEventsOf(bookingId)).toBe(0);
          expect(await reopenEventsOf(bookingId)).toBe(1);
        }
      }
      expect(reviewWins + reopenWins).toBe(ROUNDS);
      // Bất biến cuối: không có review nào gắn với buổi không còn COMPLETED.
      const orphan = await db().collection('trainer_reviews').aggregate([
        { $lookup: { from: 'pt_bookings', localField: 'booking_id', foreignField: '_id', as: 'booking' } },
        { $match: { 'booking.status': { $ne: 'COMPLETED' } } },
      ]).toArray();
      expect(orphan).toHaveLength(0);
    }, RACE_TIMEOUT);
  });
});
