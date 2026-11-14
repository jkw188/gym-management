// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-31 bước 1.
// Kiểm tra PT xem đánh giá của chính mình qua GET /api/me/trainer-reviews và /:id: đúng PT, đúng nguồn trainer_reviews (TC01–TC04).
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
// Hợp đồng test đặt ra cho Builder (US-31 bước 1, theo F01–F03 và mục 2 của spec):
//   GET /api/me/trainer-reviews – chỉ TRAINER (vai trò khác 403, không có phiên 401).
//     200 {profileLinked, items, ...}. PT chưa có hồ sơ trainers (chưa link account_id) → profileLinked=false, items=[].
//     Chỉ review có trainer_id = hồ sơ PT của principal; lọc trong truy vấn DB. Query ngoài allowlist (trainerId...) → 400.
//     Mặc định 30 ngày gần nhất theo created_at của review; thứ tự createdAt DESC rồi id DESC.
//     Mỗi item đúng 6 field như detail: {id, rating, comment, createdAt, booking: {id, startAt, endAt}, memberDisplayName}.
//     memberDisplayName lấy từ member_display_name_snapshot của review; không trả phone/email.
//     Buổi COMPLETED chưa có review KHÔNG tạo dòng rating=0; GET không tạo review.
//   GET /api/me/trainer-reviews/:id – cùng policy owner; trả đúng 6 field trên. id sai định dạng 400; không có hoặc của PT khác 404.
//   Lỗi EN01-D03: {error:{code,message}, requestId}.
//   Để bước sau: phân trang/lọc/summary/DTO (bước 2); UI (bước 3);
//     account khóa/phiên cũ 401, nguồn mồ côi dataIssue, ngày VN, trung bình qua API thật US-65 (bước 4).
//   US-23/US-28/US-64 chưa đủ dữ liệu mẫu cho PT → test ghi thẳng trainers, members, pt_bookings, trainer_reviews vào DB.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us31_own';
const password = 'MậtKhẩuUS-31-123';
const base = '/api/me/trainer-reviews';
const REVIEW_FIELDS = ['booking', 'comment', 'createdAt', 'id', 'memberDisplayName', 'rating'];
const BOOKING_FIELDS = ['endAt', 'id', 'startAt'];

type Auth = { accessToken: string };
type Pt = Auth & { trainerId: ObjectId };
type Member = { memberId: ObjectId; fullName: string; phone: string; email: string };
type Review = { reviewId: ObjectId; bookingId: ObjectId; start: Date; end: Date; createdAt: Date };
type Item = Record<string, unknown> & { id: string };

