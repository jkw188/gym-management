// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ + lệnh CLI thật): US-28 bước 2.
// Kiểm tra backfill booking cũ trong lệnh `ensure-indexes`: member_id lấy qua membership → sale → member có đối chiếu,
// snapshot tên PT/địa điểm, không đoán khi mồ côi, và phát hiện một Member có hai buổi trùng giờ (US-28-G01, G03, F04).
// Hợp đồng test đặt ra cho Builder (US-28 bước 2, theo "Thứ tự triển khai" bước 2 và bảng "pt_bookings bổ sung" mục 3;
// cùng cách đơn giản hóa sinh viên chốt 10/11 ở bước 1: dữ liệu vi phạm thì báo lỗi, người vận hành sửa tay rồi chạy lại):
//   node scripts/admin.cjs ensure-indexes, chạy TRƯỚC khi tạo guard lịch:
//   - Booking thiếu member_id → ghi member_id = service_sales.member_id của sale mà membership của booking trỏ tới.
//   - Booking đã có member_id: phải BẰNG member suy ra; khác → vi phạm (không ghi đè).
//   - Mồ côi (không tìm thấy membership, hoặc membership không có sale) → vi phạm, KHÔNG đoán member.
//   - Snapshot còn thiếu: trainer_name_snapshot = accounts.full_name của trainers.account_id; location_snapshot = work_shifts.location
//     của shift_id. Snapshot đã có giữ nguyên (lịch sử). Không tìm thấy nguồn → để trống, không phải vi phạm.
//   - Sau backfill: hai booking BOOKED/COMPLETED của CÙNG member giao nhau (trên mọi PT/membership) → vi phạm.
//   - Vi phạm → thoát mã khác 0, in SCHEDULE_DATA_INVALID, không tạo guard, KHÔNG sửa dữ liệu nào (kiểm hết rồi mới ghi).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Decimal128, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';

const databaseName = 'gym_management_test_us28_backfill';

