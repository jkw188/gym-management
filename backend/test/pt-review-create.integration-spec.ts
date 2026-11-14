// Tầng kiểm thử backend (Jest + MongoDB replica set thật + Supertest): US-65 bước 2.
// Kiểm tra Member gửi/xem đánh giá buổi PT qua POST/GET /api/me/pt-bookings/:id/review: đúng chủ booking, buổi COMPLETED,
// điểm/nhận xét hợp lệ, một buổi một đánh giá, snapshot, khóa chung S07-P01, idempotency EN-02 và rollback (TC01–TC08, TC11).
// Hợp đồng test đặt ra cho Builder (US-65 bước 2, theo F01–F05 và bảng API mục 2 của spec):
//   POST /api/me/pt-bookings/:id/review – chỉ MEMBER (quyền ptReviews.createOwn); header Idempotency-Key (UUID v4);
//     operation PT_REVIEW_CREATE; body {rating, comment?}; KHÔNG nhận memberId/trainerId/status/createdAt (400).
//     201 {id, bookingId, trainerId, rating, comment, createdAt} – đúng 6 field.
//   rating số nguyên 1–5 (chuỗi "4" cũng 400); comment trim, ≤ 1000 sau trim, vắng/rỗng → ''; ký tự điều khiển (trừ \n, \t) → 400.
//     HTML giữ nguyên dạng chữ (React escape khi hiển thị).
//   Trong CÙNG transaction (F05): schedule_guards 'global'.revision +1 → members.service_revision của chủ booking +1;
//     đọc lại booking: phải COMPLETED và booking.member_id = member của account đang gọi; kiểm chưa có review rồi insert.
//     trainer_reviews: trainer_id/member_id từ booking, created_by = account Member, created_at = giờ server,
//       trainer_name_snapshot = tên PT, member_display_name_snapshot = tên hội viên; không copy phone/email.
//     Audit (sinh viên chốt 14/11): một dòng booking_events action 'REVIEW_SUBMITTED', booking_id, actor_id = account Member,
//       occurred_at; KHÔNG chứa nội dung comment. operation_requests một dòng.
//     Không trừ quota, không tạo transaction/payment, không thêm event COMPLETE, booking giữ nguyên.
//   GET /api/me/pt-bookings/:id/review – MEMBER chủ booking (sinh viên chốt 14/11 dạng bọc):
//     chưa có → 200 {review: null, canReview: true|false, reason?}; có → 200 {review: {6 field như POST}, canReview: false}.
//     Booking của người khác → 404; GET không tự tạo review.
//   Lỗi (EN01-D03): 400 DTO/key/id sai; 401 phiên/account khóa; 403 sai vai trò; 404 booking không có hoặc của người khác;
//     409 BOOKING_NOT_COMPLETED (BOOKED/CANCELLED); 409 REVIEW_ALREADY_EXISTS (key mới khi đã có review);
//     409 IDEMPOTENCY_CONFLICT (cùng key khác payload); 503 khi DB lỗi, không lộ lỗi MongoDB thô.
//   Không có route PATCH/DELETE review.
//   Để bước sau: projection reviewState và UI (bước 3); hai instance, cạnh tranh Admin REOPEN, tổng điểm US-31/33 (bước 4).
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

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us65_review';
const password = 'MậtKhẩuUS-65-123';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const VN_OFFSET_MS = 7 * 60 * MINUTE;
const PT_NAME = 'PT Lê Văn Cường';
const MEMBER_NAME = 'Hội viên Nguyễn An';
const RESPONSE_FIELDS = ['bookingId', 'comment', 'createdAt', 'id', 'rating', 'trainerId'];

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Auth = { accessToken: string; accountId: string };

