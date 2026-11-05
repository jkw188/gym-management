// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-47 bước 2.
// Kiểm tra 4 endpoint inbox /api/me/notifications qua HTTP: DTO, mã lỗi, quyền MEMBER và index lọc trạng thái đọc.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng test đặt ra cho Builder (US-47 bước 2, theo mục 2 của spec):
//   GET  /api/me/notifications?readState=ALL|UNREAD|READ&page&limit  (mặc định ALL, 1, 20; limit 1–100)
//        -> 200 {items:[{id,title,bodyPreview,createdAt,readAt?,deliveredAt?,source?}],page,limit,total,totalPages,unreadCount,asOf}
//   GET  /api/me/notifications/unread-count -> 200 {unreadCount, asOf}
//   GET  /api/me/notifications/:id          -> 200 {id,title,body,createdAt,readAt?,deliveredAt?,source?}
//   POST /api/me/notifications/:id/read     body {} -> 200 {id, readAt}
//   Lỗi theo EN01-D03 {error:{code,message,details?},requestId}: 400 dữ liệu sai (D01: INVALID_ID), 401, 403, 404 NOT_FOUND.
//   Chỉ role MEMBER; index (account_id, read_at, notification_id) trên notification_recipients.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us47_inbox_api';
const password = 'MậtKhẩuUS-47-123';
const base = '/api/me/notifications';

type Item = { id: string; title: string; bodyPreview: string; createdAt: string; readAt?: string; deliveredAt?: string };
type ListBody = { items: Item[]; page: number; limit: number; total: number; totalPages: number; unreadCount: number; asOf: string };

