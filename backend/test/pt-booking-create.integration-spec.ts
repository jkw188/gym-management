// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật, hai app instance): US-28 bước 3.
// Kiểm tra API Member đặt slot PT trong một transaction: chủ thể/gói/slot hợp lệ, quota giữ khi BOOKED, không trùng lịch khi đồng thời,
// writer ca dùng chung khóa lịch, idempotency và rollback (TC01–TC08, TC10–TC12, TC14).
// Hợp đồng test đặt ra cho Builder (US-28 bước 3, theo F01–F04, G01–G04 và mục 3 của spec):
//   POST /api/me/pt-bookings – role MEMBER; header Idempotency-Key (UUID); operation EN-02 PT_BOOKING_CREATE;
//     body CHỈ {membershipId, trainerId, shiftId, startAt} (field khác như endAt, memberId, status, price, trainerName, location → 400).
//     201 {id, memberId, membershipId, trainerId, shiftId, startAt, endAt, location, status:'BOOKED', version, notificationState}.
//   Trong MỘT transaction: lấy khóa lịch schedule_guards → khóa members.service_revision của member → đọc lại PT/ca/gói/quota/xung đột
//     → insert pt_bookings {member_id, membership_id, trainer_id, shift_id, start_at, end_at = start+60', status BOOKED, version 0,
//       trainer_name_snapshot (accounts.full_name của PT), location_snapshot (location của ca), request_key SHA-256 hex64, created_by}
//     → operation_requests. Không tăng sessions_used, không tạo payment/invoice/transaction.
//   Lỗi: 400 dữ liệu sai/thiếu key; 401; 403 sai role; 404 gói không thuộc Member; 409 PROFILE_REQUIRED (account chưa link hồ sơ),
//     MEMBERSHIP_NOT_ELIGIBLE (GYM, chưa SETTLED, không ACTIVE, buổi ngoài kỳ), SHIFT_UNAVAILABLE (ca không CONFIRMED hoặc không thuộc PT),
//     SLOT_UNAVAILABLE (lệch mốc, phần dư, start ≤ now, PT đã có buổi/lớp giao giờ), TRAINER_UNAVAILABLE (PT/account không khả dụng),
//     MEMBER_TIME_CONFLICT (chính Member đã có buổi giao giờ), QUOTA_EXHAUSTED, IDEMPOTENCY_CONFLICT; 503 lỗi hạ tầng.
//     Lỗi conflict không trả id/tên người đang chiếm lịch.
//   US-28-G02: writer ca US-24 (tạo/sửa) và US-25 (công bố/hủy) cũng lấy khóa lịch → schedule_guards.revision tăng 1 mỗi lần ghi.
//   US-23 (PT), US-66 (lớp) chưa có → test chèn thẳng trainers/public_sessions; lớp chỉ kiểm phía đặt lịch.
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
const databaseName = 'gym_management_test_us28_booking';
const password = 'MậtKhẩuUS-28-123';
const base = '/api/me/pt-bookings';
const RESPONSE_FIELDS = ['endAt', 'id', 'location', 'memberId', 'membershipId', 'notificationState', 'shiftId', 'startAt', 'status', 'trainerId', 'version'];

type Auth = { accessToken: string };
type PlanOptions = { kind?: 'GYM' | 'PT'; transactionStatus?: string; membershipStatus?: string; startDay?: number; endDay?: number; quota?: number; used?: number };

