// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ): EN-03 bước 1.
// Kiểm tra persistBusinessEvent lưu notification + recipients + outbox cùng transaction nghiệp vụ (TC01–TC04), index và sequence.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { ClientSession, MongoServerError, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { PasswordService } from '../src/common/security/password.service';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng test đặt ra cho Builder (EN-03 bước 1):
//   NotificationsService.persistBusinessEvent(session, source, recipients)
//   source = { eventKey, title, body, memberId?, transactionId?, createdBy? } (id dạng chuỗi ObjectId)
//   recipients = danh sách accountId (chuỗi ObjectId), có thể rỗng
//   trả về { notificationId: string, notificationState: 'STORED' | 'NO_LINKED_ACCOUNT' }
import { NotificationsService } from '../src/modules/notifications/notifications.service';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_en03_persist';

type EventSource = { eventKey: string; title: string; body: string; memberId?: string; transactionId?: string; createdBy?: string };

describe('EN-03 bước 1: persistBusinessEvent lưu thông báo cùng transaction', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  let notifications: NotificationsService;
  let transactions: TransactionRunner;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    // enableTestCommands=1 để dùng failpoint failCommand giả lập lỗi insert thật ở MongoDB (EN-03-TC03).
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName, args: ['--setParameter', 'enableTestCommands=1'] },
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
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Chỉ xóa dữ liệu, giữ index (unique index phải còn để test có ý nghĩa).
    for (const collection of await connection.db!.collections()) await collection.deleteMany({});
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // Luôn tắt failpoint để test sau không bị ảnh hưởng.
    await connection.db!.admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const count = (name: string, filter: Record<string, unknown> = {}) => db().collection(name).countDocuments(filter);

  // Tạo account MEMBER thật để làm người nhận.
  let phoneSeq = 0;
  async function createMember(): Promise<string> {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole('MEMBER', 'MEMBER');
    const passwordHash = await app.get(PasswordService).hash('MậtKhẩuEN-03-123');
    phoneSeq += 1;
    const account = await users.createAccount({
      roleId: role.id.toHexString(), phone: `09140000${String(phoneSeq).padStart(2, '0')}`, fullName: `EN03 Member ${phoneSeq}`, passwordHash,
    });
    return account.id.toHexString();
  }

  function saleEvent(overrides: Partial<EventSource> = {}): EventSource {
    const saleId = new ObjectId().toHexString();
    return {
      eventKey: `SERVICE_SALE_SETTLED:${saleId}`,
      title: 'Gói tập đã được kích hoạt',
      body: 'Gói Gym 1 tháng, hạn dùng đến 2026-12-04, mã giao dịch GD0001',
      memberId: new ObjectId().toHexString(),
      transactionId: new ObjectId().toHexString(),
      ...overrides,
    };
  }

  // "Lệnh thanh toán giả": ghi một payment trong session rồi lưu thông báo trong CÙNG session.
  async function settle(source: EventSource, recipients: string[], afterPersist?: () => void) {
    return transactions.run(async (session: ClientSession) => {
      await db().collection('payments').insertOne({ transaction_id: source.transactionId,
        reference: new ObjectId().toHexString(), amount: '500000' }, { session });
      const result = await notifications.persistBusinessEvent(session, source, recipients);
      afterPersist?.();
      return result;
    });
  }

  // ---------- Chuẩn bị của bước 1: index và counter được tạo trước khi nhận ghi ----------
  describe('EN-03 bước 1: index theo mục 2 của spec', () => {
    async function indexes(name: string) {
      return db().collection(name).listIndexes().toArray();
    }
    const hasIndex = (list: Array<{ key: Record<string, number>; unique?: boolean }>, key: Record<string, number>, unique: boolean) =>
      list.some(index => JSON.stringify(index.key) === JSON.stringify(key) && Boolean(index.unique) === unique);

    it('EN-03-TC02: notifications có unique event_key và unique sequence', async () => {
      const list = await indexes('notifications');
      expect(hasIndex(list, { event_key: 1 }, true)).toBe(true);
      expect(hasIndex(list, { sequence: 1 }, true)).toBe(true);
    });

    it('EN-03-TC02: notification_recipients có unique (notification_id, account_id) và index (account_id, notification_id)', async () => {
      const list = await indexes('notification_recipients');
      expect(hasIndex(list, { notification_id: 1, account_id: 1 }, true)).toBe(true);
      expect(hasIndex(list, { account_id: 1, notification_id: 1 }, false)).toBe(true);
    });

    it('EN-03-TC01: notifications có unique id (mục 4.2.32 và spec "Giữ _id/id")', async () => {
      const list = await indexes('notifications');
      expect(hasIndex(list, { id: 1 }, true)).toBe(true);
    });

    it('EN-03-TC02: notification_outbox có unique event_key và index worker (status, available_at, lease_until)', async () => {
      const list = await indexes('notification_outbox');
      expect(hasIndex(list, { event_key: 1 }, true)).toBe(true);
      expect(hasIndex(list, { status: 1, available_at: 1, lease_until: 1 }, false)).toBe(true);
    });
  });

  // ---------- EN-03-TC01: hoàn tất sale có account liên kết ----------
  it('EN-03-TC01: lưu đúng một notification, một recipient và một outbox cùng commit với payment', async () => {
    const accountId = await createMember();
    const source = saleEvent();

    const result = await settle(source, [accountId]);

    expect(result.notificationState).toBe('STORED');
    expect(result.notificationId).toMatch(/^[0-9a-f]{24}$/);
    expect(await count('payments')).toBe(1);
    expect(await count('notifications')).toBe(1);
    expect(await count('notification_recipients')).toBe(1);
    expect(await count('notification_outbox')).toBe(1);
  });

  it('EN-03-TC01: notification lưu đúng nội dung, nguồn truy vết và sequence kiểu Int64', async () => {
    const accountId = await createMember();
    const source = saleEvent();

    const result = await settle(source, [accountId]);
    const saved = await db().collection('notifications').findOne({ _id: new ObjectId(result.notificationId) });

    expect(saved).toMatchObject({ event_key: source.eventKey, title: source.title, body: source.body });
    expect(saved!.member_id.toHexString()).toBe(source.memberId);
    expect(saved!.transaction_id.toHexString()).toBe(source.transactionId);
    expect(saved!.created_at).toBeInstanceOf(Date);
    expect(await count('notifications', { _id: saved!._id, sequence: { $type: 'long' } })).toBe(1);
  });

  it('EN-03-TC01: notification có field id kiểu ObjectId bằng đúng _id', async () => {
    const accountId = await createMember();

    const result = await settle(saleEvent(), [accountId]);
    const saved = await db().collection('notifications').findOne({ _id: new ObjectId(result.notificationId) });

    expect(saved!.id).toBeInstanceOf(ObjectId);
    expect(saved!.id.toHexString()).toBe(saved!._id.toHexString());
  });

  it('EN-03-TC01: recipient trỏ đúng notification và account, chưa có read_at và delivered_at', async () => {
    const accountId = await createMember();

    const result = await settle(saleEvent(), [accountId]);
    const recipient = await db().collection('notification_recipients').findOne({});

    expect(recipient!.notification_id.toHexString()).toBe(result.notificationId);
    expect(recipient!.account_id.toHexString()).toBe(accountId);
    expect(recipient!.read_at ?? null).toBeNull();
    expect(recipient!.delivered_at ?? null).toBeNull();
  });

  it('EN-03-TC01: outbox ở trạng thái READY, attempts 0 kiểu Int32, cùng event_key, sẵn sàng xử lý ngay', async () => {
    const accountId = await createMember();
    const source = saleEvent();
    const before = Date.now();

    const result = await settle(source, [accountId]);
    const outbox = await db().collection('notification_outbox').findOne({});

    expect(outbox).toMatchObject({ event_key: source.eventKey, status: 'READY', attempts: 0 });
    expect(outbox!.notification_id.toHexString()).toBe(result.notificationId);
    expect(outbox!.available_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(outbox!.available_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await count('notification_outbox', { _id: outbox!._id, attempts: { $type: 'int' } })).toBe(1);
  });

  it('EN-03-TC01: nhiều người nhận thì mỗi account đúng một recipient', async () => {
    const first = await createMember();
    const second = await createMember();

    await settle(saleEvent(), [first, second]);

    expect(await count('notification_recipients')).toBe(2);
    expect(await count('notification_recipients', { account_id: new ObjectId(first) })).toBe(1);
    expect(await count('notification_recipients', { account_id: new ObjectId(second) })).toBe(1);
  });

  it('EN-03-TC01: sequence của thông báo commit sau lớn hơn thông báo commit trước, counter global là Int64', async () => {
    const accountId = await createMember();

    const first = await settle(saleEvent(), [accountId]);
    const second = await settle(saleEvent(), [accountId]);
    const a = await db().collection('notifications').findOne({ _id: new ObjectId(first.notificationId) });
    const b = await db().collection('notifications').findOne({ _id: new ObjectId(second.notificationId) });

    expect(BigInt(b!.sequence.toString())).toBeGreaterThan(BigInt(a!.sequence.toString()));
    const counter = await db().collection<{ _id: string; value: unknown }>('notification_counters').findOne({ _id: 'global' });
    expect(counter).not.toBeNull();
    expect(await count('notification_counters', { _id: 'global', value: { $type: 'long' } })).toBe(1);
    expect(BigInt(String(counter!.value))).toBeGreaterThanOrEqual(BigInt(b!.sequence.toString()));
  });

  // ---------- EN-03-TC02: callback retry hoặc confirm cùng key hai lần ----------
  it('EN-03-TC02: driver chạy lại callback (lỗi tạm thời) thì vẫn chỉ có một notification, recipient, outbox', async () => {
    const accountId = await createMember();
    const source = saleEvent();
    let attempts = 0;

    await settle(source, [accountId], () => {
      attempts += 1;
      // Lần đầu giả lập lỗi tạm thời sau khi đã lưu: driver abort và chạy lại toàn bộ callback.
      if (attempts === 1) throw new MongoServerError({ message: 'Giả lập lỗi tạm thời', errorLabels: ['TransientTransactionError'] });
    });

    expect(attempts).toBe(2);
    expect(await count('payments')).toBe(1);
    expect(await count('notifications', { event_key: source.eventKey })).toBe(1);
    expect(await count('notification_recipients')).toBe(1);
    expect(await count('notification_outbox', { event_key: source.eventKey })).toBe(1);
  });

  it('EN-03-TC02: lưu lại cùng eventKey lần hai không tạo thêm và không đổi body/recipient đã commit', async () => {
    const first = await createMember();
    const other = await createMember();
    const source = saleEvent();
    const original = await settle(source, [first]);

    const again = await transactions.run(session =>
      notifications.persistBusinessEvent(session, { ...source, title: 'Tiêu đề khác', body: 'Nội dung khác' }, [other]));

    expect(again.notificationId).toBe(original.notificationId);
    expect(await count('notifications')).toBe(1);
    expect(await count('notification_outbox')).toBe(1);
    const saved = await db().collection('notifications').findOne({});
    expect(saved).toMatchObject({ title: source.title, body: source.body });
    const recipients = await db().collection('notification_recipients').find({}).toArray();
    expect(recipients.map(r => r.account_id.toHexString())).toEqual([first]);
  });

  // ---------- EN-03-TC03: lỗi insert outbox/recipient trước commit ----------
  it('EN-03-TC03: lỗi sau khi lưu thông báo (trước commit) thì rollback cả payment lẫn thông báo', async () => {
    const accountId = await createMember();

    const failure = await settle(saleEvent(), [accountId], () => { throw new Error('Lỗi nghiệp vụ giả lập trước commit'); })
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(await count('payments')).toBe(0);
    expect(await count('notifications')).toBe(0);
    expect(await count('notification_recipients')).toBe(0);
    expect(await count('notification_outbox')).toBe(0);
  });

  it('EN-03-TC03: insert outbox bị lỗi (trùng event_key) thì rollback payment, không có notification mồ côi', async () => {
    const accountId = await createMember();
    const source = saleEvent();
    // Một outbox lạc có sẵn cùng event_key làm lệnh insert outbox của lần lưu này vi phạm unique index.
    await db().collection('notification_outbox').insertOne({
      event_key: source.eventKey, notification_id: new ObjectId(), status: 'DONE', attempts: 0, available_at: new Date(),
    });

    const failure = await settle(source, [accountId]).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeDefined();
    expect(await count('payments')).toBe(0);
    expect(await count('notifications')).toBe(0);
    expect(await count('notification_recipients')).toBe(0);
    expect(await count('notification_outbox')).toBe(1); // chỉ còn bản lạc có sẵn
  });

  it('EN-03-TC03: insert recipient bị lỗi (account_id không phải ObjectId) thì rollback payment và notification', async () => {
    const failure = await settle(saleEvent(), ['khong-phai-object-id']).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeDefined();
    expect(await count('payments')).toBe(0);
    expect(await count('notifications')).toBe(0);
    expect(await count('notification_recipients')).toBe(0);
    expect(await count('notification_outbox')).toBe(0);
  });

  // Bật failpoint: lệnh insert kế tiếp vào collection `name` bị MongoDB trả lỗi (không phải lỗi tạm thời nên không retry).
  async function failNextInsertInto(name: string) {
    await db().admin().command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['insert'], namespace: `${databaseName}.${name}`, errorCode: 2, errmsg: 'Giả lập lỗi insert EN-03-TC03' },
    });
  }

  it('EN-03-TC03: insert recipient bị MongoDB từ chối (sau khi đã ghi notification) thì rollback payment và notification', async () => {
    const accountId = await createMember();
    await failNextInsertInto('notification_recipients');

    const failure = await settle(saleEvent(), [accountId]).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeDefined();
    expect(await count('payments')).toBe(0);
    expect(await count('notifications')).toBe(0);
    expect(await count('notification_recipients')).toBe(0);
    expect(await count('notification_outbox')).toBe(0);
  });

  it('EN-03-TC03: insert outbox bị MongoDB từ chối thì rollback payment, notification và recipient', async () => {
    const accountId = await createMember();
    await failNextInsertInto('notification_outbox');

    const failure = await settle(saleEvent(), [accountId]).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeDefined();
    expect(await count('payments')).toBe(0);
    expect(await count('notifications')).toBe(0);
    expect(await count('notification_recipients')).toBe(0);
    expect(await count('notification_outbox')).toBe(0);
  });

  // ---------- EN-03-TC04: sale không có account liên kết, liên kết sau đó ----------
  it('EN-03-TC04: không có account thì vẫn lưu notification với member_id, recipients rỗng, trạng thái NO_LINKED_ACCOUNT', async () => {
    const source = saleEvent();

    const result = await settle(source, []);

    expect(result.notificationState).toBe('NO_LINKED_ACCOUNT');
    const saved = await db().collection('notifications').findOne({ _id: new ObjectId(result.notificationId) });
    expect(saved!.member_id.toHexString()).toBe(source.memberId);
    expect(await count('notification_recipients')).toBe(0);
    expect(await count('payments')).toBe(1);
  });

  it('EN-03-TC04: liên kết account sau đó rồi lưu lại cùng eventKey không tự thêm recipient cho lịch sử', async () => {
    const source = saleEvent();
    await settle(source, []);
    const linkedLater = await createMember();

    const again = await transactions.run(session => notifications.persistBusinessEvent(session, source, [linkedLater]));

    expect(await count('notifications')).toBe(1);
    expect(await count('notification_recipients')).toBe(0);
    expect(again.notificationState).toBe('NO_LINKED_ACCOUNT');
  });
});
