// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ + lệnh CLI thật): US-28 bước 1.
// Kiểm tra migration trước khi mở writer lịch qua lệnh `ensure-indexes`: tạo guard global, index pt_bookings, đặt version=0
// cho booking cũ, và phát hiện dữ liệu vi phạm (overlap BOOKED/COMPLETED cùng PT, quota âm) thì báo lỗi, không tự sửa (US-28-G01).
// Hợp đồng test đặt ra cho Builder (US-28 bước 1, theo "Thứ tự triển khai" bước 1 và mục 3; sinh viên chốt 10/11: đơn giản hóa,
// bỏ phần "sửa có audit" – dữ liệu vi phạm do người vận hành sửa tay rồi chạy lại lệnh):
//   node scripts/admin.cjs ensure-indexes (chạy trên bản build dist/):
//   - schedule_guards {_id:'global', revision: Int64 0} tạo bằng upsert $setOnInsert; chạy lại không đổi revision đang có.
//   - Index pt_bookings: (trainer_id,status,start_at,end_at), (member_id,status,start_at,end_at), (membership_id,status),
//     (shift_id,status), request_key unique.
//   - pt_bookings thiếu field version → đặt version = 0; booking đã có version giữ nguyên.
//   - Kiểm dữ liệu TRƯỚC khi tạo guard: (a) hai booking BOOKED/COMPLETED cùng trainer_id giao nhau (nửa mở; tiếp giáp và CANCELLED không tính);
//     (b) membership có sessions_used + số BOOKED > service_sales.sessions_snapshot. Có vi phạm → lệnh thoát mã khác 0,
//     in mã SCHEDULE_DATA_INVALID, KHÔNG tạo guard (writer lịch chưa mở được) và KHÔNG xóa/sửa booking hay sessions_used.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Decimal128, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';

const databaseName = 'gym_management_test_us28_migration';

