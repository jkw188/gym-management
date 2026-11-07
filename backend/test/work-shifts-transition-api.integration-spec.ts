// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-25 bước 2.
// Kiểm tra API công bố/hủy ca /api/me/work-shifts/:id/confirm và /cancel: chủ thể PT, BOOKED, CAS, audit và key cùng transaction (TC01–TC08, TC10, TC11).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng test đặt ra cho Builder (US-25 bước 2, theo mục 2 của spec):
//   POST /api/me/work-shifts/:id/confirm  header Idempotency-Key (UUID), body {version}
//        -> 200 {id, startAt, endAt, location, status: 'CONFIRMED', version, ...}; operation EN-02 là SHIFT_CONFIRM.
//   POST /api/me/work-shifts/:id/cancel   header Idempotency-Key (UUID), body {version, reason}
//        -> 200 {id, status: 'CANCELLED', version, cancelledAt, ...}; operation EN-02 là SHIFT_CANCEL.
//   GET  /api/me/work-shifts/:id thêm bookedCount = số pt_bookings status BOOKED có shift_id là ca này.
//   Route chỉ cho role TRAINER, trainer lấy từ trainers.account_id = principal (hồ sơ PT mẫu như test US-24).
//   BOOKED đếm trong collection 'pt_bookings' (shift_id, status) theo mục 4.2; US-28 chưa có nên test chèn thẳng document.
//   DB: work_shifts ghi confirmed_at / cancelled_at, cancelled_by (account), cancellation_reason, updated_by, version+1;
//       shift_events ghi action CONFIRMED/CANCELLED, actor_id = account, before/after, reason khi hủy.
//   Lỗi: 400 dữ liệu sai/field lạ/thiếu key; 401; 403 sai role; 404 ca không thuộc PT; 409 INVALID_SHIFT_STATE,
//        SHIFT_ALREADY_STARTED, SHIFT_HAS_BOOKINGS, VERSION_CONFLICT, TRAINER_UNAVAILABLE, PROFILE_REQUIRED, IDEMPOTENCY_CONFLICT; 503.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us25_api';
const password = 'MậtKhẩuUS-25-123';
const base = '/api/me/work-shifts';
const reason = 'PT bận việc gia đình';

