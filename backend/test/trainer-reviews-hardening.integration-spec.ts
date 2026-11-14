// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-31 bước 4.
// Kiểm tra quyền (account khóa, phiên cũ), biên ngày VN đến từng mili giây, tổng điểm với review tạo qua API thật US-65,
// nguồn mồ côi không được đoán chủ, nội dung HTML trả nguyên văn và lỗi DB 503 (TC03–TC05, TC07–TC09, TC11).
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
// Hợp đồng test đặt ra cho Builder (US-31 bước 4, theo mục 2 và bản 1.1 của spec; API bước 1–2 đã có):
//   TC03: US-02 kiểm ở MỌI request – account LOCKED hoặc auth_version đã tăng (phiên cũ) dùng token cũ → 401 ở list và detail.
//   TC08: kỳ [00:00:00.000 fromDate, 00:00:00.000 ngày sau toDate) giờ VN (+07:00), đúng đến mili giây; mặc định 30 ngày cũng vậy.
//   TC05–TC07 (bản 1.1, nhận từ US-65-TC12): review tạo qua API thật POST /api/me/pt-bookings/:id/review (US-65)
//     phải hiện ở GET /api/me/trainer-reviews của đúng PT, đúng điểm/nhận xét/tên snapshot; summary {reviewCount, averageRating}
//     tính đúng; lọc kỳ theo thời điểm gửi chứ không theo ngày buổi.
//   TC04 (nguồn không hợp lệ, mục 2): review mà booking không tồn tại, hoặc booking.trainer_id khác review.trainer_id
//     → không hiện ở danh sách, không tính vào summary, chi tiết 404 với CẢ HAI PT (không đoán chủ review).
//   TC09: nhận xét chứa HTML được API trả NGUYÊN VĂN (không cắt, không đổi), Content-Type application/json.
//   TC11: DB lỗi khi đọc trainer_reviews → 503 {error:{code,message},requestId}, không lộ lỗi MongoDB thô; DB ổn lại → 200.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us31_hardening';
const password = 'MậtKhẩuUS-31-789';
const base = '/api/me/trainer-reviews';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const VN_OFFSET_MS = 7 * 60 * MINUTE;
const PT_NAME = 'PT Lê Văn Cường';
const MEMBER_NAME = 'Hội viên Nguyễn An';

type Auth = { accessToken: string };
type Pt = Auth & { trainerId: ObjectId; accountId: string };
type Member = Auth & { memberId: ObjectId; accountId: string };
type ListBody = {
  profileLinked: boolean; items: Array<Record<string, unknown> & { id: string; rating: number; comment: string }>;
  total: number; summary: { reviewCount: number; averageRating: number | null };
};

