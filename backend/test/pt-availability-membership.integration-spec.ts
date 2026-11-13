// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-27 bước 4.
// Kiểm tra slot theo gói Member chọn (gói tương lai, GYM, hết hạn, vượt ngày cuối, hết quota, SUPERSEDED), truy cập chéo,
// xem slot không giữ chỗ và slot lệch phút / lớp phủ một phần (TC01, TC03, TC05–TC09).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng test đặt ra cho Builder (US-27 bước 4, theo F04 và mục 2 của spec):
//   GET /api/me/pt-trainers/:id/availability?fromDate&toDate&membershipId
//   - membershipId của chính Member: đánh giá từng slot. bookable=true khi CẢ buổi nằm trong kỳ gói [startDate, endDate]
//     (ngày VN, ngày cuối vẫn dùng được), giao dịch của gói SETTLED, membership status ACTIVE, gói kind PT,
//     và available = sessions_snapshot − sessions_used − số BOOKED (mọi thời điểm) ≥ 1. Gói tương lai dùng được cho buổi trong kỳ của nó.
//   - Không đạt thì bookable=false và có reason. Mã dùng chung với lỗi 409 của US-28:
//     gói không dùng được (GYM, chưa SETTLED, không ACTIVE/SUPERSEDED, ngoài kỳ) -> MEMBERSHIP_NOT_ELIGIBLE; hết buổi -> QUOTA_EXHAUSTED.
//     Dữ liệu âm (used > quota) -> bookable=false, không làm tròn.
//   - membershipId của Member khác / không tồn tại / Member chưa link -> 404, không trả lý do gói của người khác.
//   - Không gửi membershipId -> bookable=false, reason=MEMBERSHIP_REQUIRED (đã có từ bước 1).
//   Mọi route /api/me/pt-* chỉ cho MEMBER: TRAINER/STAFF/ADMIN -> 403; không token -> 401.
//   GET không ghi gì vào DB (xem slot không giữ chỗ).

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us27_membership';
const password = 'MậtKhẩuUS-27-123';

type Auth = { accessToken: string };
type Slot = { shiftId: string; startAt: string; endAt: string; location: string; bookable: boolean; reason?: string };
type PlanOptions = {
  kind?: 'GYM' | 'PT'; transactionStatus?: string; membershipStatus?: string; startDay?: number; endDay?: number; quota?: number; used?: number;
};