describe('US-28 bước 1: migration lịch qua ensure-indexes', () => {
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
    // Khởi động app trước như test account-security: app tạo collection/index của các module đã có, rồi mới chạy lệnh CLI.
    // (Lệnh ensure-indexes hiện treo trên DB hoàn toàn trống – lỗi có sẵn ngoài phạm vi US-28, đã báo sinh viên.)
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    // Chỉ xóa dữ liệu, giữ index; xóa hẳn guard và index pt_bookings để mỗi test kiểm migration từ đầu.
    for (const collection of await db().collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    await db().collection('schedule_guards').drop().catch(() => undefined);
    await db().collection('pt_bookings').dropIndexes().catch(() => undefined);
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const bookings = () => db().collection('pt_bookings');
  // Đọc với promoteLongs: false để Int64 giữ nguyên kiểu Long (mặc định driver đổi Int64 nhỏ thành number), giống financial-integrity.
  const guard = () => db().collection<{ _id: string; revision: Long }>('schedule_guards').findOne({ _id: 'global' }, { promoteLongs: false });

  // Chạy lệnh thật; trả { ok, output } thay vì ném lỗi để test kiểm cả trường hợp thất bại.
  function ensureIndexes(): { ok: boolean; output: string } {
    try {
      const output = execFileSync(process.execPath, ['scripts/admin.cjs', 'ensure-indexes'], {
        cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: 'pipe',
      });
      return { ok: true, output };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      return { ok: false, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
    }
  }

  // ---------- Dữ liệu mẫu (khuôn báo cáo mục 4.2 như các test US-17/US-27) ----------
  const at = (hhmm: string) => new Date(`2026-11-25T${hhmm}:00+07:00`);

  async function insertPtMembership(quota: number, used: number) {
    const memberId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: new ObjectId(), member_id: memberId, plan_id: new ObjectId(), operation: 'REGISTER',
      start_date: '2026-11-01', end_date: '2026-12-31', plan_name_snapshot: 'Gói PT', benefits_snapshot: 'PT',
      list_price_snapshot: Decimal128.fromString('3000000'), credit_amount: Decimal128.fromString('0'), sessions_snapshot: quota,
      policy_snapshot: 'Giá niêm yết', created_at: new Date(),
    });
    await db().collection('memberships').insertOne({ _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: used });
    return { memberId, membershipId };
  }

  // Booking cũ trước US-28: KHÔNG có version (trừ khi truyền), có thể chưa có member_id.
  async function insertBooking(membershipId: ObjectId, trainerId: ObjectId, from: string, to: string,
    options: { status?: string; version?: number } = {}) {
    const id = new ObjectId();
    const doc: Record<string, unknown> = {
      _id: id, id, membership_id: membershipId, trainer_id: trainerId, shift_id: new ObjectId(), start_at: at(from), end_at: at(to),
      status: options.status ?? 'BOOKED', request_key: `us28-migration-${id.toHexString()}`, created_at: new Date(),
    };
    if (options.version !== undefined) doc.version = options.version;
    await bookings().insertOne(doc);
    return id;
  }

  const snapshot = async () => ({
    bookings: await bookings().find({}).sort({ _id: 1 }).toArray(),
    memberships: await db().collection('memberships').find({}).sort({ _id: 1 }).toArray(),
  });

  describe('US-28-G01: guard global và index trước khi mở writer', () => {
    it('US-28-G01: DB sạch → tạo schedule_guards global revision Int64 = 0', async () => {
      const result = ensureIndexes();
      expect(result.ok).toBe(true);
      expect(result.output).toContain('INDEXES_ENSURED');
      const doc = await guard();
      expect(doc?.revision).toBeInstanceOf(Long);
      expect(doc?.revision.toString()).toBe('0');
    });

    it('US-28-G01: chạy lại nhiều lần không reset revision đang có', async () => {
      expect(ensureIndexes().ok).toBe(true);
      await db().collection<{ _id: string; revision: Long }>('schedule_guards').updateOne({ _id: 'global' }, { $inc: { revision: Long.fromNumber(7) } });
      expect(ensureIndexes().ok).toBe(true);
      expect((await guard())?.revision.toString()).toBe('7');
      expect(await db().collection('schedule_guards').countDocuments()).toBe(1);
    });

    it('US-28-G01: tạo đủ 5 index pt_bookings theo spec, request_key unique', async () => {
      expect(ensureIndexes().ok).toBe(true);
      const indexes = await bookings().listIndexes().toArray();
      const keys = indexes.map(index => index.key);
      expect(keys).toEqual(expect.arrayContaining([
        { trainer_id: 1, status: 1, start_at: 1, end_at: 1 },
        { member_id: 1, status: 1, start_at: 1, end_at: 1 },
        { membership_id: 1, status: 1 },
        { shift_id: 1, status: 1 },
        { request_key: 1 },
      ]));
      expect(indexes.find(index => JSON.stringify(index.key) === JSON.stringify({ request_key: 1 }))?.unique).toBe(true);
    });

    it('US-28-G01: booking cũ thiếu version được đặt version = 0; booking đã có version giữ nguyên', async () => {
      const { membershipId } = await insertPtMembership(10, 0);
      const trainerId = new ObjectId();
      const legacy = await insertBooking(membershipId, trainerId, '08:00', '09:00');
      const versioned = await insertBooking(membershipId, trainerId, '10:00', '11:00', { version: 3 });

      expect(ensureIndexes().ok).toBe(true);

      expect(Number((await bookings().findOne({ _id: legacy }))?.version)).toBe(0);
      expect(Number((await bookings().findOne({ _id: versioned }))?.version)).toBe(3);
    });
  });

  describe('US-28-G01: dữ liệu vi phạm phải được báo, không tự sửa', () => {
    it('US-28-G01: hai booking BOOKED cùng PT giao nhau → lệnh thất bại SCHEDULE_DATA_INVALID, không tạo guard, dữ liệu giữ nguyên', async () => {
      const { membershipId } = await insertPtMembership(10, 0);
      const trainerId = new ObjectId();
      await insertBooking(membershipId, trainerId, '08:00', '09:00');
      await insertBooking(membershipId, trainerId, '08:30', '09:30');
      const before = await snapshot();

      const result = ensureIndexes();

      expect(result.ok).toBe(false);
      expect(result.output).toContain('SCHEDULE_DATA_INVALID');
      expect(await guard()).toBeNull();
      expect(await snapshot()).toEqual(before);
    });

    it('US-28-G01: BOOKED giao COMPLETED cùng PT cũng là vi phạm', async () => {
      const { membershipId } = await insertPtMembership(10, 1);
      const trainerId = new ObjectId();
      await insertBooking(membershipId, trainerId, '08:00', '09:00', { status: 'COMPLETED' });
      await insertBooking(membershipId, trainerId, '08:59', '09:59');

      const result = ensureIndexes();
      expect(result.ok).toBe(false);
      expect(result.output).toContain('SCHEDULE_DATA_INVALID');
    });

    it('US-28-G01: booking tiếp giáp, booking CANCELLED trùng giờ, hoặc khác PT cùng giờ → không phải vi phạm', async () => {
      const { membershipId } = await insertPtMembership(10, 0);
      const trainerA = new ObjectId();
      const trainerB = new ObjectId();
      await insertBooking(membershipId, trainerA, '08:00', '09:00');
      await insertBooking(membershipId, trainerA, '09:00', '10:00');
      await insertBooking(membershipId, trainerA, '08:00', '09:00', { status: 'CANCELLED' });
      await insertBooking(membershipId, trainerB, '08:00', '09:00');

      const result = ensureIndexes();
      expect(result.ok).toBe(true);
      expect((await guard())?.revision.toString()).toBe('0');
    });

    it('US-28-G01: quota âm (used 9 + 2 BOOKED > quota 10) → SCHEDULE_DATA_INVALID, không cộng/trừ used, không xóa booking', async () => {
      const { membershipId } = await insertPtMembership(10, 9);
      await insertBooking(membershipId, new ObjectId(), '08:00', '09:00');
      await insertBooking(membershipId, new ObjectId(), '10:00', '11:00');
      const before = await snapshot();

      const result = ensureIndexes();

      expect(result.ok).toBe(false);
      expect(result.output).toContain('SCHEDULE_DATA_INVALID');
      expect(await guard()).toBeNull();
      expect(await snapshot()).toEqual(before);
    });

    it('US-28-G01: used + BOOKED đúng bằng quota (9 + 1 = 10) → hợp lệ; booking CANCELLED không tính vào quota', async () => {
      const { membershipId } = await insertPtMembership(10, 9);
      await insertBooking(membershipId, new ObjectId(), '08:00', '09:00');
      await insertBooking(membershipId, new ObjectId(), '10:00', '11:00', { status: 'CANCELLED' });

      expect(ensureIndexes().ok).toBe(true);
    });

    it('US-28-G01: sửa tay dữ liệu vi phạm rồi chạy lại → lệnh thành công và tạo guard', async () => {
      const { membershipId } = await insertPtMembership(10, 0);
      const trainerId = new ObjectId();
      await insertBooking(membershipId, trainerId, '08:00', '09:00');
      const second = await insertBooking(membershipId, trainerId, '08:30', '09:30');
      expect(ensureIndexes().ok).toBe(false);

      // Người vận hành đối chiếu và hủy buổi sai (sửa tay, ngoài hệ thống).
      await bookings().updateOne({ _id: second }, { $set: { status: 'CANCELLED' } });

      expect(ensureIndexes().ok).toBe(true);
      expect((await guard())?.revision.toString()).toBe('0');
    });
  });
});
