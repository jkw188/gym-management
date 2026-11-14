// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ + lệnh CLI thật): US-64 bước 1.
// Kiểm tra migration trước khi mở writer hoàn tất buổi qua lệnh `ensure-indexes`: index unique booking_events,
// backfill completion_revision/completion_membership_id cho booking cũ, đối chiếu used/BOOKED trước khi ghi (US-64-F02, C04).
// Hợp đồng test đặt ra cho Builder (US-64 bước 1, "Thứ tự triển khai" bước 1 và bảng collection mục 3):
//   node scripts/admin.cjs ensure-indexes (chạy trên bản build dist/):
//   - Tạo index unique booking_events (booking_id, completion_revision, action).
//   - pt_bookings thiếu completion_revision: BOOKED/CANCELLED → 0; COMPLETED → 1 (đã hoàn tất một lần) và
//     completion_membership_id = membership_id nếu chưa có. Booking đã có completion_revision giữ nguyên. Chạy lại không đổi gì thêm.
//   - Không đổi sessions_used, status, membership_id, version của dữ liệu cũ.
//   - Đối chiếu used + số BOOKED ≤ quota (đã có từ US-28) phải chạy TRƯỚC khi ghi: vi phạm → lệnh thất bại
//     SCHEDULE_DATA_INVALID và KHÔNG backfill gì (kiểm hết rồi mới ghi, không tự chữa).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Decimal128, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';

const databaseName = 'gym_management_test_us64_migration';

