// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-30 bước 1.
// Kiểm tra API danh sách học viên của PT: quan hệ suy từ booking BOOKED/COMPLETED, distinct trước phân trang, tìm kiếm literal (TC01–TC05, TC08, TC11).
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
// Hợp đồng test đặt ra cho Builder (US-30 bước 1, theo F01, F02, F05 và mục 2 của spec):
//   GET /api/me/trainees?q?&hasUpcoming?&page?&limit?
//        -> chỉ TRAINER (vai trò khác 403, phiên không hợp lệ 401).
//        200 {profileLinked, items, page, limit, total, totalPages}; page mặc định 1, limit 20, tối đa 100; rỗng totalPages=0.
//        PT chưa có hồ sơ trainers (chưa link) -> 200 profileLinked=false, items=[], total=0.
//        Mỗi item: {memberId, memberCode, fullName, nextBookingAt?, lastCompletedAt?, relatedBookingCount, hasUpcoming}.
//   Học viên = distinct pt_bookings.member_id có ít nhất một booking BOOKED hoặc COMPLETED với trainer của principal.
//   Chỉ CANCELLED thì không có trong danh sách. BOOKED quá giờ vẫn là quan hệ, GET không tự đổi trạng thái.
//   Sắp theo fullName rồi memberId ASC. Distinct trước khi phân trang; total đếm member, không đếm booking.
//   q: trim, tối đa 120 ký tự, tìm theo tên hoặc memberCode như chuỗi thường (literal), chỉ trong tập học viên của PT.
//   Query ngoài allowlist (trainerId, memberId...) -> 400.
//   US-23/US-28 chưa đủ dữ liệu mẫu -> test ghi thẳng trainers, members, memberships, pt_bookings vào DB.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us30_list';
const password = 'MậtKhẩuUS-30-123';
const base = '/api/me/trainees';
const ITEM_FIELDS = ['fullName', 'hasUpcoming', 'lastCompletedAt', 'memberCode', 'memberId', 'nextBookingAt', 'relatedBookingCount'];

type Auth = { accessToken: string };
type Pt = Auth & { trainerId: ObjectId };
type Trainee = { memberId: ObjectId; membershipId: ObjectId; memberCode: string; fullName: string };
type Item = Record<string, unknown> & { memberId: string; fullName: string; relatedBookingCount: number; hasUpcoming: boolean };