describe('US-31 bước 4: quyền, ngày VN, API thật US-65, dữ liệu thiếu và lỗi DB', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      // enableTestCommands=1 để dùng failpoint failCommand giả lập lỗi DB (US-31-TC11).
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName, args: ['--setParameter', 'enableTestCommands=1'] },
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
      SMTP_USER: 'us31-test', SMTP_PASS: 'us31-test', SMTP_FROM: 'no-reply@gym.test',
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
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Bộ giới hạn đăng nhập (US-02) lưu trong bộ nhớ: mỗi test dùng bộ mới để không bị 429.
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await connection.db!.collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    // US-65 gửi review tăng schedule_guards 'global'.revision trong transaction (khóa chung S07-P01).
    await connection.db!.collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await connection.db!.admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());

  // ---------- Thời gian theo lịch Việt Nam ----------
  const vnDate = (instant: Date) => new Date(instant.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
  const vnDay = (days: number) => vnDate(new Date(Date.now() + days * DAY));
  // Thời điểm giờ VN chính xác: "2026-11-10", "23:59:59.999".
  const vnInstant = (day: string, time: string) => new Date(`${day}T${time}+07:00`);

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: 'MEMBER' | 'TRAINER', fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0916000${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: String(created.id), phone };
  }

  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }

  // PT mẫu (thay US-23): tài khoản TRAINER + hồ sơ trainers liên kết qua account_id.
  async function trainer(name = PT_NAME): Promise<Pt> {
    const owner = await account('TRAINER', name);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: new ObjectId(owner.accountId), specialty: 'Thể hình', status: 'ACTIVE',
      version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: owner.accountId, accessToken: await loginAs(owner.phone) };
  }

  // Member đã liên kết account (khuôn US-09), đăng nhập sẵn để gửi review qua API thật.
  async function linkedMember(name = MEMBER_NAME): Promise<Member> {
    const owner = await account('MEMBER', name);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: name, phone: owner.phone,
      account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { memberId, accountId: owner.accountId, accessToken: await loginAs(owner.phone) };
  }

  // Gói PT (thay US-14/22) để booking có membership hợp lệ.
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
      _id: planId, id: planId, code: `PT-US31H-${saleSeq}`, name: `Gói PT ${saleSeq}`, kind: 'PT', duration_days: 30,
      session_quota: 10, price: money, benefits: 'Quyền lợi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US31H-${saleSeq}`, kind: 'PT', amount_due: money,
      status: 'SETTLED', request_key: randomBytes(32).toString('hex'), created_at: now, guard_revision: Long.ZERO,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: vnDay(-40), end_date: vnDay(30), plan_name_snapshot: `Gói PT ${saleSeq}`,
      benefits_snapshot: 'Quyền lợi', list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: 10,
      policy_snapshot: 'Giá niêm yết', created_at: now,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: 3, version: 0,
    });
    return membershipId;
  }

  // Buổi PT COMPLETED (thay US-28/US-64), kết thúc `daysAgo` ngày trước.
  async function completedBooking(memberId: ObjectId, membershipId: ObjectId, pt: Pt, daysAgo = 2) {
    const id = new ObjectId();
    const end = new Date(Date.now() - daysAgo * DAY);
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: membershipId, member_id: memberId, trainer_id: pt.trainerId, shift_id: new ObjectId(),
      start_at: new Date(end.getTime() - 60 * MINUTE), end_at: end, status: 'COMPLETED', request_key: randomBytes(32).toString('hex'),
      version: 1, trainer_name_snapshot: PT_NAME, location_snapshot: 'Phòng PT 1',
      created_at: new Date(end.getTime() - 3 * DAY), updated_at: end,
      completed_at: end, completed_by: new ObjectId(pt.accountId), completed_actor_type: 'TRAINER',
      completion_membership_id: membershipId, completion_revision: 1,
    });
    return { id, start: new Date(end.getTime() - 60 * MINUTE) };
  }

  // Review ghi thẳng theo bảng trainer_reviews của US-65 (dùng cho biên thời gian và dữ liệu mồ côi).
  async function rawReview(trainerId: ObjectId, bookingId: ObjectId, rating: number, createdAt: Date, comment = `Danh gia ${rating} sao`) {
    const reviewId = new ObjectId();
    await db().collection('trainer_reviews').insertOne({
      _id: reviewId, id: reviewId, booking_id: bookingId, trainer_id: trainerId, member_id: new ObjectId(),
      created_by: new ObjectId(), rating, comment, created_at: createdAt,
      trainer_name_snapshot: PT_NAME, member_display_name_snapshot: MEMBER_NAME,
    });
    return reviewId.toHexString();
  }

  // Booking COMPLETED tối thiểu của PT (không cần Member đăng nhập) để gắn review ghi thẳng.
  async function bareBooking(trainerId: ObjectId, start: Date) {
    const id = new ObjectId();
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: new ObjectId(), member_id: new ObjectId(), trainer_id: trainerId, shift_id: new ObjectId(),
      start_at: start, end_at: new Date(start.getTime() + 60 * MINUTE), status: 'COMPLETED', request_key: randomBytes(32).toString('hex'),
      version: 1, trainer_name_snapshot: PT_NAME, location_snapshot: 'Phòng PT 1',
      created_at: new Date(start.getTime() - DAY), updated_at: start, completed_at: start, completion_revision: 1,
    });
    return id;
  }

  // ---------- Gọi API ----------
  function submitReview(me: Member, bookingId: ObjectId, body: Record<string, unknown>) {
    return http().post(`/api/me/pt-bookings/${bookingId.toHexString()}/review`).set('Origin', origin)
      .set('Authorization', `Bearer ${me.accessToken}`).set('Idempotency-Key', randomUUID()).send(body);
  }
  function list(user: Auth, query: Record<string, string | number> = {}) {
    return http().get(base).query(query).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }
  async function listOk(user: Auth, query: Record<string, string | number> = {}): Promise<ListBody> {
    return (await list(user, query).expect(200)).body as ListBody;
  }
  function detail(user: Auth, id: string) {
    return http().get(`${base}/${id}`).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }
  const ids = (body: ListBody) => body.items.map(item => item.id);

  function expectError(response: request.Response, status: number) {
    expect(response.status).toBe(status);
    expect(typeof response.body.error?.code).toBe('string');
    expect(typeof response.body.error?.message).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
  }

  // ========== TC03: kiểm quyền ở mọi request ==========

  describe('US-31-TC03: account bị khóa hoặc phiên cũ', () => {
    it('US-31-TC03: account TRAINER bị khóa (LOCKED) dùng token cũ → 401 ở danh sách và chi tiết', async () => {
      const pt = await trainer();
      const reviewId = await rawReview(pt.trainerId, await bareBooking(pt.trainerId, new Date(Date.now() - 2 * DAY)), 5, new Date(Date.now() - DAY));
      await list(pt).expect(200);

      await db().collection('accounts').updateOne({ _id: new ObjectId(pt.accountId) }, { $set: { status: 'LOCKED' } });

      expectError(await list(pt), 401);
      expectError(await detail(pt, reviewId), 401);
    });

    it('US-31-TC03: auth_version của account đã tăng (phiên cũ bị thu hồi) → token cũ 401', async () => {
      const pt = await trainer();
      await list(pt).expect(200);

      await db().collection('accounts').updateOne({ _id: new ObjectId(pt.accountId) }, { $inc: { auth_version: 1 } });

      expectError(await list(pt), 401);
    });
  });

  // ========== TC08: biên ngày VN ==========

  describe('US-31-TC08: biên ngày Việt Nam', () => {
    it('US-31-TC08: [00:00:00.000 fromDate, 00:00:00.000 ngày sau toDate) giờ VN – đúng đến mili giây', async () => {
      const pt = await trainer();
      const from = vnDay(-10);
      const to = vnDay(-8);
      const booking = await bareBooking(pt.trainerId, new Date(Date.now() - 15 * DAY));
      const firstMs = await rawReview(pt.trainerId, booking, 4, vnInstant(from, '00:00:00.000'));
      const lastMs = await rawReview(pt.trainerId, await bareBooking(pt.trainerId, new Date(Date.now() - 15 * DAY)), 5, vnInstant(to, '23:59:59.999'));
      await rawReview(pt.trainerId, await bareBooking(pt.trainerId, new Date(Date.now() - 15 * DAY)), 1, vnInstant(vnDay(-11), '23:59:59.999'));
      await rawReview(pt.trainerId, await bareBooking(pt.trainerId, new Date(Date.now() - 15 * DAY)), 1, vnInstant(vnDay(-7), '00:00:00.000'));

      const body = await listOk(pt, { fromDate: from, toDate: to });

      expect(ids(body)).toEqual([lastMs, firstMs]);
      expect(body.summary).toEqual({ reviewCount: 2, averageRating: 4.5 });
    });

    it('US-31-TC08: 07:00 sáng giờ VN (00:00 UTC) thuộc ngày VN, 06:59:59.999 giờ VN vẫn cùng ngày VN đó', async () => {
      const pt = await trainer();
      const day = vnDay(-5);
      const early = await rawReview(pt.trainerId, await bareBooking(pt.trainerId, new Date(Date.now() - 9 * DAY)), 3, vnInstant(day, '06:59:59.999'));
      const utcMidnight = await rawReview(pt.trainerId, await bareBooking(pt.trainerId, new Date(Date.now() - 9 * DAY)), 4, vnInstant(day, '07:00:00.000'));

      expect(ids(await listOk(pt, { fromDate: day, toDate: day }))).toEqual([utcMidnight, early]);
    });

    it('US-31-TC08: mặc định 30 ngày: 00:00 VN của 29 ngày trước có, 23:59:59.999 VN của 30 ngày trước không', async () => {
      const pt = await trainer();
      const inside = await rawReview(pt.trainerId, await bareBooking(pt.trainerId, new Date(Date.now() - 40 * DAY)), 5, vnInstant(vnDay(-29), '00:00:00.000'));
      await rawReview(pt.trainerId, await bareBooking(pt.trainerId, new Date(Date.now() - 40 * DAY)), 1, vnInstant(vnDay(-30), '23:59:59.999'));

      const body = await listOk(pt);

      expect(ids(body)).toEqual([inside]);
      expect(body.summary).toEqual({ reviewCount: 1, averageRating: 5 });
    });
  });

  // ========== TC05–TC07: review tạo qua API thật của US-65 (spec bản 1.1) ==========

  describe('US-31-TC07: tổng điểm với review gửi qua API thật POST /api/me/pt-bookings/:id/review', () => {
    async function twoRealReviews() {
      const pt = await trainer();
      const an = await linkedMember('Hội viên Nguyễn An');
      const binh = await linkedMember('Hội viên Trần Bình');
      const anBooking = await completedBooking(an.memberId, await insertPlan(an.memberId), pt);
      const binhBooking = await completedBooking(binh.memberId, await insertPlan(binh.memberId), pt);
      await submitReview(an, anBooking.id, { rating: 4, comment: 'PT nhiệt tình' }).expect(201);
      await submitReview(binh, binhBooking.id, { rating: 5, comment: 'Rất hài lòng' }).expect(201);
      return { pt, anBooking, binhBooking };
    }

    it('US-31-TC07: hai Member gửi 4 và 5 qua API → PT thấy 2 review, reviewCount=2, averageRating=4.5, tên lấy từ snapshot', async () => {
      const { pt } = await twoRealReviews();

      const body = await listOk(pt);

      expect(body.summary).toEqual({ reviewCount: 2, averageRating: 4.5 });
      const byComment = Object.fromEntries(body.items.map(item => [item.comment, item]));
      expect(byComment['PT nhiệt tình']).toMatchObject({ rating: 4, memberDisplayName: 'Hội viên Nguyễn An' });
      expect(byComment['Rất hài lòng']).toMatchObject({ rating: 5, memberDisplayName: 'Hội viên Trần Bình' });
    });

    it('US-31-TC06: lọc rating=5 trên review thật → reviewCount=1, averageRating=5', async () => {
      const { pt } = await twoRealReviews();

      const body = await listOk(pt, { rating: 5 });

      expect(body.items.map(item => item.comment)).toEqual(['Rất hài lòng']);
      expect(body.summary).toEqual({ reviewCount: 1, averageRating: 5 });
    });

    it('US-31-TC05: review thật gửi hôm nay cho buổi 2 ngày trước → lọc theo ngày buổi không thấy, lọc hôm nay thấy đủ', async () => {
      const { pt, anBooking } = await twoRealReviews();
      const sessionDay = vnDate(anBooking.start);

      expect((await listOk(pt, { fromDate: sessionDay, toDate: sessionDay })).summary).toEqual({ reviewCount: 0, averageRating: null });
      expect((await listOk(pt, { fromDate: vnDay(0), toDate: vnDay(0) })).summary.reviewCount).toBe(2);
    });

    it('US-31-TC07: review thật của PT khác không lẫn vào tổng điểm của mình', async () => {
      const { pt } = await twoRealReviews();
      const other = await trainer('PT Khác');
      const cuong = await linkedMember('Hội viên Lê Cường');
      const booking = await completedBooking(cuong.memberId, await insertPlan(cuong.memberId), other);
      await submitReview(cuong, booking.id, { rating: 1, comment: 'Chưa tốt' }).expect(201);

      expect((await listOk(pt)).summary).toEqual({ reviewCount: 2, averageRating: 4.5 });
      expect((await listOk(other)).summary).toEqual({ reviewCount: 1, averageRating: 1 });
    });
  });

  // ========== TC04: nguồn mồ côi / không khớp ==========

  describe('US-31-TC04: nguồn mồ côi không được đoán chủ, không tính điểm', () => {
    it('US-31-TC04: review có booking_id không tồn tại → không ở danh sách, không vào summary, chi tiết 404', async () => {
      const pt = await trainer();
      await rawReview(pt.trainerId, await bareBooking(pt.trainerId, new Date(Date.now() - 3 * DAY)), 5, new Date(Date.now() - DAY));
      const orphan = await rawReview(pt.trainerId, new ObjectId(), 1, new Date(Date.now() - DAY));

      const body = await listOk(pt);

      expect(ids(body)).not.toContain(orphan);
      expect(body.summary).toEqual({ reviewCount: 1, averageRating: 5 });
      expectError(await detail(pt, orphan), 404);
    });

    it('US-31-TC04: review.trainer_id là PT A nhưng booking thuộc PT B → cả A và B đều không thấy, không tính điểm', async () => {
      const ptA = await trainer('PT A');
      const ptB = await trainer('PT B');
      const bookingOfB = await bareBooking(ptB.trainerId, new Date(Date.now() - 3 * DAY));
      const mismatch = await rawReview(ptA.trainerId, bookingOfB, 1, new Date(Date.now() - DAY));

      for (const pt of [ptA, ptB]) {
        const body = await listOk(pt);
        expect(ids(body)).not.toContain(mismatch);
        expect(body.summary).toEqual({ reviewCount: 0, averageRating: null });
        expectError(await detail(pt, mismatch), 404);
      }
    });
  });

  // ========== TC09: nội dung HTML trả nguyên văn ==========

  describe('US-31-TC09: comment chứa script/HTML', () => {
    it('US-31-TC09: API trả nhận xét HTML nguyên văn (không cắt, không đổi) dạng JSON ở danh sách và chi tiết', async () => {
      const pt = await trainer();
      const html = '<script>alert("x")</script><img src=x onerror=alert(1)> & "trích dẫn"';
      const reviewId = await rawReview(pt.trainerId, await bareBooking(pt.trainerId, new Date(Date.now() - 3 * DAY)), 2, new Date(Date.now() - DAY), html);

      const listed = await list(pt).expect(200);
      const shown = await detail(pt, reviewId).expect(200);

      expect(listed.headers['content-type']).toMatch(/application\/json/);
      expect(shown.headers['content-type']).toMatch(/application\/json/);
      expect(listed.body.items[0].comment).toBe(html);
      expect(shown.body.comment).toBe(html);
    });
  });

  // ========== TC11: DB lỗi ==========

  describe('US-31-TC11: GET khi DB lỗi', () => {
    async function failAggregateOnReviews() {
      await db().admin().command({
        configureFailPoint: 'failCommand', mode: 'alwaysOn',
        data: { failCommands: ['aggregate', 'find'], namespace: `${databaseName}.trainer_reviews`, errorCode: 1, errmsg: 'Giả lập DB lỗi US-31-TC11' },
      });
    }

    it('US-31-TC11: đọc trainer_reviews lỗi → 503, không lộ lỗi MongoDB thô', async () => {
      const pt = await trainer();
      const reviewId = await rawReview(pt.trainerId, await bareBooking(pt.trainerId, new Date(Date.now() - 3 * DAY)), 4, new Date(Date.now() - DAY));
      await failAggregateOnReviews();

      for (const response of [await list(pt), await detail(pt, reviewId)]) {
        expectError(response, 503);
        expect(JSON.stringify(response.body)).not.toMatch(/Giả lập DB lỗi|MongoServerError|failCommand|stack/i);
      }
    });

    it('US-31-TC11: sau 503, DB ổn lại thì gọi lại được 200 đúng dữ liệu', async () => {
      const pt = await trainer();
      const reviewId = await rawReview(pt.trainerId, await bareBooking(pt.trainerId, new Date(Date.now() - 3 * DAY)), 4, new Date(Date.now() - DAY));
      await failAggregateOnReviews();
      expectError(await list(pt), 503);

      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });

      expect(ids(await listOk(pt))).toEqual([reviewId]);
    });
  });
});