describe('US-47 bước 2: API inbox thông báo /api/me/notifications', () => {
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
      SMTP_USER: 'us47-test', SMTP_PASS: 'us47-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http');
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Bộ giới hạn đăng nhập (US-02) lưu trong bộ nhớ: mỗi test dùng bộ mới để không bị 429 khi đăng nhập nhiều lần.
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    // Chỉ xóa dữ liệu, giữ index.
    for (const collection of await connection.db!.collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());
  const newId = () => new ObjectId().toHexString();

  // ---------- Chuẩn bị: account thật theo role, đăng nhập thật qua API US-02 ----------
  let phoneSeq = 0;
  async function login(roleCode: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN' = 'MEMBER') {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `09147000${String(phoneSeq).padStart(2, '0')}`;
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName: `US47 API ${phoneSeq}`, passwordHash });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { accountId: account.id.toHexString(), accessToken: response.body.accessToken as string };
  }

  // Ghi thẳng một thông báo theo schema EN-03 (sequence Int64) để test điều khiển được thứ tự.
  let sequenceSeed = 5000n;
  async function seedNotification(options: { title?: string; body?: string } = {}) {
    const _id = new ObjectId();
    sequenceSeed += 1n;
    await db().collection('notifications').insertOne({
      _id,
      id: _id,
      title: options.title ?? 'Gói tập đã được kích hoạt',
      body: options.body ?? 'Gói Gym 1 tháng, hạn dùng đến 2026-12-04, mã giao dịch GD0001',
      event_key: `SERVICE_SALE_SETTLED:${newId()}`,
      sequence: Long.fromBigInt(sequenceSeed),
      created_at: new Date(),
    });
    return _id.toHexString();
  }

  async function addRecipient(notificationId: string, accountId: string, readAt?: Date) {
    await db().collection('notification_recipients').insertOne({
      notification_id: new ObjectId(notificationId),
      account_id: new ObjectId(accountId),
      ...(readAt ? { read_at: readAt } : {}),
    });
  }

  const recipientOf = (notificationId: string, accountId: string) =>
    db().collection('notification_recipients').findOne({ notification_id: new ObjectId(notificationId), account_id: new ObjectId(accountId) });

  const get = (path: string, token?: string, query: Record<string, string> = {}) => {
    const call = http().get(`${base}${path}`).query(query).set('Origin', origin);
    if (token) call.set('Authorization', `Bearer ${token}`);
    return call;
  };
  const post = (path: string, token?: string, body: Record<string, unknown> = {}) => {
    const call = http().post(`${base}${path}`).set('Origin', origin);
    if (token) call.set('Authorization', `Bearer ${token}`);
    return call.send(body);
  };

  // Định dạng lỗi chung EN01-D03.
  const errorBody = (code?: string) => ({
    error: { code: code ?? expect.any(String), message: expect.any(String) },
    requestId: expect.any(String),
  });

  // ---------- US-47-AC01: đúng recipient và role ----------
  describe('US-47-AC01: inbox/chi tiết chỉ đúng recipient và role', () => {
    it('US-47-TC01: GET list mặc định ALL, page 1, limit 20, chỉ trả thông báo của account hiện hành', async () => {
      const me = await login();
      const other = newId();
      const mine = await seedNotification({ title: 'Của tôi' });
      const notMine = await seedNotification({ title: 'Của người khác' });
      await addRecipient(mine, me.accountId);
      await addRecipient(notMine, other);

      const response = await get('', me.accessToken).expect(200);
      const body = response.body as ListBody;

      expect(body).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1, unreadCount: 1 });
      expect(Number.isNaN(Date.parse(body.asOf))).toBe(false);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ id: mine, title: 'Của tôi', bodyPreview: expect.any(String) });
      expect(Number.isNaN(Date.parse(body.items[0].createdAt))).toBe(false);
      expect(body.items[0]).not.toHaveProperty('body');
    });

    it('US-47-TC01: GET unread-count trả {unreadCount, asOf}, không bị hiểu nhầm thành :id', async () => {
      const me = await login();
      const unread = await seedNotification();
      const read = await seedNotification();
      await addRecipient(unread, me.accountId);
      await addRecipient(read, me.accountId, new Date('2026-11-01T00:00:00Z'));

      const response = await get('/unread-count', me.accessToken).expect(200);

      expect(response.body).toMatchObject({ unreadCount: 1 });
      expect(Number.isNaN(Date.parse(response.body.asOf))).toBe(false);
    });

    it('US-47-TC01: GET :id trả chi tiết có body đầy đủ, không lộ người nhận hay event routing', async () => {
      const me = await login();
      const id = await seedNotification({ title: 'Chi tiết', body: 'Nội dung đầy đủ' });
      await addRecipient(id, me.accountId);
      await addRecipient(id, newId());

      const response = await get(`/${id}`, me.accessToken).expect(200);

      expect(response.body).toMatchObject({ id, title: 'Chi tiết', body: 'Nội dung đầy đủ' });
      for (const key of ['recipients', 'accountId', 'account_id', 'eventKey', 'event_key', 'memberId', 'member_id']) {
        expect(response.body).not.toHaveProperty(key);
      }
    });

    it('US-47-TC01: POST :id/read với body {} trả 200 {id, readAt}', async () => {
      const me = await login();
      const id = await seedNotification();
      await addRecipient(id, me.accountId);

      const response = await post(`/${id}/read`, me.accessToken).expect(200);

      expect(response.body).toEqual({ id, readAt: expect.any(String) });
      expect(Number.isNaN(Date.parse(response.body.readAt))).toBe(false);
    });

    it('US-47-TC02: GET :id của người khác trả 404 NOT_FOUND theo định dạng lỗi chung', async () => {
      const me = await login();
      const id = await seedNotification();
      await addRecipient(id, newId());

      const response = await get(`/${id}`, me.accessToken).expect(404);
      expect(response.body).toMatchObject(errorBody('NOT_FOUND'));
    });

    it('US-47-TC02: POST read thông báo của người khác trả 404, recipient của họ không đổi', async () => {
      const me = await login();
      const other = newId();
      const id = await seedNotification();
      await addRecipient(id, other);

      const response = await post(`/${id}/read`, me.accessToken).expect(404);

      expect(response.body).toMatchObject(errorBody('NOT_FOUND'));
      expect((await recipientOf(id, other))!.read_at).toBeUndefined();
    });

    it.each([
      ['accountId', { accountId: '000000000000000000000001' }],
      ['readAt', { readAt: '2020-01-01T00:00:00.000Z' }],
    ])('US-47-TC02: POST read có field %s client tự gửi trả 400, không đánh dấu', async (_field, body) => {
      const me = await login();
      const id = await seedNotification();
      await addRecipient(id, me.accountId);

      const response = await post(`/${id}/read`, me.accessToken, body).expect(400);

      expect(response.body).toMatchObject(errorBody());
      expect((await recipientOf(id, me.accountId))!.read_at).toBeUndefined();
    });

    it.each(['accountId', 'memberId'])('US-47-TC02: GET list kèm query %s (ngoài allowlist) trả 400, không xem thay người khác', async field => {
      const me = await login();
      const response = await get('', me.accessToken, { [field]: newId() }).expect(400);
      expect(response.body).toMatchObject(errorBody());
    });

    it.each(['abc', 'z'.repeat(24)])('US-47-TC02: (D01) GET :id sai định dạng "%s" trả 400 INVALID_ID', async id => {
      const me = await login();
      const response = await get(`/${id}`, me.accessToken).expect(400);
      expect(response.body).toMatchObject(errorBody('INVALID_ID'));
    });

    it('US-47-TC02: (D01) POST read với id sai định dạng trả 400 INVALID_ID', async () => {
      const me = await login();
      const response = await post('/abc/read', me.accessToken).expect(400);
      expect(response.body).toMatchObject(errorBody('INVALID_ID'));
    });

    it('US-47-TC02: (D01) id đúng định dạng nhưng không tồn tại trả 404 NOT_FOUND', async () => {
      const me = await login();
      await get(`/${newId()}`, me.accessToken).expect(404);
      await post(`/${newId()}/read`, me.accessToken).expect(404);
    });

    // US-47-TC03: 4 endpoint inbox đều chỉ dành cho MEMBER.
    const endpoints = (id: string) => [
      ['GET list', () => ''] as const,
      ['GET unread-count', () => '/unread-count'] as const,
      ['GET detail', () => `/${id}`] as const,
      ['POST read', () => `/${id}/read`] as const,
    ];
    const call = (name: string, path: string, token?: string) => (name.startsWith('POST') ? post(path, token) : get(path, token));

    it('US-47-TC03: không có token thì cả 4 endpoint trả 401 theo định dạng lỗi chung', async () => {
      const id = await seedNotification();
      for (const [name, path] of endpoints(id)) {
        const response = await call(name, path());
        expect({ name, status: response.status }).toEqual({ name, status: 401 });
        expect(response.body).toMatchObject(errorBody());
      }
    });

    it.each(['TRAINER', 'STAFF', 'ADMIN'] as const)('US-47-TC03: role %s gọi cả 4 endpoint inbox trả 403', async roleCode => {
      const user = await login(roleCode);
      const id = await seedNotification();
      // Kể cả khi có recipient, role không phải MEMBER vẫn bị chặn ở inbox S03.
      await addRecipient(id, user.accountId);
      for (const [name, path] of endpoints(id)) {
        const response = await call(name, path(), user.accessToken);
        expect({ name, status: response.status }).toEqual({ name, status: 403 });
        expect(response.body).toMatchObject(errorBody());
      }
      expect((await recipientOf(id, user.accountId))!.read_at).toBeUndefined();
    });

    it('US-47-TC03: phiên đã bị thu hồi (logout) thì cả 4 endpoint trả 401', async () => {
      const me = await login();
      const id = await seedNotification();
      await addRecipient(id, me.accountId);
      await http().post('/api/auth/logout').set('Origin', origin).set('Authorization', `Bearer ${me.accessToken}`).send({}).expect(204);

      for (const [name, path] of endpoints(id)) {
        const response = await call(name, path(), me.accessToken);
        expect({ name, status: response.status }).toEqual({ name, status: 401 });
      }
      expect((await recipientOf(id, me.accountId))!.read_at).toBeUndefined();
    });
  });

  // ---------- US-47-AC02: read/delivered/idempotency qua HTTP ----------
  describe('US-47-AC02: read và idempotency qua API', () => {
    it('US-47-TC05: GET list, unread-count và detail không tự ghi read_at', async () => {
      const me = await login();
      const id = await seedNotification();
      await addRecipient(id, me.accountId);

      await get('', me.accessToken).expect(200);
      await get('/unread-count', me.accessToken).expect(200);
      await get(`/${id}`, me.accessToken).expect(200);

      const recipient = await recipientOf(id, me.accountId);
      expect(recipient!.read_at).toBeUndefined();
      expect(recipient!.delivered_at).toBeUndefined();
    });

    it('US-47-TC06: POST read nhiều lần trả cùng readAt lần đầu, không ghi delivered_at', async () => {
      const me = await login();
      const id = await seedNotification();
      await addRecipient(id, me.accountId);

      const first = await post(`/${id}/read`, me.accessToken).expect(200);
      await new Promise(resolve => setTimeout(resolve, 20));
      const second = await post(`/${id}/read`, me.accessToken).expect(200);

      expect(second.body).toEqual(first.body);
      const recipient = await recipientOf(id, me.accountId);
      expect(recipient!.read_at.toISOString()).toBe(first.body.readAt);
      expect(recipient!.delivered_at).toBeUndefined();
    });

    it('US-47-TC06: hai tab POST read đồng thời cùng nhận một readAt, đúng một recipient đổi', async () => {
      const me = await login();
      const id = await seedNotification();
      const sibling = await seedNotification();
      await addRecipient(id, me.accountId);
      await addRecipient(sibling, me.accountId);

      const [tabA, tabB] = await Promise.all([post(`/${id}/read`, me.accessToken), post(`/${id}/read`, me.accessToken)]);

      expect([tabA.status, tabB.status]).toEqual([200, 200]);
      expect(tabA.body.readAt).toBe(tabB.body.readAt);
      expect(await db().collection('notification_recipients').countDocuments({ read_at: { $exists: true } })).toBe(1);
    });

    it('US-47-TC07: sau GET detail rồi POST read, unread-count giảm theo server, nội dung giữ nguyên', async () => {
      const me = await login();
      const id = await seedNotification({ title: 'Giữ nguyên', body: 'Nội dung không đổi' });
      const another = await seedNotification();
      await addRecipient(id, me.accountId);
      await addRecipient(another, me.accountId);

      expect((await get('/unread-count', me.accessToken).expect(200)).body.unreadCount).toBe(2);
      await get(`/${id}`, me.accessToken).expect(200);
      const read = await post(`/${id}/read`, me.accessToken).expect(200);

      expect((await get('/unread-count', me.accessToken).expect(200)).body.unreadCount).toBe(1);
      const detail = await get(`/${id}`, me.accessToken).expect(200);
      expect(detail.body).toMatchObject({ title: 'Giữ nguyên', body: 'Nội dung không đổi', readAt: read.body.readAt });
      expect(((await get('', me.accessToken).expect(200)).body as ListBody).total).toBe(2);
    });

    // ---------- US-47-TC08: lọc, phân trang (D02) và index ----------
    it.each([
      ['UNREAD', 2],
      ['READ', 1],
      ['ALL', 3],
    ] as const)('US-47-TC08: readState=%s lọc đúng, unreadCount không phụ thuộc bộ lọc', async (readState, total) => {
      const me = await login();
      for (let index = 0; index < 2; index += 1) await addRecipient(await seedNotification(), me.accountId);
      await addRecipient(await seedNotification(), me.accountId, new Date('2026-11-02T00:00:00Z'));

      const body = (await get('', me.accessToken, { readState }).expect(200)).body as ListBody;

      expect(body.total).toBe(total);
      expect(body.items).toHaveLength(total);
      expect(body.unreadCount).toBe(2);
    });

    it.each(['unread', 'NEW', ''])('US-47-TC08: readState="%s" ngoài ALL/UNREAD/READ trả 400', async readState => {
      const me = await login();
      const response = await get('', me.accessToken, { readState }).expect(400);
      expect(response.body).toMatchObject(errorBody());
    });

    it.each(['0', '-1', '1.5', 'abc'])('US-47-TC08: (D02) page=%s (nhỏ hơn 1 hoặc không nguyên) trả 400', async page => {
      const me = await login();
      const response = await get('', me.accessToken, { page }).expect(400);
      expect(response.body).toMatchObject(errorBody());
    });

    it.each(['0', '101', '1.5', 'abc'])('US-47-TC08: (D02) limit=%s ngoài 1–100 hoặc không nguyên trả 400', async limit => {
      const me = await login();
      const response = await get('', me.accessToken, { limit }).expect(400);
      expect(response.body).toMatchObject(errorBody());
    });

    it('US-47-TC08: (D02) limit biên 1 và 100 hợp lệ', async () => {
      const me = await login();
      expect(((await get('', me.accessToken, { limit: '1' }).expect(200)).body as ListBody).limit).toBe(1);
      expect(((await get('', me.accessToken, { limit: '100' }).expect(200)).body as ListBody).limit).toBe(100);
    });

    it('US-47-TC08: (D02) page lớn hơn totalPages trả 200, items rỗng, total/totalPages thật', async () => {
      const me = await login();
      for (let index = 0; index < 3; index += 1) await addRecipient(await seedNotification(), me.accountId);

      const body = (await get('', me.accessToken, { page: '5', limit: '2' }).expect(200)).body as ListBody;

      expect(body).toMatchObject({ items: [], page: 5, limit: 2, total: 3, totalPages: 2 });
    });

    it('US-47-TC08: nhiều trang qua API theo sequence giảm dần, không trùng, không sót', async () => {
      const me = await login();
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const id = await seedNotification();
        await addRecipient(id, me.accountId);
        ids.push(id);
      }

      const page1 = (await get('', me.accessToken, { page: '1', limit: '2' }).expect(200)).body as ListBody;
      const page2 = (await get('', me.accessToken, { page: '2', limit: '2' }).expect(200)).body as ListBody;

      expect([...page1.items, ...page2.items].map(item => item.id)).toEqual([...ids].reverse());
    });

    it('US-47-TC08: notification_recipients có index (account_id, read_at, notification_id) hỗ trợ lọc', async () => {
      const list = await db().collection('notification_recipients').listIndexes().toArray();
      const keys = list.map(index => JSON.stringify(index.key));
      expect(keys).toContain(JSON.stringify({ account_id: 1, read_at: 1, notification_id: 1 }));
    });
  });
});