describe('US-30 bước 1: danh sách học viên của PT', () => {
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
      SMTP_USER: 'us30-test', SMTP_PASS: 'us30-test', SMTP_FROM: 'no-reply@gym.test',
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
  // Ngày VN (YYYY-MM-DD) cách hôm nay `days` ngày (âm = quá khứ).
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const at = (days: number, hhmm = '08:00') => new Date(`${vnDay(days)}T${hhmm}:00+07:00`);

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN', fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0913000${String(phoneSeq).padStart(3, '0')}`;
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

  // Hồ sơ hội viên mẫu (khuôn US-09) + một gói PT ACTIVE (thay US-14/22). Hội viên không cần tài khoản để là học viên.
  let memberSeq = 0;
  async function trainee(fullName: string, memberCode?: string): Promise<Trainee> {
    memberSeq += 1;
    const memberId = new ObjectId();
    const code = memberCode ?? `HV30-${String(memberSeq).padStart(4, '0')}`;
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: code, full_name: fullName,
      phone: `0988${String(memberSeq).padStart(6, '0')}`, email: `hv${memberSeq}@gym.test`, address: '12 Nguyen Trai',
      version: 0, service_revision: 0n, created_by: staffId, updated_by: staffId,
    });
    const membershipId = await insertPtMembership(memberId);
    return { memberId, membershipId, memberCode: code, fullName };
  }

  async function insertPtMembership(memberId: ObjectId, quota = 10, used = 0) {
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const staffId = new ObjectId();
    const now = new Date();
    const money = Decimal128.fromString('3000000');
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US30-${planId.toHexString()}`, name: `Goi PT ${quota} buoi`, kind: 'PT', duration_days: 60,
      session_quota: quota, price: money, benefits: `${quota} buoi PT`, status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US30-${transactionId.toHexString()}`, kind: 'PT',
      amount_due: money, status: 'SETTLED', request_key: `us30-key-${transactionId.toHexString()}`, created_at: now,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: vnDay(-30), end_date: vnDay(30), plan_name_snapshot: `Goi PT ${quota} buoi`, benefits_snapshot: `${quota} buoi PT`,
      list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: quota,
      policy_snapshot: 'Gia niem yet, 60 ngay', created_at: now,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: used,
    });
    return membershipId;
  }

  // Buổi PT mẫu (thay US-28): khuôn mục 4.2.13 + phần US-28 bổ sung (member_id, snapshot, version).
  async function insertBooking(member: Trainee, trainerId: ObjectId, start: Date, status: 'BOOKED' | 'COMPLETED' | 'CANCELLED' = 'BOOKED') {
    const id = new ObjectId();
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const doc: Record<string, unknown> = {
      _id: id, id, membership_id: member.membershipId, member_id: member.memberId, trainer_id: trainerId,
      shift_id: new ObjectId(), start_at: start, end_at: end, status,
      request_key: `us30-booking-${id.toHexString()}`, version: 0,
      trainer_name_snapshot: 'PT Tran Van Binh', location_snapshot: 'Phong PT 1',
      created_by: new ObjectId(), created_at: new Date(), updated_at: new Date(),
    };
    if (status === 'COMPLETED') doc.completed_at = end;
    if (status === 'CANCELLED') Object.assign(doc, { cancelled_at: new Date(), cancelled_by: new ObjectId(), cancelled_reason: 'Hoc vien ban viec' });
    await db().collection('pt_bookings').insertOne(doc);
    return id;
  }

  function list(user: Auth, query: Record<string, string | number> = {}) {
    return http().get(base).query(query).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }
  const memberIds = (body: { items: Item[] }) => body.items.map(item => item.memberId);
  const itemOf = (body: { items: Item[] }, member: Trainee) => body.items.find(item => item.memberId === member.memberId.toHexString());

  function expectError(response: request.Response, status: number) {
    expect(response.status).toBe(status);
    expect(typeof response.body.error?.code).toBe('string');
    expect(typeof response.body.error?.message).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
  }

  // =====================================================================
  // AC01 – Quan hệ từ booking và distinct đúng (TC01–TC04)
  // =====================================================================

  describe('US-30-TC01: member có nhiều BOOKED/COMPLETED cùng PT', () => {
    it('US-30-TC01: nhiều buổi cùng PT → đúng một dòng member, relatedBookingCount đếm BOOKED và COMPLETED', async () => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen');
      await insertBooking(an, pt.trainerId, at(3), 'BOOKED');
      await insertBooking(an, pt.trainerId, at(7), 'BOOKED');
      await insertBooking(an, pt.trainerId, at(-2), 'COMPLETED');

      const response = await list(pt).expect(200);

      expect(response.body).toMatchObject({ profileLinked: true, page: 1, limit: 20, total: 1, totalPages: 1 });
      expect(memberIds(response.body)).toEqual([an.memberId.toHexString()]);
      expect(response.body.items[0]).toMatchObject({
        memberId: an.memberId.toHexString(), memberCode: an.memberCode, fullName: 'Anh Nguyen', relatedBookingCount: 3, hasUpcoming: true,
      });
    });

    it('US-30-TC01: nextBookingAt là buổi BOOKED sắp tới sớm nhất, lastCompletedAt thuộc buổi COMPLETED gần nhất', async () => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen');
      const soonest = at(3, '09:00');
      await insertBooking(an, pt.trainerId, at(7, '07:00'), 'BOOKED');
      await insertBooking(an, pt.trainerId, soonest, 'BOOKED');
      await insertBooking(an, pt.trainerId, at(-5), 'COMPLETED');
      const latestCompletedStart = at(-2);
      await insertBooking(an, pt.trainerId, latestCompletedStart, 'COMPLETED');

      const item = itemOf((await list(pt).expect(200)).body, an)!;

      expect(item.nextBookingAt).toBe(soonest.toISOString());
      // lastCompletedAt có thể là giờ bắt đầu hoặc giờ hoàn tất của buổi COMPLETED gần nhất; cả hai đều >= startAt buổi đó.
      expect(Date.parse(String(item.lastCompletedAt))).toBeGreaterThanOrEqual(latestCompletedStart.getTime());
    });

    it('US-30-TC01: member chưa có buổi sắp tới → hasUpcoming=false, nextBookingAt rỗng; chưa COMPLETED → lastCompletedAt rỗng', async () => {
      const pt = await trainer();
      const done = await trainee('Binh Tran');
      const upcoming = await trainee('Chi Le');
      await insertBooking(done, pt.trainerId, at(-4), 'COMPLETED');
      await insertBooking(upcoming, pt.trainerId, at(2), 'BOOKED');

      const body = (await list(pt).expect(200)).body;

      expect(itemOf(body, done)).toMatchObject({ hasUpcoming: false, relatedBookingCount: 1 });
      expect(itemOf(body, done)!.nextBookingAt ?? null).toBeNull();
      expect(itemOf(body, upcoming)).toMatchObject({ hasUpcoming: true, relatedBookingCount: 1 });
      expect(itemOf(body, upcoming)!.lastCompletedAt ?? null).toBeNull();
    });

    it('US-30-TC01: item chỉ gồm các field trong hợp đồng, không có phone/email/address', async () => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen');
      await insertBooking(an, pt.trainerId, at(3), 'BOOKED');

      const response = await list(pt).expect(200);

      for (const key of Object.keys(response.body.items[0])) expect(ITEM_FIELDS).toContain(key);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain('0988');
      expect(text).not.toContain('@gym.test');
      expect(text).not.toContain('Nguyen Trai');
    });

    it('US-30-TC01: sắp theo fullName rồi memberId tăng dần', async () => {
      const pt = await trainer();
      const chi = await trainee('Chi Le');
      const an = await trainee('Anh Nguyen');
      const binh = await trainee('Binh Tran');
      for (const member of [chi, an, binh]) await insertBooking(member, pt.trainerId, at(3), 'BOOKED');

      const response = await list(pt).expect(200);

      expect(response.body.items.map((item: Item) => item.fullName)).toEqual(['Anh Nguyen', 'Binh Tran', 'Chi Le']);
    });

    it('US-30-TC01: hai member trùng tên → sắp tiếp theo memberId tăng dần', async () => {
      const pt = await trainer();
      const first = await trainee('Dung Pham');
      const second = await trainee('Dung Pham');
      await insertBooking(second, pt.trainerId, at(3), 'BOOKED');
      await insertBooking(first, pt.trainerId, at(4), 'BOOKED');

      const response = await list(pt).expect(200);

      const expected = [first.memberId.toHexString(), second.memberId.toHexString()].sort();
      expect(memberIds(response.body)).toEqual(expected);
    });

    it('US-30-TC01: distinct trước phân trang: member nhiều buổi vẫn chỉ chiếm một dòng, total đếm member', async () => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen');
      const binh = await trainee('Binh Tran');
      const chi = await trainee('Chi Le');
      for (let day = 1; day <= 5; day += 1) await insertBooking(an, pt.trainerId, at(day), 'BOOKED');
      await insertBooking(binh, pt.trainerId, at(2), 'BOOKED');
      await insertBooking(chi, pt.trainerId, at(-1), 'COMPLETED');

      const page1 = await list(pt, { page: 1, limit: 2 }).expect(200);
      const page2 = await list(pt, { page: 2, limit: 2 }).expect(200);

      expect(page1.body).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(memberIds(page1.body)).toEqual([an.memberId.toHexString(), binh.memberId.toHexString()]);
      expect(page2.body).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
      expect(memberIds(page2.body)).toEqual([chi.memberId.toHexString()]);
    });

    it('US-30-TC01: limit tối đa 100 hợp lệ', async () => {
      const pt = await trainer();
      const response = await list(pt, { limit: 100 }).expect(200);
      expect(response.body.limit).toBe(100);
    });

    it.each([
      ['limit vượt 100', { limit: 101 }],
      ['limit bằng 0', { limit: 0 }],
      ['page bằng 0', { page: 0 }],
      ['page không phải số', { page: 'abc' }],
    ])('US-30-TC01: %s → 400', async (_name, query) => {
      const pt = await trainer();
      expectError(await list(pt, query), 400);
    });

    it('US-30-TC01: hasUpcoming=true chỉ trả học viên có buổi BOOKED sắp tới; false trả phần còn lại', async () => {
      const pt = await trainer();
      const upcoming = await trainee('Anh Nguyen');
      const history = await trainee('Binh Tran');
      await insertBooking(upcoming, pt.trainerId, at(3), 'BOOKED');
      await insertBooking(history, pt.trainerId, at(-3), 'COMPLETED');

      const onlyUpcoming = await list(pt, { hasUpcoming: 'true' }).expect(200);
      const notUpcoming = await list(pt, { hasUpcoming: 'false' }).expect(200);

      expect(memberIds(onlyUpcoming.body)).toEqual([upcoming.memberId.toHexString()]);
      expect(onlyUpcoming.body.total).toBe(1);
      expect(memberIds(notUpcoming.body)).toEqual([history.memberId.toHexString()]);
      expect(notUpcoming.body.total).toBe(1);
    });

    it('US-30-TC01: hasUpcoming sai giá trị → 400', async () => {
      const pt = await trainer();
      expectError(await list(pt, { hasUpcoming: 'co' }), 400);
    });
  });

  describe('US-30-TC02: PT không có booking; chỉ có CANCELLED', () => {
    it('US-30-TC02: PT chưa có booking nào → 200 items=[], total=0, totalPages=0, profileLinked=true', async () => {
      const pt = await trainer();
      await trainee('Anh Nguyen'); // có hội viên trong hệ thống nhưng không có booking với PT

      const response = await list(pt).expect(200);

      expect(response.body).toMatchObject({ profileLinked: true, items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
    });

    it('US-30-TC02: member chỉ có booking CANCELLED với PT → không có trong danh sách', async () => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen');
      await insertBooking(an, pt.trainerId, at(3), 'CANCELLED');
      await insertBooking(an, pt.trainerId, at(-3), 'CANCELLED');

      const response = await list(pt).expect(200);

      expect(response.body).toMatchObject({ items: [], total: 0, totalPages: 0 });
    });

    it('US-30-TC02: member có CANCELLED và một BOOKED → có trong danh sách, CANCELLED không được đếm', async () => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen');
      await insertBooking(an, pt.trainerId, at(2), 'CANCELLED');
      await insertBooking(an, pt.trainerId, at(4), 'BOOKED');

      const response = await list(pt).expect(200);

      expect(memberIds(response.body)).toEqual([an.memberId.toHexString()]);
      expect(response.body.items[0].relatedBookingCount).toBe(1);
    });
  });

  describe('US-30-TC03: memberId hoặc trainerId giả trong query', () => {
    it('US-30-TC03: truyền trainerId của PT khác trong query → 400, không mở danh sách PT kia', async () => {
      const me = await trainer('PT Mot');
      const other = await trainer('PT Hai');
      const an = await trainee('Anh Nguyen');
      await insertBooking(an, other.trainerId, at(3), 'BOOKED');

      const response = await list(me, { trainerId: other.trainerId.toHexString() });

      expectError(response, 400);
      expect(JSON.stringify(response.body)).not.toContain(an.memberId.toHexString());
    });

    it('US-30-TC03: truyền memberId trong query → 400 (field ngoài allowlist)', async () => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen');
      expectError(await list(pt, { memberId: an.memberId.toHexString() }), 400);
    });

    it('US-30-TC03: chỉ thấy học viên của chính mình, không thấy member của PT khác hay member toàn hệ thống', async () => {
      const me = await trainer('PT Mot');
      const other = await trainer('PT Hai');
      const mine = await trainee('Anh Nguyen');
      const theirs = await trainee('Binh Tran');
      await trainee('Chi Le'); // hội viên không có booking với ai
      await insertBooking(mine, me.trainerId, at(3), 'BOOKED');
      await insertBooking(theirs, other.trainerId, at(3), 'BOOKED');

      const response = await list(me).expect(200);

      expect(memberIds(response.body)).toEqual([mine.memberId.toHexString()]);
      expect(response.body.total).toBe(1);
      expect(JSON.stringify(response.body)).not.toContain(theirs.memberId.toHexString());
    });
  });

  describe('US-30-TC04: sai role, session cũ hoặc PT chưa link', () => {
    it.each(['MEMBER', 'STAFF', 'ADMIN'] as const)('US-30-TC04: %s gọi danh sách học viên → 403', async role => {
      const owner = await account(role, `Nguoi dung ${role}`);
      const actor = { accessToken: await loginAs(owner.phone) };
      expectError(await list(actor), 403);
    });

    it('US-30-TC04: không gửi token → 401', async () => {
      expectError(await http().get(base).set('Origin', origin), 401);
    });

    it('US-30-TC04: token của phiên đã đăng xuất → 401', async () => {
      const pt = await trainer();
      await list(pt).expect(200);
      await http().post('/api/auth/logout').set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`).send({}).expect(204);

      expectError(await list(pt), 401);
    });

    it('US-30-TC04: tài khoản TRAINER chưa có hồ sơ trainers → 200 profileLinked=false, items rỗng', async () => {
      const owner = await account('TRAINER', 'PT Chua Lien Ket');
      const actor = { accessToken: await loginAs(owner.phone) };

      const response = await list(actor).expect(200);

      expect(response.body).toMatchObject({ profileLinked: false, items: [], total: 0, totalPages: 0 });
    });
  });

  // =====================================================================
  // AC02 – phần danh sách: mỗi PT chỉ thấy buổi của mình (TC05), tìm kiếm literal (TC08)
  // =====================================================================

  describe('US-30-TC05: member có lịch với hai PT (phần danh sách)', () => {
    it('US-30-TC05: mỗi PT chỉ đếm và lấy nextBookingAt từ buổi của mình', async () => {
      const ptA = await trainer('PT Mot');
      const ptB = await trainer('PT Hai');
      const an = await trainee('Anh Nguyen');
      const bSoon = at(1, '07:00');
      const aLater = at(5, '10:00');
      await insertBooking(an, ptB.trainerId, bSoon, 'BOOKED');
      await insertBooking(an, ptB.trainerId, at(2), 'BOOKED');
      await insertBooking(an, ptA.trainerId, aLater, 'BOOKED');

      const forA = itemOf((await list(ptA).expect(200)).body, an)!;
      const forB = itemOf((await list(ptB).expect(200)).body, an)!;

      expect(forA).toMatchObject({ relatedBookingCount: 1, nextBookingAt: aLater.toISOString() });
      expect(forB).toMatchObject({ relatedBookingCount: 2, nextBookingAt: bSoon.toISOString() });
    });

    it('US-30-TC05: PT A chỉ có COMPLETED, PT B còn BOOKED sắp tới → với PT A hasUpcoming=false', async () => {
      const ptA = await trainer('PT Mot');
      const ptB = await trainer('PT Hai');
      const an = await trainee('Anh Nguyen');
      await insertBooking(an, ptA.trainerId, at(-3), 'COMPLETED');
      await insertBooking(an, ptB.trainerId, at(3), 'BOOKED');

      const forA = itemOf((await list(ptA).expect(200)).body, an)!;

      expect(forA.hasUpcoming).toBe(false);
      expect(forA.nextBookingAt ?? null).toBeNull();
    });
  });

  describe('US-30-TC08: tìm kiếm chứa regex/HTML (phần danh sách)', () => {
    it('US-30-TC08: q tìm theo một phần tên, không phân biệt hoa thường, trim khoảng trắng hai đầu', async () => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen');
      const binh = await trainee('Binh Tran');
      await insertBooking(an, pt.trainerId, at(3), 'BOOKED');
      await insertBooking(binh, pt.trainerId, at(3), 'BOOKED');

      const response = await list(pt, { q: '  nguyen  ' }).expect(200);

      expect(memberIds(response.body)).toEqual([an.memberId.toHexString()]);
      expect(response.body.total).toBe(1);
    });

    it('US-30-TC08: q tìm theo memberCode', async () => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen', 'HV30-AAA1');
      const binh = await trainee('Binh Tran', 'HV30-BBB2');
      await insertBooking(an, pt.trainerId, at(3), 'BOOKED');
      await insertBooking(binh, pt.trainerId, at(3), 'BOOKED');

      const response = await list(pt, { q: 'BBB2' }).expect(200);

      expect(memberIds(response.body)).toEqual([binh.memberId.toHexString()]);
    });

    it('US-30-TC08: q chỉ tìm trong học viên của PT, không trả hội viên khác trùng tên', async () => {
      const pt = await trainer();
      const mine = await trainee('Anh Nguyen');
      await trainee('Anh Nguyen Khac'); // trùng chữ nhưng không có booking với PT

      await insertBooking(mine, pt.trainerId, at(3), 'BOOKED');

      const response = await list(pt, { q: 'Anh Nguyen' }).expect(200);

      expect(memberIds(response.body)).toEqual([mine.memberId.toHexString()]);
      expect(response.body.total).toBe(1);
    });

    it('US-30-TC08: q là biểu thức regex ".*" được hiểu là chuỗi thường, không khớp mọi học viên', async () => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen');
      const dot = await trainee('Mr .* Star');
      await insertBooking(an, pt.trainerId, at(3), 'BOOKED');
      await insertBooking(dot, pt.trainerId, at(3), 'BOOKED');

      const response = await list(pt, { q: '.*' }).expect(200);

      expect(memberIds(response.body)).toEqual([dot.memberId.toHexString()]);
    });

    it.each(['(', '[a-', '\\', '^$|'])('US-30-TC08: q chứa ký tự regex lỗi "%s" → 200 rỗng, không 500', async q => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen');
      await insertBooking(an, pt.trainerId, at(3), 'BOOKED');

      const response = await list(pt, { q }).expect(200);

      expect(response.body).toMatchObject({ items: [], total: 0 });
    });

    it('US-30-TC08: tên chứa HTML được trả nguyên văn như chuỗi, q tìm literal thẻ HTML', async () => {
      const pt = await trainer();
      const html = await trainee('<b>Hoa</b><script>x()</script>');
      await insertBooking(html, pt.trainerId, at(3), 'BOOKED');

      const response = await list(pt, { q: '<script>' }).expect(200);

      expect(response.body.items[0].fullName).toBe('<b>Hoa</b><script>x()</script>');
    });

    it('US-30-TC08: q dài đúng 120 ký tự → 200; 121 ký tự → 400', async () => {
      const pt = await trainer();
      await list(pt, { q: 'a'.repeat(120) }).expect(200);
      expectError(await list(pt, { q: 'a'.repeat(121) }), 400);
    });
  });

  // =====================================================================
  // AC03 – phần danh sách: COMPLETED lịch sử, BOOKED quá giờ (TC11)
  // =====================================================================

  describe('US-30-TC11: chỉ còn COMPLETED lịch sử hoặc BOOKED quá giờ', () => {
    it('US-30-TC11: member chỉ còn COMPLETED lịch sử → vẫn là học viên', async () => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen');
      await insertBooking(an, pt.trainerId, at(-20), 'COMPLETED');
      await insertBooking(an, pt.trainerId, at(5), 'CANCELLED');

      const response = await list(pt).expect(200);

      expect(memberIds(response.body)).toEqual([an.memberId.toHexString()]);
      expect(response.body.items[0]).toMatchObject({ relatedBookingCount: 1, hasUpcoming: false });
    });

    it('US-30-TC11: BOOKED đã quá giờ chưa xử lý → vẫn là học viên; GET không tự đổi trạng thái booking', async () => {
      const pt = await trainer();
      const an = await trainee('Anh Nguyen');
      const overdue = await insertBooking(an, pt.trainerId, at(-2), 'BOOKED');

      const response = await list(pt).expect(200);

      expect(memberIds(response.body)).toEqual([an.memberId.toHexString()]);
      const stored = await db().collection('pt_bookings').findOne({ _id: overdue });
      expect(stored?.status).toBe('BOOKED');
      expect(stored?.completed_at).toBeUndefined();
      expect(stored?.version).toBe(0);
    });
  });
});
