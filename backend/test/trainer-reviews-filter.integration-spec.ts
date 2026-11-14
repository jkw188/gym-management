// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-31 bước 2.
// Kiểm tra lọc kỳ theo thời điểm gửi, lọc điểm, phân trang, summary trên toàn tập lọc, kiểm tra query và không có mutation (TC04–TC08, TC10).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng test đặt ra cho Builder (US-31 bước 2, theo F02, F05 và mục 2 của spec):
//   GET /api/me/trainer-reviews?fromDate?&toDate?&rating?&page?&limit?
//     200 {profileLinked, items, page, limit, total, totalPages, asOf, summary: {reviewCount, averageRating}}.
//     page mặc định 1, limit mặc định 20, tối đa 100; page/limit phải là số nguyên ≥ 1 (sai → 400). Rỗng → totalPages=0.
//     fromDate/toDate: ngày VN YYYY-MM-DD, tính CẢ HAI ngày đầu và cuối: [00:00 fromDate, 00:00 ngày sau toDate) giờ VN.
//       Lọc theo created_at của REVIEW, không theo giờ buổi tập. Không truyền → 30 ngày gần nhất.
//       Sai định dạng, ngày không có thật, fromDate sau toDate, khoảng quá 366 ngày (đếm cả hai đầu) → 400.
//     rating: số nguyên 1–5 (0, 6, 4.5, chữ → 400).
//     summary tính trên TOÀN BỘ tập lọc (kỳ + rating), không chỉ trang đang xem; chỉ review của chính PT, buổi COMPLETED.
//       averageRating = sum(rating)/count (số; giao diện làm tròn 2 số lẻ khi hiển thị); count=0 → averageRating=null.
//     PT chưa liên kết hồ sơ → total=0, totalPages=0, summary {reviewCount: 0, averageRating: null}.
//   Không có route PATCH/PUT/DELETE trên /api/me/trainer-reviews/:id; review giữ nguyên (F04).
//   Để bước 4: biên ngày VN chính xác đến giây, review tạo qua API thật US-65, nguồn mồ côi gắn dataIssue.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us31_filter';
const password = 'MậtKhẩuUS-31-456';
const base = '/api/me/trainer-reviews';

type Auth = { accessToken: string };
type Pt = Auth & { trainerId: ObjectId };
type Member = { memberId: ObjectId; fullName: string };
type Item = Record<string, unknown> & { id: string; rating: number };
type ListBody = {
  profileLinked: boolean; items: Item[]; page: number; limit: number; total: number; totalPages: number; asOf: string;
  summary: { reviewCount: number; averageRating: number | null };
};