describe('US-31 bước 1: PT xem đánh giá của chính mình', () => {
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
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN', fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0914000${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: created.id, phone };
  }

  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }

  async function userOf(roleCode: 'MEMBER' | 'STAFF' | 'ADMIN'): Promise<Auth> {
    const owner = await account(roleCode, `Tai khoan ${roleCode}`);
    return { accessToken: await loginAs(owner.phone) };
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

  // Hồ sơ hội viên mẫu (khuôn US-09), có phone/email để kiểm không bị lộ.
  let memberSeq = 0;
  async function member(fullName: string): Promise<Member> {
    memberSeq += 1;
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    const phone = `0989${String(memberSeq).padStart(6, '0')}`;
    const email = `hv31-${memberSeq}@gym.test`;
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV31-${String(memberSeq).padStart(4, '0')}`, full_name: fullName,
      phone, email, address: '12 Nguyen Trai',
      version: 0, service_revision: 0n, created_by: staffId, updated_by: staffId,
    });
    return { memberId, fullName, phone, email };
  }

  // Buổi PT COMPLETED mẫu (thay US-28/US-64): khuôn pt_bookings của US-28 + completed_at của US-64.
  async function completedBooking(who: Member, trainerId: ObjectId, start: Date) {
    const id = new ObjectId();
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: new ObjectId(), member_id: who.memberId, trainer_id: trainerId,
      shift_id: new ObjectId(), start_at: start, end_at: end, status: 'COMPLETED', completed_at: end,
      request_key: `us31-booking-${id.toHexString()}`, version: 1,
      trainer_name_snapshot: 'PT Tran Van Binh', location_snapshot: 'Phong PT 1',
      created_by: new ObjectId(), created_at: new Date(start.getTime() - DAY_MS), updated_at: end,
    });
    return { id, start, end };
  }

  // Đánh giá mẫu theo bảng trainer_reviews của US-65 (snapshot tên hội viên có thể khác members.full_name).
  async function review(
    who: Member, trainerId: ObjectId,
    options: { rating: number; comment: string; createdAt: Date; sessionStart: Date; displayName?: string },
  ): Promise<Review> {
    const booking = await completedBooking(who, trainerId, options.sessionStart);
    const reviewId = new ObjectId();
    await db().collection('trainer_reviews').insertOne({
      _id: reviewId, id: reviewId, booking_id: booking.id, trainer_id: trainerId, member_id: who.memberId,
      created_by: new ObjectId(), rating: options.rating, comment: options.comment, created_at: options.createdAt,
      trainer_name_snapshot: 'PT Tran Van Binh', member_display_name_snapshot: options.displayName ?? who.fullName,
    });
    return { reviewId, bookingId: booking.id, start: booking.start, end: booking.end, createdAt: options.createdAt };
  }

  function list(user: Auth, query: Record<string, string | number> = {}) {
    return http().get(base).query(query).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }
  function detail(user: Auth, id: string) {
    return http().get(`${base}/${id}`).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }
  const ids = (body: { items: Item[] }) => body.items.map(item => item.id);

  function expectError(response: request.Response, status: number) {
    expect(response.status).toBe(status);
    expect(typeof response.body.error?.code).toBe('string');
    expect(typeof response.body.error?.message).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
  }

  // Một review trả về phải đúng 6 field, đúng giá trị nguồn, không có thông tin liên hệ của hội viên.
  function expectReviewView(view: Record<string, unknown>, source: Review, rating: number, comment: string, displayName: string) {
    expect(Object.keys(view).sort()).toEqual(REVIEW_FIELDS);
    expect(view.id).toBe(source.reviewId.toHexString());
    expect(view.rating).toBe(rating);
    expect(view.comment).toBe(comment);
    expect(view.createdAt).toBe(source.createdAt.toISOString());
    expect(view.memberDisplayName).toBe(displayName);
    const booking = view.booking as Record<string, unknown>;
    expect(Object.keys(booking).sort()).toEqual(BOOKING_FIELDS);
    expect(booking.id).toBe(source.bookingId.toHexString());
    expect(booking.startAt).toBe(source.start.toISOString());
    expect(booking.endAt).toBe(source.end.toISOString());
  }

  // ========== AC01: đúng PT và dữ liệu nguồn ==========

  describe('US-31-TC01: PT xem review của buổi mình dạy', () => {
    it('US-31-TC01: danh sách 200, đúng điểm, nhận xét, thời điểm gửi, giờ buổi và tên từ snapshot', async () => {
      const pt = await trainer();
      const an = await member('Nguyen Van An');
      // Review gửi 2 ngày trước cho buổi 5 ngày trước: giờ buổi và giờ gửi khác nhau (F02).
      const older = await review(an, pt.trainerId, {
        rating: 4, comment: 'PT nhiệt tình, chỉ kỹ thuật rõ', createdAt: daysAgo(2), sessionStart: daysAgo(5),
        displayName: 'An Nguyen (snapshot)',
      });

      const response = await list(pt).expect(200);

      expect(response.body.profileLinked).toBe(true);
      expect(response.body.items).toHaveLength(1);
      expectReviewView(response.body.items[0], older, 4, 'PT nhiệt tình, chỉ kỹ thuật rõ', 'An Nguyen (snapshot)');
    });

    it('US-31-TC01: danh sách sắp theo thời điểm gửi review mới nhất trước, không theo giờ buổi tập', async () => {
      const pt = await trainer();
      const an = await member('Nguyen Van An');
      const binh = await member('Le Thi Binh');
      // Buổi sớm hơn nhưng review gửi muộn hơn → phải đứng đầu.
      const lateReview = await review(an, pt.trainerId, { rating: 5, comment: 'Tốt', createdAt: daysAgo(1), sessionStart: daysAgo(10) });
      const earlyReview = await review(binh, pt.trainerId, { rating: 3, comment: 'Ổn', createdAt: daysAgo(3), sessionStart: daysAgo(4) });

      const response = await list(pt).expect(200);

      expect(ids(response.body)).toEqual([lateReview.reviewId.toHexString(), earlyReview.reviewId.toHexString()]);
    });

    it('US-31-TC01: chi tiết 200 đúng 6 field', async () => {
      const pt = await trainer();
      const an = await member('Nguyen Van An');
      const mine = await review(an, pt.trainerId, { rating: 5, comment: 'Rất hài lòng', createdAt: daysAgo(1), sessionStart: daysAgo(2) });

      const response = await detail(pt, mine.reviewId.toHexString()).expect(200);

      expectReviewView(response.body, mine, 5, 'Rất hài lòng', 'Nguyen Van An');
    });

    it('US-31-TC01: không trả điện thoại, email của hội viên ở danh sách và chi tiết (F03)', async () => {
      const pt = await trainer();
      const an = await member('Nguyen Van An');
      const mine = await review(an, pt.trainerId, { rating: 4, comment: 'Ổn', createdAt: daysAgo(1), sessionStart: daysAgo(2) });

      const listed = JSON.stringify((await list(pt).expect(200)).body);
      const shown = JSON.stringify((await detail(pt, mine.reviewId.toHexString()).expect(200)).body);

      for (const text of [listed, shown]) {
        expect(text).not.toContain(an.phone);
        expect(text).not.toContain(an.email);
      }
    });
  });

  describe('US-31-TC02: đổi id PT khác hoặc gửi trainerId', () => {
    it('US-31-TC02: PT B không thấy review của PT A trong danh sách của mình', async () => {
      const ptA = await trainer('PT A');
      const ptB = await trainer('PT B');
      const an = await member('Nguyen Van An');
      const ofA = await review(an, ptA.trainerId, { rating: 5, comment: 'Bí mật của PT A', createdAt: daysAgo(1), sessionStart: daysAgo(2) });
      const ofB = await review(an, ptB.trainerId, { rating: 3, comment: 'Của PT B', createdAt: daysAgo(1), sessionStart: daysAgo(3) });

      const response = await list(ptB).expect(200);

      expect(ids(response.body)).toEqual([ofB.reviewId.toHexString()]);
      expect(JSON.stringify(response.body)).not.toContain(ofA.reviewId.toHexString());
      expect(JSON.stringify(response.body)).not.toContain('Bí mật của PT A');
    });

    it('US-31-TC02: PT B mở chi tiết review của PT A → 404, không lộ nội dung', async () => {
      const ptA = await trainer('PT A');
      const ptB = await trainer('PT B');
      const an = await member('Nguyen Van An');
      const ofA = await review(an, ptA.trainerId, { rating: 5, comment: 'Bí mật của PT A', createdAt: daysAgo(1), sessionStart: daysAgo(2) });

      const response = await detail(ptB, ofA.reviewId.toHexString());

      expectError(response, 404);
      expect(JSON.stringify(response.body)).not.toContain('Bí mật của PT A');
    });

    it('US-31-TC02: gửi query trainerId của PT khác → 400 hoặc 404, không lộ review của PT đó', async () => {
      const ptA = await trainer('PT A');
      const ptB = await trainer('PT B');
      const an = await member('Nguyen Van An');
      await review(an, ptA.trainerId, { rating: 5, comment: 'Bí mật của PT A', createdAt: daysAgo(1), sessionStart: daysAgo(2) });

      const response = await list(ptB, { trainerId: ptA.trainerId.toHexString() });

      expect([400, 404]).toContain(response.status);
      expectError(response, response.status);
      expect(JSON.stringify(response.body)).not.toContain('Bí mật của PT A');
    });

    it('US-31-TC02: id chi tiết sai định dạng → 400; id hợp lệ nhưng không tồn tại → 404', async () => {
      const pt = await trainer();

      expectError(await detail(pt, 'khong-phai-id'), 400);
      expectError(await detail(pt, new ObjectId().toHexString()), 404);
    });
  });

  describe('US-31-TC03: Member/Staff/Admin gọi route của PT', () => {
    it.each(['MEMBER', 'STAFF', 'ADMIN'] as const)('US-31-TC03: %s gọi danh sách và chi tiết → 403', async roleCode => {
      const pt = await trainer();
      const an = await member('Nguyen Van An');
      const mine = await review(an, pt.trainerId, { rating: 5, comment: 'Tốt', createdAt: daysAgo(1), sessionStart: daysAgo(2) });
      const other = await userOf(roleCode);

      expectError(await list(other), 403);
      expectError(await detail(other, mine.reviewId.toHexString()), 403);
    });

    it('US-31-TC03: không có phiên đăng nhập → 401', async () => {
      const response = await http().get(base).set('Origin', origin);
      expectError(response, 401);
      expectError(await http().get(`${base}/${new ObjectId().toHexString()}`).set('Origin', origin), 401);
    });
  });

  describe('US-31-TC04: chưa có hồ sơ/review', () => {
    it('US-31-TC04: tài khoản TRAINER chưa liên kết hồ sơ trainers → 200 profileLinked=false, danh sách rỗng; chi tiết 404', async () => {
      const owner = await account('TRAINER', 'PT chua co ho so');
      const unlinked: Auth = { accessToken: await loginAs(owner.phone) };
      // Review của một PT khác tồn tại: PT chưa link không được thấy nhờ "rơi" về bộ lọc rỗng.
      const pt = await trainer();
      const an = await member('Nguyen Van An');
      const ofOther = await review(an, pt.trainerId, { rating: 5, comment: 'Tốt', createdAt: daysAgo(1), sessionStart: daysAgo(2) });

      const response = await list(unlinked).expect(200);

      expect(response.body.profileLinked).toBe(false);
      expect(response.body.items).toEqual([]);
      expectError(await detail(unlinked, ofOther.reviewId.toHexString()), 404);
    });

    it('US-31-TC04: buổi COMPLETED chưa có review → danh sách rỗng, không tạo dòng điểm 0, GET không ghi review', async () => {
      const pt = await trainer();
      const an = await member('Nguyen Van An');
      await completedBooking(an, pt.trainerId, daysAgo(2));

      const response = await list(pt).expect(200);

      expect(response.body.profileLinked).toBe(true);
      expect(response.body.items).toEqual([]);
      expect(JSON.stringify(response.body)).not.toMatch(/"rating":0/);
      expect(await db().collection('trainer_reviews').countDocuments({})).toBe(0);
    });
  });
});
