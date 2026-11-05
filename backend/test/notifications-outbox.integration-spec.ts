// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ): EN-03 bước 2.
// Kiểm tra outbox worker: lease 30 giây, crash rồi xử lý lại, retry 10/30/60/120/300 giây, DEAD và retry vận hành (TC05–TC08).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { PasswordService } from '../src/common/security/password.service';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { UsersRepository } from '../src/modules/users/users.repository';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
// Hợp đồng test đặt ra cho Builder (EN-03 bước 2):
//   NotificationDispatcher (src/modules/notifications/notification-dispatcher.ts), provider của NotificationsModule:
//     dispatch(message: { notification: { id, eventKey, title, body, createdAt }, recipientAccountIds: string[] }): Promise<void>
//     Bước 2 chưa có socket nên thân hàm mặc định không làm gì; bước 3 gateway thay phần thân. Ném lỗi = lượt dispatch thất bại.
//   NotificationOutboxService (src/modules/notifications/notification-outbox.service.ts):
//     runOnce(): Promise<number>  một lượt tick: nhận tối đa 50 job đến hạn, dispatch, rồi DONE hoặc hẹn retry/DEAD.
//     retryDead(eventKey: string): Promise<void>  công cụ vận hành: đưa job DEAD về READY, giữ nguyên eventKey và notification.
//   NODE_ENV=test thì worker KHÔNG tự chạy tick theo chu kỳ; test tự gọi runOnce().
//   Thời gian lấy theo đồng hồ ứng dụng (new Date()), test "tua giờ" bằng cách sửa available_at/lease_until trong DB.
import { NotificationDispatcher } from '../src/modules/notifications/notification-dispatcher';
import { NotificationOutboxService } from '../src/modules/notifications/notification-outbox.service';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_en03_outbox';
// Spec mục 2: retry lỗi tại 10, 30, 60, 120, 300 giây; sau lần retry cuối vẫn lỗi thì DEAD.
const RETRY_DELAYS_SECONDS = [10, 30, 60, 120, 300];
const LEASE_SECONDS = 30;

type OutboxDoc = {
  _id: ObjectId; event_key: string; notification_id: ObjectId; status: string; attempts: number;
  available_at: Date; lease_until?: Date; lease_owner?: string; completed_at?: Date; last_error_code?: string;
};