describe('US-31 bước 2: lọc, phân trang và tổng điểm đánh giá của PT', () => {
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
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Ngày VN (YYYY-MM-DD) cách hôm nay `days` ngày (âm = quá khứ).
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10);
  // Một thời điểm giờ VN của ngày cách hôm nay `days` ngày.
  const at = (days: number, hhmm = '10:00') => new Date(`${vnDay(days)}T${hhmm}:00+07:00`);

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: 'TRAINER', fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0915000${String(phoneSeq).padStart(3, '0')}`;
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

  // Hồ sơ hội viên mẫu (khuôn US-09).
  let memberSeq = 0;
  async function member(fullName = 'Nguyen Van An'): Promise<Member> {
    memberSeq += 1;
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV31F-${String(memberSeq).padStart(4, '0')}`, full_name: fullName,
      phone: `0987${String(memberSeq).padStart(6, '0')}`, email: `hv31f-${memberSeq}@gym.test`, address: '12 Nguyen Trai',
      version: 0, service_revision: 0n, created_by: staffId, updated_by: staffId,
    });
    return { memberId, fullName };
  }

  // Buổi PT mẫu (thay US-28/US-64): khuôn pt_bookings của US-28 + completed_at của US-64.
  async function booking(who: Member, trainerId: ObjectId, start: Date, status: 'COMPLETED' | 'BOOKED' | 'CANCELLED' = 'COMPLETED') {
    const id = new ObjectId();
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const doc: Record<string, unknown> = {
      _id: id, id, membership_id: new ObjectId(), member_id: who.memberId, trainer_id: trainerId,
      shift_id: new ObjectId(), start_at: start, end_at: end, status,
      request_key: `us31f-booking-${id.toHexString()}`, version: 1,
      trainer_name_snapshot: 'PT Tran Van Binh', location_snapshot: 'Phong PT 1',
      created_by: new ObjectId(), created_at: new Date(start.getTime() - DAY_MS), updated_at: end,
    };
    if (status === 'COMPLETED') doc.completed_at = end;
    if (status === 'CANCELLED') Object.assign(doc, { cancelled_at: start, cancelled_by: new ObjectId(), cancelled_reason: 'Ban viec' });
    await db().collection('pt_bookings').insertOne(doc);
    return id;
  }

  // Đánh giá mẫu theo bảng trainer_reviews của US-65. reviewId có thể truyền vào để kiểm thứ tự id khi trùng created_at.
  async function review(
    who: Member, trainerId: ObjectId, rating: number, createdAt: Date,
    options: { sessionStart?: Date; bookingStatus?: 'COMPLETED' | 'BOOKED' | 'CANCELLED'; reviewId?: ObjectId } = {},
  ) {
    const bookingId = await booking(who, trainerId, options.sessionStart ?? new Date(createdAt.getTime() - DAY_MS), options.bookingStatus);
    const reviewId = options.reviewId ?? new ObjectId();
    await db().collection('trainer_reviews').insertOne({
      _id: reviewId, id: reviewId, booking_id: bookingId, trainer_id: trainerId, member_id: who.memberId,
      created_by: new ObjectId(), rating, comment: `Danh gia ${rating} sao`, created_at: createdAt,
      trainer_name_snapshot: 'PT Tran Van Binh', member_display_name_snapshot: who.fullName,
    });
    return reviewId.toHexString();
  }

  function list(user: Auth, query: Record<string, string | number> = {}) {
    return http().get(base).query(query).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }
  async function listOk(user: Auth, query: Record<string, string | number> = {}): Promise<ListBody> {
    return (await list(user, query).expect(200)).body as ListBody;
  }
  const ids = (body: ListBody) => body.items.map(item => item.id);

  function expectError(response: request.Response, status: number) {
    expect(response.status).toBe(status);
    expect(typeof response.body.error?.code).toBe('string');
    expect(typeof response.body.error?.message).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
  }

  // ========== AC02: lọc và tổng hợp không sai điểm ==========

  describe('US-31-TC05: lọc kỳ theo thời điểm tạo review, khác ngày buổi tập', () => {
    it('US-31-TC05: review GỬI trong kỳ cho buổi ngoài kỳ → có; review gửi ngoài kỳ cho buổi trong kỳ → không', async () => {
      const pt = await trainer();
      const an = await member();
      // Buổi 15 ngày trước, review gửi 10 ngày trước.
      const sentInPeriod = await review(an, pt.trainerId, 5, at(-10), { sessionStart: at(-15) });
      // Buổi 10 ngày trước, review gửi 7 ngày trước.
      await review(an, pt.trainerId, 2, at(-7), { sessionStart: at(-10) });

      const body = await listOk(pt, { fromDate: vnDay(-10), toDate: vnDay(-10) });

      expect(ids(body)).toEqual([sentInPeriod]);
      expect(body.summary).toEqual({ reviewCount: 1, averageRating: 5 });
    });

    it('US-31-TC05: kỳ tự chọn lấy được review cũ hơn 30 ngày mặc định', async () => {
      const pt = await trainer();
      const an = await member();
      const old = await review(an, pt.trainerId, 4, at(-60));

      expect(ids(await listOk(pt))).toEqual([]);
      expect(ids(await listOk(pt, { fromDate: vnDay(-90), toDate: vnDay(0) }))).toEqual([old]);
    });

    it('US-31-TC05: fromDate và toDate tính cả hai ngày đầu và cuối', async () => {
      const pt = await trainer();
      const an = await member();
      const first = await review(an, pt.trainerId, 3, at(-6));
      const last = await review(an, pt.trainerId, 4, at(-4));
      await review(an, pt.trainerId, 5, at(-7));
      await review(an, pt.trainerId, 5, at(-3));

      const body = await listOk(pt, { fromDate: vnDay(-6), toDate: vnDay(-4) });

      expect(ids(body)).toEqual([last, first]);
    });
  });

  describe('US-31-TC06: lọc rating và phân trang 2', () => {
    it('US-31-TC06: rating=4, limit=1, page=2 → đúng phần tử thứ hai; count/average tính trên toàn tập lọc', async () => {
      const pt = await trainer();
      const an = await member();
      const newer4 = await review(an, pt.trainerId, 4, at(-1));
      await review(an, pt.trainerId, 5, at(-2));
      const older4 = await review(an, pt.trainerId, 4, at(-3));
      await review(an, pt.trainerId, 1, at(-4));

      const page1 = await listOk(pt, { rating: 4, page: 1, limit: 1 });
      const page2 = await listOk(pt, { rating: 4, page: 2, limit: 1 });

      expect(ids(page1)).toEqual([newer4]);
      expect(ids(page2)).toEqual([older4]);
      expect(page2).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 });
      expect(page2.summary).toEqual({ reviewCount: 2, averageRating: 4 });
    });

    it('US-31-TC06: không lọc rating, trang 2 chỉ có 1 dòng nhưng summary vẫn tính đủ 3 review', async () => {
      const pt = await trainer();
      const an = await member();
      await review(an, pt.trainerId, 5, at(-1));
      await review(an, pt.trainerId, 3, at(-2));
      const oldest = await review(an, pt.trainerId, 1, at(-3));

      const body = await listOk(pt, { page: 2, limit: 2 });

      expect(ids(body)).toEqual([oldest]);
      expect(body).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
      expect(body.summary).toEqual({ reviewCount: 3, averageRating: 3 });
    });

    it('US-31-TC06: mặc định page=1, limit=20; 21 review → trang đầu 20 dòng, totalPages=2, có asOf', async () => {
      const pt = await trainer();
      const an = await member();
      for (let index = 0; index < 21; index += 1) {
        await review(an, pt.trainerId, 5, new Date(at(-2).getTime() + index * 60 * 1000));
      }

      const body = await listOk(pt);

      expect(body.items).toHaveLength(20);
      expect(body).toMatchObject({ page: 1, limit: 20, total: 21, totalPages: 2 });
      expect(new Date(body.asOf).toISOString()).toBe(body.asOf);
      expect(body.summary.reviewCount).toBe(21);
    });

    it('US-31-TC06: trùng created_at thì id lớn hơn đứng trước, phân trang không lặp hay sót dòng', async () => {
      const pt = await trainer();
      const an = await member();
      const sameTime = at(-2);
      const small = await review(an, pt.trainerId, 4, sameTime, { reviewId: new ObjectId('000000000000000000000001') });
      const big = await review(an, pt.trainerId, 5, sameTime, { reviewId: new ObjectId('000000000000000000000002') });

      const page1 = await listOk(pt, { page: 1, limit: 1 });
      const page2 = await listOk(pt, { page: 2, limit: 1 });

      expect([...ids(page1), ...ids(page2)]).toEqual([big, small]);
    });

    it('US-31-TC06: limit=100 (đúng tối đa) → 200', async () => {
      const pt = await trainer();
      expect((await listOk(pt, { limit: 100 })).limit).toBe(100);
    });

    it.each([
      ['rating=0', { rating: 0 }],
      ['rating=6', { rating: 6 }],
      ['rating=4.5', { rating: 4.5 }],
      ['rating=abc', { rating: 'abc' }],
      ['page=0', { page: 0 }],
      ['page=abc', { page: 'abc' }],
      ['limit=0', { limit: 0 }],
      ['limit=101 (quá tối đa 100)', { limit: 101 }],
    ])('US-31-TC06: %s → 400', async (_name, query) => {
      const pt = await trainer();
      expectError(await list(pt, query), 400);
    });
  });

  describe('US-31-TC07: hai điểm 4 và 5; không review', () => {
    it('US-31-TC07: điểm 4 và 5 → reviewCount=2, averageRating=4.5', async () => {
      const pt = await trainer();
      const an = await member();
      await review(an, pt.trainerId, 4, at(-2));
      await review(an, pt.trainerId, 5, at(-1));

      expect((await listOk(pt)).summary).toEqual({ reviewCount: 2, averageRating: 4.5 });
    });

    it('US-31-TC07: điểm 4, 4, 5 → trung bình 4.33 (làm tròn 2 số lẻ)', async () => {
      const pt = await trainer();
      const an = await member();
      await review(an, pt.trainerId, 4, at(-3));
      await review(an, pt.trainerId, 4, at(-2));
      await review(an, pt.trainerId, 5, at(-1));

      const { summary } = await listOk(pt);

      expect(summary.reviewCount).toBe(3);
      expect(summary.averageRating).toBeCloseTo(4.33, 2);
    });

    it('US-31-TC07: không có review (chỉ có buổi COMPLETED) → reviewCount=0, averageRating=null, totalPages=0', async () => {
      const pt = await trainer();
      const an = await member();
      await booking(an, pt.trainerId, at(-2));

      const body = await listOk(pt);

      expect(body.summary).toEqual({ reviewCount: 0, averageRating: null });
      expect(body).toMatchObject({ items: [], total: 0, totalPages: 0 });
    });

    it('US-31-TC07: điểm của PT khác không lẫn vào summary của mình', async () => {
      const ptA = await trainer('PT A');
      const ptB = await trainer('PT B');
      const an = await member();
      await review(an, ptA.trainerId, 5, at(-1));
      await review(an, ptB.trainerId, 1, at(-1));

      expect((await listOk(ptA)).summary).toEqual({ reviewCount: 1, averageRating: 5 });
    });

    it('US-31-TC07: TRAINER chưa liên kết hồ sơ → total=0, totalPages=0, summary null', async () => {
      const owner = await account('TRAINER', 'PT chua co ho so');
      const unlinked: Auth = { accessToken: await loginAs(owner.phone) };

      const body = await listOk(unlinked);

      expect(body).toMatchObject({ profileLinked: false, items: [], total: 0, totalPages: 0 });
      expect(body.summary).toEqual({ reviewCount: 0, averageRating: null });
    });
  });

  describe('US-31-TC04: nguồn không hợp lệ không được tính vào tổng điểm', () => {
    it.each(['BOOKED', 'CANCELLED'] as const)('US-31-TC04: review gắn buổi %s không có trong danh sách và summary', async status => {
      const pt = await trainer();
      const an = await member();
      await review(an, pt.trainerId, 5, at(-2));
      await review(an, pt.trainerId, 1, at(-1), { bookingStatus: status });

      const body = await listOk(pt);

      expect(body.items.map(item => item.rating)).toEqual([5]);
      expect(body.total).toBe(1);
      expect(body.summary).toEqual({ reviewCount: 1, averageRating: 5 });
    });
  });

  describe('US-31-TC08: kỳ sai hoặc quá 366 ngày', () => {
    it.each([
      ['ngày sai định dạng', { fromDate: '20/11/2026', toDate: vnDay(0) }],
      ['ngày không có thật', { fromDate: '2026-02-30', toDate: '2026-03-02' }],
      ['fromDate sau toDate', { fromDate: vnDay(-1), toDate: vnDay(-5) }],
      ['khoảng 367 ngày', { fromDate: vnDay(-366), toDate: vnDay(0) }],
    ])('US-31-TC08: %s → 400', async (_name, query) => {
      const pt = await trainer();
      expectError(await list(pt, query), 400);
    });

    it('US-31-TC08: khoảng đúng 366 ngày (tính cả hai đầu) → 200', async () => {
      const pt = await trainer();
      const an = await member();
      const oldest = await review(an, pt.trainerId, 4, at(-365));

      expect(ids(await listOk(pt, { fromDate: vnDay(-365), toDate: vnDay(0) }))).toEqual([oldest]);
    });
  });

  // ========== AC03: chỉ đọc ==========

  describe('US-31-TC10: thử PATCH/PUT/DELETE hoặc đổi rating', () => {
    it.each(['patch', 'put', 'delete'] as const)('US-31-TC10: %s /:id không được hỗ trợ, review giữ nguyên', async method => {
      const pt = await trainer();
      const an = await member();
      const reviewId = await review(an, pt.trainerId, 4, at(-1));
      const before = await db().collection('trainer_reviews').findOne({ _id: new ObjectId(reviewId) });

      const response = await http()[method](`${base}/${reviewId}`)
        .set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`)
        .send({ rating: 1, comment: 'PT tự sửa' });

      expect([404, 405]).toContain(response.status);
      expect(await db().collection('trainer_reviews').findOne({ _id: new ObjectId(reviewId) })).toEqual(before);
    });
  });
});
