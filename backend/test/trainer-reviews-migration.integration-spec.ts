// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ + lệnh CLI thật): US-65 bước 1.
// Kiểm tra schema trainer_reviews, index (unique booking_id) và migration bổ sung owner/snapshot cho đánh giá cũ.
// Hợp đồng test đặt ra cho Builder (US-65 "Thứ tự triển khai" bước 1 và bảng collection mục 2):
//   - Schema Mongoose của collection trainer_reviews: rating Int32 1–5 bắt buộc, comment ≤ 1000,
//     trainer_id/member_id/created_by bắt buộc, trainer_name_snapshot/member_display_name_snapshot ≤ 120.
//   - node scripts/admin.cjs ensure-indexes (chạy trên bản build dist/):
//     + Tạo index unique (booking_id), index (trainer_id, created_at, _id), (member_id, created_at, _id).
//     + Đánh giá cũ chỉ có _id/id/booking_id/rating/comment/created_at → backfill từ booking:
//       trainer_id = booking.trainer_id, member_id = booking.member_id, created_by = members.account_id,
//       member_display_name_snapshot = members.full_name, trainer_name_snapshot = accounts.full_name của PT.
//       Không đổi rating/comment/created_at; không copy phone/email/address. Chạy lại không đổi gì thêm.
//     + "Không đoán khi mồ côi": booking không tồn tại hoặc không COMPLETED → lệnh thất bại, KHÔNG backfill gì
//       (kiểm hết rồi mới ghi, giống migration US-64).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Decimal128, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model } from 'mongoose';

const databaseName = 'gym_management_test_us65_migration';

