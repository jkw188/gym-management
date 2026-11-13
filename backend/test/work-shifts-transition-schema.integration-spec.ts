// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ): US-25 bước 1.
// Kiểm tra work_shifts lưu được field công bố/hủy và shift_events lưu được lý do hủy (TC01, TC04).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model } from 'mongoose';
import { randomBytes } from 'node:crypto';

// Hợp đồng test đặt ra cho Builder (US-25 bước 1):
//   Schema work_shifts bổ sung confirmed_at?, cancelled_at?, cancelled_by? (ObjectId account), cancellation_reason? (tối đa 500 ký tự).
//   Schema shift_events bổ sung reason? (lý do khi action CANCELLED). Không thêm completed_at ở S04.
//   Test tìm model theo tên collection như test schema US-24. Field DB viết snake_case như spec.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us25_schema';

describe('US-25 bước 1: schema lưu công bố và hủy ca', () => {
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
      SMTP_USER: 'us24-test', SMTP_PASS: 'us24-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http');
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    // Chờ Mongoose tạo xong index của mọi model trước khi kiểm.
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    // Chỉ xóa dữ liệu, giữ index (unique index phải còn để test có ý nghĩa).
    for (const collection of await connection.db!.collections()) await collection.deleteMany({});
    // US-28-G02: writer ca (US-24/25) lấy khóa lịch schedule_guards; môi trường thật do lệnh ensure-indexes tạo sẵn.
    await connection.db!.collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;

  // Tìm model Mongoose theo tên collection, không phụ thuộc tên class Builder đặt.
  function modelOf(collectionName: string): Model<any> {
    const found = Object.values(connection.models).find(model => model.collection.collectionName === collectionName);
    if (!found) throw new Error(`Chưa có model Mongoose cho collection ${collectionName}`);
    return found;
  }

  // Ảnh chụp ca trước/sau khi chuyển trạng thái (giống cách US-24 ghi before/after).
  const snapshot = (status: string, version: number) => ({
    start_at: new Date('2026-12-01T01:10:00.000Z'), end_at: new Date('2026-12-01T03:40:00.000Z'), location: 'Phòng PT 1', status, version,
  });

  function validShift(overrides: Record<string, unknown> = {}) {
    const trainerAccount = new ObjectId();
    return {
      trainer_id: new ObjectId(),
      start_at: new Date('2026-12-01T01:10:00.000Z'),
      end_at: new Date('2026-12-01T03:40:00.000Z'),
      location: 'Phòng PT 1',
      status: 'SCHEDULED',
      version: 0,
      created_by: trainerAccount,
      updated_by: trainerAccount,
      ...overrides,
    };
  }

  function validEvent(overrides: Record<string, unknown> = {}) {
    return {
      shift_id: new ObjectId(),
      actor_id: new ObjectId(),
      action: 'CREATED',
      after: { start_at: new Date('2026-12-01T01:10:00.000Z'), end_at: new Date('2026-12-01T03:40:00.000Z'), location: 'Phòng PT 1', status: 'SCHEDULED', version: 0 },
      occurred_at: new Date('2026-11-06T03:00:00.000Z'),
      request_key: `shift-create:${new ObjectId().toHexString()}`,
      ...overrides,
    };
  }

  // ---------- TC01: công bố lưu confirmed_at ----------
  it('US-25-TC01: work_shifts lưu được ca CONFIRMED kèm confirmed_at', async () => {
    const confirmedAt = new Date('2026-11-07T03:00:00.000Z');
    const created = await modelOf('work_shifts').create(validShift({ status: 'CONFIRMED', version: 1, confirmed_at: confirmedAt }));
    const raw = await db().collection('work_shifts').findOne({ _id: created._id });
    expect(raw).toMatchObject({ status: 'CONFIRMED', version: 1, confirmed_at: confirmedAt });
  });

  it('US-25-TC01: shift_events nhận action CONFIRMED với before/after status và version', async () => {
    const created = await modelOf('shift_events').create(
      validEvent({ action: 'CONFIRMED', before: snapshot('SCHEDULED', 0), after: snapshot('CONFIRMED', 1) }),
    );
    const raw = await db().collection('shift_events').findOne({ _id: created._id });
    expect(raw).toMatchObject({ action: 'CONFIRMED', before: { status: 'SCHEDULED', version: 0 }, after: { status: 'CONFIRMED', version: 1 } });
  });

  // ---------- TC04: hủy lưu cancelled_at, cancelled_by, cancellation_reason ----------
  it('US-25-TC04: work_shifts lưu được ca CANCELLED kèm cancelled_at, cancelled_by, cancellation_reason', async () => {
    const cancelledAt = new Date('2026-11-07T03:00:00.000Z');
    const cancelledBy = new ObjectId();
    const created = await modelOf('work_shifts').create(
      validShift({ status: 'CANCELLED', version: 1, cancelled_at: cancelledAt, cancelled_by: cancelledBy, cancellation_reason: 'PT bận việc gia đình' }),
    );
    const raw = await db().collection('work_shifts').findOne({ _id: created._id });
    expect(raw).toMatchObject({ status: 'CANCELLED', cancelled_at: cancelledAt, cancellation_reason: 'PT bận việc gia đình' });
    expect(String(raw!.cancelled_by)).toBe(cancelledBy.toHexString());
  });

  it('US-25-TC04: cancellation_reason đúng 500 ký tự lưu được', async () => {
    await expect(
      modelOf('work_shifts').create(validShift({ status: 'CANCELLED', cancelled_at: new Date(), cancellation_reason: 'a'.repeat(500) })),
    ).resolves.toBeDefined();
  });

  it('US-25-TC04: cancellation_reason 501 ký tự bị schema từ chối', async () => {
    await expect(
      modelOf('work_shifts').create(validShift({ status: 'CANCELLED', cancelled_at: new Date(), cancellation_reason: 'a'.repeat(501) })),
    ).rejects.toThrow();
    expect(await db().collection('work_shifts').countDocuments({})).toBe(0);
  });

  it('US-25-TC04: shift_events nhận action CANCELLED kèm reason', async () => {
    const created = await modelOf('shift_events').create(
      validEvent({
        action: 'CANCELLED',
        reason: 'PT bận việc gia đình',
        before: snapshot('CONFIRMED', 1),
        after: snapshot('CANCELLED', 2),
      }),
    );
    const raw = await db().collection('shift_events').findOne({ _id: created._id });
    expect(raw).toMatchObject({ action: 'CANCELLED', reason: 'PT bận việc gia đình', after: { status: 'CANCELLED', version: 2 } });
  });
});
