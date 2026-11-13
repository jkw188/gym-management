// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật, có failpoint): US-47 bước 4.
// Kiểm tra đầu–cuối: thông báo từ giao dịch thật đọc được khi không có socket, ack/read độc lập, cách ly recipient, nội dung an toàn, lỗi DB.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng dùng lại từ bước 2 (spec mục 2) và EN-03:
//   GET /api/me/notifications, /unread-count, /:id; POST /:id/read (body {}).
//   Lỗi DB → 503 theo EN01-D03 {error:{code,message},requestId}, không trả lỗi DB thô (spec chưa chốt tên mã lỗi).
//   NotificationsService.persistBusinessEvent(session, {eventKey,title,body}, recipients) và acknowledge(accountId, id) của EN-03.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us47_inbox_e2e';
const password = 'MậtKhẩuUS-47-E2E-1';
const base = '/api/me/notifications';
const dbErrorText = 'Gia lap DB loi US-47-TC12';

describe('US-47 bước 4: inbox đầu–cuối, cách ly recipient và lỗi DB', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  let notifications: NotificationsService;
  let transactions: TransactionRunner;
  // Kết nối riêng chỉ để bật/tắt failpoint: lỗi giả lập làm driver của app tạm mất server, không được làm hỏng bước dọn dẹp.
  let control: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    // enableTestCommands=1 để dùng failpoint giả lập DB lỗi (US-47-TC12).
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
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'us47-test', SMTP_PASS: 'us47-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http');
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    notifications = app.get(NotificationsService);
    transactions = app.get(TransactionRunner);
    control = await mongoose.createConnection(mongo.getUri(), { runtimeAdapters: { os } }).asPromise();
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await connection.db!.collections()) {
      // Giữ roles và counter sequence (EN-03 cần counter global có sẵn).
      if (!['roles', 'notification_counters'].includes(collection.collectionName)) await collection.deleteMany({});
    }
  });

  afterEach(async () => {
    await recoverDatabase();
    jest.restoreAllMocks();
  });

  // Tắt failpoint rồi chờ kết nối của app dùng lại được (ping thành công) trước khi sang test sau.
  // Lưới an toàn: failOn dùng mã 1 nên driver không coi server mất, thường ping thành công ngay lần đầu.
  async function recoverDatabase() {
    await control.db!.admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        await connection.db!.admin().command({ ping: 1 });
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  afterAll(async () => {
    await control?.close();
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());

  let phoneSeq = 0;
  async function member() {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole('MEMBER', 'MEMBER');
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `09148000${String(phoneSeq).padStart(2, '0')}`;
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName: `US47 E2E ${phoneSeq}`, passwordHash });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { accountId: account.id.toHexString(), accessToken: response.body.accessToken as string };
  }

  // Thông báo đi đúng đường thật của EN-03: lưu trong transaction của lệnh nghiệp vụ, KHÔNG có socket, KHÔNG chạy worker.
  async function notifyReal(recipients: string[], content: { title?: string; body?: string } = {}) {
    const result = await transactions.run(session => notifications.persistBusinessEvent(session, {
      eventKey: `SERVICE_SALE_SETTLED:${new ObjectId().toHexString()}`,
      title: content.title ?? 'Gói tập đã được kích hoạt',
      body: content.body ?? 'Gói Gym 1 tháng, hạn dùng đến 2026-12-04, mã giao dịch GD0001',
    }, recipients));
    return result.notificationId.toString();
  }

  const get = (path: string, token: string) => http().get(`${base}${path}`).set('Origin', origin).set('Authorization', `Bearer ${token}`);
  const read = (id: string, token: string) =>
    http().post(`${base}/${id}/read`).set('Origin', origin).set('Authorization', `Bearer ${token}`).send({});
  const recipientOf = (notificationId: string, accountId: string) =>
    db().collection('notification_recipients').findOne({ notification_id: new ObjectId(notificationId), account_id: new ObjectId(accountId) });

  // Đếm document của mọi collection để chắc không có ghi phát sinh (sale, payment, outbox, notification mới…).
  async function documentCounts() {
    const counts: Record<string, number> = {};
    for (const collection of await db().collections()) counts[collection.collectionName] = await collection.countDocuments({});
    return counts;
  }

  function expectServiceUnavailable(response: request.Response) {
    expect(response.status).toBe(503);
    // Spec US-47 chỉ quy định 503, chưa chốt mã lỗi (dự án đang có DATABASE_UNAVAILABLE và SERVICE_UNAVAILABLE).
    expect(response.body).toMatchObject({ error: { code: expect.any(String), message: expect.any(String) }, requestId: expect.any(String) });
    expect(JSON.stringify(response.body)).not.toContain(dbErrorText);
    expect(JSON.stringify(response.body)).not.toMatch(/Mongo|failCommand|stack/i);
  }

  // Mã 1 (InternalError) là lỗi DB thường. Không dùng mã 91 (ShutdownInProgress): driver sẽ coi server đang tắt,
  // đánh dấu Unknown, tự retry lệnh đọc và transaction, chờ heartbeat tới 10 giây (giống EN-03-TC12 trước khi sửa).
  async function failOn(command: 'update' | 'aggregate' | 'find', collection: string) {
    await control.db!.admin().command({
      configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: [command], namespace: `${databaseName}.${collection}`, errorCode: 1, errmsg: dbErrorText },
    });
  }

  // ---------- US-47-AC03: offline ----------
  it('US-47-TC09: thông báo phát sinh từ giao dịch thật, không socket/không worker, vẫn đọc được qua REST', async () => {
    const a = await member();
    const id = await notifyReal([a.accountId], { title: 'Thanh toán thành công' });

    const list = await get('', a.accessToken).expect(200);
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([id]);
    expect(list.body.unreadCount).toBe(1);
    expect((await get(`/${id}`, a.accessToken).expect(200)).body).toMatchObject({ id, title: 'Thanh toán thành công' });
    expect((await get('/unread-count', a.accessToken).expect(200)).body.unreadCount).toBe(1);
  });

  // ---------- US-47-AC02: delivered và read độc lập ----------
  it('US-47-TC05: ack EN-03 thật chỉ ghi deliveredAt, inbox vẫn chưa đọc; read sau đó không đổi delivered_at', async () => {
    const a = await member();
    const id = await notifyReal([a.accountId]);

    await notifications.acknowledge(a.accountId, id);
    const deliveredAt = (await recipientOf(id, a.accountId))!.delivered_at as Date;

    const detail = (await get(`/${id}`, a.accessToken).expect(200)).body;
    expect(detail.deliveredAt).toBe(deliveredAt.toISOString());
    expect(detail.readAt ?? null).toBeNull();
    expect((await get('/unread-count', a.accessToken).expect(200)).body.unreadCount).toBe(1);

    await read(id, a.accessToken).expect(200);
    expect(((await recipientOf(id, a.accountId))!.delivered_at as Date).toISOString()).toBe(deliveredAt.toISOString());
  });

  // ---------- US-47-AC01/AC02: cách ly recipient ----------
  it('US-47-TC06: hai member cùng nhận một thông báo, A đọc thì B vẫn chưa đọc', async () => {
    const a = await member();
    const b = await member();
    const shared = await notifyReal([a.accountId, b.accountId]);

    const readA = await read(shared, a.accessToken).expect(200);

    expect((await get(`/${shared}`, a.accessToken).expect(200)).body.readAt).toBe(readA.body.readAt);
    const detailB = (await get(`/${shared}`, b.accessToken).expect(200)).body;
    expect(detailB.readAt ?? null).toBeNull();
    expect((await get('/unread-count', a.accessToken).expect(200)).body.unreadCount).toBe(0);
    expect((await get('/unread-count', b.accessToken).expect(200)).body.unreadCount).toBe(1);
  });

  it('US-47-TC02: member A không xem/đánh dấu được thông báo chỉ gửi cho B, kể cả qua giao dịch thật', async () => {
    const a = await member();
    const b = await member();
    const onlyB = await notifyReal([b.accountId]);

    expect((await get('', a.accessToken).expect(200)).body.total).toBe(0);
    await get(`/${onlyB}`, a.accessToken).expect(404);
    await read(onlyB, a.accessToken).expect(404);
    expect((await recipientOf(onlyB, b.accountId))!.read_at).toBeUndefined();
  });

  // ---------- US-47-TC10: không replay lệnh nghiệp vụ ----------
  it('US-47-TC10: đọc list/detail và read lặp lại nhiều lần không sinh document mới ở bất kỳ collection nào', async () => {
    const a = await member();
    const id = await notifyReal([a.accountId]);
    const notificationBefore = await db().collection('notifications').findOne({ _id: new ObjectId(id) });
    const before = await documentCounts();

    for (let index = 0; index < 3; index += 1) {
      await get('', a.accessToken).expect(200);
      await get(`/${id}`, a.accessToken).expect(200);
      await read(id, a.accessToken).expect(200);
    }

    expect(await documentCounts()).toEqual(before);
    expect(await db().collection('notifications').findOne({ _id: new ObjectId(id) })).toEqual(notificationBefore);
  });

  // ---------- US-47-TC11: nội dung an toàn, nguồn đã mất ----------
  it('US-47-TC11: body chứa HTML/URL ngoài được trả nguyên văn dạng chữ (server không dựng HTML, không đổi nội dung)', async () => {
    const a = await member();
    const body = 'Bấm <a href="https://evil.example/login">đây</a> <img src=x onerror=alert(1)> https://evil.example/pay';
    const id = await notifyReal([a.accountId], { title: '<b>Khuyến mãi</b>', body });

    const detail = (await get(`/${id}`, a.accessToken).expect(200)).body;
    expect(detail).toMatchObject({ title: '<b>Khuyến mãi</b>', body });
    expect(detail).not.toHaveProperty('redirectUrl');
    expect(detail).not.toHaveProperty('url');
  });

  it('US-47-TC11: nguồn đã mất (member_id/transaction_id trỏ tới bản ghi không còn) vẫn đọc được lịch sử', async () => {
    const a = await member();
    const _id = new ObjectId();
    await db().collection('notifications').insertOne({
      _id, id: _id, title: 'Giao dịch cũ', body: 'Giao dịch đã bị xóa khỏi hệ thống',
      event_key: `SERVICE_SALE_SETTLED:${new ObjectId().toHexString()}`, sequence: Long.fromBigInt(900000n),
      member_id: new ObjectId(), transaction_id: new ObjectId(), created_at: new Date(),
    });
    await db().collection('notification_recipients').insertOne({ notification_id: _id, account_id: new ObjectId(a.accountId) });

    expect((await get(`/${_id.toHexString()}`, a.accessToken).expect(200)).body).toMatchObject({ title: 'Giao dịch cũ' });
    await read(_id.toHexString(), a.accessToken).expect(200);
  });

  // ---------- US-47-TC12: lỗi DB ----------
  it('US-47-TC12: DB lỗi khi mark-read trả 503 an toàn, không ghi read_at; DB hồi phục thì đọc lại được', async () => {
    const a = await member();
    const id = await notifyReal([a.accountId]);
    await failOn('update', 'notification_recipients');

    expectServiceUnavailable(await read(id, a.accessToken));

    await recoverDatabase();
    expect((await recipientOf(id, a.accountId))!.read_at).toBeUndefined();
    expect((await get('/unread-count', a.accessToken).expect(200)).body.unreadCount).toBe(1);
    await read(id, a.accessToken).expect(200);
    expect((await get('/unread-count', a.accessToken).expect(200)).body.unreadCount).toBe(0);
  });

  it('US-47-TC12: DB lỗi khi đọc danh sách/đếm trả 503 an toàn, không trả số liệu giả', async () => {
    const a = await member();
    await notifyReal([a.accountId]);
    await failOn('aggregate', 'notification_recipients');

    expectServiceUnavailable(await get('', a.accessToken));
    expectServiceUnavailable(await get('/unread-count', a.accessToken));
  });

  it('US-47-TC12: DB lỗi khi xem chi tiết trả 503 an toàn, không phải 404', async () => {
    const a = await member();
    const id = await notifyReal([a.accountId]);
    await failOn('find', 'notification_recipients');

    expectServiceUnavailable(await get(`/${id}`, a.accessToken));
  });
});
