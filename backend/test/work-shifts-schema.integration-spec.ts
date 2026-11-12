// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ): US-24 bước 1.
// Kiểm tra schema và index của work_shifts, shift_events theo bảng "Dữ liệu hoặc index" của spec.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model } from 'mongoose';
import { randomBytes } from 'node:crypto';
// Hợp đồng test đặt ra cho Builder (US-24 bước 1):
//   ShiftsModule được import vào AppModule, khai báo 2 model Mongoose cho collection 'work_shifts' và 'shift_events'
//   (tên model tùy Builder; test tìm model theo tên collection). Field DB viết snake_case như spec.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us24_schema';

type IndexInfo = { key: Record<string, number>; unique?: boolean };

describe('US-24 bước 1: schema và index của ca làm việc', () => {
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

  async function indexes(name: string): Promise<IndexInfo[]> {
    return (await db().collection(name).listIndexes().toArray()) as unknown as IndexInfo[];
  }
  const hasIndex = (list: IndexInfo[], key: Record<string, number>, unique: boolean) =>
    list.some(index => JSON.stringify(index.key) === JSON.stringify(key) && Boolean(index.unique) === unique);

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

  // ---------- work_shifts ----------
  describe('work_shifts', () => {
    it('US-24-TC01: lưu được ca SCHEDULED version 0 với đủ field, có created_at và updated_at', async () => {
      const saved = await modelOf('work_shifts').create(validShift());
      const raw = await db().collection('work_shifts').findOne({ _id: saved._id });
      expect(raw).toMatchObject({ location: 'Phòng PT 1', status: 'SCHEDULED', version: 0 });
      expect(raw!.trainer_id).toBeInstanceOf(ObjectId);
      expect(raw!.start_at).toBeInstanceOf(Date);
      expect(raw!.end_at).toBeInstanceOf(Date);
      expect(raw!.created_by).toBeInstanceOf(ObjectId);
      expect(raw!.updated_by).toBeInstanceOf(ObjectId);
      expect(raw!.created_at).toBeInstanceOf(Date);
      expect(raw!.updated_at).toBeInstanceOf(Date);
    });

    it('US-24-TC07: status chỉ nhận SCHEDULED/CONFIRMED/COMPLETED/CANCELLED', async () => {
      for (const status of ['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED']) {
        await expect(modelOf('work_shifts').create(validShift({ status }))).resolves.toBeDefined();
      }
      await expect(modelOf('work_shifts').create(validShift({ status: 'DRAFT' }))).rejects.toThrow();
      expect(await db().collection('work_shifts').countDocuments({ status: 'DRAFT' })).toBe(0);
    });

    it('US-24-TC10: version không được âm (dùng cho kiểm version khi sửa)', async () => {
      await expect(modelOf('work_shifts').create(validShift({ version: -1 }))).rejects.toThrow();
      expect(await db().collection('work_shifts').countDocuments()).toBe(0);
    });

    it('US-24-TC03: thiếu trainer_id, start_at, end_at hoặc location thì không lưu', async () => {
      for (const field of ['trainer_id', 'start_at', 'end_at', 'location']) {
        const doc: Record<string, unknown> = validShift();
        delete doc[field];
        await expect(modelOf('work_shifts').create(doc)).rejects.toThrow();
      }
      expect(await db().collection('work_shifts').countDocuments()).toBe(0);
    });

    it('US-24-TC05: có index (trainer_id, status, start_at, end_at) để kiểm chồng ca của cùng PT', async () => {
      expect(hasIndex(await indexes('work_shifts'), { trainer_id: 1, status: 1, start_at: 1, end_at: 1 }, false)).toBe(true);
    });

    it('US-24-TC05: có index (trainer_id, start_at, _id) để liệt kê lịch theo startAt rồi id', async () => {
      expect(hasIndex(await indexes('work_shifts'), { trainer_id: 1, start_at: 1, _id: 1 }, false)).toBe(true);
    });
  });

  // ---------- shift_events (audit) ----------
  describe('shift_events', () => {
    it('US-24-TC10: lưu được audit CREATED với actor, after, occurred_at, request_key', async () => {
      const saved = await modelOf('shift_events').create(validEvent());
      const raw = await db().collection('shift_events').findOne({ _id: saved._id });
      expect(raw).toMatchObject({ action: 'CREATED' });
      expect(raw!.shift_id).toBeInstanceOf(ObjectId);
      expect(raw!.actor_id).toBeInstanceOf(ObjectId);
      expect(raw!.occurred_at).toBeInstanceOf(Date);
      expect(raw!.after).toMatchObject({ location: 'Phòng PT 1', status: 'SCHEDULED', version: 0 });
    });

    it('US-24-TC10: action chỉ nhận CREATED/UPDATED/CONFIRMED/CANCELLED', async () => {
      for (const action of ['CREATED', 'UPDATED', 'CONFIRMED', 'CANCELLED']) {
        await expect(modelOf('shift_events').create(validEvent({ action }))).resolves.toBeDefined();
      }
      await expect(modelOf('shift_events').create(validEvent({ action: 'DELETED' }))).rejects.toThrow();
    });

    it('US-24-TC10: request_key unique, gửi lại cùng key không thêm audit thứ hai', async () => {
      expect(hasIndex(await indexes('shift_events'), { request_key: 1 }, true)).toBe(true);
      await db().collection('shift_events').insertOne(validEvent({ request_key: 'same-key' }));
      await expect(db().collection('shift_events').insertOne(validEvent({ request_key: 'same-key' }))).rejects.toMatchObject({ code: 11000 });
      expect(await db().collection('shift_events').countDocuments({ request_key: 'same-key' })).toBe(1);
    });

    it('US-24-TC10: có index (shift_id, occurred_at) để xem lịch sử một ca', async () => {
      expect(hasIndex(await indexes('shift_events'), { shift_id: 1, occurred_at: 1 }, false)).toBe(true);
    });
  });
});
