// Tầng kiểm thử backend (Jest + MongoDB replica set thật + Socket.IO client thật): EN-03 bước 3 và bước 4 (nối đầu–cuối).
// Kiểm tra gateway /notifications và REST sync: chỉ người có quyền hiện hành mới nhận/đọc/ack (TC07, TC09–TC13, TC15).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken } from '@nestjs/mongoose';
import { ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { NotificationDispatcher } from '../src/modules/notifications/notification-dispatcher';
import { NotificationOutboxService } from '../src/modules/notifications/notification-outbox.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng test đặt ra cho Builder (EN-03 bước 3):
//   Socket.IO namespace /notifications trên cùng cổng HTTP. Cấu hình adapter (nếu cần) đặt trong configureHttp(app)
//   để app tạo bằng NestFactory.create + configureHttp + listen là dùng được socket.
//   Handshake: auth.accessToken (không đọc token từ query URL); Origin phải thuộc FRONTEND_ORIGIN; sai thì connect_error.
//   Server gửi 'notification.created' với đúng {id, eventKey, title, body, createdAt} khi worker dispatch (runOnce).
//   Client gửi 'notification.ack' {notificationId} kèm callback ack của Socket.IO; server trả:
//     { ok: true } khi đúng recipient; { ok: false, error: { code: 'NOT_FOUND' } } khi không sở hữu/không có;
//     { ok: false, error: { code: 'VALIDATION_ERROR' } } khi notificationId sai định dạng.
//   Trước mỗi emit và mỗi ack kiểm lại phiên bằng cùng dịch vụ AUTH-F06; mất quyền thì không gửi nội dung và ngắt socket.
//   GET /api/notifications/sync?cursor&limit (Bearer): 200 {items:[{id,eventKey,title,body,sequence,createdAt}], nextCursor, hasMore};
//     limit 1–100 mặc định 50, sai thì 400; cursor sai/bị sửa thì 400; không token thì 401.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_en03_realtime';
const password = 'MậtKhẩuEN-03-123';

type Created = { id: string; eventKey: string; title: string; body: string; createdAt: string };
type AckResponse = { ok: boolean; error?: { code: string } };
type SyncItem = Created & { sequence: string };
type SyncBody = { items: SyncItem[]; nextCursor?: string | null; hasMore: boolean };

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('EN-03 bước 3: gateway /notifications và REST sync chỉ phục vụ người có quyền hiện hành', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  let notifications: NotificationsService;
  let transactions: TransactionRunner;
  let worker: NotificationOutboxService;
  let baseUrl: string;
  const sockets: Socket[] = [];
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    // enableTestCommands=1 để dùng failpoint giả lập DB lỗi lúc kiểm quyền (EN-03-TC12).
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
      SMTP_USER: 'en03-test', SMTP_PASS: 'en03-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http');
    configureHttp(app);
    // Cổng 0: hệ điều hành chọn cổng trống; socket cần server HTTP thật đang lắng nghe.
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    connection = app.get<Connection>(getConnectionToken());
    notifications = app.get(NotificationsService);
    transactions = app.get(TransactionRunner);
    worker = app.get(NotificationOutboxService);
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Bộ giới hạn đăng nhập (US-02) lưu trong bộ nhớ: mỗi test dùng bộ mới để file nhiều lần đăng nhập không bị 429.
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await connection.db!.collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
  });

  afterEach(async () => {
    while (sockets.length) sockets.pop()!.disconnect();
    await connection.db!.admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const recipientOf = (notificationId: string, accountId: string) =>
    db().collection('notification_recipients').findOne({ notification_id: new ObjectId(notificationId), account_id: new ObjectId(accountId) });

  // ---------- Chuẩn bị: account MEMBER thật, đăng nhập thật qua API US-02 ----------
  let phoneSeq = 0;
  async function member(): Promise<{ accountId: string; phone: string; accessToken: string }> {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole('MEMBER', 'MEMBER');
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `09170000${String(phoneSeq).padStart(2, '0')}`;
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName: `EN03 Realtime ${phoneSeq}`, passwordHash });
    const login = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { accountId: account.id.toHexString(), phone, accessToken: login.body.accessToken as string };
  }

  // Lưu một thông báo (đường thật bước 1) cho danh sách người nhận; chưa dispatch.
  async function notify(recipients: string[], title = 'Gói tập đã được kích hoạt') {
    const eventKey = `SERVICE_SALE_SETTLED:${new ObjectId().toHexString()}`;
    const result = await transactions.run(session => notifications.persistBusinessEvent(session, {
      eventKey, title, body: 'Gói Gym 1 tháng, hạn dùng đến 2026-12-04, mã giao dịch GD0001',
    }, recipients));
    return { eventKey, notificationId: result.notificationId };
  }

  // ---------- Socket helper ----------
  type ConnectOptions = { accessToken?: string; origin?: string; query?: Record<string, string>; auth?: Record<string, unknown> };
  function openSocket(options: ConnectOptions): Socket {
    const socket = io(`${baseUrl}/notifications`, {
      transports: ['websocket'], reconnection: false, forceNew: true, timeout: 3000,
      auth: options.auth ?? (options.accessToken === undefined ? {} : { accessToken: options.accessToken }),
      query: options.query,
      extraHeaders: { Origin: options.origin ?? origin },
    });
    sockets.push(socket);
    return socket;
  }

  // Kết nối thành công thì resolve 'connected', bị từ chối thì 'rejected'.
  function connectResult(socket: Socket): Promise<'connected' | 'rejected'> {
    return new Promise(resolve => {
      socket.once('connect', () => resolve('connected'));
      socket.once('connect_error', () => resolve('rejected'));
    });
  }

  async function connected(accessToken: string): Promise<{ socket: Socket; received: Created[] }> {
    const socket = openSocket({ accessToken });
    const received: Created[] = [];
    socket.on('notification.created', (payload: Created) => received.push(payload));
    expect(await connectResult(socket)).toBe('connected');
    return { socket, received };
  }

  function disconnected(socket: Socket, ms = 3000): Promise<boolean> {
    if (!socket.connected) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), ms);
      socket.once('disconnect', () => { clearTimeout(timer); resolve(true); });
    });
  }

  async function ack(socket: Socket, notificationId: unknown): Promise<AckResponse | 'no-response'> {
    try {
      return await socket.timeout(2000).emitWithAck('notification.ack', { notificationId }) as AckResponse;
    } catch {
      return 'no-response';
    }
  }

  // Worker dispatch (gateway emit) rồi chờ một chút để gói tin đến client.
  async function dispatchAndSettle() {
    await worker.runOnce();
    await wait(500);
  }

  function sync(accessToken: string | undefined, query: Record<string, string> = {}) {
    const call = request(app.getHttpServer()).get('/api/notifications/sync').query(query).set('Origin', origin);
    if (accessToken) call.set('Authorization', `Bearer ${accessToken}`);
    return call;
  }

  // ---------- EN-03-TC09: handshake sai ----------
  describe('EN-03-TC09: handshake token sai/hết hạn hoặc Origin sai thì từ chối kết nối', () => {
    it('EN-03-TC09: token hợp lệ và Origin đúng thì kết nối được (đối chứng)', async () => {
      const a = await member();
      expect(await connectResult(openSocket({ accessToken: a.accessToken }))).toBe('connected');
    });

    it('EN-03-TC09: không có token thì bị từ chối', async () => {
      expect(await connectResult(openSocket({}))).toBe('rejected');
    });

    it('EN-03-TC09: token sai (chuỗi bất kỳ) thì bị từ chối', async () => {
      expect(await connectResult(openSocket({ accessToken: 'khong-phai-jwt' }))).toBe('rejected');
    });

    it('EN-03-TC09: token hết hạn thì bị từ chối', async () => {
      const a = await member();
      const jwt = app.get(JwtService);
      const claims = jwt.decode(a.accessToken) as Record<string, unknown>;
      const now = Math.floor(Date.now() / 1000);
      // Ký lại đúng secret/issuer/audience của ứng dụng nhưng exp đã qua.
      const expired = await jwt.signAsync({ sub: claims.sub, sid: claims.sid, av: claims.av, iat: now - 120, exp: now - 60 });
      expect(await connectResult(openSocket({ accessToken: expired }))).toBe('rejected');
    });

    it('EN-03-TC09: token đặt trên query URL (không có auth.accessToken) thì bị từ chối', async () => {
      const a = await member();
      expect(await connectResult(openSocket({ query: { accessToken: a.accessToken, token: a.accessToken } }))).toBe('rejected');
    });

    it('EN-03-TC09: Origin không thuộc allowlist thì bị từ chối dù token hợp lệ', async () => {
      const a = await member();
      expect(await connectResult(openSocket({ accessToken: a.accessToken, origin: 'http://evil.example' }))).toBe('rejected');
    });

    it('EN-03-TC09: socket bị từ chối không nhận được nội dung thông báo nào', async () => {
      const a = await member();
      const rejected = openSocket({ accessToken: 'khong-phai-jwt' });
      const received: Created[] = [];
      rejected.on('notification.created', (payload: Created) => received.push(payload));
      await connectResult(rejected);
      await notify([a.accountId]);

      await dispatchAndSettle();

      expect(received).toEqual([]);
    });
  });

  // ---------- Phân phối đúng người nhận, đúng allowlist ----------
  describe('EN-03-TC11: chỉ socket của recipient hiện hành nhận notification.created', () => {
    it('EN-03-TC11: recipient đang online nhận đúng {id, eventKey, title, body, createdAt}, không thêm field khác', async () => {
      const a = await member();
      const { received } = await connected(a.accessToken);
      const { eventKey, notificationId } = await notify([a.accountId]);

      await dispatchAndSettle();

      expect(received).toHaveLength(1);
      expect(Object.keys(received[0]).sort()).toEqual(['body', 'createdAt', 'eventKey', 'id', 'title']);
      expect(received[0]).toMatchObject({ id: notificationId, eventKey, title: 'Gói tập đã được kích hoạt' });
      expect(new Date(received[0].createdAt).toISOString()).toBe(received[0].createdAt);
    });

    it('EN-03-TC11: account khác (không phải recipient) đang online không nhận được', async () => {
      const a = await member();
      const b = await member();
      const socketA = await connected(a.accessToken);
      const socketB = await connected(b.accessToken);
      await notify([a.accountId]);

      await dispatchAndSettle();

      expect(socketA.received).toHaveLength(1);
      expect(socketB.received).toEqual([]);
    });

    it('EN-03-TC11: client tự xin join room/accountId của người khác thì vẫn không nhận được', async () => {
      const a = await member();
      const b = await member();
      const socketB = await connected(b.accessToken);
      socketB.socket.emit('join', { accountId: a.accountId, room: a.accountId });
      socketB.socket.emit('subscribe', { accountId: a.accountId });
      await wait(200);
      await notify([a.accountId]);

      await dispatchAndSettle();

      expect(socketB.received).toEqual([]);
    });

    it('EN-03-TC11: handshake gửi kèm accountId của người khác thì server bỏ qua, chỉ dùng principal từ token', async () => {
      const a = await member();
      const b = await member();
      const socket = openSocket({ auth: { accessToken: b.accessToken, accountId: a.accountId } });
      const received: Created[] = [];
      socket.on('notification.created', (payload: Created) => received.push(payload));
      // Token của B hợp lệ nên vẫn kết nối được; chỉ là accountId tự khai bị bỏ qua.
      expect(await connectResult(socket)).toBe('connected');
      await notify([a.accountId]);

      await dispatchAndSettle();

      expect(received).toEqual([]);
    });

    it('EN-03-TC11: một account mở hai socket (hai tab) thì cả hai đều nhận', async () => {
      const a = await member();
      const first = await connected(a.accessToken);
      const second = await connected(a.accessToken);
      await notify([a.accountId]);

      await dispatchAndSettle();

      expect(first.received).toHaveLength(1);
      expect(second.received).toHaveLength(1);
    });
  });

  // ---------- EN-03-TC10: mất quyền sau handshake ----------
  describe('EN-03-TC10: logout/khóa/đổi role/hết hạn sau handshake thì emit/ack tiếp theo bị chặn và socket bị ngắt', () => {
    async function expectEmitBlocked(socket: Socket, received: Created[]) {
      await dispatchAndSettle();
      expect(received).toEqual([]);
      expect(await disconnected(socket)).toBe(true);
    }

    it('EN-03-TC10: logout (thu hồi phiên) sau handshake thì không nhận nội dung và bị ngắt', async () => {
      const a = await member();
      const { socket, received } = await connected(a.accessToken);
      await request(app.getHttpServer()).post('/api/auth/logout').set('Origin', origin)
        .set('Authorization', `Bearer ${a.accessToken}`).send({}).expect(204);
      await notify([a.accountId]);

      await expectEmitBlocked(socket, received);
    });

    it('EN-03-TC10: account bị khóa (LOCKED) sau handshake thì không nhận nội dung và bị ngắt', async () => {
      const a = await member();
      const { socket, received } = await connected(a.accessToken);
      await db().collection('accounts').updateOne({ _id: new ObjectId(a.accountId) }, { $set: { status: 'LOCKED' } });
      await notify([a.accountId]);

      await expectEmitBlocked(socket, received);
    });

    it('EN-03-TC10: account bị đổi role (MEMBER → STAFF) sau handshake thì không nhận nội dung và bị ngắt', async () => {
      const a = await member();
      const { socket, received } = await connected(a.accessToken);
      const staff = await app.get(UsersRepository).ensureRole('STAFF', 'STAFF');
      await db().collection('accounts').updateOne({ _id: new ObjectId(a.accountId) }, { $set: { role_id: staff.id } });
      await notify([a.accountId]);

      await expectEmitBlocked(socket, received);
    });

    it('EN-03-TC10: access token hết hạn sau handshake thì emit tiếp theo bị chặn và socket bị ngắt', async () => {
      const a = await member();
      const jwt = app.get(JwtService);
      const claims = jwt.decode(a.accessToken) as Record<string, unknown>;
      const now = Math.floor(Date.now() / 1000);
      const shortLived = await jwt.signAsync({ sub: claims.sub, sid: claims.sid, av: claims.av, iat: now, exp: now + 2 });
      const { socket, received } = await connected(shortLived);
      await wait(3000);
      await notify([a.accountId]);

      await expectEmitBlocked(socket, received);
    }, 15000);

    it('EN-03-TC10: logout sau handshake thì ack bị chặn, delivered_at không được ghi và socket bị ngắt', async () => {
      const a = await member();
      const { socket } = await connected(a.accessToken);
      const { notificationId } = await notify([a.accountId]);
      await request(app.getHttpServer()).post('/api/auth/logout').set('Origin', origin)
        .set('Authorization', `Bearer ${a.accessToken}`).send({}).expect(204);

      const response = await ack(socket, notificationId);

      expect(response === 'no-response' || response.ok === false).toBe(true);
      expect((await recipientOf(notificationId, a.accountId))!.delivered_at ?? null).toBeNull();
      expect(await disconnected(socket)).toBe(true);
    });
  });

  // ---------- EN-03-TC11 (ack/sync), EN-03-TC13: ack ----------
  describe('EN-03-TC11, EN-03-TC13: notification.ack chỉ cho recipient, ghi delivered_at một lần', () => {
    it('EN-03-TC13: recipient ack thì nhận {ok: true} và delivered_at được ghi', async () => {
      const a = await member();
      const { socket } = await connected(a.accessToken);
      const { notificationId } = await notify([a.accountId]);

      expect(await ack(socket, notificationId)).toEqual({ ok: true });

      expect((await recipientOf(notificationId, a.accountId))!.delivered_at).toBeInstanceOf(Date);
    });

    it('EN-03-TC13: ack nhiều lần thì delivered_at chỉ ghi lần đầu, giữ nguyên giá trị; read_at không đổi', async () => {
      const a = await member();
      const { socket } = await connected(a.accessToken);
      const { notificationId } = await notify([a.accountId]);

      await ack(socket, notificationId);
      const first = (await recipientOf(notificationId, a.accountId))!.delivered_at as Date;
      await wait(50);
      expect(await ack(socket, notificationId)).toEqual({ ok: true });
      await ack(socket, notificationId);

      const after = await recipientOf(notificationId, a.accountId);
      expect((after!.delivered_at as Date).getTime()).toBe(first.getTime());
      expect(after!.read_at ?? null).toBeNull();
    });

    it('EN-03-TC11: account khác ack notification của người khác thì NOT_FOUND, delivered_at của recipient không đổi', async () => {
      const a = await member();
      const b = await member();
      const socketB = await connected(b.accessToken);
      const { notificationId } = await notify([a.accountId]);

      expect(await ack(socketB.socket, notificationId)).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });

      expect((await recipientOf(notificationId, a.accountId))!.delivered_at ?? null).toBeNull();
      expect(await db().collection('notification_recipients').countDocuments({ account_id: new ObjectId(b.accountId) })).toBe(0);
    });

    it('EN-03-TC11: ack notificationId không tồn tại thì NOT_FOUND (giống không sở hữu, không lộ có hay không)', async () => {
      const a = await member();
      const { socket } = await connected(a.accessToken);

      expect(await ack(socket, new ObjectId().toHexString())).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    });

    it('EN-03-TC11: ack notificationId sai định dạng thì VALIDATION_ERROR', async () => {
      const a = await member();
      const { socket } = await connected(a.accessToken);

      expect(await ack(socket, 'khong-phai-id')).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR' }) });
    });
  });

  // ---------- EN-03-TC12: DB lỗi lúc kiểm quyền ----------
  it('EN-03-TC12: DB lỗi lúc kiểm lại phiên trước emit thì không phát nội dung (không fail-open)', async () => {
    const a = await member();
    const { received } = await connected(a.accessToken);
    await notify([a.accountId]);
    // Mọi lệnh find vào auth_sessions (nơi AUTH-F06 đọc phiên) đều lỗi trong lúc dispatch.
    // Mã 1 (InternalError) là lỗi DB thường. Không dùng mã 91 (ShutdownInProgress): driver sẽ coi server đang tắt,
    // đánh dấu Unknown và chờ heartbeat tới 10 giây, làm lệnh ghi outbox sau đó ném ServerSelectionError ngẫu nhiên.
    await db().admin().command({
      configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: ['find'], namespace: `${databaseName}.auth_sessions`, errorCode: 1, errmsg: 'Giả lập DB lỗi EN-03-TC12' },
    });

    await dispatchAndSettle();

    expect(received).toEqual([]);
  });

  // ---------- EN-03-TC15 (phần backend): emit không phải đã nhận/đã xem ----------
  it('EN-03-TC15: socket nhận notification nhưng chưa ack thì delivered_at vẫn trống, read_at trống, job DONE', async () => {
    const a = await member();
    const { received } = await connected(a.accessToken);
    const { eventKey, notificationId } = await notify([a.accountId]);

    await dispatchAndSettle();

    expect(received).toHaveLength(1);
    const recipient = await recipientOf(notificationId, a.accountId);
    expect(recipient!.delivered_at ?? null).toBeNull();
    expect(recipient!.read_at ?? null).toBeNull();
    expect((await db().collection('notification_outbox').findOne({ event_key: eventKey }))!.status).toBe('DONE');
  });

  // ---------- EN-03-TC07, EN-03-TC11: REST sync ----------
  describe('EN-03-TC07, EN-03-TC11: GET /api/notifications/sync', () => {
    it('EN-03-TC07: người nhận offline lúc dispatch thì REST sync vẫn khôi phục được thông báo', async () => {
      const a = await member();
      const { eventKey, notificationId } = await notify([a.accountId]);
      await dispatchAndSettle();

      const response = await sync(a.accessToken).expect(200);

      const body = response.body as SyncBody;
      expect(body.hasMore).toBe(false);
      expect(body.items).toHaveLength(1);
      expect(Object.keys(body.items[0]).sort()).toEqual(['body', 'createdAt', 'eventKey', 'id', 'sequence', 'title']);
      expect(body.items[0]).toMatchObject({ id: notificationId, eventKey });
      expect(body.items[0].sequence).toMatch(/^\d+$/);
    });

    it('EN-03-TC07: sync trả theo sequence tăng dần và phân trang bằng cursor không bỏ sót, không trùng', async () => {
      const a = await member();
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) ids.push((await notify([a.accountId], `Thông báo ${index}`)).notificationId);

      const page1 = (await sync(a.accessToken, { limit: '2' }).expect(200)).body as SyncBody;
      expect(page1.items.map(item => item.id)).toEqual(ids.slice(0, 2));
      expect(BigInt(page1.items[1].sequence)).toBeGreaterThan(BigInt(page1.items[0].sequence));
      expect(page1.hasMore).toBe(true);
      expect(typeof page1.nextCursor).toBe('string');

      const page2 = (await sync(a.accessToken, { limit: '2', cursor: page1.nextCursor! }).expect(200)).body as SyncBody;
      expect(page2.items.map(item => item.id)).toEqual(ids.slice(2));
      expect(page2.hasMore).toBe(false);
      // Hết dữ liệu vẫn trả cursor của item cuối để client đồng bộ tiếp sau reconnect.
      expect(typeof page2.nextCursor).toBe('string');

      const empty = (await sync(a.accessToken, { cursor: page2.nextCursor! }).expect(200)).body as SyncBody;
      expect(empty.items).toEqual([]);
      expect(empty.hasMore).toBe(false);

      // Thông báo commit muộn hơn vẫn lấy được từ cursor cũ, không bị bỏ sót.
      const later = await notify([a.accountId], 'Thông báo commit muộn');
      const resumed = (await sync(a.accessToken, { cursor: page2.nextCursor! }).expect(200)).body as SyncBody;
      expect(resumed.items.map(item => item.id)).toEqual([later.notificationId]);
    });

    it('EN-03-TC07: không truyền limit thì mặc định tối đa 50 item', async () => {
      const a = await member();
      for (let index = 0; index < 51; index += 1) await notify([a.accountId]);

      const body = (await sync(a.accessToken).expect(200)).body as SyncBody;

      expect(body.items).toHaveLength(50);
      expect(body.hasMore).toBe(true);
    });

    it('EN-03-TC11: sync chỉ trả notification có recipient là principal, không thấy của người khác', async () => {
      const a = await member();
      const b = await member();
      await notify([a.accountId]);
      const mine = await notify([b.accountId]);

      const body = (await sync(b.accessToken).expect(200)).body as SyncBody;

      expect(body.items.map(item => item.id)).toEqual([mine.notificationId]);
    });

    it('EN-03-TC11: dùng cursor của account khác thì vẫn chỉ thấy notification của chính mình (cursor không mang accountId)', async () => {
      const a = await member();
      const b = await member();
      await notify([a.accountId]);
      await notify([a.accountId]);
      const mine = await notify([b.accountId]);
      const cursorOfA = ((await sync(a.accessToken, { limit: '1' }).expect(200)).body as SyncBody).nextCursor!;

      const body = (await sync(b.accessToken, { cursor: cursorOfA }).expect(200)).body as SyncBody;

      expect(body.items.map(item => item.id)).toEqual([mine.notificationId]);
    });

    it('EN-03-TC11: không có token thì 401 theo định dạng lỗi chung', async () => {
      const response = await sync(undefined).expect(401);
      expect(response.body).toMatchObject({ error: { code: expect.any(String), message: expect.any(String) }, requestId: expect.any(String) });
    });

    it.each(['0', '101', 'abc', '-1', '1.5'])('EN-03-TC11: limit=%s ngoài khoảng 1–100 hoặc sai định dạng thì 400', async limit => {
      const a = await member();
      const response = await sync(a.accessToken, { limit }).expect(400);
      expect(response.body).toMatchObject({ error: { code: expect.any(String) }, requestId: expect.any(String) });
    });

    it('EN-03-TC11: limit biên 1 và 100 hợp lệ', async () => {
      const a = await member();
      await sync(a.accessToken, { limit: '1' }).expect(200);
      await sync(a.accessToken, { limit: '100' }).expect(200);
    });

    it('EN-03-TC11: cursor bị sửa hoặc rác thì 400, không lộ lỗi MongoDB thô', async () => {
      const a = await member();
      await notify([a.accountId]);
      await notify([a.accountId]);
      const cursor = ((await sync(a.accessToken, { limit: '1' }).expect(200)).body as SyncBody).nextCursor!;
      const tampered = cursor.slice(0, -2) + (cursor.endsWith('AA') ? 'BB' : 'AA');

      for (const bad of [tampered, 'rac', '{"sequence":"0"}']) {
        const response = await sync(a.accessToken, { cursor: bad }).expect(400);
        expect(JSON.stringify(response.body)).not.toMatch(/Mongo|E11000|stack/i);
      }
    });
  });

  // ---------- EN-03 bước 4: kiểm thử nối đầu–cuối (transaction thật → worker thật → socket thật → REST sync) ----------
  // Bước 4: "Test commit/rollback, worker crash, offline replay và thu hồi quyền sau handshake".
  // Crash được giả lập bằng cách đưa outbox về đúng trạng thái DB mà worker chết để lại (giống test bước 2).
  describe('EN-03 bước 4: nối đầu–cuối worker, socket và REST sync', () => {
    const outboxOf = (eventKey: string) => db().collection('notification_outbox').findOne({ event_key: eventKey });
    const setOutbox = (eventKey: string, fields: Record<string, unknown>) =>
      db().collection('notification_outbox').updateOne({ event_key: eventKey }, { $set: fields });
    const syncIds = async (accessToken: string) => ((await sync(accessToken).expect(200)).body as SyncBody).items.map(entry => entry.id);

    // "Lệnh thanh toán giả": payment và thông báo trong CÙNG transaction (như test bước 1).
    async function settle(recipients: string[], failAfterPersist = false) {
      const eventKey = `SERVICE_SALE_SETTLED:${new ObjectId().toHexString()}`;
      const result = await transactions.run(async session => {
        await db().collection('payments').insertOne({ event_key: eventKey, amount: '500000' }, { session });
        const persisted = await notifications.persistBusinessEvent(session, {
          eventKey, title: 'Gói tập đã được kích hoạt', body: 'Gói Gym 1 tháng, mã giao dịch GD0002',
        }, recipients);
        if (failAfterPersist) throw new Error('Lỗi nghiệp vụ giả lập sau khi lưu thông báo');
        return persisted;
      });
      return { eventKey, notificationId: result.notificationId };
    }

    it('EN-03-TC03: transaction bị rollback thì người nhận đang online không nhận gì, sync rỗng, không có payment/outbox mồ côi', async () => {
      const a = await member();
      const { received } = await connected(a.accessToken);

      await expect(settle([a.accountId], true)).rejects.toThrow();
      await dispatchAndSettle();

      expect(received).toEqual([]);
      expect(await syncIds(a.accessToken)).toEqual([]);
      expect(await db().collection('payments').countDocuments()).toBe(0);
      expect(await db().collection('notification_outbox').countDocuments()).toBe(0);
    });

    it('EN-03-TC01: transaction commit thì người nhận đang online nhận đúng thông báo đó và sync cũng thấy', async () => {
      const a = await member();
      const { received } = await connected(a.accessToken);

      const { notificationId, eventKey } = await settle([a.accountId]);
      await dispatchAndSettle();

      expect(received.map(entry => entry.id)).toEqual([notificationId]);
      expect(await syncIds(a.accessToken)).toEqual([notificationId]);
      expect((await outboxOf(eventKey))!.status).toBe('DONE');
    });

    it('EN-03-TC05: worker khác đang giữ lease (crash sau claim trước emit) thì socket chưa nhận; lease hết thì nhận đúng một lần', async () => {
      const a = await member();
      const { received } = await connected(a.accessToken);
      const { notificationId, eventKey } = await settle([a.accountId]);
      await setOutbox(eventKey, { status: 'PROCESSING', lease_owner: 'worker-da-crash', lease_until: new Date(Date.now() + 30000) });

      await dispatchAndSettle();
      expect(received).toEqual([]);

      await setOutbox(eventKey, { lease_until: new Date(Date.now() - 1000) });
      await dispatchAndSettle();

      expect(received.map(entry => entry.id)).toEqual([notificationId]);
      expect((await outboxOf(eventKey))!.status).toBe('DONE');
    });

    it('EN-03-TC06: crash sau emit trước DONE thì socket nhận lại CÙNG id (client gộp theo id), DB vẫn một notification và một recipient', async () => {
      const a = await member();
      const { received } = await connected(a.accessToken);
      const { notificationId, eventKey } = await settle([a.accountId]);
      await dispatchAndSettle();
      // Trạng thái worker chết để lại: đã emit nhưng chưa kịp ghi DONE, lease đã hết.
      await db().collection('notification_outbox').updateOne({ event_key: eventKey }, {
        $set: { status: 'PROCESSING', lease_owner: 'worker-da-crash', lease_until: new Date(Date.now() - 1000) },
        $unset: { completed_at: '' },
      });

      await dispatchAndSettle();

      expect(received.map(entry => entry.id)).toEqual([notificationId, notificationId]);
      expect(received[1]).toEqual(received[0]);
      expect(await db().collection('notifications').countDocuments()).toBe(1);
      expect(await db().collection('notification_recipients').countDocuments()).toBe(1);
      expect((await outboxOf(eventKey))!.status).toBe('DONE');
    });

    it('EN-03-TC07: offline lúc dispatch, sau đó online: socket không phát lại job đã DONE, sync khôi phục được và ack ghi delivered_at', async () => {
      const a = await member();
      const { notificationId } = await settle([a.accountId]);
      await dispatchAndSettle();

      const { socket, received } = await connected(a.accessToken);
      await dispatchAndSettle();
      expect(received).toEqual([]);

      expect(await syncIds(a.accessToken)).toEqual([notificationId]);
      expect(await ack(socket, notificationId)).toEqual({ ok: true });
      expect((await recipientOf(notificationId, a.accountId))!.delivered_at).toBeInstanceOf(Date);
    });

    it('EN-03-TC10: logout sau handshake thì socket cũ không thấy nội dung; đăng nhập lại thì sync vẫn lấy được (không mất thông báo)', async () => {
      const a = await member();
      const { socket, received } = await connected(a.accessToken);
      await request(app.getHttpServer()).post('/api/auth/logout').set('Origin', origin)
        .set('Authorization', `Bearer ${a.accessToken}`).send({}).expect(204);
      const { notificationId } = await settle([a.accountId]);

      await dispatchAndSettle();
      expect(received).toEqual([]);
      expect(await disconnected(socket)).toBe(true);
      await sync(a.accessToken).expect(401);

      const relogin = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin)
        .send({ phone: a.phone, password }).expect(200);
      expect(await syncIds(relogin.body.accessToken as string)).toEqual([notificationId]);
    });

    it('EN-03-TC12: DB lỗi lúc kiểm quyền trước emit thì không phát; DB hồi phục thì sync vẫn khôi phục được thông báo', async () => {
      const a = await member();
      const { received } = await connected(a.accessToken);
      const { notificationId } = await settle([a.accountId]);
      await db().admin().command({
        configureFailPoint: 'failCommand', mode: 'alwaysOn',
        // Mã 1 (InternalError), không dùng 91: xem giải thích ở test EN-03-TC12 phía trên.
        data: { failCommands: ['find'], errorCode: 1, namespace: `${databaseName}.auth_sessions` },
      });

      await dispatchAndSettle();
      expect(received).toEqual([]);

      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
      expect(await syncIds(a.accessToken)).toEqual([notificationId]);
    });

    it('EN-03-TC15: socket/dispatch lỗi sau commit thì payment và thông báo vẫn còn (không rollback), job hẹn retry rồi gửi được', async () => {
      const a = await member();
      const { received } = await connected(a.accessToken);
      const { notificationId, eventKey } = await settle([a.accountId]);
      const dispatcher = app.get(NotificationDispatcher);
      const failing = jest.spyOn(dispatcher, 'dispatch').mockRejectedValueOnce(new Error('socket hỏng giả lập'));

      await dispatchAndSettle();

      expect(failing).toHaveBeenCalledTimes(1);
      expect(received).toEqual([]);
      expect(await db().collection('payments').countDocuments({ event_key: eventKey })).toBe(1);
      expect(await syncIds(a.accessToken)).toEqual([notificationId]);
      const job = await outboxOf(eventKey);
      expect(job!.status).toBe('READY');
      expect(job!.attempts).toBe(1);

      await setOutbox(eventKey, { available_at: new Date(Date.now() - 1000) });
      await dispatchAndSettle();
      expect(received.map(entry => entry.id)).toEqual([notificationId]);
      expect((await outboxOf(eventKey))!.status).toBe('DONE');
    });
  });
});
