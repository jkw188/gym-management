// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật + Socket.IO client thật, hai app instance): US-28 bước 4.
// Kiểm tra thông báo EN-03 khi Member đặt slot PT: event BOOKING_CREATED lưu cùng transaction với booking, chống trùng khi replay,
// rollback khi lỗi insert thông báo, đọc được qua REST khi socket offline/crash, BOOKED quá giờ không tự hoàn tất (TC01, TC10, TC12, TC13).
// Hợp đồng test đặt ra cho Builder (US-28 bước 4, theo G04 đoạn "Notification và recipient/outbox theo EN-03" và mục 3):
//   POST /api/me/pt-bookings thành công → trong CÙNG transaction với booking (sau booking, trước operation_requests như G04 bước 5):
//     notifications: đúng một document event_key = "BOOKING_CREATED:<bookingId>", member_id = member của booking, có sequence;
//       title ≤ 190, body ≤ 2000; nội dung chỉ tên buổi, giờ (theo giờ Việt Nam), địa điểm, trạng thái — không số điện thoại, email, tiền.
//     notification_recipients: account Member đang liên kết + account của PT trong booking (mỗi account một bản ghi), chưa có read_at/delivered_at.
//     notification_outbox: đúng một job cùng event_key, status READY.
//     Response 201 có notificationState = "STORED" (Member đặt lịch luôn có account liên kết nên luôn có người nhận).
//   Gửi lại cùng key: trả 201/body gốc, không tạo thêm notification/recipient/outbox.
//   Lỗi insert notifications/notification_recipients/notification_outbox trước commit → 503, rollback toàn bộ (không booking, không operation).
//   Socket/worker chạy sau commit: không ai online thì job vẫn DONE, REST sync (/api/notifications/sync) của Member và PT đọc được;
//     Member đọc được trong inbox US-47 (/api/me/notifications); PT chưa có inbox US-47 (403).
//   Dùng lại EN-03: NotificationOutboxService.runOnce() (một tick worker), namespace /notifications, sự kiện notification.created.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { NotificationOutboxService } from '../src/modules/notifications/notification-outbox.service';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us28_events';
const password = 'MậtKhẩuUS-28-456';
const base = '/api/me/pt-bookings';
const PRICE = '3000000';