describe('US-25 bước 2: API công bố và hủy ca', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    // enableTestCommands=1 để dùng failpoint failCommand giả lập lỗi ghi audit/key trước commit (US-25-TC11).
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
      SMTP_USER: 'us25-test', SMTP_PASS: 'us25-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http');
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
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

  afterEach(async () => {
    jest.restoreAllMocks();
    await connection.db!.admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());
  const count = (name: string, filter: Record<string, unknown> = {}) => db().collection(name).countDocuments(filter);

  // ---------- Thời gian: ca mặc định ở ngày tương lai theo lịch Việt Nam ----------
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  // Ngày Việt Nam (YYYY-MM-DD) cách hôm nay `days` ngày.
  function vnDay(days: number): string {
    return new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  const day = vnDay(10);
  const asDate = (hhmm: string, onDay = day) => new Date(`${onDay}T${hhmm}:00+07:00`);
  // Phút tròn hiện tại cộng/trừ `minutes` (dùng cho ca đang diễn ra, đã hết).
  const minutesFromNow = (minutes: number) => new Date(Math.floor(Date.now() / 60000) * 60000 + minutes * 60000);

  // ---------- Chuẩn bị: account thật theo role, đăng nhập thật qua API US-02 ----------
  let phoneSeq = 0;
  async function login(roleCode: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN') {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0912500${String(phoneSeq).padStart(3, '0')}`;
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName: `US25 ${roleCode} ${phoneSeq}`, passwordHash });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { accountId: account.id.toHexString(), accessToken: response.body.accessToken as string };
  }

  // PT mẫu: account TRAINER + hồ sơ trainers (thay cho US-23 chưa có).
  async function trainer(status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
    const account = await login('TRAINER');
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: new ObjectId(account.accountId), specialty: 'Thể hình', status,
      version: 0, created_at: now, updated_at: now,
    });
    return { ...account, trainerId };
  }

  // Ghi thẳng một ca vào DB (mặc định nháp 08:00–10:00 ngày tương lai, version 0).
  async function insertShift(trainerId: ObjectId, options: { status?: string; from?: Date; to?: Date; version?: number } = {}) {
    const id = new ObjectId();
    const now = new Date();
    await db().collection('work_shifts').insertOne({
      _id: id, id, trainer_id: trainerId,
      start_at: options.from ?? asDate('08:00'), end_at: options.to ?? asDate('10:00'), location: 'Phòng PT 1',
      status: options.status ?? 'SCHEDULED', version: options.version ?? 0,
      created_by: new ObjectId(), updated_by: new ObjectId(), created_at: now, updated_at: now,
    });
    return id.toHexString();
  }

  // Ghi thẳng một lịch đặt PT (US-28 chưa có), field theo mục 4.2 pt_bookings.
  async function insertBooking(trainerId: ObjectId, shiftId: string, status: string, from = asDate('08:00')) {
    const id = new ObjectId();
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: new ObjectId(), trainer_id: trainerId, shift_id: new ObjectId(shiftId),
      start_at: from, end_at: new Date(from.getTime() + 60 * 60000), status, request_key: `us25-${id.toHexString()}`, created_at: new Date(),
    });
    return id;
  }

  type Auth = { accessToken: string };
  function confirm(user: Auth | undefined, id: string, body: Record<string, unknown>, key: string | null = randomUUID()) {
    let call = http().post(`${base}/${id}/confirm`).set('Origin', origin);
    if (user) call = call.set('Authorization', `Bearer ${user.accessToken}`);
    if (key !== null) call = call.set('Idempotency-Key', key);
    return call.send(body);
  }
  function cancel(user: Auth | undefined, id: string, body: Record<string, unknown>, key: string | null = randomUUID()) {
    let call = http().post(`${base}/${id}/cancel`).set('Origin', origin);
    if (user) call = call.set('Authorization', `Bearer ${user.accessToken}`);
    if (key !== null) call = call.set('Idempotency-Key', key);
    return call.send(body);
  }
  function getOne(user: Auth, id: string) {
    return http().get(`${base}/${id}`).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }
  function lookup(user: Auth, operation: string, key: string) {
    return http().get(`/api/operations/${operation}/${key}`).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }
  const shiftInDb = (id: string) => db().collection('work_shifts').findOne({ _id: new ObjectId(id) });
  const eventsOf = (id: string) => db().collection('shift_events').find({ shift_id: new ObjectId(id) }).toArray();

  function failInsert(collection: string) {
    // Mã 1 (InternalError): lỗi DB thường, không làm driver đánh dấu server Unknown (xem bản sửa EN-03-TC12).
    return db().admin().command({
      configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: ['insert'], namespace: `${databaseName}.${collection}`, errorCode: 1, errmsg: 'Giả lập DB lỗi US-25-TC11' },
    });
  }
  const failPointOff = () => db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });

  // Ca không đổi gì: status, version giữ nguyên và không có audit mới.
  async function expectUnchanged(id: string, status: string, version = 0) {
    expect(await shiftInDb(id)).toMatchObject({ status, version });
    expect(await eventsOf(id)).toHaveLength(0);
  }

  // =====================================================================
  // AC01: transition và ownership (TC01–TC04)
  // =====================================================================
  describe('US-25-TC01: PT công bố nháp tương lai hợp lệ', () => {
    it('US-25-TC01: trả 200 CONFIRMED, version+1, giữ đúng giờ và location', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      const response = await confirm(pt, id, { version: 0 });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id, status: 'CONFIRMED', version: 1, location: 'Phòng PT 1' });
      expect(new Date(response.body.startAt).toISOString()).toBe(asDate('08:00').toISOString());
      expect(new Date(response.body.endAt).toISOString()).toBe(asDate('10:00').toISOString());
    });

    it('US-25-TC01: DB ghi CONFIRMED, confirmed_at, updated_by là account PT; audit CONFIRMED có before/after; một bản ghi idempotency', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      const before = Date.now();
      await confirm(pt, id, { version: 0 }).expect(200);
      const saved = await shiftInDb(id);
      expect(saved).toMatchObject({ status: 'CONFIRMED', version: 1 });
      expect(saved!.confirmed_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(saved!.updated_by.toHexString()).toBe(pt.accountId);
      expect(saved!.completed_at).toBeUndefined();
      const events = await eventsOf(id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: 'CONFIRMED', before: { status: 'SCHEDULED', version: 0 }, after: { status: 'CONFIRMED', version: 1 } });
      expect(events[0].actor_id.toHexString()).toBe(pt.accountId);
      expect(await count('operation_requests', { operation: 'SHIFT_CONFIRM' })).toBe(1);
    });

    it('US-25-TC01: GET /:id sau công bố trả CONFIRMED và bookedCount 0', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      await confirm(pt, id, { version: 0 }).expect(200);
      const response = await getOne(pt, id).expect(200);
      expect(response.body).toMatchObject({ id, status: 'CONFIRMED', version: 1, bookedCount: 0 });
    });

    it('US-25-TC01: công bố không gửi thông báo broadcast cho Member', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      await confirm(pt, id, { version: 0 }).expect(200);
      expect(await count('notifications')).toBe(0);
      expect(await count('notification_recipients')).toBe(0);
    });

    it('US-25-TC01: nháp chồng lên ca CONFIRMED khác của cùng PT (dữ liệu bất thường) → 409, không công bố', async () => {
      const pt = await trainer();
      await insertShift(pt.trainerId, { status: 'CONFIRMED', from: asDate('09:00'), to: asDate('11:00') });
      const id = await insertShift(pt.trainerId, { from: asDate('08:00'), to: asDate('10:00') });
      const response = await confirm(pt, id, { version: 0 });
      expect(response.status).toBe(409);
      await expectUnchanged(id, 'SCHEDULED');
    });
  });

  describe('US-25-TC02: sai role, ca PT khác, session cũ hoặc PT không ACTIVE', () => {
    it('US-25-TC02: không đăng nhập → 401, không transition', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      expect((await confirm(undefined, id, { version: 0 })).status).toBe(401);
      expect((await cancel(undefined, id, { version: 0, reason })).status).toBe(401);
      await expectUnchanged(id, 'SCHEDULED');
    });

    for (const role of ['MEMBER', 'STAFF', 'ADMIN'] as const) {
      it(`US-25-TC02: role ${role} công bố/hủy ca của PT → 403, không transition`, async () => {
        const pt = await trainer();
        const user = await login(role);
        const id = await insertShift(pt.trainerId);
        expect((await confirm(user, id, { version: 0 })).status).toBe(403);
        expect((await cancel(user, id, { version: 0, reason })).status).toBe(403);
        await expectUnchanged(id, 'SCHEDULED');
      });
    }

    it('US-25-TC02: PT khác công bố ca không thuộc mình → 404, không transition', async () => {
      const owner = await trainer();
      const other = await trainer();
      const id = await insertShift(owner.trainerId);
      const response = await confirm(other, id, { version: 0 });
      expect(response.status).toBe(404);
      await expectUnchanged(id, 'SCHEDULED');
    });

    it('US-25-TC02: PT khác hủy ca không thuộc mình → 404, lỗi không lộ thông tin ca', async () => {
      const owner = await trainer();
      const other = await trainer();
      const id = await insertShift(owner.trainerId, { status: 'CONFIRMED' });
      const response = await cancel(other, id, { version: 0, reason });
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Phòng PT 1');
      await expectUnchanged(id, 'CONFIRMED');
    });

    it('US-25-TC02: id ca không tồn tại → 404; id sai định dạng → 400', async () => {
      const pt = await trainer();
      expect((await confirm(pt, new ObjectId().toHexString(), { version: 0 })).status).toBe(404);
      expect((await confirm(pt, 'khong-phai-objectid', { version: 0 })).status).toBe(400);
      expect((await cancel(pt, 'khong-phai-objectid', { version: 0, reason })).status).toBe(400);
    });

    it('US-25-TC02: session cũ (auth_version đã tăng) → 401, không transition', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      await db().collection('accounts').updateOne({ _id: new ObjectId(pt.accountId) }, { $inc: { auth_version: 1 } });
      expect((await confirm(pt, id, { version: 0 })).status).toBe(401);
      expect((await cancel(pt, id, { version: 0, reason })).status).toBe(401);
      await expectUnchanged(id, 'SCHEDULED');
    });

    it('US-25-TC02: PT INACTIVE công bố → 409 TRAINER_UNAVAILABLE, không transition', async () => {
      const pt = await trainer('INACTIVE');
      const id = await insertShift(pt.trainerId);
      const response = await confirm(pt, id, { version: 0 });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('TRAINER_UNAVAILABLE');
      await expectUnchanged(id, 'SCHEDULED');
    });

    it('US-25-TC02: PT bị chuyển INACTIVE sau khi mở form thì hủy ca → 409 TRAINER_UNAVAILABLE (recheck, không dùng dữ liệu cũ)', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      await db().collection('trainers').updateOne({ _id: pt.trainerId }, { $set: { status: 'INACTIVE' } });
      const response = await cancel(pt, id, { version: 0, reason });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('TRAINER_UNAVAILABLE');
      await expectUnchanged(id, 'CONFIRMED');
    });

    it('US-25-TC02: account TRAINER chưa có hồ sơ PT → 409 PROFILE_REQUIRED, không ghi key', async () => {
      const owner = await trainer();
      const unlinked = await login('TRAINER');
      const id = await insertShift(owner.trainerId);
      const response = await confirm(unlinked, id, { version: 0 });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PROFILE_REQUIRED');
      expect(await count('operation_requests')).toBe(0);
    });

    it('US-25-TC02: body có field ngoài allowlist (status, trainerId, ownerId) → 400, không transition', async () => {
      const pt = await trainer();
      const other = await trainer();
      const id = await insertShift(pt.trainerId);
      for (const extra of [{ status: 'CANCELLED' }, { trainerId: other.trainerId.toHexString() }, { ownerId: other.accountId }]) {
        expect((await confirm(pt, id, { version: 0, ...extra })).status).toBe(400);
        expect((await cancel(pt, id, { version: 0, reason, ...extra })).status).toBe(400);
      }
      await expectUnchanged(id, 'SCHEDULED');
    });

    it('US-25-TC02: thiếu version, thiếu Idempotency-Key hoặc key không phải UUID → 400, không transition', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      expect((await confirm(pt, id, {})).status).toBe(400);
      expect((await confirm(pt, id, { version: 0 }, null)).status).toBe(400);
      expect((await confirm(pt, id, { version: 0 }, 'khong-phai-uuid')).status).toBe(400);
      expect((await cancel(pt, id, { reason })).status).toBe(400);
      await expectUnchanged(id, 'SCHEDULED');
    });
  });

  describe('US-25-TC03: công bố ca đã bắt đầu, đã CONFIRMED hoặc version cũ', () => {
    it('US-25-TC03: công bố ca đã CONFIRMED → 409 INVALID_SHIFT_STATE, không thêm audit', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      const response = await confirm(pt, id, { version: 0 });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INVALID_SHIFT_STATE');
      await expectUnchanged(id, 'CONFIRMED');
    });

    it('US-25-TC03: công bố nháp đang diễn ra → 409 SHIFT_ALREADY_STARTED, vẫn là SCHEDULED (không tự reset)', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { from: minutesFromNow(-30), to: minutesFromNow(90) });
      const response = await confirm(pt, id, { version: 0 });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SHIFT_ALREADY_STARTED');
      await expectUnchanged(id, 'SCHEDULED');
    });

    it('US-25-TC03: công bố với version cũ → 409 VERSION_CONFLICT, không ghi đè, không audit', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { version: 2 });
      const response = await confirm(pt, id, { version: 1 });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('VERSION_CONFLICT');
      await expectUnchanged(id, 'SCHEDULED', 2);
    });

    it('US-25-TC03: hủy với version cũ → 409 VERSION_CONFLICT', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED', version: 3 });
      const response = await cancel(pt, id, { version: 2, reason });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('VERSION_CONFLICT');
      await expectUnchanged(id, 'CONFIRMED', 3);
    });
  });

  describe('US-25-TC04: hủy ca trống trước startAt với reason hợp lệ', () => {
    for (const status of ['SCHEDULED', 'CONFIRMED'] as const) {
      it(`US-25-TC04: hủy ca ${status} trống → 200 CANCELLED, version+1, có cancelledAt`, async () => {
        const pt = await trainer();
        const id = await insertShift(pt.trainerId, { status });
        const response = await cancel(pt, id, { version: 0, reason });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ id, status: 'CANCELLED', version: 1 });
        expect(Number.isNaN(Date.parse(response.body.cancelledAt))).toBe(false);
      });
    }

    it('US-25-TC04: DB ghi cancelled_at, cancelled_by là account PT, lý do đã trim; audit CANCELLED kèm reason cùng commit; một bản ghi idempotency', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      await cancel(pt, id, { version: 0, reason: `   ${reason}   ` }).expect(200);
      const saved = await shiftInDb(id);
      expect(saved).toMatchObject({ status: 'CANCELLED', version: 1, cancellation_reason: reason });
      expect(saved!.cancelled_by.toHexString()).toBe(pt.accountId);
      expect(saved!.updated_by.toHexString()).toBe(pt.accountId);
      expect(saved!.cancelled_at).toBeInstanceOf(Date);
      expect(saved!.completed_at).toBeUndefined();
      const events = await eventsOf(id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'CANCELLED', reason, before: { status: 'CONFIRMED', version: 0 }, after: { status: 'CANCELLED', version: 1 },
      });
      expect(events[0].actor_id.toHexString()).toBe(pt.accountId);
      expect(await count('operation_requests', { operation: 'SHIFT_CANCEL' })).toBe(1);
    });

    it('US-25-TC04: hủy ca trống không phát thông báo cho Member', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      await cancel(pt, id, { version: 0, reason }).expect(200);
      expect(await count('notifications')).toBe(0);
    });

    it('US-25-TC04: reason 9 ký tự sau trim hoặc 501 ký tự → 400 VALIDATION_ERROR, không transition, không ghi key', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      for (const bad of ['  ' + 'a'.repeat(9) + '  ', 'a'.repeat(501)]) {
        const response = await cancel(pt, id, { version: 0, reason: bad });
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
      await expectUnchanged(id, 'CONFIRMED');
      expect(await count('operation_requests')).toBe(0);
    });
  });

  // =====================================================================
  // AC02: hủy bảo toàn booking và lịch sử (TC05–TC08)
  // =====================================================================
  describe('US-25-TC05: hủy ca còn BOOKED hoặc nháp bất thường có BOOKED', () => {
    it('US-25-TC05: ca CONFIRMED còn BOOKED → 409 SHIFT_HAS_BOOKINGS, booking giữ nguyên, không audit, không thông báo', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      const bookingId = await insertBooking(pt.trainerId, id, 'BOOKED');
      const response = await cancel(pt, id, { version: 0, reason });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SHIFT_HAS_BOOKINGS');
      await expectUnchanged(id, 'CONFIRMED');
      expect(await db().collection('pt_bookings').findOne({ _id: bookingId })).toMatchObject({ status: 'BOOKED', shift_id: new ObjectId(id) });
      expect(await count('notifications')).toBe(0);
    });

    it('US-25-TC05: nháp bất thường có BOOKED → 409 SHIFT_HAS_BOOKINGS', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      await insertBooking(pt.trainerId, id, 'BOOKED');
      const response = await cancel(pt, id, { version: 0, reason });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SHIFT_HAS_BOOKINGS');
      await expectUnchanged(id, 'SCHEDULED');
    });

    it('US-25-TC05: BOOKED có giờ bất thường (đã qua) vẫn chặn, không chỉ đếm booking tương lai', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      await insertBooking(pt.trainerId, id, 'BOOKED', minutesFromNow(-24 * 60));
      const response = await cancel(pt, id, { version: 0, reason });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SHIFT_HAS_BOOKINGS');
    });

    it('US-25-TC05: GET /:id trả bookedCount đúng số BOOKED (không tính CANCELLED/COMPLETED)', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      await insertBooking(pt.trainerId, id, 'BOOKED', asDate('08:00'));
      await insertBooking(pt.trainerId, id, 'BOOKED', asDate('09:00'));
      await insertBooking(pt.trainerId, id, 'CANCELLED', asDate('08:00'));
      const response = await getOne(pt, id).expect(200);
      expect(response.body.bookedCount).toBe(2);
    });
  });

  describe('US-25-TC06: Member/Staff hủy hết BOOKED rồi PT hủy ca lại', () => {
    it('US-25-TC06: lần đầu 409, sau khi mọi booking thành CANCELLED thì hủy lại (key mới) → 200; mỗi booking giữ lịch sử riêng', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      const first = await insertBooking(pt.trainerId, id, 'BOOKED', asDate('08:00'));
      const second = await insertBooking(pt.trainerId, id, 'BOOKED', asDate('09:00'));
      expect((await cancel(pt, id, { version: 0, reason })).status).toBe(409);
      // Giả lập US-29: Member/Staff hủy từng lịch.
      await db().collection('pt_bookings').updateMany({ shift_id: new ObjectId(id) }, { $set: { status: 'CANCELLED' } });
      const retry = await cancel(pt, id, { version: 0, reason });
      expect(retry.status).toBe(200);
      expect(retry.body.status).toBe('CANCELLED');
      for (const bookingId of [first, second]) {
        expect(await db().collection('pt_bookings').findOne({ _id: bookingId })).toMatchObject({ status: 'CANCELLED', shift_id: new ObjectId(id) });
      }
      expect(await count('pt_bookings')).toBe(2);
    });
  });

  describe('US-25-TC07: hủy ca đang diễn ra, đã hết hoặc COMPLETED', () => {
    it('US-25-TC07: hủy ca CONFIRMED đang diễn ra → 409 SHIFT_ALREADY_STARTED, không suy diễn hoàn tất', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED', from: minutesFromNow(-30), to: minutesFromNow(90) });
      const response = await cancel(pt, id, { version: 0, reason });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SHIFT_ALREADY_STARTED');
      await expectUnchanged(id, 'CONFIRMED');
    });

    it('US-25-TC07: hủy nháp đã hết giờ → 409 SHIFT_ALREADY_STARTED, vẫn SCHEDULED', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { from: minutesFromNow(-180), to: minutesFromNow(-60) });
      const response = await cancel(pt, id, { version: 0, reason });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SHIFT_ALREADY_STARTED');
      await expectUnchanged(id, 'SCHEDULED');
    });

    it('US-25-TC07: hủy ca COMPLETED → 409, ca giữ COMPLETED', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'COMPLETED', from: minutesFromNow(-180), to: minutesFromNow(-60) });
      const response = await cancel(pt, id, { version: 0, reason });
      expect(response.status).toBe(409);
      await expectUnchanged(id, 'COMPLETED');
    });

    it('US-25-TC07: hủy lại ca CANCELLED → 409 INVALID_SHIFT_STATE', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CANCELLED' });
      const response = await cancel(pt, id, { version: 0, reason });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INVALID_SHIFT_STATE');
      await expectUnchanged(id, 'CANCELLED');
    });
  });

  describe('US-25-TC08: ca có lịch COMPLETED/CANCELLED trong dữ liệu lịch sử', () => {
    it('US-25-TC08: hủy ca được, không xóa booking lịch sử; chủ ca xem lại được, PT khác nhận 404', async () => {
      const pt = await trainer();
      const other = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      const done = await insertBooking(pt.trainerId, id, 'COMPLETED', asDate('08:00'));
      const cancelled = await insertBooking(pt.trainerId, id, 'CANCELLED', asDate('09:00'));
      await cancel(pt, id, { version: 0, reason }).expect(200);
      expect(await db().collection('pt_bookings').findOne({ _id: done })).toMatchObject({ status: 'COMPLETED', shift_id: new ObjectId(id) });
      expect(await db().collection('pt_bookings').findOne({ _id: cancelled })).toMatchObject({ status: 'CANCELLED', shift_id: new ObjectId(id) });
      const own = await getOne(pt, id).expect(200);
      expect(own.body).toMatchObject({ id, status: 'CANCELLED', bookedCount: 0 });
      expect((await getOne(other, id)).status).toBe(404);
      expect(await count('work_shifts')).toBe(1);
    });
  });

  // =====================================================================
  // AC03: race và replay (TC10, TC11). TC09 (đặt lịch song song) và bản hai instance thuộc bước 4.
  // =====================================================================
  describe('US-25-TC10: hai confirm/cancel cùng ca và version', () => {
    it('US-25-TC10: hai confirm cùng version khác key gửi đồng thời → một 200, một 409, chỉ một audit CONFIRMED (lặp 5 lần)', async () => {
      const pt = await trainer();
      for (let round = 0; round < 5; round += 1) {
        const onDay = vnDay(10 + round);
        const id = await insertShift(pt.trainerId, { from: asDate('08:00', onDay), to: asDate('10:00', onDay) });
        const [a, b] = await Promise.all([confirm(pt, id, { version: 0 }), confirm(pt, id, { version: 0 })]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        const loser = a.status === 409 ? a : b;
        expect(['VERSION_CONFLICT', 'INVALID_SHIFT_STATE']).toContain(loser.body.error.code);
        expect(await shiftInDb(id)).toMatchObject({ status: 'CONFIRMED', version: 1 });
        expect(await eventsOf(id)).toHaveLength(1);
      }
    });

    it('US-25-TC10: confirm và cancel cùng version gửi đồng thời → đúng một transition thắng, một audit (lặp 5 lần)', async () => {
      const pt = await trainer();
      for (let round = 0; round < 5; round += 1) {
        const onDay = vnDay(10 + round);
        const id = await insertShift(pt.trainerId, { from: asDate('08:00', onDay), to: asDate('10:00', onDay) });
        const [a, b] = await Promise.all([confirm(pt, id, { version: 0 }), cancel(pt, id, { version: 0, reason })]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        const winner = a.status === 200 ? a : b;
        expect(await shiftInDb(id)).toMatchObject({ status: winner.body.status, version: 1 });
        expect(await eventsOf(id)).toHaveLength(1);
      }
    });

    it('US-25-TC10: gửi lại confirm cùng key cùng payload → cùng status/body gốc, version không tăng, không thêm audit', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      const key = randomUUID();
      const first = await confirm(pt, id, { version: 0 }, key).expect(200);
      const second = await confirm(pt, id, { version: 0 }, key);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(await shiftInDb(id)).toMatchObject({ version: 1 });
      expect(await eventsOf(id)).toHaveLength(1);
      expect(await count('operation_requests')).toBe(1);
    });

    it('US-25-TC10: gửi lại cancel cùng key cùng payload → body gốc, không thêm audit', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      const key = randomUUID();
      const first = await cancel(pt, id, { version: 0, reason }, key).expect(200);
      const second = await cancel(pt, id, { version: 0, reason }, key);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(await eventsOf(id)).toHaveLength(1);
    });

    it('US-25-TC10: key mới trên ca đã CONFIRMED → 409, không thêm audit', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      await confirm(pt, id, { version: 0 }).expect(200);
      const again = await confirm(pt, id, { version: 1 });
      expect(again.status).toBe(409);
      expect(await eventsOf(id)).toHaveLength(1);
    });

    it('US-25-TC10: cùng key nhưng khác payload (đổi reason) → 409 IDEMPOTENCY_CONFLICT, không thêm audit', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      const key = randomUUID();
      await cancel(pt, id, { version: 0, reason }, key).expect(200);
      const response = await cancel(pt, id, { version: 0, reason: 'Lý do khác hẳn lần trước' }, key);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await eventsOf(id)).toHaveLength(1);
    });

    it('US-25-TC10: tra cứu key SHIFT_CONFIRM đã commit trả COMMITTED với status 200 gốc', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      const key = randomUUID();
      const { body } = await confirm(pt, id, { version: 0 }, key).expect(200);
      const response = await lookup(pt, 'SHIFT_CONFIRM', key);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'COMMITTED', responseStatus: 200, responseBody: body });
    });
  });

  describe('US-25-TC11: gửi lại key sau mất response và lỗi audit', () => {
    it('US-25-TC11: ghi shift_events lỗi khi công bố → 503, ca vẫn SCHEDULED, không có bản ghi idempotency; tra cứu key là chưa biết', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      const key = randomUUID();
      await failInsert('shift_events');
      const response = await confirm(pt, id, { version: 0 }, key);
      expect(response.status).toBe(503);
      expect(JSON.stringify(response.body)).not.toContain('Giả lập DB lỗi');
      await failPointOff();
      await expectUnchanged(id, 'SCHEDULED');
      expect(await count('operation_requests')).toBe(0);
      const found = await lookup(pt, 'SHIFT_CONFIRM', key);
      expect(found.status).toBe(404);
      expect(found.body.error.code).toBe('OPERATION_UNKNOWN');
    });

    it('US-25-TC11: ghi operation_requests lỗi khi hủy → 503, ca giữ nguyên, không audit dở dang', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      await failInsert('operation_requests');
      const response = await cancel(pt, id, { version: 0, reason });
      expect(response.status).toBe(503);
      await failPointOff();
      await expectUnchanged(id, 'CONFIRMED');
      expect((await shiftInDb(id))!.cancelled_at).toBeUndefined();
    });

    it('US-25-TC11: sau lỗi, gửi lại đúng key → 200, chỉ một transition và một audit', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, { status: 'CONFIRMED' });
      const key = randomUUID();
      await failInsert('shift_events');
      expect((await cancel(pt, id, { version: 0, reason }, key)).status).toBe(503);
      await failPointOff();
      const retry = await cancel(pt, id, { version: 0, reason }, key);
      expect(retry.status).toBe(200);
      expect(await shiftInDb(id)).toMatchObject({ status: 'CANCELLED', version: 1 });
      expect(await eventsOf(id)).toHaveLength(1);
      expect(await count('operation_requests')).toBe(1);
    });
  });
});