describe('US-65 bước 1: schema, index và migration trainer_reviews', () => {
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
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'us65-test', SMTP_PASS: 'us65-test', SMTP_FROM: 'no-reply@gym.test',
    });
    // Khởi động app trước như test US-64 bước 1: app tạo collection/index của các module đã có, rồi mới chạy lệnh CLI.
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    // Chỉ xóa dữ liệu; xóa index trainer_reviews để kiểm lệnh CLI tự tạo lại (app có thể đã tạo sẵn lúc khởi động).
    for (const collection of await db().collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    await reviews().dropIndexes().catch(() => undefined);
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const reviews = () => db().collection('trainer_reviews');

  // Tìm model theo tên collection để test không phụ thuộc tên class Builder đặt.
  function reviewModel(): Model<unknown> {
    const model = Object.values(connection.models).find(item => item.collection.collectionName === 'trainer_reviews');
    if (!model) throw new Error('Chưa có Mongoose model cho collection trainer_reviews');
    return model as Model<unknown>;
  }

  // Chạy lệnh thật, BẤT ĐỒNG BỘ (execFile) như test US-64 bước 1 để Jest vẫn đọc log của mongod.
  function ensureIndexes(): Promise<{ ok: boolean; output: string }> {
    return new Promise(resolve => {
      execFile(process.execPath, ['scripts/admin.cjs', 'ensure-indexes'], {
        cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 60000, windowsHide: true,
      }, (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}` }));
    });
  }

  function findIndex(indexes: Array<{ key: object; unique?: boolean }>, key: object) {
    return indexes.find(index => JSON.stringify(index.key) === JSON.stringify(key));
  }

  // ---------- Dữ liệu mẫu (khuôn báo cáo mục 4.2: accounts, members, trainers, pt_bookings, trainer_reviews) ----------
  const at = (hhmm: string) => new Date(`2026-11-25T${hhmm}:00+07:00`);

  async function insertAccount(fullName: string, phone: string) {
    const id = new ObjectId();
    await db().collection('accounts').insertOne({
      _id: id, id, role_id: new ObjectId(), full_name: fullName, phone, email: `${phone}@gym.test`, address: '1 Lê Lợi',
      password_hash: '$argon2id$fake', status: 'ACTIVE', version: 0, auth_version: 0, created_at: new Date(), updated_at: new Date(),
    });
    return id;
  }

  // Một booking COMPLETED (hoặc trạng thái khác) cùng Member có tài khoản và PT có tài khoản.
  async function insertBookingGraph(options: { status?: string } = {}) {
    const memberAccountId = await insertAccount('Nguyễn Văn Hội Viên', `+849${Math.floor(Math.random() * 1e8)}`);
    const trainerAccountId = await insertAccount('Trần Thị PT', `+848${Math.floor(Math.random() * 1e8)}`);
    const memberId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, account_id: memberAccountId, member_code: `M-${memberId.toHexString()}`,
      full_name: 'Nguyễn Văn Hội Viên', phone: '+84900000001', address: '2 Nguyễn Huệ', version: 0,
    });
    const trainerId = new ObjectId();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: trainerAccountId, specialty: 'Gym', status: 'ACTIVE',
    });
    const bookingId = new ObjectId();
    const status = options.status ?? 'COMPLETED';
    // Gói PT hợp lệ để các migration trước (US-28, US-64) đối chiếu used/quota không báo lỗi dữ liệu.
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: new ObjectId(), member_id: memberId, plan_id: new ObjectId(), operation: 'REGISTER',
      start_date: '2026-11-01', end_date: '2026-12-31', plan_name_snapshot: 'Gói PT', benefits_snapshot: 'PT',
      list_price_snapshot: Decimal128.fromString('3000000'), credit_amount: Decimal128.fromString('0'), sessions_snapshot: 10,
      policy_snapshot: 'Giá niêm yết', created_at: new Date(),
    });
    await db().collection('memberships').insertOne({ _id: membershipId, id: membershipId, service_sale_id: saleId,
      status: 'ACTIVE', sessions_used: status === 'COMPLETED' ? 1 : 0, version: 0 });
    await db().collection('pt_bookings').insertOne({
      _id: bookingId, id: bookingId, membership_id: membershipId, member_id: memberId, trainer_id: trainerId, shift_id: new ObjectId(),
      start_at: at('08:00'), end_at: at('09:00'), status, request_key: `us65-migration-${bookingId.toHexString()}`,
      created_at: new Date(), version: 1, completion_revision: status === 'COMPLETED' ? 1 : 0,
      ...(status === 'COMPLETED' ? { completed_at: at('09:05') } : {}),
    });
    return { bookingId, memberId, trainerId, memberAccountId, trainerAccountId };
  }

  // Đánh giá cũ theo báo cáo 4.2.16: chỉ có 6 field gốc, chưa có owner/snapshot.
  async function insertLegacyReview(bookingId: ObjectId, rating = 4, comment = 'Buổi tập tốt') {
    const id = new ObjectId();
    const createdAt = new Date('2026-11-25T03:00:00Z');
    await reviews().insertOne({ _id: id, id, booking_id: bookingId, rating, comment, created_at: createdAt });
    return { id, createdAt };
  }

  // Đánh giá đầy đủ field mới (dùng cho kiểm index và schema).
  function fullReview(overrides: Record<string, unknown> = {}) {
    const id = new ObjectId();
    return {
      _id: id, id, booking_id: new ObjectId(), rating: 4, comment: '', created_at: new Date(),
      trainer_id: new ObjectId(), member_id: new ObjectId(), created_by: new ObjectId(),
      trainer_name_snapshot: 'Trần Thị PT', member_display_name_snapshot: 'Nguyễn Văn Hội Viên', ...overrides,
    };
  }

  // ---------- Index ----------
  describe('US-65-F03: index trainer_reviews', () => {
    it('US-65-F03: ensure-indexes tạo index unique (booking_id)', async () => {
      expect((await ensureIndexes()).ok).toBe(true);
      const found = findIndex(await reviews().listIndexes().toArray(), { booking_id: 1 });
      expect(found).toBeDefined();
      expect(found?.unique).toBe(true);
    });

    it('US-65-F03: ensure-indexes tạo index (trainer_id, created_at, _id) và (member_id, created_at, _id) cho US-31/33', async () => {
      expect((await ensureIndexes()).ok).toBe(true);
      const indexes = await reviews().listIndexes().toArray();
      expect(findIndex(indexes, { trainer_id: 1, created_at: 1, _id: 1 })).toBeDefined();
      expect(findIndex(indexes, { member_id: 1, created_at: 1, _id: 1 })).toBeDefined();
    });

    // US-65-TC09 (tầng dữ liệu): unique booking_id là bảo vệ cuối, hai review cùng buổi không thể cùng tồn tại.
    it('US-65-TC09: hai review cùng booking_id → MongoDB từ chối (E11000), chỉ còn một review', async () => {
      expect((await ensureIndexes()).ok).toBe(true);
      const bookingId = new ObjectId();
      await reviews().insertOne(fullReview({ booking_id: bookingId }));
      await expect(reviews().insertOne(fullReview({ booking_id: bookingId }))).rejects.toMatchObject({ code: 11000 });
      expect(await reviews().countDocuments({ booking_id: bookingId })).toBe(1);
    });
  });

  // ---------- Schema ----------
  describe('US-65-F02: schema Mongoose trainer_reviews', () => {
    // US-65-TC05 (tầng schema): rating ngoài 1–5 hoặc không nguyên bị chặn ngay ở schema, kể cả khi DTO bị bỏ qua.
    it.each([0, 6, 1.5])('US-65-TC05: rating %p bị schema từ chối', async rating => {
      await expect(reviewModel().create(fullReview({ rating }))).rejects.toThrow();
      expect(await reviews().countDocuments()).toBe(0);
    });

    it.each([1, 5])('US-65-TC05: rating %p hợp lệ và lưu kiểu Int32', async rating => {
      const doc = fullReview({ rating });
      await reviewModel().create(doc);
      expect(await reviews().countDocuments({ _id: doc._id, rating: { $type: 'int' } })).toBe(1);
    });

    it('US-65-TC05: comment 1001 ký tự bị schema từ chối', async () => {
      await expect(reviewModel().create(fullReview({ comment: 'a'.repeat(1001) }))).rejects.toThrow();
      expect(await reviews().countDocuments()).toBe(0);
    });

    it('US-65-TC05: comment đúng 1000 ký tự được lưu', async () => {
      const doc = fullReview({ comment: 'a'.repeat(1000) });
      await reviewModel().create(doc);
      expect(await reviews().countDocuments({ _id: doc._id })).toBe(1);
    });

    it.each(['trainer_name_snapshot', 'member_display_name_snapshot'])('US-65-TC08: %s quá 120 ký tự bị schema từ chối', async field => {
      await expect(reviewModel().create(fullReview({ [field]: 'a'.repeat(121) }))).rejects.toThrow();
      expect(await reviews().countDocuments()).toBe(0);
    });

    it.each(['trainer_id', 'member_id', 'created_by'])('US-65-F04: review mới thiếu %s bị schema từ chối', async field => {
      const doc: Record<string, unknown> = fullReview();
      delete doc[field];
      await expect(reviewModel().create(doc)).rejects.toThrow();
      expect(await reviews().countDocuments()).toBe(0);
    });
  });

  // ---------- Migration ----------
  describe('US-65-F04: migration owner/snapshot cho review cũ', () => {
    it('US-65-TC01 (migration): review cũ được bổ sung trainer_id, member_id, created_by và tên snapshot từ booking', async () => {
      const graph = await insertBookingGraph();
      const legacy = await insertLegacyReview(graph.bookingId);

      const result = await ensureIndexes();
      expect(result.ok).toBe(true);

      const doc = await reviews().findOne({ _id: legacy.id });
      expect(doc?.trainer_id).toEqual(graph.trainerId);
      expect(doc?.member_id).toEqual(graph.memberId);
      expect(doc?.created_by).toEqual(graph.memberAccountId);
      expect(doc?.trainer_name_snapshot).toBe('Trần Thị PT');
      expect(doc?.member_display_name_snapshot).toBe('Nguyễn Văn Hội Viên');
    });

    it('US-65-F04: migration không đổi rating, comment, created_at của review cũ', async () => {
      const graph = await insertBookingGraph();
      const legacy = await insertLegacyReview(graph.bookingId, 5, 'PT nhiệt tình');

      expect((await ensureIndexes()).ok).toBe(true);

      const doc = await reviews().findOne({ _id: legacy.id });
      expect(doc?.member_id).toEqual(graph.memberId); // đã backfill thật, không phải "giữ nguyên vì chưa làm gì"
      expect(doc?.rating).toBe(5);
      expect(doc?.comment).toBe('PT nhiệt tình');
      expect(doc?.created_at).toEqual(legacy.createdAt);
    });

    it('US-65-TC08 (migration): review sau backfill không chứa phone/email/address của Member hay PT', async () => {
      const graph = await insertBookingGraph();
      const legacy = await insertLegacyReview(graph.bookingId);

      expect((await ensureIndexes()).ok).toBe(true);

      const doc = await reviews().findOne({ _id: legacy.id });
      expect(doc?.member_display_name_snapshot).toBe('Nguyễn Văn Hội Viên'); // có snapshot tên, nhưng không có liên hệ
      const keys = Object.keys(doc ?? {});
      for (const forbidden of ['phone', 'email', 'address', 'birth_date']) {
        expect(keys.some(key => key.includes(forbidden))).toBe(false);
      }
    });

    it('US-65-F04: chạy ensure-indexes lần hai không đổi gì thêm', async () => {
      const graph = await insertBookingGraph();
      const legacy = await insertLegacyReview(graph.bookingId);

      expect((await ensureIndexes()).ok).toBe(true);
      const first = await reviews().findOne({ _id: legacy.id });
      expect(first?.trainer_id).toEqual(graph.trainerId);
      expect((await ensureIndexes()).ok).toBe(true);
      const second = await reviews().findOne({ _id: legacy.id });

      expect(second).toEqual(first);
    });

    it('US-65-F04: review đã đủ owner/snapshot được giữ nguyên, không ghi đè bằng dữ liệu hiện tại', async () => {
      const graph = await insertBookingGraph();
      const doc = fullReview({ booking_id: graph.bookingId, trainer_id: graph.trainerId, member_id: graph.memberId,
        created_by: graph.memberAccountId, trainer_name_snapshot: 'Tên PT lúc gửi', member_display_name_snapshot: 'Tên HV lúc gửi' });
      await reviews().insertOne(doc);

      expect((await ensureIndexes()).ok).toBe(true);

      const after = await reviews().findOne({ _id: doc._id });
      expect(after?.trainer_name_snapshot).toBe('Tên PT lúc gửi');
      expect(after?.member_display_name_snapshot).toBe('Tên HV lúc gửi');
    });

    // "Dữ liệu cũ backfill từ booking có đối chiếu; không đoán khi mồ côi."
    it('US-65-F04: review cũ trỏ tới booking không tồn tại → lệnh thất bại, không backfill review nào', async () => {
      const graph = await insertBookingGraph();
      const good = await insertLegacyReview(graph.bookingId);
      const orphan = await insertLegacyReview(new ObjectId());

      expect((await ensureIndexes()).ok).toBe(false);

      for (const id of [good.id, orphan.id]) {
        const doc = await reviews().findOne({ _id: id });
        expect(doc?.trainer_id).toBeUndefined();
        expect(doc?.member_id).toBeUndefined();
      }
    });

    // US-65-F01: chỉ booking COMPLETED mới có review hợp lệ.
    it.each(['BOOKED', 'CANCELLED'])('US-65-TC04 (migration): review cũ của booking %s → lệnh thất bại, không backfill', async status => {
      const graph = await insertBookingGraph({ status });
      const legacy = await insertLegacyReview(graph.bookingId);

      expect((await ensureIndexes()).ok).toBe(false);

      const doc = await reviews().findOne({ _id: legacy.id });
      expect(doc?.trainer_id).toBeUndefined();
      expect(doc?.member_id).toBeUndefined();
    });
  });
});
