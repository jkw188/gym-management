// Tầng kiểm thử backend (Jest + MongoDB replica set thật + Supertest): US-64 bước 4 (phần backend).
// Kiểm tra thông báo PT_BOOKING_COMPLETED:<bookingId>:<revision> cùng commit với lệnh hoàn tất, rollback khi lỗi, REST còn khi offline,
// API danh sách buổi của PT GET /api/me/trainer-bookings (sinh viên chốt 12/11) và đối chiếu US-17/US-27 sau hoàn tất (F05, TC09, TC15).
// Hợp đồng test đặt ra cho Builder (US-64 bước 4, theo F05, bảng API mục 3 bản 1.1 và đoạn UI của spec):
//   Lệnh hoàn tất (PT: POST /api/me/pt-bookings/:id/complete; Admin COMPLETE: POST /api/admin/pt-bookings/:id/corrections) trong CÙNG transaction:
//     notifications: đúng một event_key "PT_BOOKING_COMPLETED:<bookingId>:<completion_revision>", member_id = member của booking,
//       title 1–190 ký tự, body ≤ 2000;
//     notification_recipients: account đang liên kết của Member + account của PT, chưa read_at/delivered_at;
//     notification_outbox: đúng một job cùng event_key, status READY.
//     Response thêm notificationState "STORED". Lỗi insert thông báo/outbox trước commit → 503, không hoàn tất, không trừ buổi.
//     Gửi lại cùng key hoặc key mới trên COMPLETED không tạo thông báo thứ hai. Xác nhận lại sau REOPEN → event_key revision mới.
//   GET /api/me/trainer-bookings?fromDate&toDate[&status] – chỉ TRAINER (vai trò khác 403); fromDate/toDate ngày VN YYYY-MM-DD,
//     sai định dạng, toDate < fromDate hoặc quá 31 ngày → 400. 200 {items:[{id, memberName, startAt, endAt, status, version, completedAt?, permittedActions}]},
//     chỉ buổi có trainer_id của chính PT, startAt nằm trong các ngày VN đã chọn, sắp theo startAt tăng dần.
//     permittedActions = ['COMPLETE'] khi BOOKED và giờ server ≥ endAt; ngược lại []. Không có phone/tiền/gói của Member.
//   Đối chiếu sau hoàn tất: GET /api/me/memberships (US-17) thấy sessionsUsed +1, sessionsReserved −1;
//     GET /api/me/pt-bookings/:id (US-27) thấy status COMPLETED, cancelAllowed false.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { NotificationOutboxService } from '../src/modules/notifications/notification-outbox.service';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us64_notify';
const password = 'MậtKhẩuUS-64-789';
const REASON = 'PT đã dạy, có xác nhận chữ ký học viên tại quầy';
const MINUTE = 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * MINUTE;

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Auth = { accessToken: string; accountId: string };
type SyncBody = { items: { eventKey: string }[] };