describe('US-27 bước 4: slot theo gói, truy cập chéo, không giữ chỗ', () => {
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
      SMTP_USER: 'us27-test', SMTP_PASS: 'us27-test', SMTP_FROM: 'no-reply@gym.test',
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
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const at = (onDay: string, hhmm: string) => new Date(`${onDay}T${hhmm}:00+07:00`);
  const D = 10; // ngày xem slot: cách hôm nay 10 ngày
  const day = vnDay(D);

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN', fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0912900${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: created.id, phone };
  }

  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }

  async function loginRole(roleCode: 'TRAINER' | 'STAFF' | 'ADMIN') {
    const owner = await account(roleCode, `US27 ${roleCode}`);
    return { accessToken: await loginAs(owner.phone) };
  }

  // PT mẫu (thay US-23).
  async function trainer(name = 'PT Trần Văn Bình') {
    const owner = await account('TRAINER', name);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: owner.accountId, specialty: 'Thể hình', status: 'ACTIVE',
      version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: owner.accountId };
  }

  async function insertShift(trainerId: ObjectId, onDay: string, from: string, to: string) {
    const id = new ObjectId();
    const now = new Date();
    await db().collection('work_shifts').insertOne({
      _id: id, id, trainer_id: trainerId, start_at: at(onDay, from), end_at: at(onDay, to), location: 'Phòng PT 1',
      status: 'CONFIRMED', version: 1, created_by: new ObjectId(), updated_by: new ObjectId(), created_at: now, updated_at: now,
    });
    return id.toHexString();
  }

  async function insertClass(trainerId: ObjectId, onDay: string, from: string, to: string) {
    const id = new ObjectId();
    const now = new Date();
    const adminId = new ObjectId();
    await db().collection('public_sessions').insertOne({
      _id: id, id, trainer_id: trainerId, title: 'Yoga', subject_code: 'YOGA', location: 'Phòng 1',
      start_at: at(onDay, from), end_at: at(onDay, to), status: 'PUBLISHED', version: 1, created_at: now, updated_at: now,
      created_by: adminId, updated_by: adminId, published_at: now,
    });
  }

  // Hồ sơ hội viên mẫu (khuôn US-09) gắn account.
  async function insertMember(accountId: ObjectId, phone: string) {
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: `Hội viên ${phone}`, phone,
      account_id: accountId, version: 0, service_revision: 0n, created_by: staffId, updated_by: staffId,
    });
    return memberId;
  }

  // Một gói (thay US-14/22): plan → transaction → sale (kỳ theo ngày VN) → membership.
  let saleSeq = 0;
  async function insertPlan(memberId: ObjectId, options: PlanOptions = {}) {
    saleSeq += 1;
    const kind = options.kind ?? 'PT';
    const quota = options.quota ?? (kind === 'PT' ? 10 : 0);
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const staffId = new ObjectId();
    const now = new Date();
    const money = Decimal128.fromString('3000000');
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `${kind}-US27B4-${saleSeq}`, name: `Gói ${kind} ${saleSeq}`, kind, duration_days: 30,
      session_quota: quota, price: money, benefits: 'Quyền lợi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US27B4-${saleSeq}`, kind,
      amount_due: money, status: options.transactionStatus ?? 'SETTLED', request_key: `us27b4-key-${transactionId.toHexString()}`, created_at: now,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: vnDay(options.startDay ?? -5), end_date: vnDay(options.endDay ?? 30), plan_name_snapshot: `Gói ${kind} ${saleSeq}`,
      benefits_snapshot: 'Quyền lợi', list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: quota,
      policy_snapshot: 'Giá niêm yết', created_at: now,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, id: membershipId, service_sale_id: saleId, status: options.membershipStatus ?? 'ACTIVE',
      sessions_used: options.used ?? 0,
    });
    return membershipId;
  }

  // Member đã link (chưa có gói; test tự thêm gói cần dùng).
  async function linkedMember() {
    const owner = await account('MEMBER', `Hội viên US27 B4 ${phoneSeq + 1}`);
    const memberId = await insertMember(owner.accountId, owner.phone);
    return { accessToken: await loginAs(owner.phone), memberId };
  }

  // Buổi PT mẫu (thay US-28).
  async function insertBooking(memberId: ObjectId, membershipId: ObjectId, trainerId: ObjectId, start: Date, status = 'BOOKED') {
    const id = new ObjectId();
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: membershipId, member_id: memberId, trainer_id: trainerId, shift_id: new ObjectId(),
      start_at: start, end_at: new Date(start.getTime() + 3600000), status, request_key: `us27b4-booking-${id.toHexString()}`,
      version: 0, trainer_name_snapshot: 'PT mẫu', location_snapshot: 'Phòng PT 1', created_at: new Date(), updated_at: new Date(),
    });
  }

  function availability(user: Auth | undefined, trainerId: ObjectId, query: Record<string, string>) {
    const call = http().get(`/api/me/pt-trainers/${trainerId.toHexString()}/availability`)
      .query({ fromDate: day, toDate: day, ...query }).set('Origin', origin);
    return user ? call.set('Authorization', `Bearer ${user.accessToken}`) : call;
  }

  async function slots(user: Auth, trainerId: ObjectId, query: Record<string, string> = {}): Promise<Slot[]> {
    const response = await availability(user, trainerId, query).expect(200);
    return [...(response.body.slots as Slot[])].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  }

  const startsOf = (list: Slot[]) => list.map(item => new Date(item.startAt).toISOString());
  const slotAt = (list: Slot[], start: Date) => {
    const found = list.find(item => Date.parse(item.startAt) === start.getTime());
    if (!found) throw new Error(`Không thấy slot ${start.toISOString()}`);
    return found;
  };

  function expectError(response: request.Response, status: number) {
    expect(response.status).toBe(status);
    expect(typeof response.body.error?.code).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
  }

  async function snapshot() {
    const result: Record<string, unknown[]> = {};
    for (const collection of await db().collections()) {
      result[collection.collectionName] = await collection.find({}).sort({ _id: 1 }).toArray();
    }
    return result;
  }

  // =====================================================================
  // AC01 bổ sung: slot lệch phút và lớp phủ một phần (TC01, TC03)
  // =====================================================================

  describe('US-27-TC01: slot lệch phút', () => {
    it('US-27-TC01: ca 08:10–11:20 sinh slot 08:10, 09:10, 10:10; 10 phút dư không thành slot', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:10', '11:20');
      expect(startsOf(await slots(me, pt.trainerId))).toEqual(['08:10', '09:10', '10:10'].map(t => at(day, t).toISOString()));
    });
  });

  describe('US-27-TC03: lớp phủ một phần trên ca lệch phút', () => {
    it('US-27-TC03: lớp 08:30–09:00 trên ca 08:10–11:10 chỉ loại slot 08:10–09:10, không dịch slot sau', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:10', '11:10');
      await insertClass(pt.trainerId, day, '08:30', '09:00');
      expect(startsOf(await slots(me, pt.trainerId))).toEqual(['09:10', '10:10'].map(t => at(day, t).toISOString()));
    });

    it('US-27-TC03: lớp 09:05–09:15 chạm hai slot 08:10 và 09:10 → loại cả hai, còn 10:10', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:10', '11:10');
      await insertClass(pt.trainerId, day, '09:05', '09:15');
      expect(startsOf(await slots(me, pt.trainerId))).toEqual([at(day, '10:10').toISOString()]);
    });

    it('US-27-TC03: lớp kết thúc đúng 09:10 (tiếp giáp slot 09:10) → slot 09:10 vẫn còn', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:10', '10:10');
      await insertClass(pt.trainerId, day, '08:40', '09:10');
      expect(startsOf(await slots(me, pt.trainerId))).toEqual([at(day, '09:10').toISOString()]);
    });
  });

  // =====================================================================
  // AC02: membership và quyền riêng tư (TC05–TC08)
  // =====================================================================

  describe('US-27-TC05: gói future ACTIVE / PT đã SETTLED, buổi nằm trong kỳ', () => {
    it('US-27-TC05: gói PT hiện hành, SETTLED, còn buổi → slot trong kỳ bookable=true, không có reason', async () => {
      const me = await linkedMember();
      const membershipId = await insertPlan(me.memberId);
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:00', '10:00');

      const list = await slots(me, pt.trainerId, { membershipId: membershipId.toHexString() });

      expect(list).toHaveLength(2);
      for (const item of list) {
        expect(item.bookable).toBe(true);
        expect(item.reason).toBeUndefined();
      }
    });

    it('US-27-TC05: gói tương lai (bắt đầu đúng ngày xem) dùng được cho buổi trong kỳ của nó dù hôm nay chưa hiệu lực', async () => {
      const me = await linkedMember();
      const membershipId = await insertPlan(me.memberId, { startDay: D, endDay: D + 30 });
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:00', '09:00');

      const [only] = await slots(me, pt.trainerId, { membershipId: membershipId.toHexString() });
      expect(only.bookable).toBe(true);
    });

    it('US-27-TC05: gói tương lai không dùng được cho buổi trước ngày bắt đầu → MEMBERSHIP_NOT_ELIGIBLE', async () => {
      const me = await linkedMember();
      const membershipId = await insertPlan(me.memberId, { startDay: D + 1, endDay: D + 30 });
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:00', '09:00');

      const [only] = await slots(me, pt.trainerId, { membershipId: membershipId.toHexString() });
      expect(only).toMatchObject({ bookable: false, reason: 'MEMBERSHIP_NOT_ELIGIBLE' });
    });

    it('US-27-TC05: giao dịch của gói chưa SETTLED (PENDING) → không bookable, MEMBERSHIP_NOT_ELIGIBLE', async () => {
      const me = await linkedMember();
      const membershipId = await insertPlan(me.memberId, { transactionStatus: 'PENDING' });
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:00', '09:00');

      const [only] = await slots(me, pt.trainerId, { membershipId: membershipId.toHexString() });
      expect(only).toMatchObject({ bookable: false, reason: 'MEMBERSHIP_NOT_ELIGIBLE' });
    });

    it('US-27-TC05: buổi BOOKED của chính Member vẫn loại slot giao nhau khi đã chọn gói', async () => {
      const me = await linkedMember();
      const membershipId = await insertPlan(me.memberId);
      const ptA = await trainer('PT A');
      const ptB = await trainer('PT B');
      await insertShift(ptA.trainerId, day, '08:00', '10:00');
      await insertBooking(me.memberId, membershipId, ptB.trainerId, at(day, '08:00'));

      const list = await slots(me, ptA.trainerId, { membershipId: membershipId.toHexString() });
      expect(startsOf(list)).toEqual([at(day, '09:00').toISOString()]);
      expect(list[0].bookable).toBe(true);
    });
  });

  describe('US-27-TC06: gói GYM / hết hạn / buổi vượt ngày cuối / quota còn 0', () => {
    it('US-27-TC06: gói GYM (quota 0) không bao giờ coi là gói PT → MEMBERSHIP_NOT_ELIGIBLE', async () => {
      const me = await linkedMember();
      const membershipId = await insertPlan(me.memberId, { kind: 'GYM' });
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:00', '09:00');

      const [only] = await slots(me, pt.trainerId, { membershipId: membershipId.toHexString() });
      expect(only).toMatchObject({ bookable: false, reason: 'MEMBERSHIP_NOT_ELIGIBLE' });
    });

    it('US-27-TC06: gói PT đã hết hạn (ngày cuối trước ngày xem) → MEMBERSHIP_NOT_ELIGIBLE', async () => {
      const me = await linkedMember();
      const membershipId = await insertPlan(me.memberId, { startDay: -40, endDay: -1 });
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:00', '09:00');

      const [only] = await slots(me, pt.trainerId, { membershipId: membershipId.toHexString() });
      expect(only).toMatchObject({ bookable: false, reason: 'MEMBERSHIP_NOT_ELIGIBLE' });
    });

    it('US-27-TC06: buổi đúng ngày cuối của gói vẫn bookable; buổi ngày hôm sau → MEMBERSHIP_NOT_ELIGIBLE', async () => {
      const me = await linkedMember();
      const membershipId = await insertPlan(me.memberId, { endDay: D });
      const pt = await trainer();
      const nextDay = vnDay(D + 1);
      await insertShift(pt.trainerId, day, '20:00', '21:00');
      await insertShift(pt.trainerId, nextDay, '08:00', '09:00');

      const list = await slots(me, pt.trainerId, { fromDate: day, toDate: nextDay, membershipId: membershipId.toHexString() });

      expect(slotAt(list, at(day, '20:00')).bookable).toBe(true);
      expect(slotAt(list, at(nextDay, '08:00'))).toMatchObject({ bookable: false, reason: 'MEMBERSHIP_NOT_ELIGIBLE' });
    });

    it('US-27-TC06: quota còn 0 (used + BOOKED = quota, BOOKED quá giờ vẫn tính) → QUOTA_EXHAUSTED', async () => {
      const me = await linkedMember();
      const membershipId = await insertPlan(me.memberId, { quota: 10, used: 9 });
      const pt = await trainer();
      // Buổi BOOKED đã qua giờ vẫn giữ quota.
      await insertBooking(me.memberId, membershipId, pt.trainerId, at(vnDay(-2), '08:00'));
      await insertShift(pt.trainerId, day, '08:00', '09:00');

      const [only] = await slots(me, pt.trainerId, { membershipId: membershipId.toHexString() });
      expect(only).toMatchObject({ bookable: false, reason: 'QUOTA_EXHAUSTED' });
    });

    it('US-27-TC06: buổi CANCELLED không giữ quota → còn 1 buổi thì vẫn bookable', async () => {
      const me = await linkedMember();
      const membershipId = await insertPlan(me.memberId, { quota: 10, used: 9 });
      const pt = await trainer();
      await insertBooking(me.memberId, membershipId, pt.trainerId, at(vnDay(-2), '08:00'), 'CANCELLED');
      await insertShift(pt.trainerId, day, '08:00', '09:00');

      const [only] = await slots(me, pt.trainerId, { membershipId: membershipId.toHexString() });
      expect(only.bookable).toBe(true);
    });

    it('US-27-TC06: dữ liệu âm (used lớn hơn quota) → bookable=false, không làm tròn để cho đặt', async () => {
      const me = await linkedMember();
      const membershipId = await insertPlan(me.memberId, { quota: 10, used: 11 });
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:00', '09:00');

      const [only] = await slots(me, pt.trainerId, { membershipId: membershipId.toHexString() });
      expect(only.bookable).toBe(false);
      expect(typeof only.reason).toBe('string');
    });
  });

  describe('US-27-TC07: membership của người khác và truy cập chéo', () => {
    it('US-27-TC07: membershipId của Member khác → 404, không trả slot hay lý do gói của họ', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const theirs = await insertPlan(other.memberId, { quota: 10, used: 10 });
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:00', '09:00');

      const response = await availability(me, pt.trainerId, { membershipId: theirs.toHexString() });

      expectError(response, 404);
      expect(response.body.slots).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toMatch(/QUOTA_EXHAUSTED|MEMBERSHIP_NOT_ELIGIBLE/);
    });

    it('US-27-TC07: membershipId không tồn tại → 404 cùng mã lỗi với gói của người khác', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const theirs = await insertPlan(other.memberId);
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:00', '09:00');

      const foreign = await availability(me, pt.trainerId, { membershipId: theirs.toHexString() });
      const missing = await availability(me, pt.trainerId, { membershipId: new ObjectId().toHexString() });

      expectError(foreign, 404);
      expectError(missing, 404);
      expect(foreign.body.error.code).toBe(missing.body.error.code);
    });

    it('US-27-TC07: Member chưa link gửi membershipId → 404', async () => {
      const other = await linkedMember();
      const theirs = await insertPlan(other.memberId);
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:00', '09:00');
      const owner = await account('MEMBER', 'Chưa liên kết');
      const me = { accessToken: await loginAs(owner.phone) };

      expectError(await availability(me, pt.trainerId, { membershipId: theirs.toHexString() }), 404);
    });

    it.each(['TRAINER', 'STAFF', 'ADMIN'] as const)('US-27-TC07: %s gọi các API /api/me/pt-* → 403', async role => {
      const pt = await trainer();
      const user = await loginRole(role);
      const paths = [
        '/api/me/pt-trainers',
        `/api/me/pt-trainers/${pt.trainerId.toHexString()}/availability?fromDate=${day}&toDate=${day}`,
        `/api/me/pt-bookings?fromDate=${day}&toDate=${day}`,
        `/api/me/pt-bookings/${new ObjectId().toHexString()}`,
      ];
      for (const path of paths) {
        expectError(await http().get(path).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`), 403);
      }
    });

    it('US-27-TC07: không đăng nhập gọi các API /api/me/pt-* → 401', async () => {
      const pt = await trainer();
      const paths = [
        '/api/me/pt-trainers',
        `/api/me/pt-trainers/${pt.trainerId.toHexString()}/availability?fromDate=${day}&toDate=${day}`,
        `/api/me/pt-bookings?fromDate=${day}&toDate=${day}`,
        `/api/me/pt-bookings/${new ObjectId().toHexString()}`,
      ];
      for (const path of paths) expectError(await http().get(path).set('Origin', origin), 401);
    });
  });

  describe('US-27-TC08: gói đã SUPERSEDED', () => {
    it('US-27-TC08: chọn gói cũ đã SUPERSEDED (của chính mình) → 200 nhưng không mở slot: MEMBERSHIP_NOT_ELIGIBLE', async () => {
      const me = await linkedMember();
      const oldMembership = await insertPlan(me.memberId, { membershipStatus: 'SUPERSEDED' });
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:00', '10:00');

      const list = await slots(me, pt.trainerId, { membershipId: oldMembership.toHexString() });

      expect(list).toHaveLength(2);
      for (const item of list) expect(item).toMatchObject({ bookable: false, reason: 'MEMBERSHIP_NOT_ELIGIBLE' });
    });

    it('US-27-TC08: gói mới sau nâng cấp vẫn mở slot dù gói cũ SUPERSEDED còn buổi BOOKED', async () => {
      const me = await linkedMember();
      const oldMembership = await insertPlan(me.memberId, { membershipStatus: 'SUPERSEDED' });
      const newMembership = await insertPlan(me.memberId);
      const pt = await trainer();
      await insertBooking(me.memberId, oldMembership, pt.trainerId, at(vnDay(-2), '08:00'));
      await insertShift(pt.trainerId, day, '08:00', '09:00');

      const [only] = await slots(me, pt.trainerId, { membershipId: newMembership.toHexString() });
      expect(only.bookable).toBe(true);
    });
  });

  // =====================================================================
  // AC03: dữ liệu stale (TC09)
  // =====================================================================

  describe('US-27-TC09: hai người xem cùng slot', () => {
    it('US-27-TC09: hai Member xem cùng slot nhiều lần → cả hai đều thấy slot bookable, DB không đổi (xem không giữ chỗ)', async () => {
      const first = await linkedMember();
      const second = await linkedMember();
      const firstPlan = await insertPlan(first.memberId);
      const secondPlan = await insertPlan(second.memberId);
      const pt = await trainer();
      await insertShift(pt.trainerId, day, '08:00', '09:00');
      const before = await snapshot();

      for (let round = 0; round < 2; round += 1) {
        const [a] = await slots(first, pt.trainerId, { membershipId: firstPlan.toHexString() });
        const [b] = await slots(second, pt.trainerId, { membershipId: secondPlan.toHexString() });
        expect(a.bookable).toBe(true);
        expect(b.bookable).toBe(true);
        expect(a.startAt).toBe(b.startAt);
      }

      expect(await snapshot()).toEqual(before);
    });
  });
});