describe('US-28 bước 2: backfill member_id/snapshot cho booking cũ', () => {
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
      NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: 'http://localhost:5173', MONGODB_URI: mongo.getUri(), MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'us28-test', SMTP_PASS: 'us28-test', SMTP_FROM: 'no-reply@gym.test',
    });
    // Khởi động app trước (tạo collection/index các module đã có) rồi mới chạy lệnh CLI, như scheduling-migration.
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    for (const collection of await db().collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    await db().collection('schedule_guards').drop().catch(() => undefined);
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const bookings = () => db().collection('pt_bookings');
  const guard = () => db().collection<{ _id: string; revision: Long }>('schedule_guards').findOne({ _id: 'global' }, { promoteLongs: false });
  const bookingOf = (id: ObjectId) => bookings().findOne({ _id: id });

  // Chạy lệnh thật, BẤT ĐỒNG BỘ (execFile) để Jest vẫn đọc log của mongod (xem scheduling-migration).
  function ensureIndexes(): Promise<{ ok: boolean; output: string }> {
    return new Promise(resolve => {
      execFile(process.execPath, ['scripts/admin.cjs', 'ensure-indexes'], {
        cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 60000, windowsHide: true,
      }, (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}` }));
    });
  }

  // ---------- Dữ liệu mẫu ----------
  const at = (hhmm: string) => new Date(`2026-11-25T${hhmm}:00+07:00`);

  // Gói PT của một member: sale (có member_id) → membership.
  async function insertPtMembership(memberId = new ObjectId()) {
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: new ObjectId(), member_id: memberId, plan_id: new ObjectId(), operation: 'REGISTER',
      start_date: '2026-11-01', end_date: '2026-12-31', plan_name_snapshot: 'Gói PT', benefits_snapshot: 'PT',
      list_price_snapshot: Decimal128.fromString('3000000'), credit_amount: Decimal128.fromString('0'), sessions_snapshot: 20,
      policy_snapshot: 'Giá niêm yết', created_at: new Date(),
    });
    await db().collection('memberships').insertOne({ _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: 0 });
    return { memberId, membershipId, saleId };
  }

  // PT có account (tên hiển thị) và một ca có địa điểm.
  async function insertTrainerWithShift(fullName = 'PT Trần Văn Bình', location = 'Phòng PT 2') {
    const accountId = new ObjectId();
    const trainerId = new ObjectId();
    const shiftId = new ObjectId();
    await db().collection('accounts').insertOne({ _id: accountId, id: accountId, full_name: fullName, phone: `+8490${String(Math.random()).slice(2, 9)}`, status: 'ACTIVE' });
    await db().collection('trainers').insertOne({ _id: trainerId, id: trainerId, account_id: accountId, specialty: 'Thể hình', status: 'ACTIVE', version: 0 });
    await db().collection('work_shifts').insertOne({
      _id: shiftId, id: shiftId, trainer_id: trainerId, start_at: at('08:00'), end_at: at('12:00'), location, status: 'CONFIRMED', version: 1,
    });
    return { trainerId, shiftId, accountId };
  }

  // Booking cũ trước US-28: không có member_id/snapshot/version trừ khi truyền.
  async function insertLegacyBooking(membershipId: ObjectId, trainerId: ObjectId, shiftId: ObjectId, from: string, to: string,
    extra: Record<string, unknown> = {}) {
    const id = new ObjectId();
    await bookings().insertOne({
      _id: id, id, membership_id: membershipId, trainer_id: trainerId, shift_id: shiftId, start_at: at(from), end_at: at(to),
      status: 'BOOKED', request_key: randomBytes(32).toString('hex'), created_at: new Date(), ...extra,
    });
    return id;
  }

  const allBookings = () => bookings().find({}).sort({ _id: 1 }).toArray();

  async function expectInvalid(before: unknown[]) {
    const result = await ensureIndexes();
    expect(result.ok).toBe(false);
    expect(result.output).toContain('SCHEDULE_DATA_INVALID');
    expect(await guard()).toBeNull();
    expect(await allBookings()).toEqual(before);
  }

  describe('US-28-G03: member_id suy ra qua membership → sale → member, có đối chiếu', () => {
    it('US-28-G03: booking cũ thiếu member_id được ghi đúng member của sale', async () => {
      const owner = await insertPtMembership();
      const pt = await insertTrainerWithShift();
      const id = await insertLegacyBooking(owner.membershipId, pt.trainerId, pt.shiftId, '08:00', '09:00');

      const result = await ensureIndexes();

      expect(result.ok).toBe(true);
      expect(String((await bookingOf(id))?.member_id)).toBe(owner.memberId.toHexString());
      expect((await guard())?.revision.toString()).toBe('0');
    });

    it('US-28-G03: booking của nhiều member khác nhau được ghi member của chính gói mình, không lẫn', async () => {
      const a = await insertPtMembership();
      const b = await insertPtMembership();
      const pt = await insertTrainerWithShift();
      const bookingA = await insertLegacyBooking(a.membershipId, pt.trainerId, pt.shiftId, '08:00', '09:00');
      const bookingB = await insertLegacyBooking(b.membershipId, pt.trainerId, pt.shiftId, '09:00', '10:00');

      expect((await ensureIndexes()).ok).toBe(true);

      expect(String((await bookingOf(bookingA))?.member_id)).toBe(a.memberId.toHexString());
      expect(String((await bookingOf(bookingB))?.member_id)).toBe(b.memberId.toHexString());
    });

    it('US-28-G03: booking đã có member_id đúng → giữ nguyên, lệnh thành công', async () => {
      const owner = await insertPtMembership();
      const pt = await insertTrainerWithShift();
      const id = await insertLegacyBooking(owner.membershipId, pt.trainerId, pt.shiftId, '08:00', '09:00', { member_id: owner.memberId });

      expect((await ensureIndexes()).ok).toBe(true);
      expect(String((await bookingOf(id))?.member_id)).toBe(owner.memberId.toHexString());
    });

    it('US-28-G03: booking đã có member_id KHÁC member suy ra → SCHEDULE_DATA_INVALID, không ghi đè, không tạo guard', async () => {
      const owner = await insertPtMembership();
      const pt = await insertTrainerWithShift();
      await insertLegacyBooking(owner.membershipId, pt.trainerId, pt.shiftId, '08:00', '09:00', { member_id: new ObjectId() });
      await expectInvalid(await allBookings());
    });

    it('US-28-G03: booking mồ côi (membership không tồn tại) → SCHEDULE_DATA_INVALID, không đoán member', async () => {
      const pt = await insertTrainerWithShift();
      await insertLegacyBooking(new ObjectId(), pt.trainerId, pt.shiftId, '08:00', '09:00');
      await expectInvalid(await allBookings());
    });

    it('US-28-G03: booking mồ côi (membership có nhưng sale không tồn tại) → SCHEDULE_DATA_INVALID', async () => {
      const owner = await insertPtMembership();
      await db().collection('service_sales').deleteOne({ _id: owner.saleId });
      const pt = await insertTrainerWithShift();
      await insertLegacyBooking(owner.membershipId, pt.trainerId, pt.shiftId, '08:00', '09:00');
      await expectInvalid(await allBookings());
    });

    it('US-28-G03: có một booking mồ côi thì KHÔNG backfill booking hợp lệ nào (kiểm hết rồi mới ghi)', async () => {
      const owner = await insertPtMembership();
      const pt = await insertTrainerWithShift();
      const good = await insertLegacyBooking(owner.membershipId, pt.trainerId, pt.shiftId, '08:00', '09:00');
      await insertLegacyBooking(new ObjectId(), pt.trainerId, pt.shiftId, '10:00', '11:00');

      expect((await ensureIndexes()).ok).toBe(false);
      expect((await bookingOf(good))?.member_id).toBeUndefined();
    });

    it('US-28-G03: chạy lại sau khi đã backfill → không đổi gì thêm', async () => {
      const owner = await insertPtMembership();
      const pt = await insertTrainerWithShift();
      await insertLegacyBooking(owner.membershipId, pt.trainerId, pt.shiftId, '08:00', '09:00');
      expect((await ensureIndexes()).ok).toBe(true);
      const afterFirst = await allBookings();

      expect((await ensureIndexes()).ok).toBe(true);
      expect(await allBookings()).toEqual(afterFirst);
    });
  });

  describe('US-28-G03: snapshot tên PT và địa điểm cho booking cũ', () => {
    it('US-28-G03: snapshot thiếu → lấy tên PT từ account và địa điểm từ ca', async () => {
      const owner = await insertPtMembership();
      const pt = await insertTrainerWithShift('PT Lê Thị Cúc', 'Phòng PT 3');
      const id = await insertLegacyBooking(owner.membershipId, pt.trainerId, pt.shiftId, '08:00', '09:00');

      expect((await ensureIndexes()).ok).toBe(true);

      expect(await bookingOf(id)).toMatchObject({ trainer_name_snapshot: 'PT Lê Thị Cúc', location_snapshot: 'Phòng PT 3' });
    });

    it('US-28-G03: snapshot đã có giữ nguyên dù tên PT/địa điểm ca đã đổi (lịch sử không đổi theo dữ liệu mới)', async () => {
      const owner = await insertPtMembership();
      const pt = await insertTrainerWithShift('PT Tên Mới', 'Phòng Mới');
      const id = await insertLegacyBooking(owner.membershipId, pt.trainerId, pt.shiftId, '08:00', '09:00',
        { trainer_name_snapshot: 'PT Tên Cũ', location_snapshot: 'Phòng Cũ' });

      expect((await ensureIndexes()).ok).toBe(true);

      expect(await bookingOf(id)).toMatchObject({ trainer_name_snapshot: 'PT Tên Cũ', location_snapshot: 'Phòng Cũ' });
    });

    it('US-28-G03: không tìm thấy ca/PT để lấy snapshot → để trống (không đoán), lệnh vẫn thành công và member_id vẫn được ghi', async () => {
      const owner = await insertPtMembership();
      const id = await insertLegacyBooking(owner.membershipId, new ObjectId(), new ObjectId(), '08:00', '09:00');

      expect((await ensureIndexes()).ok).toBe(true);

      const saved = await bookingOf(id);
      expect(saved?.trainer_name_snapshot).toBeUndefined();
      expect(saved?.location_snapshot).toBeUndefined();
      expect(String(saved?.member_id)).toBe(owner.memberId.toHexString());
    });
  });

  describe('US-28-F04: một Member không có hai buổi trùng giờ trên mọi PT/gói', () => {
    it('US-28-F04: cùng member, hai gói, hai PT, hai buổi BOOKED giao nhau → SCHEDULE_DATA_INVALID, không tạo guard', async () => {
      const memberId = new ObjectId();
      const first = await insertPtMembership(memberId);
      const second = await insertPtMembership(memberId);
      const ptA = await insertTrainerWithShift('PT A');
      const ptB = await insertTrainerWithShift('PT B');
      await insertLegacyBooking(first.membershipId, ptA.trainerId, ptA.shiftId, '08:00', '09:00');
      await insertLegacyBooking(second.membershipId, ptB.trainerId, ptB.shiftId, '08:30', '09:30');
      await expectInvalid(await allBookings());
    });

    it('US-28-F04: cùng member, hai buổi tiếp giáp hoặc một buổi CANCELLED trùng giờ → hợp lệ', async () => {
      const owner = await insertPtMembership();
      const ptA = await insertTrainerWithShift('PT A');
      const ptB = await insertTrainerWithShift('PT B');
      await insertLegacyBooking(owner.membershipId, ptA.trainerId, ptA.shiftId, '08:00', '09:00');
      await insertLegacyBooking(owner.membershipId, ptB.trainerId, ptB.shiftId, '09:00', '10:00');
      await insertLegacyBooking(owner.membershipId, ptB.trainerId, ptB.shiftId, '08:00', '09:00', { status: 'CANCELLED' });

      expect((await ensureIndexes()).ok).toBe(true);
    });

    it('US-28-F04: hai member KHÁC nhau cùng giờ với hai PT khác nhau → hợp lệ', async () => {
      const a = await insertPtMembership();
      const b = await insertPtMembership();
      const ptA = await insertTrainerWithShift('PT A');
      const ptB = await insertTrainerWithShift('PT B');
      await insertLegacyBooking(a.membershipId, ptA.trainerId, ptA.shiftId, '08:00', '09:00');
      await insertLegacyBooking(b.membershipId, ptB.trainerId, ptB.shiftId, '08:00', '09:00');

      expect((await ensureIndexes()).ok).toBe(true);
    });
  });
});