type Auth = { accessToken: string };
type Created = { id: string; eventKey: string; title: string; body: string; createdAt: string };
type SyncBody = { items: (Created & { sequence: string })[]; nextCursor?: string | null; hasMore: boolean };

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('US-28 bước 4: thông báo EN-03 khi Member đặt slot PT', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let second: INestApplication;
  let connection: Connection;
  let worker: NotificationOutboxService;
  let baseUrl: string;
  const sockets: Socket[] = [];
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      // enableTestCommands=1 để dùng failpoint failCommand giả lập lỗi insert thông báo trước commit (TC12).
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName, args: ['--setParameter', 'enableTestCommands=1'] },
    });
    Object.assign(process.env, {
      NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(), MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'us28-test', SMTP_PASS: 'us28-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    // Cổng 0: hệ điều hành chọn cổng trống; socket cần server HTTP thật đang lắng nghe (TC13).
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    worker = app.get(NotificationOutboxService);
    // Instance thứ hai (kết nối DB riêng) để mô phỏng hai app server chạy song song (TC10).
    second = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(second);
    await second.init();
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const instance of [app, second]) {
      const limiter = new LoginLimiter();
      jest.spyOn(instance.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    }
    for (const collection of await db().collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    // Khóa lịch global (lệnh ensure-indexes tạo trong môi trường thật).
    await db().collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
  });

  afterEach(async () => {
    while (sockets.length) sockets.pop()!.disconnect();
    await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await second?.close();
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = (instance: INestApplication = app) => request(instance.getHttpServer());

  // ---------- Thời gian theo lịch Việt Nam ----------
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+07:00`);
  const day = vnDay(10);
  const iso = (d: string, hhmm: string) => `${d}T${hhmm}:00+07:00`;

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: 'MEMBER' | 'TRAINER', fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0914800${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: created.id, phone };
  }
  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }

  // PT mẫu (thay US-23): account TRAINER + hồ sơ trainers.
  async function trainer(fullName = 'PT Trần Văn Bình') {
    const owner = await account('TRAINER', fullName);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: owner.accountId, specialty: 'Thể hình', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: owner.accountId, phone: owner.phone, accessToken: await loginAs(owner.phone) };
  }

  async function insertShift(trainerId: ObjectId, onDay: string, from: string, to: string, location = 'Phòng PT 2') {
    const id = new ObjectId();
    const now = new Date();
    await db().collection('work_shifts').insertOne({
      _id: id, id, trainer_id: trainerId, start_at: at(onDay, from), end_at: at(onDay, to), location, status: 'CONFIRMED', version: 1,
      created_by: new ObjectId(), updated_by: new ObjectId(), created_at: now, updated_at: now, confirmed_at: now,
    });
    return id;
  }

  // Member có tài khoản đã liên kết hồ sơ (khuôn US-09, service_revision Int64 cho khóa member của EN-02).
  async function linkedMember(name = 'Hội viên US28 B4') {
    const owner = await account('MEMBER', name);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: name, phone: owner.phone, email: 'hoivien.us28@gym.test',
      account_id: owner.accountId, version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { accessToken: await loginAs(owner.phone), memberId, accountId: owner.accountId, phone: owner.phone };
  }

  // Một gói PT (thay US-14/22): plan → transaction → sale (kỳ theo ngày VN) → membership.
  let saleSeq = 0;
  async function insertPtPlan(memberId: ObjectId, quota = 10) {
    saleSeq += 1;
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const staffId = new ObjectId();
    const now = new Date();
    const money = Decimal128.fromString(PRICE);
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US28B4-${saleSeq}`, name: `Gói PT ${saleSeq}`, kind: 'PT', duration_days: 30,
      session_quota: quota, price: money, benefits: 'Quyền lợi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US28B4-${saleSeq}`, kind: 'PT', amount_due: money,
      status: 'SETTLED', request_key: randomBytes(32).toString('hex'), created_at: now, guard_revision: Long.ZERO,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: vnDay(-5), end_date: vnDay(30), plan_name_snapshot: `Gói PT ${saleSeq}`,
      benefits_snapshot: 'Quyền lợi', list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: quota,
      policy_snapshot: 'Giá niêm yết', created_at: now,
    });
    await db().collection('memberships').insertOne({ _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: 0 });
    return membershipId;
  }

  // Một bộ dữ liệu sẵn sàng đặt: Member có gói PT, PT có ca CONFIRMED 08:00–11:00 ở "Phòng PT 2".
  async function ready() {
    const me = await linkedMember();
    const membershipId = await insertPtPlan(me.memberId);
    const pt = await trainer();
    const shiftId = await insertShift(pt.trainerId, day, '08:00', '11:00');
    return { me, membershipId, pt, shiftId };
  }

  const bodyOf = (membershipId: ObjectId, trainerId: ObjectId, shiftId: ObjectId, startAt: string) => ({
    membershipId: membershipId.toHexString(), trainerId: trainerId.toHexString(), shiftId: shiftId.toHexString(), startAt,
  });

  function book(user: Auth, body: Record<string, unknown>, key: string = randomUUID(), instance: INestApplication = app) {
    return http(instance).post(base).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`).set('Idempotency-Key', key).send(body);
  }

  const count = (collection: string, filter: Record<string, unknown> = {}) => db().collection(collection).countDocuments(filter);
  const eventKeyOf = (bookingId: string) => `BOOKING_CREATED:${bookingId}`;
  const notificationOf = (bookingId: string) => db().collection('notifications').findOne({ event_key: eventKeyOf(bookingId) });
  const outboxOf = (bookingId: string) => db().collection('notification_outbox').findOne({ event_key: eventKeyOf(bookingId) });
  const guardRevision = async () => String((await db().collection('schedule_guards').findOne({ _id: 'global' as unknown as ObjectId }, { promoteLongs: false }))?.revision);
  const memberRevision = async (memberId: ObjectId) => String((await db().collection('members').findOne({ _id: memberId }, { promoteLongs: false }))?.service_revision);
  async function recipientAccounts(notificationId: ObjectId) {
    const rows = await db().collection('notification_recipients').find({ notification_id: notificationId }).toArray();
    return rows.map(row => (row.account_id as ObjectId).toHexString()).sort();
  }
  async function quotaOf(user: Auth, membershipId: ObjectId) {
    const response = await http().get(`/api/me/memberships/${membershipId.toHexString()}`).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`).expect(200);
    const { sessionsUsed, sessionsReserved, sessionsAvailable } = response.body as Record<string, number>;
    return { sessionsUsed, sessionsReserved, sessionsAvailable };
  }

  // ---------- REST sync (EN-03), inbox (US-47), socket ----------
  const sync = (accessToken: string) => http().get('/api/notifications/sync').set('Origin', origin).set('Authorization', `Bearer ${accessToken}`);
  const syncEventKeys = async (accessToken: string) => ((await sync(accessToken).expect(200)).body as SyncBody).items.map(item => item.eventKey);
  const inbox = (accessToken: string) => http().get('/api/me/notifications').set('Origin', origin).set('Authorization', `Bearer ${accessToken}`);

  async function connected(accessToken: string): Promise<Created[]> {
    const socket = io(`${baseUrl}/notifications`, {
      transports: ['websocket'], reconnection: false, forceNew: true, timeout: 3000,
      auth: { accessToken }, extraHeaders: { Origin: origin },
    });
    sockets.push(socket);
    const received: Created[] = [];
    socket.on('notification.created', (payload: Created) => received.push(payload));
    const result = await new Promise<string>(resolve => {
      socket.once('connect', () => resolve('connected'));
      socket.once('connect_error', () => resolve('rejected'));
    });
    expect(result).toBe('connected');
    return received;
  }

  // Một tick worker (gateway emit) rồi chờ một chút để gói tin đến client.
  async function dispatchAndSettle() {
    await worker.runOnce();
    await wait(500);
  }

  // Bật/tắt lỗi giả lập khi insert vào một collection (giống US-28-TC12 bước 3).
  async function failInsertsOn(collection: string, work: () => Promise<void>) {
    await db().admin().command({
      configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: ['insert'], namespace: `${databaseName}.${collection}`, errorCode: 1, errmsg: 'Giả lập DB lỗi US-28-TC12 bước 4' },
    });
    try {
      await work();
    } finally {
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
  }

  // =====================================================================
  // TC01 – đặt thành công thì lưu thông báo nguồn cùng commit (G04 bước 5)
  // =====================================================================
  describe('US-28-TC01: đặt thành công lưu event BOOKING_CREATED cùng commit', () => {
    it('US-28-TC01: 201 có notificationState STORED; đúng một notification BOOKING_CREATED:<bookingId> có member_id và sequence', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00'))).expect(201);

      expect(response.body.notificationState).toBe('STORED');
      expect(await count('notifications')).toBe(1);
      const notification = await notificationOf(response.body.id);
      expect(notification).not.toBeNull();
      expect((notification!.member_id as ObjectId).toHexString()).toBe(me.memberId.toHexString());
      expect(notification!.sequence).toBeDefined();
      expect(typeof notification!.title).toBe('string');
      expect((notification!.title as string).length).toBeGreaterThan(0);
      expect((notification!.title as string).length).toBeLessThanOrEqual(190);
      expect((notification!.body as string).length).toBeLessThanOrEqual(2000);
    });

    it('US-28-TC01: người nhận là account Member đang liên kết và account PT của booking, mỗi người một bản ghi, chưa giao/chưa đọc', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00'))).expect(201);

      const notification = await notificationOf(response.body.id);
      expect(await recipientAccounts(notification!._id as ObjectId)).toEqual([me.accountId.toHexString(), pt.accountId.toHexString()].sort());
      const rows = await db().collection('notification_recipients').find({ notification_id: notification!._id }).toArray();
      for (const row of rows) {
        expect(row.read_at).toBeUndefined();
        expect(row.delivered_at).toBeUndefined();
      }
    });

    it('US-28-TC01: đúng một outbox READY cùng event_key, trỏ về notification vừa lưu', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00'))).expect(201);

      const notification = await notificationOf(response.body.id);
      const outbox = await outboxOf(response.body.id);
      expect(await count('notification_outbox')).toBe(1);
      expect(outbox).not.toBeNull();
      expect(outbox!.status).toBe('READY');
      expect((outbox!.notification_id as ObjectId).toHexString()).toBe((notification!._id as ObjectId).toHexString());
    });

    it('US-28-TC01: nội dung có giờ theo giờ Việt Nam và địa điểm của ca; không có số điện thoại, email hay số tiền', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00'))).expect(201);

      const notification = await notificationOf(response.body.id);
      const text = `${notification!.title}\n${notification!.body}`;
      // 09:00 giờ VN = 02:00 UTC: phải hiện giờ VN.
      expect(text).toContain('09:00');
      expect(text).toContain('Phòng PT 2');
      for (const secret of [me.phone, pt.phone, 'hoivien.us28@gym.test', PRICE, '3.000.000', '3,000,000']) {
        expect(text).not.toContain(secret);
      }
    });
  });

  // =====================================================================
  // TC10 – replay / hai instance không nhân đôi event
  // =====================================================================
  describe('US-28-TC10: cùng key cùng payload không nhân đôi thông báo', () => {
    it('US-28-TC10: gửi lại đúng key sau khi đã commit → 201 cùng body gốc (STORED); vẫn một notification, mỗi người một recipient, một outbox', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const key = randomUUID();
      const body = bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00'));
      const first = await book(me, body, key).expect(201);
      const replay = await book(me, body, key).expect(201);

      expect(replay.body).toEqual(first.body);
      expect(replay.body.notificationState).toBe('STORED');
      expect(await count('notifications')).toBe(1);
      expect(await count('notification_recipients')).toBe(2);
      expect(await count('notification_outbox')).toBe(1);
    });

    it('US-28-TC10: cùng key gửi cùng lúc trên hai instance → một booking, một notification, một outbox', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const key = randomUUID();
      const body = bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00'));
      const [a, b] = await Promise.all([book(me, body, key, app), book(me, body, key, second)]);

      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body).toEqual(b.body);
      expect(await count('pt_bookings')).toBe(1);
      expect(await count('notifications')).toBe(1);
      expect(await count('notification_recipients')).toBe(2);
      expect(await count('notification_outbox')).toBe(1);
    });
  });

  // =====================================================================
  // TC12 – lỗi insert event/outbox/recipient trước commit
  // =====================================================================
  describe('US-28-TC12: lỗi insert thông báo trước commit', () => {
    it.each(['notifications', 'notification_recipients', 'notification_outbox'])(
      'US-28-TC12: insert vào %s lỗi → 503, rollback: không booking, không thông báo/operation, khóa và quota giữ nguyên',
      async collection => {
        const { me, membershipId, pt, shiftId } = await ready();
        const guardBefore = await guardRevision();
        const memberBefore = await memberRevision(me.memberId);
        const quotaBefore = await quotaOf(me, membershipId);

        let response!: request.Response;
        await failInsertsOn(collection, async () => {
          response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00')));
        });

        expect(response.status).toBe(503);
        expect(JSON.stringify(response.body)).not.toMatch(/Giả lập DB lỗi|MongoServerError/);
        expect(await count('pt_bookings')).toBe(0);
        expect(await count('notifications')).toBe(0);
        expect(await count('notification_recipients')).toBe(0);
        expect(await count('notification_outbox')).toBe(0);
        expect(await count('operation_requests')).toBe(0);
        expect(await guardRevision()).toBe(guardBefore);
        expect(await memberRevision(me.memberId)).toBe(memberBefore);
        expect(await quotaOf(me, membershipId)).toEqual(quotaBefore);
      },
    );
  });

  // =====================================================================
  // TC13 – socket offline/crash sau emit, BOOKED quá giờ
  // =====================================================================
  describe('US-28-TC13: socket offline/crash sau emit và BOOKED quá giờ', () => {
    it('US-28-TC13: Member và PT không mở socket → worker chạy xong job DONE; cả hai đọc được thông báo qua REST sync', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00'))).expect(201);
      await dispatchAndSettle();

      expect((await outboxOf(response.body.id))!.status).toBe('DONE');
      expect(await syncEventKeys(me.accessToken)).toEqual([eventKeyOf(response.body.id)]);
      expect(await syncEventKeys(pt.accessToken)).toEqual([eventKeyOf(response.body.id)]);
    });

    it('US-28-TC13: Member đọc được thông báo đặt lịch trong inbox US-47; PT chưa có inbox US-47 (403)', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00'))).expect(201);
      const notification = await notificationOf(response.body.id);

      const list = await inbox(me.accessToken).expect(200);
      expect((list.body.items as { id: string }[]).map(item => item.id)).toEqual([(notification!._id as ObjectId).toHexString()]);
      expect((await inbox(pt.accessToken)).status).toBe(403);
    });

    it('US-28-TC13: Member và PT đang online nhận notification.created đúng một lần với eventKey BOOKING_CREATED:<bookingId>', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const memberReceived = await connected(me.accessToken);
      const ptReceived = await connected(pt.accessToken);

      const response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00'))).expect(201);
      await dispatchAndSettle();
      await dispatchAndSettle();

      expect(memberReceived.map(item => item.eventKey)).toEqual([eventKeyOf(response.body.id)]);
      expect(ptReceived.map(item => item.eventKey)).toEqual([eventKeyOf(response.body.id)]);
    });

    it('US-28-TC13: worker crash sau emit trước DONE → được phát lại cùng id; DB/sync vẫn một thông báo, không có booking thứ hai', async () => {
      const { me, membershipId, pt, shiftId } = await ready();
      const memberReceived = await connected(me.accessToken);
      const response = await book(me, bodyOf(membershipId, pt.trainerId, shiftId, iso(day, '09:00'))).expect(201);
      await dispatchAndSettle();

      // Trạng thái worker chết để lại: đã emit nhưng chưa kịp ghi DONE, lease đã hết.
      await db().collection('notification_outbox').updateOne(
        { event_key: eventKeyOf(response.body.id) },
        { $set: { status: 'PROCESSING', lease_owner: 'worker-da-crash', lease_until: new Date(Date.now() - 1000) }, $unset: { completed_at: '' } },
      );
      await dispatchAndSettle();

      // Phát lại được phép, nhưng cùng một notification id để client dedupe.
      expect(memberReceived.length).toBeGreaterThanOrEqual(1);
      expect(new Set(memberReceived.map(item => item.id)).size).toBe(1);
      expect(await count('notifications')).toBe(1);
      expect(await count('pt_bookings')).toBe(1);
      expect(await syncEventKeys(me.accessToken)).toEqual([eventKeyOf(response.body.id)]);
    });

    it('US-28-TC13: BOOKED đã qua giờ không tự hoàn tất: sau khi worker chạy vẫn BOOKED, used giữ nguyên, vẫn giữ quota', async () => {
      const { me, membershipId, pt } = await ready();
      // Buổi BOOKED hôm qua (chưa ai xử lý hoàn tất ở S07).
      const yesterday = vnDay(-1);
      const id = new ObjectId();
      await db().collection('pt_bookings').insertOne({
        _id: id, id, membership_id: membershipId, member_id: me.memberId, trainer_id: pt.trainerId, shift_id: new ObjectId(),
        start_at: at(yesterday, '08:00'), end_at: at(yesterday, '09:00'), status: 'BOOKED', request_key: randomBytes(32).toString('hex'),
        version: 0, trainer_name_snapshot: 'PT Trần Văn Bình', location_snapshot: 'Phòng PT 2', created_at: new Date(), updated_at: new Date(),
      });
      await dispatchAndSettle();

      expect((await db().collection('pt_bookings').findOne({ _id: id }))!.status).toBe('BOOKED');
      expect(await quotaOf(me, membershipId)).toEqual({ sessionsUsed: 0, sessionsReserved: 1, sessionsAvailable: 9 });
    });
  });
});
