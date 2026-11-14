// Tầng kiểm thử backend (Jest + MongoDB replica set thật + Supertest): US-65 bước 3 – projection reviewState.
// Kiểm tra danh sách/chi tiết lịch riêng của Member có gợi ý reviewState/reviewId đúng theo trạng thái buổi và review đã gửi (TC02, TC04, TC07).
// Hợp đồng test đặt ra cho Builder (US-65 bước 3, theo dòng "GET own booking list/detail" bảng API mục 2 của spec):
//   GET /api/me/pt-bookings (mỗi item) và GET /api/me/pt-bookings/:id có thêm:
//     reviewState: 'NOT_ELIGIBLE' | 'ELIGIBLE' | 'SUBMITTED'; reviewId: chỉ có khi SUBMITTED (= id review đã gửi).
//     NOT_ELIGIBLE: buổi BOOKED/CANCELLED. ELIGIBLE: COMPLETED, chưa có review (gói hết hạn sau buổi vẫn ELIGIBLE).
//     SUBMITTED: đã có trainer_reviews cho booking này.
//   Đây chỉ là gợi ý UI: GET không ghi gì (không review, không key, không tăng khóa); POST vẫn tự kiểm lại (bước 2).
//   Review của Member khác không làm đổi reviewState của buổi mình.
// Fixture dùng lại khuôn của test bước 2 (pt-review-create.integration-spec.ts).
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
const databaseName = 'gym_management_test_us65_review_state';
const password = 'MậtKhẩuUS-65-123';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const VN_OFFSET_MS = 7 * 60 * MINUTE;
const PT_NAME = 'PT Lê Văn Cường';
const MEMBER_NAME = 'Hội viên Nguyễn An';

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Auth = { accessToken: string; accountId: string };

