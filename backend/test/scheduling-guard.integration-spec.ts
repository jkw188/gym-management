// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ): US-28 bước 1.
// Kiểm tra khóa ghi lịch dùng chung S04-G01: schedule_guards {_id:"global", revision Int64} tăng thật trong transaction,
// thiếu guard thì báo chưa sẵn sàng, rollback không tăng, hai writer đồng thời bị tuần tự hóa (US-28-G01).
// Hợp đồng test đặt ra cho Builder (US-28 bước 1, theo G01 của spec; sinh viên chốt 10/11: bước 1 đơn giản hóa):
//   Mở rộng DataGuardsService của EN-02 (src/infrastructure/transaction/data-guards.service.ts), KHÔNG tạo mutex riêng:
//     acquire(session, { schedule: true }) → updateOne schedule_guards {_id:'global', revision là Int64 ≥ 0} với $inc revision 1.
//     Thứ tự khi gọi kèm khóa khác: security_state → plans → schedule_guards → members → transactions.
//     Không có guard (hoặc revision sai kiểu) → ApplicationError 409 DATA_GUARD_NOT_READY (giống các guard EN-02 khác).
//     Gọi ngoài transaction → lỗi DATA_GUARD_TRANSACTION_REQUIRED (đã có).
//   Guard được tạo bởi lệnh ensure-indexes (xem scheduling-migration.integration-spec.ts); test này tự chèn guard.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { ApplicationError } from '../src/common/errors/application-error';
import { DataGuardsService } from '../src/infrastructure/transaction/data-guards.service';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us28_guard';

describe('US-28 bước 1: khóa ghi lịch schedule_guards (S04-G01)', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  let guards: DataGuardsService;
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
      SMTP_USER: 'us28-test', SMTP_PASS: 'us28-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    guards = app.get(DataGuardsService);
  }, 600000);

  beforeEach(async () => {
    for (const collection of await connection.db!.collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const scheduleGuards = () => db().collection<{ _id: string; revision: Long }>('schedule_guards');
  const insertGuard = (revision = Long.ZERO) => scheduleGuards().insertOne({ _id: 'global', revision });
  const guardDoc = () => scheduleGuards().findOne({ _id: 'global' });

  // Chạy một callback trong transaction thật (một session).
  async function inTransaction(work: (session: import('mongodb').ClientSession) => Promise<void>) {
    const session = connection.getClient().startSession();
    try {
      await session.withTransaction(() => work(session));
    } finally {
      await session.endSession();
    }
  }

  // Hồ sơ hội viên tối thiểu có service_revision Int64 (khóa member của EN-02).
  async function insertMember() {
    const id = new ObjectId();
    await db().collection('members').insertOne({
      _id: id, id, member_code: `HV-${id.toHexString()}`, full_name: 'Hội viên US28', phone: `+8490${String(Date.now()).slice(-7)}`,
      version: 0, service_revision: Long.ZERO, created_by: new ObjectId(), updated_by: new ObjectId(),
    });
    return id;
  }

  describe('US-28-G01: guard global tăng thật', () => {
    it('US-28-G01: acquire { schedule: true } trong transaction → revision tăng đúng 1 và vẫn là Int64', async () => {
      await insertGuard(Long.fromNumber(5));

      await inTransaction(session => guards.acquire(session, { schedule: true }));

      const doc = await guardDoc();
      expect(doc?.revision).toBeInstanceOf(Long);
      expect(doc?.revision.toString()).toBe('6');
    });

    it('US-28-G01: transaction bị hủy sau khi lấy guard → revision không đổi', async () => {
      await insertGuard();
      const session = connection.getClient().startSession();
      try {
        session.startTransaction();
        await guards.acquire(session, { schedule: true });
        await session.abortTransaction();
      } finally {
        await session.endSession();
      }
      expect((await guardDoc())?.revision.toString()).toBe('0');
    });

    it('US-28-G01: chưa có guard global → ApplicationError 409 DATA_GUARD_NOT_READY, không tự tạo guard', async () => {
      let caught: unknown;
      try {
        await inTransaction(session => guards.acquire(session, { schedule: true }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApplicationError);
      expect((caught as ApplicationError).code).toBe('DATA_GUARD_NOT_READY');
      expect(await scheduleGuards().countDocuments()).toBe(0);
    });

    it('US-28-G01: revision sai kiểu (số thường, không phải Int64) → DATA_GUARD_NOT_READY', async () => {
      await db().collection('schedule_guards').insertOne({ _id: 'global' as unknown as ObjectId, revision: 3 });
      await expect(inTransaction(session => guards.acquire(session, { schedule: true }))).rejects.toMatchObject({ code: 'DATA_GUARD_NOT_READY' });
    });

    it('US-28-G01: gọi ngoài transaction → lỗi, không tăng revision', async () => {
      await insertGuard();
      const session = connection.getClient().startSession();
      try {
        await expect(guards.acquire(session, { schedule: true })).rejects.toThrow('DATA_GUARD_TRANSACTION_REQUIRED');
      } finally {
        await session.endSession();
      }
      expect((await guardDoc())?.revision.toString()).toBe('0');
    });

    it('US-28-G01: không yêu cầu schedule thì không chạm guard lịch (các khóa EN-02 cũ giữ nguyên hành vi)', async () => {
      await insertGuard();
      const memberId = await insertMember();

      await inTransaction(session => guards.acquire(session, { members: [memberId] }));

      expect((await guardDoc())?.revision.toString()).toBe('0');
    });

    it('US-28-G01: lấy kèm khóa member → guard lịch và members.service_revision cùng tăng 1 trong một transaction', async () => {
      await insertGuard();
      const memberId = await insertMember();

      await inTransaction(session => guards.acquire(session, { schedule: true, members: [memberId] }));

      expect((await guardDoc())?.revision.toString()).toBe('1');
      const member = await db().collection('members').findOne({ _id: memberId });
      expect(String(member?.service_revision)).toBe('1');
    });

    it('US-28-G01: lấy kèm khóa member nhưng member không tồn tại → lỗi và rollback cả guard lịch', async () => {
      await insertGuard();
      await expect(inTransaction(session => guards.acquire(session, { schedule: true, members: [new ObjectId()] })))
        .rejects.toMatchObject({ code: 'DATA_GUARD_NOT_READY' });
      expect((await guardDoc())?.revision.toString()).toBe('0');
    });

    it('US-28-G01: hai writer đồng thời cùng lấy guard → bị tuần tự hóa (retry), cả hai commit, revision tăng đúng 2', async () => {
      await insertGuard();
      // Mỗi writer giữ guard một lúc trước khi commit để hai transaction chắc chắn chồng nhau.
      const writer = () => inTransaction(async session => {
        await guards.acquire(session, { schedule: true });
        await new Promise(resolve => setTimeout(resolve, 150));
      });

      await Promise.all([writer(), writer()]);

      expect((await guardDoc())?.revision.toString()).toBe('2');
    });
  });
});
