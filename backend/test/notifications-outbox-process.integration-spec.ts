// Tầng kiểm thử backend (Jest + MongoDB replica set thật + tiến trình Node thật): EN-03 bước 2, spec bản 1.2.
// Kiểm tra worker chỉ tự chạy trong HTTP server (TC18) và lệnh vận hành retry-notification (TC08, TC20).
// Cần `npm run build` trước khi chạy vì test gọi dist/main.js và scripts/admin.cjs (giống foundation.integration-spec.ts).
import 'reflect-metadata';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { PasswordService } from '../src/common/security/password.service';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { UsersRepository } from '../src/modules/users/users.repository';

// Dùng NODE_ENV=development (không phải test) để worker được phép tự chạy như khi chạy thật.
const databaseName = 'gym_management_en03_process';

type OutboxDoc = { _id: ObjectId; event_key: string; notification_id: ObjectId; status: string; attempts: number; available_at: Date };

// Chạy một lệnh node đến khi thoát, gom stdout + stderr.
function runProcess(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: process.env, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Child process did not exit')); }, 25000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('EN-03 bước 2 (spec 1.2): worker chỉ chạy trong HTTP server và lệnh vận hành retry-notification', () => {
  let mongo: MongoMemoryReplSet;
  let context: INestApplicationContext;
  let connection: Connection;
  let notifications: NotificationsService;
  let transactions: TransactionRunner;
  let accountId: string;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName } });
    Object.assign(process.env, {
      NODE_ENV: 'development',
      PORT: String(40000 + Math.floor(Math.random() * 20000)),
      FRONTEND_ORIGIN: 'http://localhost:5173',
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'en03-test', SMTP_PASS: 'en03-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    // App context (không phải HTTP server), giống cách lệnh CLI khởi động AppModule.
    context = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
    connection = context.get<Connection>(getConnectionToken());
    notifications = context.get(NotificationsService);
    transactions = context.get(TransactionRunner);
    const users = context.get(UsersRepository);
    const role = await users.ensureRole('MEMBER', 'MEMBER');
    const passwordHash = await context.get(PasswordService).hash('MậtKhẩuEN-03-123');
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone: '0916000001', fullName: 'EN03 Process', passwordHash });
    accountId = account.id.toHexString();
  }, 600000);

  beforeEach(async () => {
    await connection.db!.collection('notification_outbox').deleteMany({});
    await connection.db!.collection('notification_recipients').deleteMany({});
    await connection.db!.collection('notifications').deleteMany({});
  });

  afterAll(async () => {
    await context?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const outbox = (eventKey: string) => connection.db!.collection<OutboxDoc>('notification_outbox').findOne({ event_key: eventKey });

  async function createJob(): Promise<string> {
    const eventKey = `SERVICE_SALE_SETTLED:${new ObjectId().toHexString()}`;
    await transactions.run(session => notifications.persistBusinessEvent(session, {
      eventKey, title: 'Gói tập đã được kích hoạt', body: 'Gói Gym 1 tháng, mã giao dịch GD0001',
    }, [accountId]));
    return eventKey;
  }

  // Đưa job về trạng thái DEAD như sau khi hết retry (ghi thẳng DB để không phụ thuộc cách worker chạy).
  async function makeDead(eventKey: string) {
    await connection.db!.collection('notification_outbox').updateOne({ event_key: eventKey },
      { $set: { status: 'DEAD', attempts: 6, last_error_code: 'DISPATCH_FAILED' } });
  }

  // ---------- EN-03-TC18: chỉ HTTP server chạy worker ----------
  describe('EN-03-TC18: worker chỉ tự chạy trong HTTP server', () => {
    it('EN-03-TC18: app context (như lệnh CLI) ở NODE_ENV=development KHÔNG tự chạy worker, job vẫn READY sau hơn một tick', async () => {
      const eventKey = await createJob();

      await wait(6500);

      expect((await outbox(eventKey))!.status).toBe('READY');
    }, 15000);

    it('EN-03-TC18: HTTP server thật (dist/main.js) tự chạy worker, job READY thành DONE trong khoảng một tick', async () => {
      const eventKey = await createJob();
      let server: ChildProcess | undefined;
      try {
        server = spawn(process.execPath, ['dist/main.js'], { env: process.env, windowsHide: true });
        // Server cần vài giây để khởi động, cộng 5 giây một tick: chờ tối đa 15 giây, hỏi DB mỗi 250 ms.
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && (await outbox(eventKey))!.status !== 'DONE') await wait(250);
      } finally {
        server?.kill();
      }

      expect((await outbox(eventKey))!.status).toBe('DONE');
    }, 30000);
  });

  // ---------- EN-03-TC08, EN-03-TC20: lệnh vận hành retry-notification ----------
  describe('EN-03-TC08, EN-03-TC20: lệnh node scripts/admin.cjs retry-notification <eventKey>', () => {
    it('EN-03-TC08: job DEAD thì lệnh thoát mã 0 và job về READY, giữ nguyên _id, eventKey, notification', async () => {
      const eventKey = await createJob();
      await makeDead(eventKey);
      const before = await outbox(eventKey);

      const result = await runProcess(['scripts/admin.cjs', 'retry-notification', eventKey]);

      expect(result.code).toBe(0);
      const after = await outbox(eventKey);
      expect(after!.status).toBe('READY');
      expect(after!._id.toHexString()).toBe(before!._id.toHexString());
      expect(after!.event_key).toBe(eventKey);
      expect(after!.notification_id.toHexString()).toBe(before!.notification_id.toHexString());
    }, 30000);

    it('EN-03-TC20: eventKey không tồn tại thì in NOTIFICATION_OUTBOX_NOT_FOUND và thoát mã 1, không lộ URI hay stack', async () => {
      const result = await runProcess(['scripts/admin.cjs', 'retry-notification', `SERVICE_SALE_SETTLED:${new ObjectId().toHexString()}`]);

      expect(result.code).toBe(1);
      expect(result.output).toContain('NOTIFICATION_OUTBOX_NOT_FOUND');
      expect(result.output).not.toContain('mongodb://');
      expect(result.output).not.toContain('    at ');
    }, 30000);

    it('EN-03-TC20: job không ở DEAD (READY) thì in NOTIFICATION_OUTBOX_NOT_DEAD, thoát mã 1 và job giữ nguyên', async () => {
      const eventKey = await createJob();
      const before = await outbox(eventKey);

      const result = await runProcess(['scripts/admin.cjs', 'retry-notification', eventKey]);

      expect(result.code).toBe(1);
      expect(result.output).toContain('NOTIFICATION_OUTBOX_NOT_DEAD');
      expect(await outbox(eventKey)).toEqual(before);
    }, 30000);
  });
});
