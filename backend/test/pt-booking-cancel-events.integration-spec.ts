// Tầng kiểm thử backend (Jest + MongoDB replica set thật): US-29 bước 2.
// Kiểm tra lệnh hủy buổi PT ghi audit booking_events, thông báo BOOKING_CANCELLED theo EN-03 cùng commit,
// lấy khóa lịch rồi khóa member, và lỗi giữa chừng thì không hủy nửa chừng (TC04, TC05, TC07–TC09, TC11–TC13).
// Hợp đồng test đặt ra cho Builder (US-29 bước 2, theo F04, F05 và mục 2 của spec; sinh viên chốt 2026-11-11):
//   CancelBookingService.cancel nhận thêm idempotencyKey: string (UUID). Gửi lại cùng key và operation_requests để bước 3 (API).
//   Kết quả thêm notificationState (EN-03): "STORED" khi đã lưu thông báo cho người nhận.
//   Trong CÙNG transaction với lệnh hủy:
//     schedule_guards 'global'.revision +1 rồi members.service_revision của member chủ booking +1 (F04: khóa lịch trước khóa member).
//     booking_events: đúng một document {booking_id, member_id, membership_id (gói của booking lúc hủy), actor_id (account người hủy),
//       action 'CANCELLED', actor_role (MEMBER/STAFF/ADMIN), reason (đã trim), occurred_at (= cancelled_at), before_status 'BOOKED',
//       after_status 'CANCELLED', request_key (băm từ idempotencyKey: hex 64 ký tự, không chứa key thô)}.
//       Index (booking_id, occurred_at) và request_key unique.
//     notifications: đúng một event_key "BOOKING_CANCELLED:<bookingId>", member_id = member của booking, title ≤ 190, body ≤ 2000.
//     notification_recipients: account đang liên kết của Member + account của PT (kể cả account bị khóa), chưa read_at/delivered_at.
//     notification_outbox: đúng một job cùng event_key, status READY.
//   Lỗi nghiệp vụ hoặc lỗi insert trước commit → không có gì được ghi (booking vẫn BOOKED, không event/thông báo, khóa không tăng).
//   Không xóa hay đánh dấu đã đọc thông báo BOOKING_CREATED cũ của booking.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { ApplicationError } from '../src/common/errors/application-error';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { CancelBookingService } from '../src/modules/bookings/cancel-booking.service';
import { NotificationOutboxService } from '../src/modules/notifications/notification-outbox.service';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us29_events';
const password = 'MậtKhẩuUS-29-456';
const REASON = 'Học viên báo ốm, nhân viên hủy hộ';
const MINUTE = 60 * 1000;

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type CancelInput = {
  policy: 'OWN' | 'SUPPORT'; actorId: string; actorRole: Role; bookingId: string; version: number; reason?: string; idempotencyKey: string;
};
type Auth = { accessToken: string };
type SyncBody = { items: { eventKey: string }[] };