describe('EN-03 bước 2: outbox worker với lease, attempts và retry DEAD', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  let notifications: NotificationsService;
  let transactions: TransactionRunner;
  let worker: NotificationOutboxService;
  let dispatcher: NotificationDispatcher;
  let dispatchSpy: jest.SpyInstance;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName } });
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
      SMTP_USER: 'en03-test', SMTP_PASS: 'en03-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http');
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    notifications = app.get(NotificationsService);
    transactions = app.get(TransactionRunner);
    worker = app.get(NotificationOutboxService);
    dispatcher = app.get(NotificationDispatcher);
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Chỉ xóa dữ liệu, giữ index.
    for (const collection of await connection.db!.collections()) await collection.deleteMany({});
    // Mặc định dispatch thành công (người nhận offline cũng là thành công: không có socket nào để gửi).
    dispatchSpy = jest.spyOn(dispatcher, 'dispatch').mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const outbox = (eventKey: string) => db().collection<OutboxDoc>('notification_outbox').findOne({ event_key: eventKey });
  const setOutbox = (eventKey: string, fields: Partial<OutboxDoc>) =>
    db().collection<OutboxDoc>('notification_outbox').updateOne({ event_key: eventKey }, { $set: fields });
  // "Tua giờ": cho job đến hạn ngay bây giờ thay vì chờ thật 10–300 giây.
  const makeDue = (eventKey: string) => setOutbox(eventKey, { available_at: new Date(Date.now() - 1000) });

  let phoneSeq = 0;
  async function createMember(): Promise<string> {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole('MEMBER', 'MEMBER');
    const passwordHash = await app.get(PasswordService).hash('MậtKhẩuEN-03-123');
    phoneSeq += 1;
    const account = await users.createAccount({
      roleId: role.id.toHexString(), phone: `09150000${String(phoneSeq).padStart(2, '0')}`, fullName: `EN03 Outbox ${phoneSeq}`, passwordHash,
    });
    return account.id.toHexString();
  }

  // Tạo một job outbox READY bằng đường thật của bước 1 (persistBusinessEvent trong transaction).
  async function createJob() {
    const accountId = await createMember();
    const source = {
      eventKey: `SERVICE_SALE_SETTLED:${new ObjectId().toHexString()}`,
      title: 'Gói tập đã được kích hoạt',
      body: 'Gói Gym 1 tháng, hạn dùng đến 2026-12-04, mã giao dịch GD0001',
      memberId: new ObjectId().toHexString(),
      transactionId: new ObjectId().toHexString(),
    };
    const result = await transactions.run(session => notifications.persistBusinessEvent(session, source, [accountId]));
    return { accountId, eventKey: source.eventKey, title: source.title, body: source.body, notificationId: result.notificationId };
  }

  // Cho dispatch lỗi liên tục và chạy đủ 1 lần đầu + 5 lần retry để job thành DEAD.
  async function driveToDead(eventKey: string, error: Error = new Error('Gateway lỗi giả lập')) {
    dispatchSpy.mockRejectedValue(error);
    for (let attempt = 1; attempt <= RETRY_DELAYS_SECONDS.length + 1; attempt += 1) {
      await worker.runOnce();
      await makeDue(eventKey);
    }
  }

  // ---------- EN-03-TC05: worker crash sau claim, trước emit ----------
  describe('EN-03-TC05: lease hết thì worker khác xử lý lại', () => {
    it('EN-03-TC05: khi đang dispatch, job ở PROCESSING có lease_owner và lease_until khoảng now + 30 giây', async () => {
      const job = await createJob();
      let seen: OutboxDoc | null = null;
      let before = 0;
      dispatchSpy.mockImplementation(async () => { seen = await outbox(job.eventKey); });

      before = Date.now();
      await worker.runOnce();
      const after = Date.now();

      expect(seen).not.toBeNull();
      const claimed = seen as unknown as OutboxDoc;
      expect(claimed.status).toBe('PROCESSING');
      expect(typeof claimed.lease_owner).toBe('string');
      expect(claimed.lease_owner!.length).toBeGreaterThan(0);
      expect(claimed.lease_until!.getTime()).toBeGreaterThanOrEqual(before + LEASE_SECONDS * 1000 - 1000);
      expect(claimed.lease_until!.getTime()).toBeLessThanOrEqual(after + LEASE_SECONDS * 1000 + 1000);
    });

    it('EN-03-TC05: job PROCESSING của worker đã crash, lease đã hết, được lấy lại, dispatch một lần rồi DONE', async () => {
      const job = await createJob();
      // Trạng thái để lại khi worker cũ crash sau claim, trước emit.
      await setOutbox(job.eventKey, { status: 'PROCESSING', lease_owner: 'worker-da-crash', lease_until: new Date(Date.now() - 1000) });

      await worker.runOnce();

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const done = await outbox(job.eventKey);
      expect(done!.status).toBe('DONE');
      expect(done!.completed_at).toBeInstanceOf(Date);
    });

    it('EN-03-TC05: job PROCESSING mà lease còn hạn thì worker khác KHÔNG lấy, giữ nguyên chủ lease', async () => {
      const job = await createJob();
      const leaseUntil = new Date(Date.now() + 20_000);
      await setOutbox(job.eventKey, { status: 'PROCESSING', lease_owner: 'worker-dang-chay', lease_until: leaseUntil });

      await worker.runOnce();

      expect(dispatchSpy).not.toHaveBeenCalled();
      const still = await outbox(job.eventKey);
      expect(still!.status).toBe('PROCESSING');
      expect(still!.lease_owner).toBe('worker-dang-chay');
      expect(still!.lease_until!.getTime()).toBe(leaseUntil.getTime());
    });

    it('EN-03-TC05: worker mất lease trong lúc dispatch (worker khác đã lấy) thì không được ghi DONE', async () => {
      const job = await createJob();
      dispatchSpy.mockImplementation(async () => {
        // Giả lập: lease của worker này đã hết và worker khác vừa nhận job.
        await setOutbox(job.eventKey, { lease_owner: 'worker-khac', lease_until: new Date(Date.now() + 30_000) });
      });

      await worker.runOnce();

      const after = await outbox(job.eventKey);
      expect(after!.status).toBe('PROCESSING');
      expect(after!.lease_owner).toBe('worker-khac');
      expect(after!.completed_at ?? null).toBeNull();
    });

    it('EN-03-TC05: hai lượt tick chạy song song chỉ một bên nhận được job, dispatch đúng một lần', async () => {
      await createJob();
      dispatchSpy.mockImplementation(() => new Promise<void>(resolve => setTimeout(resolve, 50)));

      await Promise.all([worker.runOnce(), worker.runOnce()]);

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- EN-03-TC06: crash sau emit, trước DONE ----------
  it('EN-03-TC06: crash sau emit trước DONE thì lượt sau emit lại cùng notification id rồi DONE', async () => {
    const job = await createJob();
    const emittedIds: string[] = [];
    dispatchSpy.mockImplementationOnce(async (message: { notification: { id: string } }) => {
      emittedIds.push(message.notification.id);
      // Đã emit xong nhưng worker "chết" trước khi ghi DONE: lease bị bỏ lại và hết hạn.
      await setOutbox(job.eventKey, { lease_owner: 'worker-da-crash', lease_until: new Date(Date.now() - 1000) });
    });
    dispatchSpy.mockImplementation(async (message: { notification: { id: string } }) => { emittedIds.push(message.notification.id); });

    await worker.runOnce();
    expect((await outbox(job.eventKey))!.status).not.toBe('DONE');
    await worker.runOnce();

    // Phát lại được phép; cả hai lần mang cùng id để client gộp (dedupe) thành một thông báo.
    expect(emittedIds).toEqual([job.notificationId, job.notificationId]);
    expect((await outbox(job.eventKey))!.status).toBe('DONE');
    expect(await db().collection('notifications').countDocuments()).toBe(1);
  });

  // ---------- EN-03-TC07: socket người nhận offline ----------
  describe('EN-03-TC07: người nhận offline không làm mất thông báo', () => {
    it('EN-03-TC07: dispatch nhận đúng nội dung và đúng người nhận của thông báo', async () => {
      const job = await createJob();

      await worker.runOnce();

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const message = dispatchSpy.mock.calls[0][0] as { notification: Record<string, unknown>; recipientAccountIds: string[] };
      expect(message.notification).toMatchObject({ id: job.notificationId, eventKey: job.eventKey, title: job.title, body: job.body });
      expect(message.recipientAccountIds).toEqual([job.accountId]);
    });

    it('EN-03-TC07: không có socket nào nhận thì job vẫn DONE, notification và recipient còn nguyên, chưa có delivered_at', async () => {
      const job = await createJob();

      await worker.runOnce();

      const done = await outbox(job.eventKey);
      expect(done!.status).toBe('DONE');
      expect(done!.completed_at).toBeInstanceOf(Date);
      expect(await db().collection('notifications').countDocuments({ _id: new ObjectId(job.notificationId) })).toBe(1);
      const recipient = await db().collection('notification_recipients').findOne({ notification_id: new ObjectId(job.notificationId) });
      expect(recipient!.account_id.toHexString()).toBe(job.accountId);
      // delivered_at chỉ ghi khi client ack (bước 3), không suy ra từ việc dispatch/emit.
      expect(recipient!.delivered_at ?? null).toBeNull();
    });

    it('EN-03-TC07: job đã DONE thì lượt tick sau không dispatch lại', async () => {
      await createJob();

      await worker.runOnce();
      await worker.runOnce();

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- EN-03-TC08: lỗi liên tục đến hết retry ----------
  describe('EN-03-TC08: hết retry thì DEAD, retry vận hành không đổi eventKey', () => {
    it('EN-03-TC08: dispatch lỗi lần đầu thì job về READY, attempts 1, hẹn lại sau 10 giây và chưa chạy lại ngay', async () => {
      const job = await createJob();
      dispatchSpy.mockRejectedValue(new Error('Gateway lỗi giả lập'));

      const before = Date.now();
      await worker.runOnce();
      const after = Date.now();

      const failed = await outbox(job.eventKey);
      expect(failed!.status).toBe('READY');
      expect(failed!.attempts).toBe(1);
      expect(failed!.available_at.getTime()).toBeGreaterThanOrEqual(before + 10_000 - 1000);
      expect(failed!.available_at.getTime()).toBeLessThanOrEqual(after + 10_000 + 1000);

      await worker.runOnce();
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
    });

    it('EN-03-TC08: lỗi liên tục thì hẹn lại theo đúng lịch 10, 30, 60, 120, 300 giây', async () => {
      const job = await createJob();
      dispatchSpy.mockRejectedValue(new Error('Gateway lỗi giả lập'));

      for (let index = 0; index < RETRY_DELAYS_SECONDS.length; index += 1) {
        const delayMs = RETRY_DELAYS_SECONDS[index] * 1000;
        const before = Date.now();
        await worker.runOnce();
        const after = Date.now();

        const failed = await outbox(job.eventKey);
        expect(failed!.status).toBe('READY');
        expect(failed!.attempts).toBe(index + 1);
        expect(failed!.available_at.getTime()).toBeGreaterThanOrEqual(before + delayMs - 1000);
        expect(failed!.available_at.getTime()).toBeLessThanOrEqual(after + delayMs + 1000);
        await makeDue(job.eventKey);
      }
      expect(dispatchSpy).toHaveBeenCalledTimes(RETRY_DELAYS_SECONDS.length);
    });

    it('EN-03-TC08: sau lần retry cuối (lần thử thứ 6) vẫn lỗi thì DEAD, attempts 6 kiểu Int32', async () => {
      const job = await createJob();

      await driveToDead(job.eventKey);

      const dead = await outbox(job.eventKey);
      expect(dead!.status).toBe('DEAD');
      expect(dead!.attempts).toBe(RETRY_DELAYS_SECONDS.length + 1);
      expect(dispatchSpy).toHaveBeenCalledTimes(RETRY_DELAYS_SECONDS.length + 1);
      expect(await db().collection('notification_outbox').countDocuments({ _id: dead!._id, attempts: { $type: 'int' } })).toBe(1);
    });

    it('EN-03-TC08: DEAD lưu mã lỗi an toàn, không chứa message thô, stack hay secret', async () => {
      const job = await createJob();
      const leaky = new Error('connect failed mongodb://admin:MatKhauBiMat@db.local:27017 token=abc.def.ghi');

      await driveToDead(job.eventKey, leaky);

      const dead = await outbox(job.eventKey);
      expect(dead!.last_error_code).toMatch(/^[A-Z0-9_]{1,64}$/);
      const stored = JSON.stringify(dead);
      expect(stored).not.toContain('MatKhauBiMat');
      expect(stored).not.toContain('mongodb://');
      expect(stored).not.toContain('abc.def.ghi');
      expect(stored).not.toContain('    at ');
    });

    it('EN-03-TC08: job DEAD không được worker tự lấy lại nữa', async () => {
      const job = await createJob();
      await driveToDead(job.eventKey);
      dispatchSpy.mockClear();

      await worker.runOnce();

      expect(dispatchSpy).not.toHaveBeenCalled();
      expect((await outbox(job.eventKey))!.status).toBe('DEAD');
    });

    it('EN-03-TC08: retry vận hành theo eventKey đưa job về READY, giữ nguyên eventKey và notification', async () => {
      const job = await createJob();
      await driveToDead(job.eventKey);
      const dead = await outbox(job.eventKey);

      await worker.retryDead(job.eventKey);

      const retried = await outbox(job.eventKey);
      expect(retried!._id.toHexString()).toBe(dead!._id.toHexString());
      expect(retried!.status).toBe('READY');
      expect(retried!.event_key).toBe(job.eventKey);
      expect(retried!.notification_id.toHexString()).toBe(job.notificationId);
      expect(retried!.available_at.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('EN-03-TC08: sau retry vận hành, lượt tick sau gửi lại đúng notification cũ rồi DONE, không tạo thông báo hay eventKey mới', async () => {
      const job = await createJob();
      await driveToDead(job.eventKey);
      await worker.retryDead(job.eventKey);
      dispatchSpy.mockReset();
      dispatchSpy.mockResolvedValue(undefined);

      await worker.runOnce();

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const message = dispatchSpy.mock.calls[0][0] as { notification: { id: string; eventKey: string } };
      expect(message.notification.id).toBe(job.notificationId);
      expect(message.notification.eventKey).toBe(job.eventKey);
      expect((await outbox(job.eventKey))!.status).toBe('DONE');
      expect(await db().collection('notifications').countDocuments()).toBe(1);
      expect(await db().collection('notification_outbox').countDocuments()).toBe(1);
    });
  });
});