describe('US-64 bước 1: migration nguồn hoàn tất qua ensure-indexes', () => {
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
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'us64-test', SMTP_PASS: 'us64-test', SMTP_FROM: 'no-reply@gym.test',
    });
    // Khởi động app trước như test US-28 bước 1: app tạo collection/index của các module đã có, rồi mới chạy lệnh CLI.
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    // Chỉ xóa dữ liệu; xóa index booking_events để kiểm lệnh tự tạo lại (app đã tạo sẵn lúc khởi động).
    for (const collection of await db().collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    await db().collection('booking_events').dropIndexes().catch(() => undefined);
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const bookings = () => db().collection('pt_bookings');
  const events = () => db().collection('booking_events');

  // Chạy lệnh thật, BẤT ĐỒNG BỘ (execFile) như test US-28 bước 1 để Jest vẫn đọc log của mongod.
  function ensureIndexes(): Promise<{ ok: boolean; output: string }> {
    return new Promise(resolve => {
      execFile(process.execPath, ['scripts/admin.cjs', 'ensure-indexes'], {
        cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 60000, windowsHide: true,
      }, (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}` }));
    });
  }

  // ---------- Dữ liệu mẫu (khuôn báo cáo mục 4.2 như test US-28) ----------
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
    // US-14 đã khởi tạo version; suite này chỉ kiểm migration hoàn tất booking của US-64.
    await db().collection('memberships').insertOne({ _id: membershipId, id: membershipId,
      service_sale_id: saleId, status: 'ACTIVE', sessions_used: used, version: 0 });
    return { memberId, membershipId };
  }

  // Booking trước US-64: đã có member_id/version (US-28) nhưng CHƯA có field hoàn tất, trừ khi truyền vào.
  async function insertBooking(memberId: ObjectId, membershipId: ObjectId, from: string, to: string,
    options: { status?: string; extra?: Record<string, unknown> } = {}) {
    const id = new ObjectId();
    await bookings().insertOne({
      _id: id, id, membership_id: membershipId, member_id: memberId, trainer_id: new ObjectId(), shift_id: new ObjectId(),
      start_at: at(from), end_at: at(to), status: options.status ?? 'BOOKED', request_key: `us64-migration-${id.toHexString()}`,
      created_at: new Date(), version: 0, ...(options.extra ?? {}),
    });
    return id;
  }

  function completeEventDoc(bookingId: ObjectId, revision: number) {
    return {
      booking_id: bookingId, member_id: new ObjectId(), membership_id: new ObjectId(), actor_id: new ObjectId(), actor_role: 'TRAINER',
      action: 'COMPLETE', occurred_at: new Date(), before_status: 'BOOKED', after_status: 'COMPLETED',
      request_key: `us64-event-${new ObjectId().toHexString()}`, completion_revision: revision,
      used_before: 0, used_after: 1, version_before: 0, version_after: 1,
    };
  }

  describe('US-64-C04: index booking_events', () => {
    it('US-64-C04: ensure-indexes tạo index unique booking_events (booking_id, completion_revision, action)', async () => {
      expect((await ensureIndexes()).ok).toBe(true);
      const indexes = await events().listIndexes().toArray();
      const found = indexes.find(index => JSON.stringify(index.key) === JSON.stringify({ booking_id: 1, completion_revision: 1, action: 1 }));
      expect(found).toBeDefined();
      expect(found?.unique).toBe(true);
    });

    it('US-64-C04: hai dòng COMPLETE cùng booking cùng revision → MongoDB từ chối (E11000); revision khác thì được', async () => {
      expect((await ensureIndexes()).ok).toBe(true);
      const bookingId = new ObjectId();
      await events().insertOne(completeEventDoc(bookingId, 1));
      await expect(events().insertOne(completeEventDoc(bookingId, 1))).rejects.toMatchObject({ code: 11000 });
      await expect(events().insertOne(completeEventDoc(bookingId, 2))).resolves.toBeDefined();
    });
  });

  describe('US-64-C04/F02: backfill nguồn hoàn tất cho booking cũ', () => {
    it('US-64-C04: booking cũ BOOKED/CANCELLED thiếu completion_revision → 0, không thêm completion_membership_id', async () => {
      const { memberId, membershipId } = await insertPtMembership(10, 0);
      const booked = await insertBooking(memberId, membershipId, '08:00', '09:00');
      const cancelled = await insertBooking(memberId, membershipId, '10:00', '11:00', { status: 'CANCELLED' });

      expect((await ensureIndexes()).ok).toBe(true);

      for (const id of [booked, cancelled]) {
        const doc = await bookings().findOne({ _id: id });
        expect(Number(doc?.completion_revision)).toBe(0);
        expect(doc?.completion_membership_id).toBeUndefined();
      }
    });

    it('US-64-C04: booking cũ COMPLETED thiếu completion_revision → 1 và completion_membership_id = membership_id', async () => {
      const { memberId, membershipId } = await insertPtMembership(10, 1);
      const completed = await insertBooking(memberId, membershipId, '08:00', '09:00',
        { status: 'COMPLETED', extra: { completed_at: at('09:10') } });

      expect((await ensureIndexes()).ok).toBe(true);

      const doc = await bookings().findOne({ _id: completed });
      expect(Number(doc?.completion_revision)).toBe(1);
      expect(String(doc?.completion_membership_id)).toBe(String(membershipId));
    });

    it('US-64-C04: booking đã có completion_revision/completion_membership_id giữ nguyên', async () => {
      const { memberId, membershipId } = await insertPtMembership(10, 1);
      const otherMembership = new ObjectId();
      const completed = await insertBooking(memberId, membershipId, '08:00', '09:00', {
        status: 'COMPLETED', extra: { completed_at: at('09:10'), completion_revision: 3, completion_membership_id: otherMembership },
      });

      expect((await ensureIndexes()).ok).toBe(true);

      const doc = await bookings().findOne({ _id: completed });
      expect(Number(doc?.completion_revision)).toBe(3);
      expect(String(doc?.completion_membership_id)).toBe(String(otherMembership));
    });

    it('US-64-C04: booking COMPLETED đã có completion_revision = 2 nhưng thiếu completion_membership_id → điền membership_id, revision vẫn 2', async () => {
      const { memberId, membershipId } = await insertPtMembership(10, 1);
      const completed = await insertBooking(memberId, membershipId, '08:00', '09:00', {
        status: 'COMPLETED', extra: { completed_at: at('09:10'), completion_revision: 2 },
      });

      expect((await ensureIndexes()).ok).toBe(true);

      const doc = await bookings().findOne({ _id: completed });
      expect(String(doc?.completion_membership_id)).toBe(String(membershipId));
      expect(Number(doc?.completion_revision)).toBe(2);
    });

    it('US-64-F02: migration không đổi sessions_used, status, membership_id, version; chạy lại lần hai không đổi thêm', async () => {
      const { memberId, membershipId } = await insertPtMembership(10, 2);
      await insertBooking(memberId, membershipId, '08:00', '09:00', { status: 'COMPLETED', extra: { completed_at: at('09:10') } });
      await insertBooking(memberId, membershipId, '10:00', '11:00');
      const membershipBefore = await db().collection('memberships').findOne({ _id: membershipId });
      const pick = (docs: Record<string, unknown>[]) =>
        docs.map(({ _id, status, membership_id, version }) => ({ _id, status, membership_id, version }));
      const bookingsBefore = pick(await bookings().find({}).sort({ _id: 1 }).toArray());

      expect((await ensureIndexes()).ok).toBe(true);
      const afterFirst = await bookings().find({}).sort({ _id: 1 }).toArray();
      expect(await db().collection('memberships').findOne({ _id: membershipId })).toEqual(membershipBefore);
      expect(pick(afterFirst)).toEqual(bookingsBefore);

      expect((await ensureIndexes()).ok).toBe(true);
      expect(await bookings().find({}).sort({ _id: 1 }).toArray()).toEqual(afterFirst);
    });

    it('US-64-F02: used + BOOKED > quota → SCHEDULE_DATA_INVALID, KHÔNG backfill booking nào, used giữ nguyên', async () => {
      const { memberId, membershipId } = await insertPtMembership(2, 2);
      const booked = await insertBooking(memberId, membershipId, '08:00', '09:00');
      const completed = await insertBooking(memberId, membershipId, '10:00', '11:00',
        { status: 'COMPLETED', extra: { completed_at: at('11:10') } });
      const before = {
        bookings: await bookings().find({}).sort({ _id: 1 }).toArray(),
        memberships: await db().collection('memberships').find({}).sort({ _id: 1 }).toArray(),
      };

      const result = await ensureIndexes();

      expect(result.ok).toBe(false);
      expect(result.output).toContain('SCHEDULE_DATA_INVALID');
      expect((await bookings().findOne({ _id: booked }))?.completion_revision).toBeUndefined();
      expect((await bookings().findOne({ _id: completed }))?.completion_revision).toBeUndefined();
      expect({
        bookings: await bookings().find({}).sort({ _id: 1 }).toArray(),
        memberships: await db().collection('memberships').find({}).sort({ _id: 1 }).toArray(),
      }).toEqual(before);
    });
  });
});