describe('US-29 bước 2: audit booking_events, thông báo BOOKING_CANCELLED, khóa lịch rồi khóa member', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      // enableTestCommands=1 để dùng failpoint failCommand giả lập lỗi insert trước commit (TC12), giống US-28-TC12.
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName, args: ['--setParameter', 'enableTestCommands=1'] },
    });
    Object.assign(process.env, {
      NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(), MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'us29-test', SMTP_PASS: 'us29-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    // Server HTTP thật đang lắng nghe để worker EN-03 phát socket được (TC13), giống US-28-TC13.
    await app.listen(0, '127.0.0.1');
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
    // Khóa lịch global (lệnh ensure-indexes tạo trong môi trường thật).
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
  const cancel = (input: CancelInput) => app.get(CancelBookingService).cancel(input);

  // ---------- Thời gian ----------
  const minutesAhead = (minutes: number) => new Date(Math.ceil((Date.now() + minutes * MINUTE) / MINUTE) * MINUTE);
  const minutesAgo = (minutes: number) => new Date(Math.floor((Date.now() - minutes * MINUTE) / MINUTE) * MINUTE);
  const VN_OFFSET_MS = 7 * 60 * MINUTE;
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * MINUTE).toISOString().slice(0, 10);
  const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+07:00`);

  // ---------- Tài khoản và dữ liệu mẫu (khuôn US-28) ----------
  let phoneSeq = 0;
  async function account(roleCode: Role, fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0914900${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    // accountId dạng chuỗi hex (giống id trong JWT) để truyền vào actorId.
    return { accountId: String(created.id), phone };
  }
  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }

  async function trainer(fullName = 'PT Lê Văn Cường') {
    const owner = await account('TRAINER', fullName);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: new ObjectId(owner.accountId), specialty: 'Thể hình', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: owner.accountId, phone: owner.phone };
  }

  async function linkedMember(name = 'Hội viên US29 B2') {
    const owner = await account('MEMBER', name);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: name, phone: owner.phone,
      account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { memberId, accountId: owner.accountId, phone: owner.phone };
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
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US29B2-${saleSeq}`, name: `Gói PT ${saleSeq}`, kind: 'PT', duration_days: 30,
      session_quota: 10, price: money, benefits: 'Quyền lợi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US29B2-${saleSeq}`, kind: 'PT', amount_due: money,
      status: 'SETTLED', request_key: randomBytes(32).toString('hex'), created_at: now, guard_revision: Long.ZERO,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: vnDay(-5), end_date: vnDay(30), plan_name_snapshot: `Gói PT ${saleSeq}`,
      benefits_snapshot: 'Quyền lợi', list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: 10,
      policy_snapshot: 'Giá niêm yết', created_at: now,
    });
    await db().collection('memberships').insertOne({ _id: membershipId, id: membershipId, service_sale_id: saleId, status: 'ACTIVE', sessions_used: 2 });
    return membershipId;
  }

  async function insertBooking(memberId: ObjectId, membershipId: ObjectId, trainerId: ObjectId, start: Date) {
    const id = new ObjectId();
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: membershipId, member_id: memberId, trainer_id: trainerId, shift_id: new ObjectId(),
      start_at: start, end_at: new Date(start.getTime() + 60 * MINUTE), status: 'BOOKED', request_key: randomBytes(32).toString('hex'),
      version: 0, trainer_name_snapshot: 'PT Lê Văn Cường', location_snapshot: 'Phòng PT 1', created_at: new Date(), updated_at: new Date(),
    });
    return id;
  }

  // Bộ dữ liệu sẵn: Member có gói PT, một buổi BOOKED với PT bắt đầu lúc `start` (mặc định còn 3 giờ).
  async function ready(start: Date = minutesAhead(180)) {
    const me = await linkedMember();
    const membershipId = await insertPlan(me.memberId);
    const pt = await trainer();
    const bookingId = await insertBooking(me.memberId, membershipId, pt.trainerId, start);
    return { me, membershipId, pt, bookingId };
  }

  const ownInput = (me: { accountId: string }, bookingId: ObjectId, key: string = randomUUID(), version = 0): CancelInput => ({
    policy: 'OWN', actorId: me.accountId, actorRole: 'MEMBER', bookingId: bookingId.toHexString(), version, reason: REASON, idempotencyKey: key,
  });
  const supportInput = (actor: { accountId: string }, role: Role, bookingId: ObjectId, key: string = randomUUID(), version = 0): CancelInput => ({
    policy: 'SUPPORT', actorId: actor.accountId, actorRole: role, bookingId: bookingId.toHexString(), version, reason: `  ${REASON}  `, idempotencyKey: key,
  });

  // ---------- Đọc kết quả ----------
  const count = (collection: string, filter: Record<string, unknown> = {}) => db().collection(collection).countDocuments(filter);
  const cancelKeyOf = (bookingId: ObjectId | string) => `BOOKING_CANCELLED:${String(bookingId)}`;
  const createdKeyOf = (bookingId: ObjectId | string) => `BOOKING_CREATED:${String(bookingId)}`;
  const eventsOf = (bookingId: ObjectId) => db().collection('booking_events').find({ booking_id: bookingId }).toArray();
  const cancelNotificationOf = (bookingId: ObjectId) => db().collection('notifications').findOne({ event_key: cancelKeyOf(bookingId) });
  const cancelOutboxOf = (bookingId: ObjectId) => db().collection('notification_outbox').findOne({ event_key: cancelKeyOf(bookingId) });
  const guardRevision = async () => Number(String((await db().collection('schedule_guards').findOne({ _id: 'global' as unknown as ObjectId }, { promoteLongs: false }))?.revision));
  const memberRevision = async (memberId: ObjectId) => Number(String((await db().collection('members').findOne({ _id: memberId }, { promoteLongs: false }))?.service_revision));
  async function recipientAccounts(notificationId: ObjectId) {
    const rows = await db().collection('notification_recipients').find({ notification_id: notificationId }).toArray();
    return rows.map(row => String(row.account_id)).sort();
  }
  const sync = (accessToken: string) => http().get('/api/notifications/sync').set('Origin', origin).set('Authorization', `Bearer ${accessToken}`);
  const syncEventKeys = async (accessToken: string) => ((await sync(accessToken).expect(200)).body as SyncBody).items.map(item => item.eventKey);

  // Không có dấu vết hủy nào được ghi: không event, không thông báo hủy, không outbox hủy.
  async function expectNoCancelTrace(bookingId: ObjectId) {
    expect(await count('booking_events')).toBe(0);
    expect(await count('notifications', { event_key: cancelKeyOf(bookingId) })).toBe(0);
    expect(await count('notification_outbox', { event_key: cancelKeyOf(bookingId) })).toBe(0);
  }

  // Bật lỗi giả lập khi insert vào một collection, chạy work, rồi tắt (giống US-28-TC12).
  async function failInsertsOn(collection: string, work: () => Promise<void>) {
    await db().admin().command({
      configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: ['insert'], namespace: `${databaseName}.${collection}`, errorCode: 1, errmsg: 'Giả lập DB lỗi US-29-TC12' },
    });
    try {
      await work();
    } finally {
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
  }

  // =====================================================================
  // AC01–AC02 – Audit booking_events (TC04, TC05, TC07)
  // =====================================================================

  describe('US-29-TC05: Staff/Admin hủy hỗ trợ có audit role/reason', () => {
    it('US-29-TC05: STAFF hủy buổi còn 30 phút → đúng một booking_events đủ field, actor_role STAFF, reason đã trim, BOOKED → CANCELLED', async () => {
      const { me, membershipId, bookingId } = await ready(minutesAhead(30));
      const staff = await account('STAFF', 'Nhân viên Quầy');
      const key = randomUUID();

      await cancel(supportInput(staff, 'STAFF', bookingId, key));

      const events = await eventsOf(bookingId);
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({ action: 'CANCELLED', actor_role: 'STAFF', reason: REASON, before_status: 'BOOKED', after_status: 'CANCELLED' });
      expect(String(event.member_id)).toBe(me.memberId.toHexString());
      expect(String(event.membership_id)).toBe(membershipId.toHexString());
      expect(String(event.actor_id)).toBe(staff.accountId);
      const booking = await db().collection('pt_bookings').findOne({ _id: bookingId });
      expect(event.occurred_at).toBeInstanceOf(Date);
      expect((event.occurred_at as Date).getTime()).toBe((booking!.cancelled_at as Date).getTime());
    });

    it('US-29-TC05: request_key của event là bản băm hex 64 ký tự, không lưu Idempotency-Key thô', async () => {
      const { bookingId } = await ready(minutesAhead(30));
      const staff = await account('STAFF', 'Nhân viên Quầy');
      const key = randomUUID();

      await cancel(supportInput(staff, 'STAFF', bookingId, key));

      const [event] = await eventsOf(bookingId);
      expect(event.request_key).toMatch(/^[a-f0-9]{64}$/);
      expect(event.request_key).not.toContain(key);
      expect(JSON.stringify(event)).not.toContain(key);
    });

    it('US-29-TC05: ADMIN hủy buổi đã qua giờ → event actor_role ADMIN, actor_id là account admin', async () => {
      const { bookingId } = await ready(minutesAgo(24 * 60));
      const admin = await account('ADMIN', 'Quản trị viên');

      await cancel(supportInput(admin, 'ADMIN', bookingId));

      const [event] = await eventsOf(bookingId);
      expect(event).toMatchObject({ actor_role: 'ADMIN', action: 'CANCELLED' });
      expect(String(event.actor_id)).toBe(admin.accountId);
    });

    it('US-29-TC05: booking_events có index (booking_id, occurred_at) và index unique request_key', async () => {
      const indexes = await db().collection('booking_events').indexes();

      expect(indexes.some(index => JSON.stringify(index.key) === JSON.stringify({ booking_id: 1, occurred_at: 1 }))).toBe(true);
      expect(indexes.some(index => JSON.stringify(index.key) === JSON.stringify({ request_key: 1 }) && index.unique === true)).toBe(true);
    });
  });

  describe('US-29-TC04: membership đã đổi sau nâng cấp, audit ghi gói hiện tại', () => {
    it('US-29-TC04: Member tự hủy sau khi booking chuyển sang gói mới → event có member_id cũ, membership_id gói mới, actor_role MEMBER', async () => {
      const { me, bookingId } = await ready();
      const newMembershipId = await insertPlan(me.memberId);
      await db().collection('pt_bookings').updateOne({ _id: bookingId }, { $set: { membership_id: newMembershipId, version: 1 } });

      await cancel(ownInput(me, bookingId, randomUUID(), 1));

      const [event] = await eventsOf(bookingId);
      expect(event).toMatchObject({ actor_role: 'MEMBER', before_status: 'BOOKED', after_status: 'CANCELLED' });
      expect(String(event.member_id)).toBe(me.memberId.toHexString());
      expect(String(event.membership_id)).toBe(newMembershipId.toHexString());
      expect(String(event.actor_id)).toBe(me.accountId);
    });
  });

  describe('US-29-TC07: booking đã CANCELLED gửi key mới → không giả tạo thêm lần hủy', () => {
    it('US-29-TC07: hủy lại bằng key mới → 409 INVALID_BOOKING_STATE; vẫn một event, một thông báo hủy, một outbox', async () => {
      const { me, bookingId } = await ready();
      await cancel(ownInput(me, bookingId));

      const error = await cancel(ownInput(me, bookingId, randomUUID(), 1)).then(() => null, (caught: unknown) => caught);

      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe('INVALID_BOOKING_STATE');
      expect(await eventsOf(bookingId)).toHaveLength(1);
      expect(await count('notifications', { event_key: cancelKeyOf(bookingId) })).toBe(1);
      expect(await count('notification_outbox', { event_key: cancelKeyOf(bookingId) })).toBe(1);
    });
  });

  // =====================================================================
  // AC02–AC03 – Thông báo BOOKING_CANCELLED theo EN-03 (TC08, TC13)
  // =====================================================================

  describe('US-29-TC08: Member/PT bị khóa nhưng hỗ trợ của staff vẫn hợp lệ, recipient lưu theo snapshot', () => {
    it('US-29-TC08: account Member và PT LOCKED, trainer INACTIVE → hủy thành công, recipient vẫn là account Member và account PT lúc commit', async () => {
      const { me, pt, bookingId } = await ready(minutesAhead(30));
      await db().collection('accounts').updateMany({ _id: { $in: [new ObjectId(me.accountId), new ObjectId(pt.accountId)] } }, { $set: { status: 'LOCKED' } });
      await db().collection('trainers').updateOne({ _id: pt.trainerId }, { $set: { status: 'INACTIVE' } });
      const staff = await account('STAFF', 'Nhân viên Quầy');

      const result = await cancel(supportInput(staff, 'STAFF', bookingId));

      expect(result).toMatchObject({ status: 'CANCELLED', notificationState: 'STORED' });
      const notification = await cancelNotificationOf(bookingId);
      expect(notification).not.toBeNull();
      expect(await recipientAccounts(notification!._id as ObjectId)).toEqual([me.accountId, pt.accountId].sort());
    });
  });

  describe('US-29-TC13: thông báo hủy lưu theo EN-03, đọc được qua REST, giữ lịch sử, không tự đánh dấu đã đọc', () => {
    it('US-29-TC13: hủy thành công → kết quả notificationState STORED; đúng một notification BOOKING_CANCELLED:<id> có member_id, tiêu đề/nội dung trong giới hạn', async () => {
      const { me, bookingId } = await ready();

      const result = await cancel(ownInput(me, bookingId));

      expect((result as { notificationState?: string }).notificationState).toBe('STORED');
      expect(await count('notifications', { event_key: cancelKeyOf(bookingId) })).toBe(1);
      const notification = await cancelNotificationOf(bookingId);
      expect(String(notification!.member_id)).toBe(me.memberId.toHexString());
      expect(notification!.sequence).toBeDefined();
      expect((notification!.title as string).length).toBeGreaterThan(0);
      expect((notification!.title as string).length).toBeLessThanOrEqual(190);
      expect((notification!.body as string).length).toBeLessThanOrEqual(2000);
    });

    it('US-29-TC13: người nhận là account Member và account PT, mỗi người một bản ghi, chưa giao/chưa đọc; đúng một outbox READY trỏ về thông báo', async () => {
      const { me, pt, bookingId } = await ready();

      await cancel(ownInput(me, bookingId));

      const notification = await cancelNotificationOf(bookingId);
      expect(await recipientAccounts(notification!._id as ObjectId)).toEqual([me.accountId, pt.accountId].sort());
      const rows = await db().collection('notification_recipients').find({ notification_id: notification!._id }).toArray();
      for (const row of rows) {
        expect(row.read_at).toBeUndefined();
        expect(row.delivered_at).toBeUndefined();
      }
      const outbox = await cancelOutboxOf(bookingId);
      expect(await count('notification_outbox', { event_key: cancelKeyOf(bookingId) })).toBe(1);
      expect(outbox!.status).toBe('READY');
      expect(String(outbox!.notification_id)).toBe(String(notification!._id));
    });

    // Đặt lịch thật qua API US-28 để có thông báo BOOKING_CREATED "cũ" đúng định dạng EN-03, rồi hủy.
    async function bookedViaApi() {
      const me = await linkedMember();
      const membershipId = await insertPlan(me.memberId);
      const pt = await trainer();
      const day = vnDay(10);
      const shiftId = new ObjectId();
      const now = new Date();
      await db().collection('work_shifts').insertOne({
        _id: shiftId, id: shiftId, trainer_id: pt.trainerId, start_at: at(day, '08:00'), end_at: at(day, '11:00'), location: 'Phòng PT 2',
        status: 'CONFIRMED', version: 1, created_by: new ObjectId(), updated_by: new ObjectId(), created_at: now, updated_at: now, confirmed_at: now,
      });
      const member: Auth = { accessToken: await loginAs(me.phone) };
      const trainerAuth: Auth = { accessToken: await loginAs(pt.phone) };
      const response = await http().post('/api/me/pt-bookings').set('Origin', origin).set('Authorization', `Bearer ${member.accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ membershipId: membershipId.toHexString(), trainerId: pt.trainerId.toHexString(), shiftId: shiftId.toHexString(), startAt: `${day}T09:00:00+07:00` })
        .expect(201);
      return { me, pt, member, trainerAuth, bookingId: new ObjectId(response.body.id as string) };
    }

    it('US-29-TC13: không ai mở socket → worker chạy xong job hủy DONE; Member và PT đọc qua REST sync thấy cả BOOKING_CREATED và BOOKING_CANCELLED', async () => {
      const { me, member, trainerAuth, bookingId } = await bookedViaApi();
      const worker = app.get(NotificationOutboxService);
      await worker.runOnce();

      await cancel(ownInput(me, bookingId));
      await worker.runOnce();

      expect((await cancelOutboxOf(bookingId))!.status).toBe('DONE');
      expect((await syncEventKeys(member.accessToken)).sort()).toEqual([cancelKeyOf(bookingId), createdKeyOf(bookingId)].sort());
      expect((await syncEventKeys(trainerAuth.accessToken)).sort()).toEqual([cancelKeyOf(bookingId), createdKeyOf(bookingId)].sort());
    });

    it('US-29-TC13: thông báo BOOKING_CREATED cũ vẫn còn, không bị đánh dấu đã đọc; đọc REST không tự mark-read thông báo hủy', async () => {
      const { me, member, bookingId } = await bookedViaApi();
      const created = await db().collection('notifications').findOne({ event_key: createdKeyOf(bookingId) });
      expect(created).not.toBeNull();

      await cancel(ownInput(me, bookingId));
      await syncEventKeys(member.accessToken);

      expect(await count('notifications', { event_key: createdKeyOf(bookingId) })).toBe(1);
      const cancelled = await cancelNotificationOf(bookingId);
      const rows = await db().collection('notification_recipients')
        .find({ notification_id: { $in: [created!._id, cancelled!._id] } }).toArray();
      expect(rows).toHaveLength(4);
      for (const row of rows) expect(row.read_at).toBeUndefined();
    });
  });

  // =====================================================================
  // AC03 – Đồng thời, khóa member, rollback (TC09, TC11, TC12)
  // =====================================================================

  describe('US-29-TC09: hai actor hủy cùng version cùng lúc', () => {
    it('US-29-TC09: Member (OWN) và Staff (SUPPORT) cùng gửi version 0 → đúng một thành công, người sau 409; một event, một thông báo, khóa tăng đúng 1', async () => {
      const { me, bookingId } = await ready();
      const staff = await account('STAFF', 'Nhân viên Quầy');
      const guardBefore = await guardRevision();
      const memberBefore = await memberRevision(me.memberId);

      const results = await Promise.allSettled([cancel(ownInput(me, bookingId)), cancel(supportInput(staff, 'STAFF', bookingId))]);

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ApplicationError);
      expect((rejected[0].reason as ApplicationError).status).toBe(409);
      expect(['VERSION_CONFLICT', 'INVALID_BOOKING_STATE']).toContain((rejected[0].reason as ApplicationError).code);
      expect((await db().collection('pt_bookings').findOne({ _id: bookingId }))!.version).toBe(1);
      expect(await eventsOf(bookingId)).toHaveLength(1);
      expect(await count('notifications', { event_key: cancelKeyOf(bookingId) })).toBe(1);
      expect(await count('notification_outbox', { event_key: cancelKeyOf(bookingId) })).toBe(1);
      expect(await guardRevision()).toBe(guardBefore + 1);
      expect(await memberRevision(me.memberId)).toBe(memberBefore + 1);
    });
  });

  describe('US-29-TC11: lệnh hủy giữ khóa lịch và khóa member', () => {
    it('US-29-TC11: Member tự hủy → schedule_guards.revision và members.service_revision mỗi cái tăng đúng 1', async () => {
      const { me, bookingId } = await ready();
      const guardBefore = await guardRevision();
      const memberBefore = await memberRevision(me.memberId);

      await cancel(ownInput(me, bookingId));

      expect(await guardRevision()).toBe(guardBefore + 1);
      expect(await memberRevision(me.memberId)).toBe(memberBefore + 1);
    });

    it('US-29-TC11: Staff hủy hỗ trợ → khóa member là member CHỦ booking (không phải staff) tăng đúng 1', async () => {
      const { me, bookingId } = await ready(minutesAhead(30));
      const staff = await account('STAFF', 'Nhân viên Quầy');
      const memberBefore = await memberRevision(me.memberId);

      await cancel(supportInput(staff, 'STAFF', bookingId));

      expect(await memberRevision(me.memberId)).toBe(memberBefore + 1);
    });

    it('US-29-TC11: lệnh hủy bị từ chối (409 quá hạn) → khóa lịch và khóa member không tăng, không có dấu vết hủy', async () => {
      const { me, bookingId } = await ready(minutesAhead(60));
      const guardBefore = await guardRevision();
      const memberBefore = await memberRevision(me.memberId);

      await cancel(ownInput(me, bookingId)).catch(() => undefined);

      expect(await guardRevision()).toBe(guardBefore);
      expect(await memberRevision(me.memberId)).toBe(memberBefore);
      await expectNoCancelTrace(bookingId);
    });
  });

  describe('US-29-TC12: lỗi audit/outbox trước commit → rollback toàn bộ, không hủy nửa chừng', () => {
    it.each(['booking_events', 'notifications', 'notification_recipients', 'notification_outbox'])(
      'US-29-TC12: insert vào %s lỗi → lệnh hủy báo lỗi; booking vẫn BOOKED version 0, không event/thông báo/outbox, khóa không tăng',
      async collection => {
        const { me, bookingId } = await ready();
        const before = await db().collection('pt_bookings').findOne({ _id: bookingId });
        const guardBefore = await guardRevision();
        const memberBefore = await memberRevision(me.memberId);

        let failed = false;
        await failInsertsOn(collection, async () => {
          await cancel(ownInput(me, bookingId)).catch(() => { failed = true; });
        });

        expect(failed).toBe(true);
        expect(await db().collection('pt_bookings').findOne({ _id: bookingId })).toEqual(before);
        await expectNoCancelTrace(bookingId);
        expect(await count('notification_recipients')).toBe(0);
        expect(await guardRevision()).toBe(guardBefore);
        expect(await memberRevision(me.memberId)).toBe(memberBefore);
      },
    );
  });
});