describe('US-64 bước 4: thông báo hoàn tất và danh sách buổi của PT', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      // enableTestCommands=1 để dùng failpoint failCommand giả lập lỗi insert trước commit (TC09).
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName, args: ['--setParameter', 'enableTestCommands=1'] },
    });
    Object.assign(process.env, {
      NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(), MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'us64-test', SMTP_PASS: 'us64-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await db().collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    await db().collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
  });

  afterEach(async () => {
    await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());

  // ---------- Thời gian ----------
  const roundedNow = () => new Date(Math.floor(Date.now() / MINUTE) * MINUTE);
  const vnDate = (instant: Date) => new Date(instant.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
  const freezeClock = (now: Date) => jest.spyOn(ServerClock.prototype, 'now').mockImplementation(() => new Date(now.getTime()));

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: Role, fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0914800${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: String(created.id), phone };
  }
  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }
  async function userOf(role: Role): Promise<Auth> {
    const created = await account(role, `${role} US64`);
    return { accountId: created.accountId, accessToken: await loginAs(created.phone) };
  }

  async function trainer(fullName = 'PT Lê Văn Cường') {
    const owner = await account('TRAINER', fullName);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: new ObjectId(owner.accountId), specialty: 'Thể hình', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: owner.accountId, accessToken: await loginAs(owner.phone) };
  }

  async function linkedMember(name = 'Nguyễn Thị Hoa') {
    const owner = await account('MEMBER', name);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: name, phone: owner.phone,
      account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { memberId, accountId: owner.accountId, accessToken: await loginAs(owner.phone), phone: owner.phone };
  }

  let saleSeq = 0;
  async function insertPlan(memberId: ObjectId) {
    saleSeq += 1;
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const staffId = new ObjectId();
    const now = new Date();
    const money = Decimal128.fromString('3000000');
    const today = vnDate(new Date());
    const shiftDays = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 24 * 60 * MINUTE).toISOString().slice(0, 10);
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US64N-${saleSeq}`, name: `Gói PT ${saleSeq}`, kind: 'PT', duration_days: 30,
      session_quota: 10, price: money, benefits: 'Quyền lợi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US64N-${saleSeq}`, kind: 'PT', amount_due: money,
      status: 'SETTLED', request_key: randomBytes(32).toString('hex'), created_at: now, guard_revision: Long.ZERO,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: shiftDays(-10), end_date: shiftDays(30), plan_name_snapshot: `Gói PT ${saleSeq}`,
      benefits_snapshot: 'Quyền lợi', list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: 10,
      policy_snapshot: 'Giá niêm yết', created_at: now,
    });
    await db().collection('memberships').insertOne({ _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: 2 });
    return membershipId;
  }

  async function insertBooking(memberId: ObjectId, membershipId: ObjectId, trainerId: ObjectId, end: Date, extra: Record<string, unknown> = {}) {
    const id = new ObjectId();
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: membershipId, member_id: memberId, trainer_id: trainerId, shift_id: new ObjectId(),
      start_at: new Date(end.getTime() - 60 * MINUTE), end_at: end, status: 'BOOKED', request_key: randomBytes(32).toString('hex'),
      version: 0, completion_revision: 0, trainer_name_snapshot: 'PT Lê Văn Cường', location_snapshot: 'Phòng PT 1',
      created_at: new Date(), updated_at: new Date(), ...extra,
    });
    return id;
  }

  async function ready(end: Date = roundedNow()) {
    const me = await linkedMember();
    const membershipId = await insertPlan(me.memberId);
    const pt = await trainer();
    const bookingId = await insertBooking(me.memberId, membershipId, pt.trainerId, end);
    return { me, membershipId, pt, bookingId, end };
  }

  // ---------- Gọi API ----------
  const complete = (auth: Auth, bookingId: ObjectId, version = 0, key: string = randomUUID()) =>
    http().post(`/api/me/pt-bookings/${bookingId.toHexString()}/complete`).set('Origin', origin)
      .set('Authorization', `Bearer ${auth.accessToken}`).set('Idempotency-Key', key).send({ version });
  const correct = (auth: Auth, bookingId: ObjectId, body: Record<string, unknown>) =>
    http().post(`/api/admin/pt-bookings/${bookingId.toHexString()}/corrections`).set('Origin', origin)
      .set('Authorization', `Bearer ${auth.accessToken}`).set('Idempotency-Key', randomUUID()).send(body);
  const get = (path: string, auth: Auth, query: Record<string, string> = {}) =>
    http().get(path).query(query).set('Origin', origin).set('Authorization', `Bearer ${auth.accessToken}`);
  const syncEventKeys = async (auth: Auth) =>
    ((await get('/api/notifications/sync', auth).expect(200)).body as SyncBody).items.map(item => item.eventKey);

  function expectError(response: request.Response, status: number, code?: string) {
    expect(response.status).toBe(status);
    expect(typeof response.body.error?.code).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
    if (code) expect(response.body.error.code).toBe(code);
  }

  // ---------- Đọc DB ----------
  const keyOf = (bookingId: ObjectId, revision: number) => `PT_BOOKING_COMPLETED:${bookingId.toHexString()}:${revision}`;
  const count = (collection: string, filter: Record<string, unknown> = {}) => db().collection(collection).countDocuments(filter);
  const completedNotifications = (bookingId: ObjectId) =>
    count('notifications', { event_key: { $regex: `^PT_BOOKING_COMPLETED:${bookingId.toHexString()}:` } });
  async function recipientAccounts(notificationId: ObjectId) {
    const rows = await db().collection('notification_recipients').find({ notification_id: notificationId }).toArray();
    return rows.map(row => String(row.account_id)).sort();
  }
  const usedOf = async (membershipId: ObjectId) => (await db().collection('memberships').findOne({ _id: membershipId }))?.sessions_used as number;

  // Bật lỗi giả lập khi insert vào một collection, chạy work, rồi tắt (giống US-29-TC12).
  async function failInsertsOn(collection: string, work: () => Promise<void>) {
    await db().admin().command({
      configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: ['insert'], namespace: `${databaseName}.${collection}`, errorCode: 1, errmsg: 'Giả lập DB lỗi US-64-TC09' },
    });
    try {
      await work();
    } finally {
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
  }

  // =====================================================================
  // F05 – Thông báo PT_BOOKING_COMPLETED cùng commit
  // =====================================================================
  describe('US-64-F05: thông báo hoàn tất', () => {
    it('US-64-F05: PT xác nhận → notificationState STORED; đúng một notification PT_BOOKING_COMPLETED:<id>:1 có member_id, tiêu đề/nội dung trong giới hạn', async () => {
      const { me, pt, bookingId, end } = await ready();
      freezeClock(end);

      const response = await complete(pt, bookingId).expect(200);

      expect(response.body.notificationState).toBe('STORED');
      expect(await count('notifications', { event_key: keyOf(bookingId, 1) })).toBe(1);
      const notification = await db().collection('notifications').findOne({ event_key: keyOf(bookingId, 1) });
      expect(String(notification!.member_id)).toBe(me.memberId.toHexString());
      expect((notification!.title as string).length).toBeGreaterThan(0);
      expect((notification!.title as string).length).toBeLessThanOrEqual(190);
      expect((notification!.body as string).length).toBeLessThanOrEqual(2000);
    });

    it('US-64-F05: người nhận là account Member và account PT, chưa giao/chưa đọc; đúng một outbox READY trỏ về thông báo', async () => {
      const { me, pt, bookingId, end } = await ready();
      freezeClock(end);

      await complete(pt, bookingId).expect(200);

      const notification = await db().collection('notifications').findOne({ event_key: keyOf(bookingId, 1) });
      expect(await recipientAccounts(notification!._id as ObjectId)).toEqual([me.accountId, pt.accountId].sort());
      const rows = await db().collection('notification_recipients').find({ notification_id: notification!._id }).toArray();
      for (const row of rows) {
        expect(row.read_at ?? null).toBeNull();
        expect(row.delivered_at ?? null).toBeNull();
      }
      expect(await count('notification_outbox', { event_key: keyOf(bookingId, 1) })).toBe(1);
      const outbox = await db().collection('notification_outbox').findOne({ event_key: keyOf(bookingId, 1) });
      expect(outbox!.status).toBe('READY');
      expect(String(outbox!.notification_id)).toBe(String(notification!._id));
    });

    it('US-64-F05: Admin COMPLETE hỗ trợ cũng tạo đúng một thông báo PT_BOOKING_COMPLETED:<id>:1 cho Member và PT', async () => {
      const { me, pt, bookingId, end } = await ready();
      const admin = await userOf('ADMIN');
      freezeClock(end);

      const response = await correct(admin, bookingId, { version: 0, action: 'COMPLETE', reason: REASON }).expect(200);

      expect(response.body.notificationState).toBe('STORED');
      const notification = await db().collection('notifications').findOne({ event_key: keyOf(bookingId, 1) });
      expect(notification).not.toBeNull();
      expect(await recipientAccounts(notification!._id as ObjectId)).toEqual([me.accountId, pt.accountId].sort());
    });

    it('US-64-F05: gửi lại cùng key và gửi key mới trên buổi COMPLETED → vẫn chỉ một thông báo, một outbox', async () => {
      const { pt, bookingId, end } = await ready();
      freezeClock(end);
      const key = randomUUID();

      await complete(pt, bookingId, 0, key).expect(200);
      await complete(pt, bookingId, 0, key).expect(200);
      expectError(await complete(pt, bookingId, 1), 409, 'BOOKING_ALREADY_COMPLETED');

      expect(await completedNotifications(bookingId)).toBe(1);
      expect(await count('notification_outbox', { event_key: keyOf(bookingId, 1) })).toBe(1);
    });

    it('US-64-F05 (C04): xác nhận lại sau REOPEN → thêm thông báo PT_BOOKING_COMPLETED:<id>:3; thông báo :1 vẫn còn', async () => {
      const { pt, bookingId, end } = await ready();
      const admin = await userOf('ADMIN');
      freezeClock(end);
      await complete(pt, bookingId, 0).expect(200);
      await correct(admin, bookingId, { version: 1, action: 'REOPEN', reason: REASON }).expect(200);

      await complete(pt, bookingId, 2).expect(200);

      expect(await count('notifications', { event_key: keyOf(bookingId, 1) })).toBe(1);
      expect(await count('notifications', { event_key: keyOf(bookingId, 3) })).toBe(1);
      expect(await completedNotifications(bookingId)).toBe(2);
    });
  });

  // =====================================================================
  // TC09 – Rollback khi lỗi thông báo; REST còn khi offline
  // =====================================================================
  describe('US-64-TC09: thông báo và rollback', () => {
    it.each(['notifications', 'notification_recipients', 'notification_outbox'])(
      'US-64-TC09: insert vào %s lỗi trước commit → 503; booking vẫn BOOKED, used giữ nguyên, không event, không thông báo', async collection => {
        const { membershipId, pt, bookingId, end } = await ready();
        freezeClock(end);

        await failInsertsOn(collection, async () => {
          const response = await complete(pt, bookingId);
          expectError(response, 503);
          expect(JSON.stringify(response.body)).not.toContain('Giả lập DB lỗi');
        });

        expect((await db().collection('pt_bookings').findOne({ _id: bookingId }))?.status).toBe('BOOKED');
        expect(await usedOf(membershipId)).toBe(2);
        expect(await count('booking_events', { booking_id: bookingId })).toBe(0);
        expect(await completedNotifications(bookingId)).toBe(0);
        expect(await count('notification_outbox', { event_key: keyOf(bookingId, 1) })).toBe(0);
      });

    it('US-64-TC09: không ai mở socket → worker xử lý xong; Member và PT đọc qua REST sync vẫn thấy PT_BOOKING_COMPLETED', async () => {
      const { me, pt, bookingId, end } = await ready();
      freezeClock(end);
      await complete(pt, bookingId).expect(200);

      await app.get(NotificationOutboxService).runOnce();

      expect(await syncEventKeys(me)).toContain(keyOf(bookingId, 1));
      expect(await syncEventKeys(pt)).toContain(keyOf(bookingId, 1));
    });
  });

  // =====================================================================
  // TC15 / đối chiếu US-17, US-27 – dữ liệu sau hoàn tất
  // =====================================================================
  describe('US-64 bước 4: đối chiếu US-17/US-27 sau hoàn tất', () => {
    it('US-64-TC15 (US-17): sau khi PT xác nhận, Member thấy gói sessionsUsed +1, sessionsReserved −1', async () => {
      const { me, membershipId, pt, bookingId, end } = await ready();
      const findPlan = async () => ((await get('/api/me/memberships', me).expect(200)).body.items as Record<string, unknown>[])
        .find(item => item.id === membershipId.toHexString())!;
      const before = await findPlan();
      freezeClock(end);

      await complete(pt, bookingId).expect(200);

      const after = await findPlan();
      expect(after.sessionsUsed).toBe(Number(before.sessionsUsed) + 1);
      expect(after.sessionsReserved).toBe(Number(before.sessionsReserved) - 1);
    });

    it('US-64-TC15 (US-27): sau khi PT xác nhận, Member xem chi tiết buổi thấy COMPLETED, cancelAllowed false', async () => {
      const { me, pt, bookingId, end } = await ready();
      freezeClock(end);
      await complete(pt, bookingId).expect(200);

      const detail = await get(`/api/me/pt-bookings/${bookingId.toHexString()}`, me).expect(200);

      expect(detail.body).toMatchObject({ status: 'COMPLETED', cancelAllowed: false });
    });
  });

  // =====================================================================
  // GET /api/me/trainer-bookings – danh sách buổi của PT (spec mục 3 bản 1.1)
  // =====================================================================
  describe('US-64 bước 4: GET /api/me/trainer-bookings', () => {
    it('US-64-TC15: PT thấy buổi của mình trong ngày đã chọn, sắp theo startAt; không thấy buổi của PT khác hay ngoài ngày', async () => {
      const end = roundedNow();
      const { me, membershipId, pt, bookingId } = await ready(end);
      const earlier = await insertBooking(me.memberId, membershipId, pt.trainerId, new Date(end.getTime() - 2 * 60 * MINUTE));
      // Buổi ngày khác (cách 3 ngày) và buổi của PT khác cùng giờ.
      await insertBooking(me.memberId, membershipId, pt.trainerId, new Date(end.getTime() + 3 * 24 * 60 * MINUTE));
      const otherPt = await trainer('PT Trần Thị Dung');
      await insertBooking(me.memberId, membershipId, otherPt.trainerId, end);
      // Ngày VN của hai buổi cùng ngày (buổi sớm hơn có thể rơi sang ngày trước nếu chạy test gần nửa đêm).
      const fromDate = vnDate(new Date(end.getTime() - 3 * 60 * MINUTE));
      const toDate = vnDate(end);

      const response = await get('/api/me/trainer-bookings', pt, { fromDate, toDate }).expect(200);

      const ids = (response.body.items as { id: string }[]).map(item => item.id);
      expect(ids).toEqual([earlier.toHexString(), bookingId.toHexString()]);
    });

    it('US-64-TC15: mỗi item đủ field, có tên hội viên; KHÔNG có số điện thoại, giá tiền hay gói của Member', async () => {
      const { me, pt, end } = await ready();

      const response = await get('/api/me/trainer-bookings', pt, { fromDate: vnDate(end), toDate: vnDate(end) }).expect(200);

      const item = response.body.items[0] as Record<string, unknown>;
      expect(item).toMatchObject({ memberName: 'Nguyễn Thị Hoa', status: 'BOOKED', version: 0 });
      for (const field of ['id', 'startAt', 'endAt', 'permittedActions']) expect(item).toHaveProperty(field);
      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain(me.phone);
      for (const field of ['phone', 'price', 'amount', 'membershipId', 'sessionsUsed']) expect(item).not.toHaveProperty(field);
    });

    it('US-64-TC15: permittedActions có COMPLETE khi BOOKED và giờ server ≥ endAt; trước endAt 1 giây thì rỗng', async () => {
      const { pt, end } = await ready();
      const query = { fromDate: vnDate(end), toDate: vnDate(end) };

      const clock = freezeClock(end);
      expect((await get('/api/me/trainer-bookings', pt, query).expect(200)).body.items[0].permittedActions).toEqual(['COMPLETE']);
      clock.mockRestore();
      freezeClock(new Date(end.getTime() - 1000));
      expect((await get('/api/me/trainer-bookings', pt, query).expect(200)).body.items[0].permittedActions).toEqual([]);
    });

    it('US-64-TC15: buổi COMPLETED có completedAt (giờ xác nhận, khác endAt) và permittedActions rỗng; buổi CANCELLED permittedActions rỗng', async () => {
      const end = new Date(roundedNow().getTime() - 2 * 60 * MINUTE);
      const { me, membershipId, pt, bookingId } = await ready(end);
      const cancelled = await insertBooking(me.memberId, membershipId, pt.trainerId, new Date(end.getTime() - 90 * MINUTE), { status: 'CANCELLED', cancelled_at: new Date() });
      const confirmedAt = roundedNow();
      freezeClock(confirmedAt);
      await complete(pt, bookingId).expect(200);

      const response = await get('/api/me/trainer-bookings', pt, {
        fromDate: vnDate(new Date(end.getTime() - 3 * 60 * MINUTE)), toDate: vnDate(confirmedAt),
      }).expect(200);

      const items = response.body.items as Record<string, unknown>[];
      const done = items.find(item => item.id === bookingId.toHexString())!;
      expect(done).toMatchObject({ status: 'COMPLETED', permittedActions: [] });
      expect(new Date(done.completedAt as string).getTime()).toBe(confirmedAt.getTime());
      expect(done.completedAt).not.toBe(done.endAt);
      expect(items.find(item => item.id === cancelled.toHexString())).toMatchObject({ status: 'CANCELLED', permittedActions: [] });
    });

    it('US-64-TC15: lọc status=BOOKED chỉ trả buổi BOOKED', async () => {
      const end = roundedNow();
      const { me, membershipId, pt, bookingId } = await ready(end);
      await insertBooking(me.memberId, membershipId, pt.trainerId, new Date(end.getTime() - 90 * MINUTE), { status: 'CANCELLED', cancelled_at: new Date() });

      const response = await get('/api/me/trainer-bookings', pt, {
        fromDate: vnDate(new Date(end.getTime() - 3 * 60 * MINUTE)), toDate: vnDate(end), status: 'BOOKED',
      }).expect(200);

      expect((response.body.items as { id: string }[]).map(item => item.id)).toEqual([bookingId.toHexString()]);
    });

    it.each(['MEMBER', 'STAFF', 'ADMIN'] as const)('US-64-TC15: %s gọi danh sách của PT → 403', async role => {
      const actor = await userOf(role);
      const today = vnDate(new Date());
      expectError(await get('/api/me/trainer-bookings', actor, { fromDate: today, toDate: today }), 403);
    });

    it.each([
      ['thiếu fromDate', { toDate: '2026-11-20' }],
      ['ngày sai định dạng', { fromDate: '20/11/2026', toDate: '2026-11-20' }],
      ['toDate trước fromDate', { fromDate: '2026-11-20', toDate: '2026-11-19' }],
      ['status ngoài danh sách', { fromDate: '2026-11-20', toDate: '2026-11-20', status: 'DONE' }],
    ])('US-64-TC15: %s → 400', async (_label, query) => {
      const pt = await trainer();
      expectError(await get('/api/me/trainer-bookings', pt, query as Record<string, string>), 400);
    });

    // Giới hạn tối đa 31 ngày mỗi lần xem (sinh viên chốt 12/11, giống tra cứu US-27/US-29).
    it('US-64-TC15: khoảng đúng 31 ngày (01/11–01/12/2026) → 200', async () => {
      const pt = await trainer();
      const response = await get('/api/me/trainer-bookings', pt, { fromDate: '2026-11-01', toDate: '2026-12-01' }).expect(200);
      expect(Array.isArray(response.body.items)).toBe(true);
    });

    it('US-64-TC15: khoảng 32 ngày (01/11–02/12/2026) → 400', async () => {
      const pt = await trainer();
      expectError(await get('/api/me/trainer-bookings', pt, { fromDate: '2026-11-01', toDate: '2026-12-02' }), 400);
    });
  });
});