describe('US-28 bước 3: Member đặt slot PT', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let second: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      // enableTestCommands=1 để dùng failpoint failCommand giả lập lỗi insert trước commit (TC12), giống US-25-TC11.
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName, args: ['--setParameter', 'enableTestCommands=1'] },
    });
    Object.assign(process.env, {
      NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(), MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'us28-test', SMTP_PASS: 'us28-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    // Instance thứ hai (kết nối DB riêng) để mô phỏng hai app server chạy song song (TC05, TC10).
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

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await second?.close();
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = (instance: INestApplication = app) => request(instance.getHttpServer());

  // ---------- Thời gian theo lịch Việt Nam ----------
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+07:00`);
  const D = 10;
  const day = vnDay(D);
  const iso = (d: string, hhmm: string) => `${d}T${hhmm}:00+07:00`;

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN', fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0913800${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: created.id, phone };
  }
  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }

  // PT mẫu (thay US-23): account TRAINER + hồ sơ trainers; trả token để gọi API ca US-24/25.
  async function trainer(fullName = 'PT Trần Văn Bình') {
    const owner = await account('TRAINER', fullName);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: owner.accountId, specialty: 'Thể hình', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: owner.accountId, accessToken: await loginAs(owner.phone) };
  }

  async function insertShift(trainerId: ObjectId, onDay: string, from: string, to: string, status = 'CONFIRMED', location = 'Phòng PT 1') {
    const id = new ObjectId();
    const now = new Date();
    await db().collection('work_shifts').insertOne({
      _id: id, id, trainer_id: trainerId, start_at: at(onDay, from), end_at: at(onDay, to), location, status, version: 1,
      created_by: new ObjectId(), updated_by: new ObjectId(), created_at: now, updated_at: now,
      ...(status === 'CONFIRMED' ? { confirmed_at: now } : {}),
    });
    return id;
  }

  async function insertClass(trainerId: ObjectId, onDay: string, from: string, to: string) {
    const id = new ObjectId();
    const now = new Date();
    const adminId = new ObjectId();
    await db().collection('public_sessions').insertOne({
      _id: id, id, trainer_id: trainerId, title: 'Yoga', subject_code: 'YOGA', location: 'Phòng 1', start_at: at(onDay, from), end_at: at(onDay, to),
      status: 'PUBLISHED', version: 1, created_at: now, updated_at: now, created_by: adminId, updated_by: adminId, published_at: now,
    });
  }

  // Member có tài khoản đã liên kết hồ sơ (khuôn US-09, service_revision Int64 cho khóa member của EN-02).
  async function linkedMember(name = 'Hội viên US28') {
    const owner = await account('MEMBER', name);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: name, phone: owner.phone,
      account_id: owner.accountId, version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { accessToken: await loginAs(owner.phone), memberId, accountId: owner.accountId };
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
      _id: planId, id: planId, code: `${kind}-US28B3-${saleSeq}`, name: `Gói ${kind} ${saleSeq}`, kind, duration_days: 30,
      session_quota: quota, price: money, benefits: 'Quyền lợi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US28B3-${saleSeq}`, kind, amount_due: money,
      status: options.transactionStatus ?? 'SETTLED', request_key: randomBytes(32).toString('hex'), created_at: now, guard_revision: Long.ZERO,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: vnDay(options.startDay ?? -5), end_date: vnDay(options.endDay ?? 30), plan_name_snapshot: `Gói ${kind} ${saleSeq}`,
      benefits_snapshot: 'Quyền lợi', list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: quota,
      policy_snapshot: 'Giá niêm yết', created_at: now,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, id: membershipId, service_sale_id: saleId, status: options.membershipStatus ?? 'ACTIVE', sessions_used: options.used ?? 0,
    });
    return membershipId;
  }

  // Buổi PT có sẵn (đặt trước đó).
  async function insertBooking(memberId: ObjectId, membershipId: ObjectId, trainerId: ObjectId, start: Date, status = 'BOOKED') {
    const id = new ObjectId();
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: membershipId, member_id: memberId, trainer_id: trainerId, shift_id: new ObjectId(),
      start_at: start, end_at: new Date(start.getTime() + 3600000), status, request_key: randomBytes(32).toString('hex'),
      version: 0, trainer_name_snapshot: 'PT mẫu', location_snapshot: 'Phòng PT 1', created_at: new Date(), updated_at: new Date(),
    });
    return id;
  }

  // Một bộ dữ liệu sẵn sàng đặt: Member có gói PT, PT có ca CONFIRMED 08:00–11:00 ngày D.
  async function ready(options: PlanOptions = {}) {
    const me = await linkedMember();
    const membershipId = await insertPlan(me.memberId, options);
    const pt = await trainer();
    const shiftId = await insertShift(pt.trainerId, day, '08:00', '11:00', 'CONFIRMED', 'Phòng PT 2');
    return { me, membershipId, pt, shiftId };
  }

  const bodyOf = (membershipId: ObjectId, trainerId: ObjectId, shiftId: ObjectId, startAt: string) => ({
    membershipId: membershipId.toHexString(), trainerId: trainerId.toHexString(), shiftId: shiftId.toHexString(), startAt,
  });

  function book(user: Auth | undefined, body: Record<string, unknown>, key: string | null = randomUUID(), instance: INestApplication = app) {
    let call = http(instance).post(base).set('Origin', origin);
    if (user) call = call.set('Authorization', `Bearer ${user.accessToken}`);
    if (key !== null) call = call.set('Idempotency-Key', key);
    return call.send(body);
  }

  function expectError(response: request.Response, status: number, code?: string) {
    expect(response.status).toBe(status);
    expect(typeof response.body.error?.code).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
    if (code) expect(response.body.error.code).toBe(code);
  }

  const bookingCount = (filter: Record<string, unknown> = {}) => db().collection('pt_bookings').countDocuments(filter);
  const guardRevision = async () => String((await db().collection('schedule_guards').findOne({ _id: 'global' as unknown as ObjectId }, { promoteLongs: false }))?.revision);
  const memberRevision = async (memberId: ObjectId) => String((await db().collection('members').findOne({ _id: memberId }, { promoteLongs: false }))?.service_revision);
  async function reservedOf(user: Auth, membershipId: ObjectId) {
    const response = await http().get(`/api/me/memberships/${membershipId.toHexString()}`).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`).expect(200);
    const { sessionsUsed, sessionsReserved, sessionsAvailable } = response.body as Record<string, number>;
    return { sessionsUsed, sessionsReserved, sessionsAvailable };
  }

  // Lỗi nghiệp vụ: không có booking mới, gói giữ nguyên.
  async function expectRejected(response: request.Response, status: number, code: string, membershipId?: ObjectId) {
    expectError(response, status, code);
    // Booking tạo qua API luôn có created_by; booking mẫu chèn sẵn trong test thì không.
    expect(await bookingCount({ created_by: { $exists: true } })).toBe(0);
    if (membershipId) expect((await db().collection('memberships').findOne({ _id: membershipId }))?.sessions_used).toBe(0);
  }

  // Bật/tắt lỗi giả lập khi insert vào một collection (giống US-25-TC11).
  async function failInsertsOn(collection: string, work: () => Promise<void>) {
    await db().admin().command({
      configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: ['insert'], namespace: `${databaseName}.${collection}`, errorCode: 1, errmsg: 'Giả lập DB lỗi US-28-TC12' },
    });
    try {
      await work();
    } finally {
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
  }

  // =====================================================================
  // AC01 – Chủ thể slot và gói đủ điều kiện (TC01–TC04)
  // =====================================================================

  describe('US-28-TC01: Member đúng gói/slot 60 phút trong ca công bố', () => {
    it('US-28-TC01: 201 BOOKED ngay, đúng các field hợp đồng; endAt do server tính, địa điểm lấy từ ca', async () => {
      const { me, membershipId, pt, shiftId } = await ready();

      const response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00')));

      expect(response.status).toBe(201);
      expect(Object.keys(response.body).sort()).toEqual(RESPONSE_FIELDS);
      expect(response.body).toMatchObject({
        memberId: me.memberId.toHexString(), membershipId: membershipId.toHexString(), trainerId: pt.trainerId.toHexString(),
        shiftId: shiftId.toHexString(), location: 'Phòng PT 2', status: 'BOOKED', version: 0,
      });
      expect(new Date(response.body.startAt).toISOString()).toBe(at(day, '09:00').toISOString());
      expect(new Date(response.body.endAt).toISOString()).toBe(at(day, '10:00').toISOString());
      expect(response.body.startAt).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
    });

    it('US-28-TC01: DB lưu member_id, snapshot tên PT/địa điểm, version 0, request_key băm SHA-256 (không phải key thô), created_by', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const key = randomUUID();

      const response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00')), key).expect(201);

      const saved = await db().collection('pt_bookings').findOne({ _id: new ObjectId(response.body.id) });
      expect(saved).toMatchObject({ status: 'BOOKED', version: 0, trainer_name_snapshot: 'PT Trần Văn Bình', location_snapshot: 'Phòng PT 2' });
      expect(String(saved?.member_id)).toBe(me.memberId.toHexString());
      expect(String(saved?.membership_id)).toBe(membershipId.toHexString());
      expect(String(saved?.shift_id)).toBe(shiftId.toHexString());
      expect(saved?.end_at.toISOString()).toBe(at(day, '09:00').toISOString());
      expect(saved?.request_key).toMatch(/^[a-f0-9]{64}$/);
      expect(saved?.request_key).not.toContain(key);
      expect(saved?.created_by).toBeDefined();
    });

    it('US-28-TC01: reserved tăng 1, used không đổi; không tạo payment, invoice hay transaction mới', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const before = await reservedOf(me, membershipId);
      const counts = async () => Promise.all(['payments', 'invoices', 'transactions'].map(name => db().collection(name).countDocuments()));
      const countsBefore = await counts();

      await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))).expect(201);

      const after = await reservedOf(me, membershipId);
      expect(after.sessionsReserved).toBe(before.sessionsReserved + 1);
      expect(after.sessionsUsed).toBe(before.sessionsUsed);
      expect(after.sessionsAvailable).toBe(before.sessionsAvailable - 1);
      expect(await counts()).toEqual(countsBefore);
    });

    it('US-28-TC01: đặt thành công ghi tăng khóa lịch và members.service_revision mỗi cái đúng 1 (G01, G03)', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const guardBefore = await guardRevision();
      const memberBefore = await memberRevision(me.memberId);

      await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))).expect(201);

      expect(Number(await guardRevision())).toBe(Number(guardBefore) + 1);
      expect(Number(await memberRevision(me.memberId))).toBe(Number(memberBefore) + 1);
    });

    it('US-28-TC01: booking mới thấy ngay trong lịch riêng (US-27) và slot đó không còn trong giờ trống', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const created = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))).expect(201);

      const own = await http().get(`${base}/${created.body.id}`).set('Origin', origin).set('Authorization', `Bearer ${me.accessToken}`).expect(200);
      expect(own.body).toMatchObject({ id: created.body.id, status: 'BOOKED', location: 'Phòng PT 2' });

      const slots = await http().get(`/api/me/pt-trainers/${pt.trainerId.toHexString()}/availability`).query({ fromDate: day, toDate: day })
        .set('Origin', origin).set('Authorization', `Bearer ${me.accessToken}`).expect(200);
      expect(slots.body.slots.map((slot: { startAt: string }) => new Date(slot.startAt).toISOString()))
        .toEqual([at(day, '09:00').toISOString(), at(day, '10:00').toISOString()]);
    });

    it.each([
      ['endAt', { endAt: '2026-12-01T10:00:00+07:00' }],
      ['memberId', { memberId: new ObjectId().toHexString() }],
      ['status', { status: 'BOOKED' }],
      ['price', { price: '0' }],
      ['trainerName', { trainerName: 'PT Giả' }],
      ['location', { location: 'Phòng VIP' }],
    ])('US-28-TC01: client gửi thêm field %s → 400, không tạo booking', async (_name, extra) => {
      const { me, membershipId, pt, shiftId } = await ready();
      const response = await book(me, { ...bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00')), ...extra });
      expectError(response, 400);
      expect(await bookingCount()).toBe(0);
    });

    it('US-28-TC01: thiếu Idempotency-Key hoặc key không phải UUID → 400, không tạo booking', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const body = bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'));
      expectError(await book(me, body, null), 400);
      expectError(await book(me, body, 'khong-phai-uuid'), 400);
      expect(await bookingCount()).toBe(0);
    });
  });

  describe('US-28-TC02: gói người khác/GYM/PENDING/SUPERSEDED hoặc thiếu member link', () => {
    it('US-28-TC02: membershipId của Member khác → 404, không cấp booking', async () => {
      const { me, pt, shiftId } = await ready();
      const other = await linkedMember('Người khác');
      const theirs = await insertPlan(other.memberId);
      await expectRejected(await book(me, bodyOf(theirs, pt.trainerId, shiftId, iso(day, '08:00'))), 404, 'NOT_FOUND');
    });

    it.each([
      ['gói GYM', { kind: 'GYM' as const }],
      ['giao dịch còn PENDING', { transactionStatus: 'PENDING' }],
      ['gói đã SUPERSEDED', { membershipStatus: 'SUPERSEDED' }],
    ])('US-28-TC02: %s → 409 MEMBERSHIP_NOT_ELIGIBLE, không cấp booking', async (_name, options) => {
      const { me, membershipId, pt, shiftId } = await ready(options);
      await expectRejected(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))), 409, 'MEMBERSHIP_NOT_ELIGIBLE', membershipId);
    });

    it('US-28-TC02: account MEMBER chưa liên kết hồ sơ → 409 PROFILE_REQUIRED, không tự link theo phone', async () => {
      const { membershipId, pt, shiftId } = await ready();
      const owner = await account('MEMBER', 'Chưa liên kết');
      const unlinked = { accessToken: await loginAs(owner.phone) };
      await expectRejected(await book(unlinked, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))), 409, 'PROFILE_REQUIRED');
    });

    it.each(['TRAINER', 'STAFF', 'ADMIN'] as const)('US-28-TC02: role %s gọi đặt lịch → 403', async role => {
      const { membershipId, pt, shiftId } = await ready();
      const owner = await account(role, `US28 ${role}`);
      expectError(await book({ accessToken: await loginAs(owner.phone) }, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))), 403);
      expect(await bookingCount()).toBe(0);
    });

    it('US-28-TC02: không đăng nhập → 401', async () => {
      const { membershipId, pt, shiftId } = await ready();
      expectError(await book(undefined, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))), 401);
    });
  });

  describe('US-28-TC03: slot lệch mốc, phần dư, ca nháp, start ≤ now, buổi vượt kỳ', () => {
    it('US-28-TC03: slot lệch mốc 08:30 trong ca 08:00–11:00 → 409 SLOT_UNAVAILABLE', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      await expectRejected(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:30'))), 409, 'SLOT_UNAVAILABLE', membershipId);
    });

    it('US-28-TC03: slot rơi vào phần dư (ca 08:10–10:40, chọn 10:10) → 409 SLOT_UNAVAILABLE', async () => {
      const { me, membershipId, pt } = await ready();
      const shiftId = await insertShift(pt.trainerId, day, '08:10', '10:40');
      await expectRejected(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '10:10'))), 409, 'SLOT_UNAVAILABLE', membershipId);
    });

    it.each(['SCHEDULED', 'CANCELLED'])('US-28-TC03: ca %s → 409 SHIFT_UNAVAILABLE', async status => {
      const { me, membershipId, pt } = await ready();
      const shiftId = await insertShift(pt.trainerId, vnDay(D + 1), '08:00', '10:00', status);
      await expectRejected(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(vnDay(D + 1), '08:00'))), 409, 'SHIFT_UNAVAILABLE', membershipId);
    });

    it('US-28-TC03: slot đã qua giờ (ca CONFIRMED hôm qua) → 409 SLOT_UNAVAILABLE', async () => {
      const { me, membershipId, pt } = await ready();
      const yesterday = vnDay(-1);
      const shiftId = await insertShift(pt.trainerId, yesterday, '08:00', '10:00');
      await expectRejected(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(yesterday, '08:00'))), 409, 'SLOT_UNAVAILABLE', membershipId);
    });

    it('US-28-TC03: buổi nằm sau ngày cuối của gói → 409 MEMBERSHIP_NOT_ELIGIBLE', async () => {
      const { me, membershipId, pt, shiftId } = await ready({ endDay: D - 1 });
      await expectRejected(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))), 409, 'MEMBERSHIP_NOT_ELIGIBLE', membershipId);
    });

    it('US-28-TC03: shiftId thuộc PT khác với trainerId gửi lên → 409 SHIFT_UNAVAILABLE (server xác minh quan hệ)', async () => {
      const { me, membershipId, shiftId } = await ready();
      const otherPt = await trainer('PT Khác');
      await expectRejected(await book(me, bodyOf(membershipId, otherPt.trainerId, shiftId, iso(day, '08:00'))), 409, 'SHIFT_UNAVAILABLE', membershipId);
    });

    it('US-28-TC03: PT INACTIVE hoặc account PT bị khóa → 409 TRAINER_UNAVAILABLE', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      await db().collection('trainers').updateOne({ _id: pt.trainerId }, { $set: { status: 'INACTIVE' } });
      await expectRejected(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))), 409, 'TRAINER_UNAVAILABLE', membershipId);

      await db().collection('trainers').updateOne({ _id: pt.trainerId }, { $set: { status: 'ACTIVE' } });
      await db().collection('accounts').updateOne({ _id: pt.accountId }, { $set: { status: 'LOCKED' } });
      await expectRejected(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))), 409, 'TRAINER_UNAVAILABLE', membershipId);
    });

    it('US-28-TC03: startAt có giây hoặc thiếu múi giờ → 400', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      expectError(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, `${day}T08:00:30+07:00`)), 400);
      expectError(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, `${day}T08:00:00`)), 400);
      expect(await bookingCount()).toBe(0);
    });
  });

  describe('US-28-TC04: future membership PT đã thanh toán và buổi trong kỳ', () => {
    it('US-28-TC04: gói tương lai bắt đầu đúng ngày buổi tập → 201 dù hôm nay gói chưa hiệu lực', async () => {
      const { me, membershipId, pt, shiftId } = await ready({ startDay: D, endDay: D + 30 });
      const response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00')));
      expect(response.status).toBe(201);
      expect(response.body.membershipId).toBe(membershipId.toHexString());
    });

    it('US-28-TC04: gói tương lai bắt đầu sau ngày buổi tập → 409 MEMBERSHIP_NOT_ELIGIBLE', async () => {
      const { me, membershipId, pt, shiftId } = await ready({ startDay: D + 1, endDay: D + 30 });
      await expectRejected(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))), 409, 'MEMBERSHIP_NOT_ELIGIBLE', membershipId);
    });
  });

  // =====================================================================
  // AC02 – Quota và conflict được giữ khi đồng thời (TC05–TC08)
  // =====================================================================

  describe('US-28-TC05: hai Member khác nhau tranh cùng giờ cùng PT', () => {
    it('US-28-TC05: PT đã có buổi BOOKED giao giờ → 409 SLOT_UNAVAILABLE, không lộ người đang chiếm lịch', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const other = await linkedMember('Người Chiếm Lịch');
      const theirs = await insertPlan(other.memberId);
      const takenId = await insertBooking(other.memberId, theirs, pt.trainerId, at(day, '08:00'));

      const response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00')));

      expectError(response, 409, 'SLOT_UNAVAILABLE');
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(takenId.toHexString());
      expect(text).not.toContain(other.memberId.toHexString());
      expect(text).not.toContain('Người Chiếm Lịch');
    });

    it('US-28-TC05: PT có buổi COMPLETED giao giờ hoặc lớp PUBLISHED phủ một phần → 409 SLOT_UNAVAILABLE', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const other = await linkedMember('Người khác');
      const theirs = await insertPlan(other.memberId);
      await insertBooking(other.memberId, theirs, pt.trainerId, at(day, '08:00'), 'COMPLETED');
      await insertClass(pt.trainerId, day, '09:30', '10:30');

      expectError(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))), 409, 'SLOT_UNAVAILABLE');
      expectError(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00'))), 409, 'SLOT_UNAVAILABLE');
      expectError(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '10:00'))), 409, 'SLOT_UNAVAILABLE');
    });

    it('US-28-TC05: buổi CANCELLED cùng giờ không chặn → 201', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const other = await linkedMember('Người khác');
      const theirs = await insertPlan(other.memberId);
      await insertBooking(other.memberId, theirs, pt.trainerId, at(day, '08:00'), 'CANCELLED');
      await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))).expect(201);
    });

    it('US-28-TC05: hai Member gửi cùng lúc cùng slot trên hai instance → đúng một 201, người thua 409 SLOT_UNAVAILABLE', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const other = await linkedMember('Người thứ hai');
      const theirs = await insertPlan(other.memberId);

      const results = await Promise.all([
        book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00')), randomUUID(), app),
        book(other, bodyOf(theirs, pt.trainerId, shiftId, iso(day, '08:00')), randomUUID(), second),
      ]);

      expect(results.map(result => result.status).sort()).toEqual([201, 409]);
      expect(results.find(result => result.status === 409)!.body.error.code).toBe('SLOT_UNAVAILABLE');
      expect(await bookingCount({ trainer_id: pt.trainerId, status: 'BOOKED' })).toBe(1);
    });
  });

  describe('US-28-TC06: một Member đặt cùng giờ hai PT khác nhau', () => {
    it('US-28-TC06: Member đã có buổi với PT khác giao giờ → 409 MEMBER_TIME_CONFLICT', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const otherPt = await trainer('PT Khác');
      await insertBooking(me.memberId, membershipId, otherPt.trainerId, at(day, '08:30'));
      expectError(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))), 409, 'MEMBER_TIME_CONFLICT');
    });

    it('US-28-TC06: buổi của Member ở gói khác (cùng member) cũng tính → 409 MEMBER_TIME_CONFLICT', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const secondPlan = await insertPlan(me.memberId);
      const otherPt = await trainer('PT Khác');
      await insertBooking(me.memberId, secondPlan, otherPt.trainerId, at(day, '08:00'));
      expectError(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))), 409, 'MEMBER_TIME_CONFLICT');
    });

    it('US-28-TC06: gửi cùng lúc hai PT cùng giờ → một BOOKED, cái còn lại 409 MEMBER_TIME_CONFLICT', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const otherPt = await trainer('PT Khác');
      const otherShift = await insertShift(otherPt.trainerId, day, '08:00', '10:00');

      const results = await Promise.all([
        book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00')), randomUUID(), app),
        book(me, bodyOf(membershipId, otherPt.trainerId, otherShift, iso(day, '08:00')), randomUUID(), second),
      ]);

      expect(results.map(result => result.status).sort()).toEqual([201, 409]);
      expect(results.find(result => result.status === 409)!.body.error.code).toBe('MEMBER_TIME_CONFLICT');
      expect(await bookingCount({ member_id: me.memberId, status: 'BOOKED' })).toBe(1);
    });
  });

  describe('US-28-TC07: một quota còn 1, đặt hai giờ khác nhau', () => {
    it('US-28-TC07: used + BOOKED = quota (BOOKED quá giờ vẫn giữ) → 409 QUOTA_EXHAUSTED', async () => {
      const { me, membershipId, pt, shiftId } = await ready({ quota: 10, used: 9 });
      await insertBooking(me.memberId, membershipId, pt.trainerId, at(vnDay(-2), '08:00'));
      await expectRejected(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))), 409, 'QUOTA_EXHAUSTED');
    });

    it('US-28-TC07: dữ liệu âm (used > quota) → 409 QUOTA_EXHAUSTED, chặn ghi', async () => {
      const { me, membershipId, pt, shiftId } = await ready({ quota: 10, used: 11 });
      expectError(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))), 409, 'QUOTA_EXHAUSTED');
      expect(await bookingCount()).toBe(0);
    });

    it('US-28-TC07: còn 1 buổi, gửi cùng lúc hai giờ khác nhau → đúng một 201, một 409 QUOTA_EXHAUSTED; used + BOOKED ≤ quota', async () => {
      const { me, membershipId, pt, shiftId } = await ready({ quota: 10, used: 9 });

      const results = await Promise.all([
        book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00')), randomUUID(), app),
        book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '10:00')), randomUUID(), second),
      ]);

      expect(results.map(result => result.status).sort()).toEqual([201, 409]);
      expect(results.find(result => result.status === 409)!.body.error.code).toBe('QUOTA_EXHAUSTED');
      const quota = await reservedOf(me, membershipId);
      expect(quota.sessionsUsed + quota.sessionsReserved).toBeLessThanOrEqual(10);
    });
  });

  describe('US-28-TC08: writer ca cạnh tranh với đặt lịch dùng chung khóa lịch', () => {
    it('US-28-TC08: writer ca US-24 (tạo, sửa) và US-25 (công bố, hủy) đều ghi tăng khóa lịch đúng 1 mỗi lần (G02)', async () => {
      const pt = await trainer();
      const shiftDay = vnDay(12);
      const ptAuth = { accessToken: pt.accessToken };
      const call = (method: 'post' | 'patch', path: string, body: Record<string, unknown>) =>
        http()[method](path).set('Origin', origin).set('Authorization', `Bearer ${ptAuth.accessToken}`).set('Idempotency-Key', randomUUID()).send(body);

      let revision = Number(await guardRevision());
      const created = await call('post', '/api/me/work-shifts', { startAt: iso(shiftDay, '08:00'), endAt: iso(shiftDay, '10:00'), location: 'Phòng PT 1' }).expect(201);
      expect(Number(await guardRevision())).toBe(revision += 1);

      const updated = await call('patch', `/api/me/work-shifts/${created.body.id}`,
        { version: created.body.version, startAt: iso(shiftDay, '09:00'), endAt: iso(shiftDay, '11:00'), location: 'Phòng PT 2' }).expect(200);
      expect(Number(await guardRevision())).toBe(revision += 1);

      const confirmed = await call('post', `/api/me/work-shifts/${created.body.id}/confirm`, { version: updated.body.version }).expect(200);
      expect(Number(await guardRevision())).toBe(revision += 1);

      await call('post', `/api/me/work-shifts/${created.body.id}/cancel`, { version: confirmed.body.version, reason: 'PT bận việc gia đình đột xuất' }).expect(200);
      expect(Number(await guardRevision())).toBe(revision += 1);
    });

    it('US-28-TC08: hủy ca (US-25) và đặt lịch gửi cùng lúc, lặp nhiều lần → không bao giờ còn BOOKED trên ca đã CANCELLED', async () => {
      const { me, membershipId, pt } = await ready({ quota: 20 });
      for (let round = 0; round < 4; round += 1) {
        const shiftDay = vnDay(D + 1 + round);
        const shiftId = await insertShift(pt.trainerId, shiftDay, '08:00', '09:00');

        const [booking, cancelled] = await Promise.all([
          book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(shiftDay, '08:00')), randomUUID(), app),
          http(second).post(`/api/me/work-shifts/${shiftId.toHexString()}/cancel`).set('Origin', origin)
            .set('Authorization', `Bearer ${pt.accessToken}`).set('Idempotency-Key', randomUUID())
            .send({ version: 1, reason: 'PT bận việc gia đình đột xuất' }),
        ]);

        const shift = await db().collection('work_shifts').findOne({ _id: shiftId });
        const booked = await bookingCount({ shift_id: shiftId, status: 'BOOKED' });
        if (shift?.status === 'CANCELLED') {
          // Hủy thắng: đặt lịch phải bị từ chối vì ca không còn.
          expect(cancelled.status).toBe(200);
          expectError(booking, 409, 'SHIFT_UNAVAILABLE');
          expect(booked).toBe(0);
        } else {
          // Đặt thắng: hủy bị chặn vì ca còn BOOKED (US-25).
          expect(booking.status).toBe(201);
          expectError(cancelled, 409, 'SHIFT_HAS_BOOKINGS');
          expect(booked).toBe(1);
        }
      }
    });
  });

  // =====================================================================
  // AC03 – Idempotency, rollback (TC10–TC12) và biên thời gian (TC14)
  // =====================================================================

  describe('US-28-TC10: cùng key cùng payload trên hai instance, mất response', () => {
    it('US-28-TC10: gửi cùng lúc trên hai instance → cả hai 201 cùng body, đúng một booking và một operation', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const key = randomUUID();
      const body = bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'));

      const [one, two] = await Promise.all([book(me, body, key, app), book(me, body, key, second)]);

      expect(one.status).toBe(201);
      expect(two.status).toBe(201);
      expect(two.body).toEqual(one.body);
      expect(await bookingCount()).toBe(1);
      expect(await db().collection('operation_requests').countDocuments({ operation: 'PT_BOOKING_CREATE' })).toBe(1);
    });

    it('US-28-TC10: mất response rồi gửi lại đúng key → 201 cùng body gốc; tra cứu operation trả kết quả đã commit', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const key = randomUUID();
      const body = bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'));
      const first = await book(me, body, key).expect(201);

      const replay = await book(me, body, key, second);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);

      const lookup = await http().get(`/api/operations/PT_BOOKING_CREATE/${key}`).set('Origin', origin).set('Authorization', `Bearer ${me.accessToken}`).expect(200);
      expect(lookup.body.responseBody).toEqual(first.body);
      expect(await bookingCount()).toBe(1);
    });
  });

  describe('US-28-TC11: cùng key khác payload hoặc replay sau khóa account', () => {
    it('US-28-TC11: cùng key nhưng đổi startAt → 409 IDEMPOTENCY_CONFLICT, không tạo booking thứ hai', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const key = randomUUID();
      await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00')), key).expect(201);

      expectError(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00')), key), 409, 'IDEMPOTENCY_CONFLICT');
      expect(await bookingCount()).toBe(1);
    });

    it('US-28-TC11: replay đúng key sau khi account bị khóa → 401, không lộ kết quả cũ', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const key = randomUUID();
      const body = bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'));
      const first = await book(me, body, key).expect(201);
      await db().collection('accounts').updateOne({ _id: me.accountId }, { $set: { status: 'LOCKED' } });

      const replay = await book(me, body, key);

      expectError(replay, 401);
      expect(JSON.stringify(replay.body)).not.toContain(first.body.id);
    });

    it('US-28-TC11: Member khác tra cứu key của mình → 404, không thấy kết quả', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const key = randomUUID();
      await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00')), key).expect(201);
      const other = await linkedMember('Người khác');
      const lookup = await http().get(`/api/operations/PT_BOOKING_CREATE/${key}`).set('Origin', origin).set('Authorization', `Bearer ${other.accessToken}`);
      expectError(lookup, 404);
    });
  });

  describe('US-28-TC12: lỗi insert trước commit', () => {
    it.each(['operation_requests', 'pt_bookings'])('US-28-TC12: insert vào %s lỗi → 503, rollback: không booking, khóa lịch/member và quota giữ nguyên', async collection => {
      const { me, membershipId, pt, shiftId } = await ready();
      const guardBefore = await guardRevision();
      const memberBefore = await memberRevision(me.memberId);
      const quotaBefore = await reservedOf(me, membershipId);

      let response!: request.Response;
      await failInsertsOn(collection, async () => {
        response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00')));
      });

      expect(response.status).toBe(503);
      expect(JSON.stringify(response.body)).not.toMatch(/Giả lập DB lỗi|MongoServerError/);
      expect(await bookingCount()).toBe(0);
      expect(await guardRevision()).toBe(guardBefore);
      expect(await memberRevision(me.memberId)).toBe(memberBefore);
      expect(await reservedOf(me, membershipId)).toEqual(quotaBefore);
    });
  });

  describe('US-28-TC14: ngày cuối, UTC khác VN, lớp phủ một phần và tiếp giáp', () => {
    it('US-28-TC14: buổi 20:00 đúng ngày cuối của gói → 201; buổi ngày hôm sau → 409 MEMBERSHIP_NOT_ELIGIBLE', async () => {
      const { me, membershipId, pt } = await ready({ endDay: D });
      const lastDayShift = await insertShift(pt.trainerId, day, '20:00', '21:00');
      const nextDay = vnDay(D + 1);
      const nextDayShift = await insertShift(pt.trainerId, nextDay, '08:00', '09:00');

      await book(me, bodyOf(membershipId, pt.trainerId, lastDayShift, iso(day, '20:00'))).expect(201);
      expectError(await book(me, bodyOf(membershipId, pt.trainerId, nextDayShift, iso(nextDay, '08:00'))), 409, 'MEMBERSHIP_NOT_ELIGIBLE');
    });

    it('US-28-TC14: buổi 00:00–01:00 VN ngày bắt đầu gói (UTC còn là hôm trước) → 201', async () => {
      const { me, membershipId, pt } = await ready({ startDay: D, endDay: D + 30 });
      const midnightShift = await insertShift(pt.trainerId, day, '00:00', '02:00');
      const response = await book(me, bodyOf(membershipId, pt.trainerId, midnightShift, iso(day, '00:00')));
      expect(response.status).toBe(201);
      expect(new Date(response.body.startAt).toISOString()).toBe(at(day, '00:00').toISOString());
    });

    it('US-28-TC14: buổi tiếp giáp buổi BOOKED có sẵn của cùng PT và của chính Member → 201', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const other = await linkedMember('Người khác');
      const theirs = await insertPlan(other.memberId);
      await insertBooking(other.memberId, theirs, pt.trainerId, at(day, '08:00'));
      const otherPt = await trainer('PT Khác');
      await insertBooking(me.memberId, membershipId, otherPt.trainerId, at(day, '10:00'));

      await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00'))).expect(201);
    });

    it('US-28-TC14: lớp kết thúc đúng lúc slot bắt đầu (tiếp giáp) không chặn; lớp phủ một phần thì chặn', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      await insertClass(pt.trainerId, day, '07:00', '08:00');
      await insertClass(pt.trainerId, day, '10:30', '11:30');

      await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '08:00'))).expect(201);
      expectError(await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '10:00'))), 409, 'SLOT_UNAVAILABLE');
    });
  });
});
