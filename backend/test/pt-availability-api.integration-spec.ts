// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-27 bước 1.
// Kiểm tra API Member xem slot trống của PT: sinh slot 60 phút từ ca CONFIRMED, loại khoảng PT bận và khoảng Member bận (TC01–TC04).
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
// Hợp đồng test đặt ra cho Builder (US-27 bước 1, theo mục 1 F01–F04 và mục 2 của spec):
//   GET /api/me/pt-trainers                  -> MEMBER; 200 {items:[{id,displayName,specialty}], page, limit, total, totalPages}
//        chỉ PT khả dụng: trainers.status ACTIVE, account ACTIVE, role TRAINER.
//   GET /api/me/pt-trainers/:id/availability -> MEMBER; query fromDate, toDate (ngày VN YYYY-MM-DD), membershipId?;
//        200 {trainerId, memberLinked, asOf, slots:[{shiftId,startAt,endAt,location,bookable,reason?}]}.
//        PT không khả dụng -> 404 TRAINER_NOT_AVAILABLE.
//   Slot: chỉ từ ca CONFIRMED; start = shift.startAt + k×60 phút, end = start + 60 phút, end ≤ shift.endAt; location lấy từ ca.
//   "Loại" slot = slot KHÔNG xuất hiện trong mảng slots. Overlap khi a.start < b.end và b.start < a.end; tiếp giáp không giao.
//   Khoảng bận: lớp public_sessions PUBLISHED và pt_bookings BOOKED/COMPLETED của cùng trainer;
//        với Member đã link: thêm pt_bookings BOOKED/COMPLETED của chính member trên mọi PT.
//   US-23 (PT), US-28 (booking) chưa có -> test ghi thẳng trainers, work_shifts, public_sessions, pt_bookings vào DB.
//   pt_bookings ghi cả member_id (US-28 bổ sung) lẫn membership_id có chuỗi sale -> member đúng chủ, để dữ liệu nhất quán.
//   Mọi ca/lớp đặt ở ngày VN cách hôm nay 10 ngày nên luôn sau "now".

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us27_api';
const password = 'MậtKhẩuUS-27-123';

type Auth = { accessToken: string };
type Slot = { shiftId: string; startAt: string; endAt: string; location: string; bookable: boolean; reason?: string };