describe('US-65 bước 3: projection reviewState trên lịch riêng của Member', () => {
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
  function submit(auth: Auth, bookingId: ObjectId, body: Record<string, unknown> = { rating: 4 }) {
    return http().post(`/api/me/pt-bookings/${bookingId.toHexString()}/review`).set('Origin', origin)
      .set('Authorization', `Bearer ${auth.accessToken}`).set('Idempotency-Key', randomUUID()).send(body);
  }
  const get = (path: string, auth: Auth) => http().get(path).set('Origin', origin).set('Authorization', `Bearer ${auth.accessToken}`);
  const list = (auth: Auth) => get(`/api/me/pt-bookings?fromDate=${shiftDays(-3)}&toDate=${shiftDays(1)}`, auth);
  const detail = (auth: Auth, bookingId: ObjectId) => get(`/api/me/pt-bookings/${bookingId.toHexString()}`, auth);

  // Lấy item của một booking trong danh sách lịch riêng.
  async function listItem(auth: Auth, bookingId: ObjectId) {
    const response = await list(auth).expect(200);
    const item = (response.body.items as Array<Record<string, unknown>>).find(row => row.id === bookingId.toHexString());
    expect(item).toBeDefined();
    return item!;
  }

  // Kiểm cả danh sách và chi tiết cùng trả một reviewState/reviewId.
  async function expectState(auth: Auth, bookingId: ObjectId, state: string, reviewId?: string) {
    const item = await listItem(auth, bookingId);
    const one = (await detail(auth, bookingId).expect(200)).body as Record<string, unknown>;
    for (const view of [item, one]) {
      expect(view.reviewState).toBe(state);
      if (reviewId) expect(view.reviewId).toBe(reviewId);
      else expect(view.reviewId ?? undefined).toBeUndefined();
    }
  }

  const count = (collection: string, filter: Record<string, unknown> = {}) => db().collection(collection).countDocuments(filter);
  const guardRevision = async () => Number((await db().collection<{ _id: string; revision: Long }>('schedule_guards').findOne({ _id: 'global' }))?.revision);

  // =====================================================================
  // reviewState theo trạng thái buổi (TC04)
  // =====================================================================
  describe('US-65-AC01: gợi ý được đánh giá hay không theo trạng thái buổi', () => {
    it('US-65-TC04: buổi COMPLETED chưa có review → reviewState ELIGIBLE, không có reviewId (danh sách và chi tiết)', async () => {
      const { me, bookingId } = await ready();
      await expectState(me, bookingId, 'ELIGIBLE');
    });

    it.each(['BOOKED', 'CANCELLED'] as const)('US-65-TC04: buổi %s → reviewState NOT_ELIGIBLE, không có reviewId', async status => {
      const { me, bookingId } = await ready({ status });
      await expectState(me, bookingId, 'NOT_ELIGIBLE');
    });

    it('US-65-TC04: gói đã hết hạn sau buổi tập → buổi COMPLETED vẫn ELIGIBLE', async () => {
      const { me, bookingId } = await ready({ endDate: shiftDays(-1) });
      await expectState(me, bookingId, 'ELIGIBLE');
    });

    it('US-65-TC04: danh sách có nhiều buổi → mỗi buổi đúng reviewState của nó', async () => {
      const { me, membershipId, pt, bookingId: completed } = await ready();
      const booked = await insertBooking(me.memberId, membershipId, pt.trainerId, pt.accountId, 'BOOKED');
      const cancelled = await insertBooking(me.memberId, membershipId, pt.trainerId, pt.accountId, 'CANCELLED');

      expect((await listItem(me, completed)).reviewState).toBe('ELIGIBLE');
      expect((await listItem(me, booked)).reviewState).toBe('NOT_ELIGIBLE');
      expect((await listItem(me, cancelled)).reviewState).toBe('NOT_ELIGIBLE');
    });
  });

  // =====================================================================
  // Sau khi gửi (TC07) và không lẫn dữ liệu người khác (TC02)
  // =====================================================================
  describe('US-65-AC02: đã gửi thì SUBMITTED, trỏ đúng review gốc', () => {
    it('US-65-TC07: gửi review xong → reviewState SUBMITTED, reviewId = id review trả về từ POST (danh sách và chi tiết)', async () => {
      const { me, bookingId } = await ready();
      const created = await submit(me, bookingId, { rating: 4, comment: 'Tốt' }).expect(201);
      await expectState(me, bookingId, 'SUBMITTED', created.body.id as string);
    });

    it('US-65-TC07: review có sẵn trong DB (dữ liệu cũ đã backfill) → SUBMITTED với reviewId của review đó', async () => {
      const { me, pt, bookingId } = await ready();
      const reviewId = new ObjectId();
      await db().collection('trainer_reviews').insertOne({
        _id: reviewId, id: reviewId, booking_id: bookingId, trainer_id: pt.trainerId, member_id: me.memberId, created_by: new ObjectId(me.accountId),
        rating: 5, comment: '', created_at: new Date(), trainer_name_snapshot: PT_NAME, member_display_name_snapshot: MEMBER_NAME,
      });
      await expectState(me, bookingId, 'SUBMITTED', reviewId.toHexString());
    });

    it('US-65-TC02: Member khác gửi review cho buổi của họ → buổi của mình vẫn ELIGIBLE', async () => {
      const mine = await ready();
      const other = await linkedMember('Hội viên Trần Bình');
      const otherPlan = await insertPlan(other.memberId);
      const otherBooking = await insertBooking(other.memberId, otherPlan, mine.pt.trainerId, mine.pt.accountId);
      await submit(other, otherBooking).expect(201);

      await expectState(mine.me, mine.bookingId, 'ELIGIBLE');
      const ids = ((await list(mine.me).expect(200)).body.items as Array<{ id: string }>).map(row => row.id);
      expect(ids).not.toContain(otherBooking.toHexString());
    });
  });

  // =====================================================================
  // Projection chỉ là gợi ý: GET không ghi gì
  // =====================================================================
  describe('US-65-AC03: GET lịch riêng không có tác dụng phụ', () => {
    it('US-65-TC04: GET danh sách/chi tiết buổi ELIGIBLE không tạo review, không ghi key, không tăng khóa lịch', async () => {
      const { me, bookingId } = await ready();
      await list(me).expect(200);
      await detail(me, bookingId).expect(200);

      expect(await count('trainer_reviews')).toBe(0);
      expect(await count('operation_requests')).toBe(0);
      expect(await count('booking_events', { action: 'REVIEW_SUBMITTED' })).toBe(0);
      expect(await guardRevision()).toBe(0);
    });
  });
});