describe('US-65 bước 2: Member gửi và xem đánh giá buổi PT', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
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
  const vnDate = (instant: Date) => new Date(instant.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
  const shiftDays = (days: number) => vnDate(new Date(Date.now() + days * DAY));

  // ---------- Tài khoản (khuôn giống test US-64) ----------
  let phoneSeq = 0;
  async function account(roleCode: Role, fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0914650${String(phoneSeq).padStart(3, '0')}`;
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

  // PT mẫu (thay US-23): account TRAINER + hồ sơ trainers.
  async function trainer() {
    const owner = await account('TRAINER', PT_NAME);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: new ObjectId(owner.accountId), specialty: 'Thể hình', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: owner.accountId, accessToken: await loginAs(owner.phone) };
  }

  // Member đã liên kết account, đăng nhập sẵn.
  async function linkedMember(name = MEMBER_NAME) {
    const owner = await account('MEMBER', name);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: name, phone: owner.phone,
      account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { memberId, accountId: owner.accountId, accessToken: await loginAs(owner.phone) };
  }

  // Gói PT (thay US-14/22): quota 10, used 3 (đã tính buổi COMPLETED). endDate để thử gói hết hạn sau buổi.
  let saleSeq = 0;
  async function insertPlan(memberId: ObjectId, options: { endDate?: string } = {}) {
    saleSeq += 1;
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const staffId = new ObjectId();
    const now = new Date();
    const money = Decimal128.fromString('3000000');
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US65-${saleSeq}`, name: `Gói PT ${saleSeq}`, kind: 'PT', duration_days: 30,
      session_quota: 10, price: money, benefits: 'Quyền lợi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US65-${saleSeq}`, kind: 'PT', amount_due: money,
      status: 'SETTLED', request_key: randomBytes(32).toString('hex'), created_at: now, guard_revision: Long.ZERO,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: shiftDays(-40), end_date: options.endDate ?? shiftDays(30), plan_name_snapshot: `Gói PT ${saleSeq}`,
      benefits_snapshot: 'Quyền lợi', list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: 10,
      policy_snapshot: 'Giá niêm yết', created_at: now,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: 3, version: 0,
    });
    return membershipId;
  }

  // Buổi PT đã kết thúc hôm qua. COMPLETED (mặc định) giống dữ liệu sau US-64; BOOKED/CANCELLED để thử chặn.
  async function insertBooking(memberId: ObjectId, membershipId: ObjectId, trainerId: ObjectId, trainerAccountId: string,
    status: 'COMPLETED' | 'BOOKED' | 'CANCELLED' = 'COMPLETED', extra: Record<string, unknown> = {}) {
    const id = new ObjectId();
    const end = new Date(Date.now() - DAY);
    const completed = status === 'COMPLETED'
      ? { completed_at: end, completed_by: new ObjectId(trainerAccountId), completed_actor_type: 'TRAINER',
        completion_membership_id: membershipId, completion_revision: 1 }
      : { completion_revision: 0 };
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: membershipId, member_id: memberId, trainer_id: trainerId, shift_id: new ObjectId(),
      start_at: new Date(end.getTime() - 60 * MINUTE), end_at: end, status, request_key: randomBytes(32).toString('hex'),
      version: status === 'COMPLETED' ? 1 : 0, trainer_name_snapshot: PT_NAME, location_snapshot: 'Phòng PT 1',
      created_at: new Date(end.getTime() - 3 * DAY), updated_at: end, ...completed, ...extra,
    });
    return id;
  }

  async function ready(options: { status?: 'COMPLETED' | 'BOOKED' | 'CANCELLED'; endDate?: string } = {}) {
    const me = await linkedMember();
    const membershipId = await insertPlan(me.memberId, { endDate: options.endDate });
    const pt = await trainer();
    const bookingId = await insertBooking(me.memberId, membershipId, pt.trainerId, pt.accountId, options.status);
    return { me, membershipId, pt, bookingId };
  }

  // ---------- Gọi API ----------
  function submit(auth: Auth | undefined, bookingId: ObjectId | string, body: Record<string, unknown> = { rating: 4 },
    key: string | null = randomUUID()) {
    let call = http().post(`/api/me/pt-bookings/${String(bookingId)}/review`).set('Origin', origin);
    if (auth) call = call.set('Authorization', `Bearer ${auth.accessToken}`);
    if (key !== null) call = call.set('Idempotency-Key', key);
    return call.send(body);
  }
  function readReview(auth: Auth | undefined, bookingId: ObjectId | string) {
    let call = http().get(`/api/me/pt-bookings/${String(bookingId)}/review`).set('Origin', origin);
    if (auth) call = call.set('Authorization', `Bearer ${auth.accessToken}`);
    return call;
  }
  const get = (path: string, auth: Auth) => http().get(path).set('Origin', origin).set('Authorization', `Bearer ${auth.accessToken}`);

  function expectError(response: request.Response, status: number, code?: string) {
    expect(response.status).toBe(status);
    expect(typeof response.body.error?.code).toBe('string');
    expect(typeof response.body.error?.message).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
    if (code) expect(response.body.error.code).toBe(code);
  }

  // ---------- Đọc DB ----------
  const count = (collection: string, filter: Record<string, unknown> = {}) => db().collection(collection).countDocuments(filter);
  const reviewOf = (bookingId: ObjectId) => db().collection('trainer_reviews').findOne({ booking_id: bookingId });
  const bookingDoc = (id: ObjectId) => db().collection('pt_bookings').findOne({ _id: id });
  const usedOf = async (membershipId: ObjectId) => (await db().collection('memberships').findOne({ _id: membershipId }))?.sessions_used as number;
  const guardRevision = async () => Number((await db().collection<{ _id: string; revision: Long }>('schedule_guards').findOne({ _id: 'global' }))?.revision);
  const memberRevision = async (memberId: ObjectId) => Number((await db().collection('members').findOne({ _id: memberId }))?.service_revision);
  const reviewEvents = (bookingId: ObjectId) => db().collection('booking_events').find({ booking_id: bookingId, action: 'REVIEW_SUBMITTED' }).toArray();

  // Lỗi thì không có gì được ghi: không review, không audit, không key, booking/gói/khóa giữ nguyên.
  async function expectNothingWritten(bookingId: ObjectId, membershipId: ObjectId, work: () => Promise<void>) {
    const before = { booking: await bookingDoc(bookingId), used: await usedOf(membershipId), guard: await guardRevision() };
    await work();
    expect(await count('trainer_reviews')).toBe(0);
    expect(await count('booking_events', { action: 'REVIEW_SUBMITTED' })).toBe(0);
    expect(await count('operation_requests', { operation: 'PT_REVIEW_CREATE' })).toBe(0);
    expect(await bookingDoc(bookingId)).toEqual(before.booking);
    expect(await usedOf(membershipId)).toEqual(before.used);
    expect(await guardRevision()).toBe(before.guard);
  }

  // Bật lỗi giả lập khi insert vào một collection, chạy work, rồi tắt (giống US-64-TC09).
  async function failInsertsOn(collection: string, work: () => Promise<void>) {
    await db().admin().command({
      configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: ['insert'], namespace: `${databaseName}.${collection}`, errorCode: 1, errmsg: 'Giả lập DB lỗi US-65-TC11' },
    });
    try {
      await work();
    } finally {
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
  }

  // =====================================================================
  // AC01 – Owner và trạng thái (TC01–TC04)
  // =====================================================================
  describe('US-65-AC01: chủ booking và trạng thái buổi', () => {
    it('US-65-TC01: Member đúng booking COMPLETED gửi 4 sao → 201 đúng 6 field, giá trị lấy từ booking', async () => {
      const { me, pt, bookingId } = await ready();
      const response = await submit(me, bookingId, { rating: 4, comment: 'PT hướng dẫn kỹ' }).expect(201);
      expect(Object.keys(response.body).sort()).toEqual(RESPONSE_FIELDS);
      expect(response.body).toMatchObject({
        bookingId: bookingId.toHexString(), trainerId: pt.trainerId.toHexString(), rating: 4, comment: 'PT hướng dẫn kỹ',
      });
      expect(typeof response.body.id).toBe('string');
    });

    it('US-65-TC01: review lưu owner/snapshot đúng; created_at là giờ server lúc gửi, không phải giờ buổi tập', async () => {
      const { me, pt, bookingId } = await ready();
      const before = Date.now();
      const response = await submit(me, bookingId).expect(201);
      const after = Date.now();

      const doc = await reviewOf(bookingId);
      expect(String(doc?._id)).toBe(response.body.id);
      expect(doc?.member_id).toEqual(me.memberId);
      expect(doc?.trainer_id).toEqual(pt.trainerId);
      expect(String(doc?.created_by)).toBe(me.accountId);
      expect(doc?.trainer_name_snapshot).toBe(PT_NAME);
      expect(doc?.member_display_name_snapshot).toBe(MEMBER_NAME);
      const createdAt = (doc?.created_at as Date).getTime();
      expect(createdAt).toBeGreaterThanOrEqual(before - 1000);
      expect(createdAt).toBeLessThanOrEqual(after + 1000);
      expect(new Date(response.body.createdAt).getTime()).toBe(createdAt);
    });

    it('US-65-TC01: đúng một audit REVIEW_SUBMITTED (booking, actor = account Member, thời điểm), không chứa comment; một operation_requests', async () => {
      const { me, bookingId } = await ready();
      await submit(me, bookingId, { rating: 5, comment: 'Nội dung riêng tư của hội viên' }).expect(201);

      const events = await reviewEvents(bookingId);
      expect(events).toHaveLength(1);
      expect(String(events[0].actor_id)).toBe(me.accountId);
      expect(events[0].occurred_at).toBeInstanceOf(Date);
      expect(JSON.stringify(events[0])).not.toContain('Nội dung riêng tư');
      expect(await count('operation_requests', { operation: 'PT_REVIEW_CREATE' })).toBe(1);
    });

    it('US-65-TC01 (F04): không trừ quota, không tạo transaction/payment, không thêm COMPLETE; booking giữ nguyên', async () => {
      const { me, membershipId, bookingId } = await ready();
      const booking = await bookingDoc(bookingId);
      const counts = { transactions: await count('transactions'), payments: await count('payments') };

      await submit(me, bookingId).expect(201);

      expect(await usedOf(membershipId)).toBe(3);
      expect(await count('transactions')).toBe(counts.transactions);
      expect(await count('payments')).toBe(counts.payments);
      expect(await count('booking_events', { booking_id: bookingId, action: 'COMPLETE' })).toBe(0);
      expect(await bookingDoc(bookingId)).toEqual(booking);
    });

    it('US-65-TC01 (F05): khóa lịch global và members.service_revision của chủ booking mỗi cái tăng đúng 1', async () => {
      const { me, bookingId } = await ready();
      await submit(me, bookingId).expect(201);
      expect(await guardRevision()).toBe(1);
      expect(await memberRevision(me.memberId)).toBe(1);
    });

    it('US-65-TC01 (F01): buổi đã chuyển sang gói khác sau nâng cấp (membership_id đổi, member_id giữ) → vẫn gửi được', async () => {
      const { me, bookingId } = await ready();
      const upgraded = await insertPlan(me.memberId);
      await db().collection('pt_bookings').updateOne({ _id: bookingId }, { $set: { membership_id: upgraded } });
      await submit(me, bookingId).expect(201);
    });

    it('US-65-TC02: Member khác gửi cho booking không phải của mình → 404, không ghi gì', async () => {
      const { membershipId, bookingId } = await ready();
      const stranger = await linkedMember('Người lạ');
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await submit(stranger, bookingId), 404);
      });
    });

    it('US-65-TC02: GET review booking của người khác → 404, không tự tạo review', async () => {
      const { bookingId } = await ready();
      const stranger = await linkedMember('Người lạ');
      expectError(await readReview(stranger, bookingId), 404);
      expect(await count('trainer_reviews')).toBe(0);
    });

    it.each([
      ['memberId', () => ({ rating: 4, memberId: new ObjectId().toHexString() })],
      ['trainerId', () => ({ rating: 4, trainerId: new ObjectId().toHexString() })],
      ['status', () => ({ rating: 4, status: 'COMPLETED' })],
      ['createdAt', () => ({ rating: 4, createdAt: '2020-01-01T00:00:00Z' })],
    ])('US-65-TC02: body có %s → 400, không viết thay', async (_field, body) => {
      const { me, membershipId, bookingId } = await ready();
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await submit(me, bookingId, body()), 400);
      });
    });

    it('US-65-TC02: booking không tồn tại → 404; id sai định dạng → 400', async () => {
      const me = await linkedMember();
      expectError(await submit(me, new ObjectId()), 404);
      expectError(await submit(me, 'khong-phai-id'), 400);
    });

    it.each(['TRAINER', 'ADMIN', 'STAFF'] as const)('US-65-TC03: %s gửi đánh giá hộ → 403, không ghi gì', async role => {
      const { membershipId, bookingId, pt } = await ready();
      const caller = role === 'TRAINER' ? pt : await userOf(role);
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await submit(caller, bookingId), 403);
      });
    });

    it('US-65-TC03: chưa đăng nhập → 401, không ghi gì', async () => {
      const { membershipId, bookingId } = await ready();
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await submit(undefined, bookingId), 401);
        expectError(await readReview(undefined, bookingId), 401);
      });
    });

    it('US-65-TC03: account Member bị khóa (LOCKED) dùng token cũ → 401, không ghi gì', async () => {
      const { me, membershipId, bookingId } = await ready();
      await db().collection('accounts').updateOne({ _id: new ObjectId(me.accountId) }, { $set: { status: 'LOCKED' } });
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await submit(me, bookingId), 401);
      });
    });

    it.each(['BOOKED', 'CANCELLED'] as const)('US-65-TC04: booking %s → 409 BOOKING_NOT_COMPLETED, không ghi gì', async status => {
      const { me, membershipId, bookingId } = await ready({ status });
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await submit(me, bookingId), 409, 'BOOKING_NOT_COMPLETED');
      });
    });

    it('US-65-TC04: gói đã hết hạn sau buổi (end_date hôm qua) → vẫn gửi được 201', async () => {
      const { me, bookingId } = await ready({ endDate: shiftDays(-1) });
      await submit(me, bookingId).expect(201);
      expect(await count('trainer_reviews', { booking_id: bookingId })).toBe(1);
    });

    it('US-65-TC04: GET khi chưa có review: COMPLETED → {review: null, canReview: true}; BOOKED → canReview false', async () => {
      const completed = await ready();
      const okBody = (await readReview(completed.me, completed.bookingId).expect(200)).body;
      expect(okBody.review).toBeNull();
      expect(okBody.canReview).toBe(true);

      const booked = await ready({ status: 'BOOKED' });
      const notYet = (await readReview(booked.me, booked.bookingId).expect(200)).body;
      expect(notYet.review).toBeNull();
      expect(notYet.canReview).toBe(false);
      expect(await count('trainer_reviews')).toBe(0);
    });
  });

  // =====================================================================
  // AC02 – Điểm, nhận xét và bất biến (TC05–TC08)
  // =====================================================================
  describe('US-65-AC02: điểm, nhận xét và bất biến', () => {
    it.each([
      ['rating 0', { rating: 0 }],
      ['rating 6', { rating: 6 }],
      ['rating 1.5', { rating: 1.5 }],
      ['rating chuỗi "4"', { rating: '4' }],
      ['thiếu rating', { comment: 'Tốt' }],
      ['comment 1001 ký tự', { rating: 4, comment: 'a'.repeat(1001) }],
      ['comment có ký tự điều khiển \\u0007', { rating: 4, comment: 'Tốt\u0007lắm' }],
    ])('US-65-TC05: %s → 400, không có review', async (_label, body) => {
      const { me, membershipId, bookingId } = await ready();
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await submit(me, bookingId, body), 400);
      });
    });

    it.each([1, 5])('US-65-TC05: rating biên %p hợp lệ → 201', async rating => {
      const { me, bookingId } = await ready();
      expect((await submit(me, bookingId, { rating }).expect(201)).body.rating).toBe(rating);
    });

    it('US-65-TC05: comment đúng 1000 ký tự sau trim (có khoảng trắng hai đầu) → 201, lưu bản đã trim', async () => {
      const { me, bookingId } = await ready();
      const text = 'b'.repeat(1000);
      const response = await submit(me, bookingId, { rating: 4, comment: `   ${text}  ` }).expect(201);
      expect(response.body.comment).toBe(text);
      expect((await reviewOf(bookingId))?.comment).toBe(text);
    });

    it.each([
      ['không gửi comment', { rating: 4 }],
      ['comment rỗng', { rating: 4, comment: '' }],
      ['comment chỉ có khoảng trắng', { rating: 4, comment: '    ' }],
    ])('US-65-TC06: %s → lưu chuỗi rỗng', async (_label, body) => {
      const { me, bookingId } = await ready();
      expect((await submit(me, bookingId, body).expect(201)).body.comment).toBe('');
      expect((await reviewOf(bookingId))?.comment).toBe('');
    });

    it('US-65-TC06: comment có HTML → lưu nguyên dạng chữ (không chạy, không cắt), xuống dòng và tab được giữ', async () => {
      const { me, bookingId } = await ready();
      const comment = '<b>Rất tốt</b><script>alert(1)</script>\nDòng 2\tcó tab';
      const response = await submit(me, bookingId, { rating: 4, comment }).expect(201);
      expect(response.body.comment).toBe(comment);
      expect((await reviewOf(bookingId))?.comment).toBe(comment);
    });

    it.each(['patch', 'delete'] as const)('US-65-TC07: %s review → không có API sửa/xóa, review giữ nguyên', async method => {
      const { me, bookingId } = await ready();
      await submit(me, bookingId, { rating: 4, comment: 'Ban đầu' }).expect(201);
      const before = await reviewOf(bookingId);

      const response = await http()[method](`/api/me/pt-bookings/${bookingId.toHexString()}/review`).set('Origin', origin)
        .set('Authorization', `Bearer ${me.accessToken}`).set('Idempotency-Key', randomUUID()).send({ rating: 1, comment: 'Sửa' });
      expect([404, 405]).toContain(response.status);
      expect(await reviewOf(bookingId)).toEqual(before);
    });

    it('US-65-TC07: key mới gửi review lần 2 → 409 REVIEW_ALREADY_EXISTS; review gốc, audit và khóa không đổi', async () => {
      const { me, bookingId } = await ready();
      await submit(me, bookingId, { rating: 4, comment: 'Lần 1' }).expect(201);
      const before = { review: await reviewOf(bookingId), guard: await guardRevision() };

      expectError(await submit(me, bookingId, { rating: 2, comment: 'Lần 2' }), 409, 'REVIEW_ALREADY_EXISTS');

      expect(await count('trainer_reviews', { booking_id: bookingId })).toBe(1);
      expect(await reviewOf(bookingId)).toEqual(before.review);
      expect(await reviewEvents(bookingId)).toHaveLength(1);
      expect(await guardRevision()).toBe(before.guard);
    });

    it('US-65-TC07: GET sau khi gửi → {review: bản gốc 6 field, canReview: false}', async () => {
      const { me, bookingId } = await ready();
      const created = (await submit(me, bookingId, { rating: 5, comment: 'Tuyệt' }).expect(201)).body;
      const body = (await readReview(me, bookingId).expect(200)).body;
      expect(body.canReview).toBe(false);
      expect(body.review).toEqual(created);
    });

    it('US-65-TC08: đổi tên PT và tên hội viên sau khi gửi → snapshot trong review giữ tên lúc gửi', async () => {
      const { me, pt, bookingId } = await ready();
      await submit(me, bookingId).expect(201);

      await db().collection('accounts').updateOne({ _id: new ObjectId(pt.accountId) }, { $set: { full_name: 'PT Tên Mới' } });
      await db().collection('members').updateOne({ _id: me.memberId }, { $set: { full_name: 'Hội viên Tên Mới' } });
      await db().collection('trainers').updateOne({ _id: pt.trainerId }, { $set: { specialty: 'Yoga' } });

      const doc = await reviewOf(bookingId);
      expect(doc?.trainer_name_snapshot).toBe(PT_NAME);
      expect(doc?.member_display_name_snapshot).toBe(MEMBER_NAME);
    });

    it('US-65-TC08: review và response không lộ điện thoại/email của Member hay PT', async () => {
      const { me, bookingId } = await ready();
      const created = await submit(me, bookingId).expect(201);
      const read = await readReview(me, bookingId).expect(200);
      const doc = await reviewOf(bookingId);
      const phones = (await db().collection('accounts').find({}).toArray()).map(item => String(item.phone));
      for (const text of [JSON.stringify(created.body), JSON.stringify(read.body), JSON.stringify(doc)]) {
        for (const phone of phones) expect(text).not.toContain(phone);
        expect(text).not.toMatch(/"(phone|email|address)"/);
      }
    });
  });

  // =====================================================================
  // AC03 – Idempotency và rollback trên một instance (TC09 phần một app, TC11)
  // =====================================================================
  describe('US-65-AC03: idempotency EN-02 và rollback', () => {
    it('US-65-TC09 (một instance): gửi lại cùng key cùng body → 201 body gốc; một review, một audit, một operation', async () => {
      const { me, bookingId } = await ready();
      const key = randomUUID();
      const first = await submit(me, bookingId, { rating: 4, comment: 'Một lần' }, key).expect(201);
      const replay = await submit(me, bookingId, { rating: 4, comment: 'Một lần' }, key).expect(201);
      expect(replay.body).toEqual(first.body);
      expect(await count('trainer_reviews')).toBe(1);
      expect(await reviewEvents(bookingId)).toHaveLength(1);
      expect(await count('operation_requests', { operation: 'PT_REVIEW_CREATE' })).toBe(1);
    });

    it('US-65-TC09 (một instance): cùng key nhưng khác payload → 409 IDEMPOTENCY_CONFLICT, review gốc giữ nguyên', async () => {
      const { me, bookingId } = await ready();
      const key = randomUUID();
      await submit(me, bookingId, { rating: 4 }, key).expect(201);
      const before = await reviewOf(bookingId);
      expectError(await submit(me, bookingId, { rating: 1 }, key), 409, 'IDEMPOTENCY_CONFLICT');
      expect(await reviewOf(bookingId)).toEqual(before);
    });

    it.each([
      ['thiếu Idempotency-Key', null],
      ['Idempotency-Key không phải UUID', 'khong-phai-uuid'],
    ])('US-65-TC09: %s → 400, không ghi gì', async (_label, key) => {
      const { me, membershipId, bookingId } = await ready();
      await expectNothingWritten(bookingId, membershipId, async () => {
        expectError(await submit(me, bookingId, { rating: 4 }, key), 400);
      });
    });

    it.each(['booking_events', 'operation_requests', 'trainer_reviews'])(
      'US-65-TC11: insert vào %s lỗi trước commit → 503 không lộ lỗi MongoDB; không review, không audit, không key, khóa giữ nguyên',
      async collection => {
        const { me, membershipId, bookingId } = await ready();
        await expectNothingWritten(bookingId, membershipId, async () => {
          await failInsertsOn(collection, async () => {
            const response = await submit(me, bookingId);
            expectError(response, 503);
            expect(JSON.stringify(response.body)).not.toContain('Giả lập DB lỗi');
          });
        });
        expect(await memberRevision(me.memberId)).toBe(0);
      });

    it('US-65-TC11: sau lỗi 503, gửi lại CÙNG key khi DB đã ổn → 201, đúng một review (không tạo trùng)', async () => {
      const { me, bookingId } = await ready();
      const key = randomUUID();
      await failInsertsOn('booking_events', async () => {
        expectError(await submit(me, bookingId, { rating: 4 }, key), 503);
      });
      await submit(me, bookingId, { rating: 4 }, key).expect(201);
      expect(await count('trainer_reviews', { booking_id: bookingId })).toBe(1);
      expect(await reviewEvents(bookingId)).toHaveLength(1);
    });

    it('US-65-TC11: mất response → GET /api/operations/PT_REVIEW_CREATE/:key trả kết quả gốc; Member khác tra cứu → 404', async () => {
      const { me, bookingId } = await ready();
      const key = randomUUID();
      const created = await submit(me, bookingId, { rating: 5 }, key).expect(201);
      const lookup = await get(`/api/operations/PT_REVIEW_CREATE/${key}`, me).expect(200);
      expect(JSON.stringify(lookup.body)).toContain(created.body.id);
      const stranger = await linkedMember('Người lạ');
      expectError(await get(`/api/operations/PT_REVIEW_CREATE/${key}`, stranger), 404);
    });
  });
});