describe('US-27 bước 1: Member xem slot trống của PT', () => {
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
  const day = vnDay(10);
  const at = (hhmm: string) => new Date(`${day}T${hhmm}:00+07:00`);
  const iso = (hhmm: string) => at(hhmm).toISOString();

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: 'MEMBER' | 'TRAINER' | 'STAFF', fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0912700${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: created.id, phone };
  }

  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }

  // PT mẫu (thay US-23): account (mặc định TRAINER) + hồ sơ trainers.
  async function trainer(options: { name?: string; status?: string; roleCode?: 'TRAINER' | 'STAFF' } = {}) {
    const owner = await account(options.roleCode ?? 'TRAINER', options.name ?? 'PT Trần Văn Bình');
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: owner.accountId, specialty: 'Thể hình', status: options.status ?? 'ACTIVE',
      version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: owner.accountId };
  }

  // Ca làm việc mẫu (US-24/25 đã có, ghi thẳng cho gọn).
  async function insertShift(trainerId: ObjectId, from: string, to: string, status = 'CONFIRMED', location = 'Phòng PT 1') {
    const id = new ObjectId();
    const now = new Date();
    await db().collection('work_shifts').insertOne({
      _id: id, id, trainer_id: trainerId, start_at: at(from), end_at: at(to), location, status, version: 1,
      created_by: new ObjectId(), updated_by: new ObjectId(), created_at: now, updated_at: now,
    });
    return id.toHexString();
  }

  // Lớp miễn phí mẫu (thay US-66), field như test US-26.
  async function insertClass(trainerId: ObjectId, from: string, to: string, status = 'PUBLISHED') {
    const id = new ObjectId();
    const now = new Date();
    const adminId = new ObjectId();
    await db().collection('public_sessions').insertOne({
      _id: id, id, trainer_id: trainerId, title: 'Yoga buổi sáng', subject_code: 'YOGA', location: 'Phòng 1',
      start_at: at(from), end_at: at(to), status, version: 1, created_at: now, updated_at: now,
      created_by: adminId, updated_by: adminId, ...(status === 'PUBLISHED' ? { published_at: now } : {}),
    });
  }

  // Member có tài khoản đã liên kết hồ sơ (khuôn US-09) và một gói PT đã thu tiền (thay US-14/22).
  let memberSeq = 0;
  async function linkedMember() {
    memberSeq += 1;
    const owner = await account('MEMBER', `Hội viên US27 ${memberSeq}`);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: `Hội viên US27 ${memberSeq}`,
      phone: owner.phone, account_id: owner.accountId, version: 0, service_revision: 0n, created_by: staffId, updated_by: staffId,
    });
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const now = new Date();
    const money = Decimal128.fromString('3000000');
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US27-${memberSeq}`, name: 'Gói PT 10 buổi', kind: 'PT', duration_days: 60,
      session_quota: 10, price: money, benefits: '10 buổi PT', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US27-${memberSeq}`, kind: 'PT',
      amount_due: money, status: 'SETTLED', request_key: `us27-key-${transactionId.toHexString()}`, created_at: now,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: vnDay(0), end_date: vnDay(59), plan_name_snapshot: 'Gói PT 10 buổi', benefits_snapshot: '10 buổi PT',
      list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: 10,
      policy_snapshot: 'Giá niêm yết, 60 ngày', created_at: now,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: 0,
    });
    const accessToken = await loginAs(owner.phone);
    return { accessToken, memberId, membershipId };
  }

  // Buổi PT mẫu (thay US-28): khuôn mục 4.2.13 + phần US-28 bổ sung (member_id, snapshot, version).
  async function insertBooking(
    owner: { memberId: ObjectId; membershipId: ObjectId }, trainerId: ObjectId, from: string, to: string,
    status: 'BOOKED' | 'COMPLETED' | 'CANCELLED' = 'BOOKED',
  ) {
    const id = new ObjectId();
    const doc: Record<string, unknown> = {
      _id: id, id, membership_id: owner.membershipId, member_id: owner.memberId, trainer_id: trainerId, shift_id: new ObjectId(),
      start_at: at(from), end_at: at(to), status, request_key: `us27-booking-${id.toHexString()}`, version: 0,
      trainer_name_snapshot: 'PT mẫu', location_snapshot: 'Phòng PT 1', created_at: new Date(), updated_at: new Date(),
    };
    if (status === 'COMPLETED') doc.completed_at = at(to);
    await db().collection('pt_bookings').insertOne(doc);
  }

  function availability(user: Auth, trainerId: ObjectId | string) {
    const id = typeof trainerId === 'string' ? trainerId : trainerId.toHexString();
    return http().get(`/api/me/pt-trainers/${id}/availability`).query({ fromDate: day, toDate: day })
      .set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }

  // Danh sách giờ bắt đầu slot, đổi về ISO UTC và sắp tăng dần để so sánh.
  async function slotStarts(user: Auth, trainerId: ObjectId) {
    const response = await availability(user, trainerId).expect(200);
    return (response.body.slots as Slot[]).map(slot => new Date(slot.startAt).toISOString()).sort();
  }

  function expectNotAvailable(response: request.Response) {
    expect(response.status).toBe(404);
    expect(response.body.error?.code).toBe('TRAINER_NOT_AVAILABLE');
    expect(typeof response.body.error?.message).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
  }

  // =====================================================================
  // AC01 – Slot đúng ca và khoảng bận (TC01–TC04)
  // =====================================================================

  describe('US-27-TC01: ca CONFIRMED 08:10–10:40, không bận', () => {
    it('US-27-TC01: sinh đúng hai slot 08:10–09:10 và 09:10–10:10 tính từ đầu ca, 30 phút dư không mở slot', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      const shiftId = await insertShift(pt.trainerId, '08:10', '10:40', 'CONFIRMED', 'Phòng PT 2');

      const response = await availability(me, pt.trainerId).expect(200);

      expect(response.body.trainerId).toBe(pt.trainerId.toHexString());
      expect(response.body.memberLinked).toBe(true);
      expect(Number.isNaN(Date.parse(response.body.asOf))).toBe(false);
      const slots = [...(response.body.slots as Slot[])].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
      expect(slots.map(slot => [new Date(slot.startAt).toISOString(), new Date(slot.endAt).toISOString()])).toEqual([
        [iso('08:10'), iso('09:10')],
        [iso('09:10'), iso('10:10')],
      ]);
      for (const slot of slots) {
        expect(slot.shiftId).toBe(shiftId);
        expect(slot.location).toBe('Phòng PT 2');
        expect(slot.startAt).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
        expect(typeof slot.bookable).toBe('boolean');
      }
    });
  });

  describe('US-27-TC02: ca SCHEDULED/CANCELLED hoặc PT/account không khả dụng', () => {
    it('US-27-TC02: ca SCHEDULED (chưa công bố) không sinh slot', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      await insertShift(pt.trainerId, '08:00', '10:00', 'SCHEDULED');
      expect(await slotStarts(me, pt.trainerId)).toEqual([]);
    });

    it('US-27-TC02: ca CANCELLED không sinh slot, ca CONFIRMED cùng PT vẫn sinh slot', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      await insertShift(pt.trainerId, '08:00', '10:00', 'CANCELLED');
      await insertShift(pt.trainerId, '14:00', '15:00', 'CONFIRMED');
      expect(await slotStarts(me, pt.trainerId)).toEqual([iso('14:00')]);
    });

    it('US-27-TC02: hồ sơ PT INACTIVE → 404 TRAINER_NOT_AVAILABLE dù có ca CONFIRMED', async () => {
      const me = await linkedMember();
      const pt = await trainer({ status: 'INACTIVE' });
      await insertShift(pt.trainerId, '08:00', '10:00');
      expectNotAvailable(await availability(me, pt.trainerId));
    });

    it('US-27-TC02: account của PT bị khóa (LOCKED) → 404 TRAINER_NOT_AVAILABLE', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      await insertShift(pt.trainerId, '08:00', '10:00');
      await db().collection('accounts').updateOne({ _id: pt.accountId }, { $set: { status: 'LOCKED' } });
      expectNotAvailable(await availability(me, pt.trainerId));
    });

    it('US-27-TC02: account gắn hồ sơ PT không còn role TRAINER → 404 TRAINER_NOT_AVAILABLE', async () => {
      const me = await linkedMember();
      const pt = await trainer({ roleCode: 'STAFF' });
      await insertShift(pt.trainerId, '08:00', '10:00');
      expectNotAvailable(await availability(me, pt.trainerId));
    });

    it('US-27-TC02: trainerId không tồn tại → 404 TRAINER_NOT_AVAILABLE', async () => {
      const me = await linkedMember();
      expectNotAvailable(await availability(me, new ObjectId()));
    });

    it('US-27-TC02: danh mục PT cho Member chỉ có PT khả dụng, không có PT INACTIVE/LOCKED/không còn role TRAINER', async () => {
      const me = await linkedMember();
      const ok = await trainer({ name: 'PT Khả Dụng' });
      const inactive = await trainer({ name: 'PT Ngừng', status: 'INACTIVE' });
      const locked = await trainer({ name: 'PT Bị Khóa' });
      await db().collection('accounts').updateOne({ _id: locked.accountId }, { $set: { status: 'LOCKED' } });
      const notTrainer = await trainer({ name: 'PT Đổi Role', roleCode: 'STAFF' });

      const response = await http().get('/api/me/pt-trainers').set('Origin', origin)
        .set('Authorization', `Bearer ${me.accessToken}`).expect(200);

      const ids = (response.body.items as { id: string }[]).map(item => item.id);
      expect(ids).toEqual([ok.trainerId.toHexString()]);
      for (const hidden of [inactive, locked, notTrainer]) {
        expect(JSON.stringify(response.body)).not.toContain(hidden.trainerId.toHexString());
      }
    });
  });

  describe('US-27-TC03: lớp 08:30–09:30 trên ca 08:00–11:00', () => {
    it('US-27-TC03: lớp PUBLISHED của cùng PT loại slot 08:00 và 09:00, chỉ còn slot 10:00', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      await insertShift(pt.trainerId, '08:00', '11:00');
      await insertClass(pt.trainerId, '08:30', '09:30');
      expect(await slotStarts(me, pt.trainerId)).toEqual([iso('10:00')]);
    });
  });

  describe('US-27-TC04: booking cùng PT, cùng Member trên PT khác và interval tiếp giáp', () => {
    it('US-27-TC04: booking BOOKED của Member khác trên cùng PT loại slot giao nhau', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const pt = await trainer();
      await insertShift(pt.trainerId, '08:00', '11:00');
      await insertBooking(other, pt.trainerId, '09:00', '10:00', 'BOOKED');
      expect(await slotStarts(me, pt.trainerId)).toEqual([iso('08:00'), iso('10:00')]);
    });

    it('US-27-TC04: booking COMPLETED trên cùng PT vẫn là giờ đã dùng, loại slot giao nhau', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const pt = await trainer();
      await insertShift(pt.trainerId, '08:00', '11:00');
      await insertBooking(other, pt.trainerId, '08:00', '09:00', 'COMPLETED');
      expect(await slotStarts(me, pt.trainerId)).toEqual([iso('09:00'), iso('10:00')]);
    });

    it('US-27-TC04: booking của chính Member trên PT khác loại slot giao nhau ở PT đang xem', async () => {
      const me = await linkedMember();
      const ptA = await trainer({ name: 'PT A' });
      const ptB = await trainer({ name: 'PT B' });
      await insertShift(ptA.trainerId, '08:00', '11:00');
      await insertBooking(me, ptB.trainerId, '08:30', '09:30', 'BOOKED');
      expect(await slotStarts(me, ptA.trainerId)).toEqual([iso('10:00')]);
    });

    it('US-27-TC04: booking của Member KHÁC trên PT khác không ảnh hưởng slot của mình', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const ptA = await trainer({ name: 'PT A' });
      const ptB = await trainer({ name: 'PT B' });
      await insertShift(ptA.trainerId, '08:00', '11:00');
      await insertBooking(other, ptB.trainerId, '08:00', '11:00', 'BOOKED');
      expect(await slotStarts(me, ptA.trainerId)).toEqual([iso('08:00'), iso('09:00'), iso('10:00')]);
    });

    it('US-27-TC04: booking tiếp giáp (kết thúc đúng lúc slot bắt đầu, bắt đầu đúng lúc slot kết thúc) không loại slot', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const pt = await trainer();
      await insertShift(pt.trainerId, '09:00', '10:00');
      // Hai booking nằm ngoài ca nhưng chạm đúng hai đầu slot 09:00–10:00.
      await insertBooking(other, pt.trainerId, '08:00', '09:00', 'BOOKED');
      await insertBooking(me, pt.trainerId, '10:00', '11:00', 'BOOKED');
      expect(await slotStarts(me, pt.trainerId)).toEqual([iso('09:00')]);
    });
  });
});
