// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-24 bước 2.
// Kiểm tra API ca nháp /api/me/work-shifts: chủ thể PT từ principal, overlap, version CAS, idempotency EN-02 và atomic (TC01–TC11).
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
// Hợp đồng test đặt ra cho Builder (US-24 bước 2, theo mục 2 của spec):
//   Mọi route: role TRAINER; trainer lấy từ trainers.account_id = principal (US-23 chưa có → test ghi thẳng hồ sơ PT mẫu
//   vào collection 'trainers' theo mục 4.2.8: id=_id, account_id, specialty, status ACTIVE/INACTIVE, version).
//   GET   /api/me/work-shifts?fromDate&toDate&status?&page&limit -> 200 {profileLinked, items, page, limit, total, totalPages}
//   GET   /api/me/work-shifts/:id -> 200 {id,startAt,endAt,location,status,version,createdAt,updatedAt}
//   POST  /api/me/work-shifts  header Idempotency-Key (UUID), body {startAt,endAt,location} -> 201 DTO, SCHEDULED, version 0
//   PATCH /api/me/work-shifts/:id header Idempotency-Key, body {version,startAt,endAt,location} -> 200 DTO, version+1
//   Lỗi: 400 dữ liệu sai/field lạ/thiếu key; 401; 403 sai role; 404 không thuộc PT; 409 SHIFT_OVERLAP, SHIFT_NOT_EDITABLE,
//   VERSION_CONFLICT, TRAINER_UNAVAILABLE (PT INACTIVE), SHIFT_HAS_BOOKINGS, IDEMPOTENCY_CONFLICT,
//   PROFILE_REQUIRED (account TRAINER chưa có hồ sơ PT, theo mục Guard của US-23); 503 lỗi hạ tầng.
//   operation trong EN-02: SHIFT_CREATE và SHIFT_UPDATE; tra cứu GET /api/operations/:operation/:key.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us24_api';
const password = 'MậtKhẩuUS-24-123';
const base = '/api/me/work-shifts';

type ShiftBody = { id: string; startAt: string; endAt: string; location: string; status: string; version: number; createdAt: string; updatedAt: string };

describe('US-24 bước 2: API ca nháp /api/me/work-shifts', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    // enableTestCommands=1 để dùng failpoint failCommand giả lập lỗi ghi audit trước commit (US-24-TC11).
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
      SMTP_USER: 'us24-test', SMTP_PASS: 'us24-test', SMTP_FROM: 'no-reply@gym.test',
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

  // ---------- Thời gian: luôn dùng ngày tương lai theo lịch Việt Nam ----------
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  // Ngày Việt Nam (YYYY-MM-DD) cách hôm nay `days` ngày.
  function vnDay(days: number): string {
    return new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  const day = vnDay(10);
  const nextDay = vnDay(11);
  // Thời điểm giờ Việt Nam có offset rõ ràng, ví dụ at('08:10') = '<day>T08:10:00+07:00'.
  const at = (hhmm: string, onDay = day) => `${onDay}T${hhmm}:00+07:00`;
  const asDate = (hhmm: string, onDay = day) => new Date(at(hhmm, onDay));

  // ---------- Chuẩn bị: account thật theo role, đăng nhập thật qua API US-02 ----------
  let phoneSeq = 0;
  async function login(roleCode: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN') {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `09124000${String(phoneSeq).padStart(2, '0')}`;
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName: `US24 ${roleCode} ${phoneSeq}`, passwordHash });
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

  // Ghi thẳng một ca vào DB (dùng cho trạng thái mà API bước này không tạo được: CONFIRMED, CANCELLED, ca đã bắt đầu…).
  async function insertShift(trainerId: ObjectId, from: Date, to: Date, status = 'SCHEDULED', location = 'Phòng PT 1') {
    const id = new ObjectId();
    const now = new Date();
    await db().collection('work_shifts').insertOne({
      _id: id, id, trainer_id: trainerId, start_at: from, end_at: to, location, status, version: 0,
      created_by: new ObjectId(), updated_by: new ObjectId(), created_at: now, updated_at: now,
    });
    return id;
  }

  type Auth = { accessToken: string };
  function create(user: Auth | undefined, body: Record<string, unknown>, key: string | null = randomUUID()) {
    let call = http().post(base).set('Origin', origin);
    if (user) call = call.set('Authorization', `Bearer ${user.accessToken}`);
    if (key !== null) call = call.set('Idempotency-Key', key);
    return call.send(body);
  }
  function update(user: Auth, id: string, body: Record<string, unknown>, key: string | null = randomUUID()) {
    let call = http().patch(`${base}/${id}`).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
    if (key !== null) call = call.set('Idempotency-Key', key);
    return call.send(body);
  }
  function getOne(user: Auth | undefined, id: string) {
    const call = http().get(`${base}/${id}`).set('Origin', origin);
    return user ? call.set('Authorization', `Bearer ${user.accessToken}`) : call;
  }
  function list(user: Auth | undefined, query: Record<string, string | number> = {}) {
    const call = http().get(base).query({ fromDate: day, toDate: nextDay, ...query }).set('Origin', origin);
    return user ? call.set('Authorization', `Bearer ${user.accessToken}`) : call;
  }
  const draft = (from = '08:10', to = '10:40', location = 'Phòng PT 1') => ({ startAt: at(from), endAt: at(to), location });

  async function shiftInDb(id: string) {
    return db().collection('work_shifts').findOne({ _id: new ObjectId(id) });
  }

  function failInsert(collection: string) {
    // Mã 1 (InternalError): lỗi DB thường, không làm driver đánh dấu server Unknown (xem bản sửa EN-03-TC12).
    return db().admin().command({
      configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: ['insert'], namespace: `${databaseName}.${collection}`, errorCode: 1, errmsg: 'Giả lập DB lỗi US-24-TC11' },
    });
  }

  // =====================================================================
  // AC01: chủ thể và dữ liệu ca hợp lệ (TC01–TC04)
  // =====================================================================
  describe('US-24-TC01: PT ACTIVE tạo ca 08:10–10:40', () => {
    it('US-24-TC01: trả 201 SCHEDULED version 0, đúng thời điểm và location', async () => {
      const pt = await trainer();
      const response = await create(pt, draft());
      expect(response.status).toBe(201);
      const body = response.body as ShiftBody;
      expect(body).toMatchObject({ location: 'Phòng PT 1', status: 'SCHEDULED', version: 0 });
      expect(new Date(body.startAt).toISOString()).toBe(asDate('08:10').toISOString());
      expect(new Date(body.endAt).toISOString()).toBe(asDate('10:40').toISOString());
      expect(ObjectId.isValid(body.id)).toBe(true);
      expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(body.updatedAt))).toBe(false);
    });

    it('US-24-TC01: DB lưu ca thuộc trainer của principal, created_by là account, kèm audit CREATED và một bản ghi idempotency', async () => {
      const pt = await trainer();
      const key = randomUUID();
      const { body } = await create(pt, draft(), key).expect(201);
      const saved = await shiftInDb(body.id);
      expect(saved!.trainer_id.equals(pt.trainerId)).toBe(true);
      expect(saved!.created_by.toHexString()).toBe(pt.accountId);
      expect(saved!.start_at.toISOString()).toBe(asDate('08:10').toISOString());
      const events = await db().collection('shift_events').find({ shift_id: new ObjectId(body.id) }).toArray();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: 'CREATED' });
      expect(events[0].actor_id.toHexString()).toBe(pt.accountId);
      expect(await count('operation_requests')).toBe(1);
    });

    it('US-24-TC01: lưu ca nháp không tạo thông báo cho Member (chưa công bố)', async () => {
      const pt = await trainer();
      await create(pt, draft()).expect(201);
      expect(await count('notifications')).toBe(0);
      expect(await count('notification_recipients')).toBe(0);
    });

    it('US-24-TC01: GET /:id của chính PT trả đúng các field của DTO, không lộ trainer_id hay created_by', async () => {
      const pt = await trainer();
      const { body: created } = await create(pt, draft()).expect(201);
      const response = await getOne(pt, created.id).expect(200);
      expect(Object.keys(response.body).sort()).toEqual(['createdAt', 'endAt', 'id', 'location', 'startAt', 'status', 'updatedAt', 'version']);
      expect(response.body).toMatchObject({ id: created.id, status: 'SCHEDULED', version: 0 });
    });
  });

  describe('US-24-TC02: sai role, id của PT khác, chưa liên kết hoặc PT INACTIVE', () => {
    it('US-24-TC02: không đăng nhập trả 401, không ghi', async () => {
      expect((await create(undefined, draft())).status).toBe(401);
      expect((await list(undefined)).status).toBe(401);
      expect(await count('work_shifts')).toBe(0);
    });

    for (const role of ['MEMBER', 'STAFF', 'ADMIN'] as const) {
      it(`US-24-TC02: role ${role} gọi route của PT trả 403, không ghi thay`, async () => {
        const user = await login(role);
        const created = await create(user, draft());
        expect(created.status).toBe(403);
        expect(created.body.error.code).toBeDefined();
        expect((await list(user)).status).toBe(403);
        expect(await count('work_shifts')).toBe(0);
        expect(await count('shift_events')).toBe(0);
      });
    }

    it('US-24-TC02: PT khác xem ca không thuộc mình trả 404', async () => {
      const owner = await trainer();
      const other = await trainer();
      const { body } = await create(owner, draft()).expect(201);
      expect((await getOne(other, body.id)).status).toBe(404);
    });

    it('US-24-TC02: PT khác sửa ca không thuộc mình trả 404, ca giữ nguyên', async () => {
      const owner = await trainer();
      const other = await trainer();
      const { body } = await create(owner, draft()).expect(201);
      const response = await update(other, body.id, { version: 0, ...draft('08:10', '10:40', 'Phòng của PT khác') });
      expect(response.status).toBe(404);
      const saved = await shiftInDb(body.id);
      expect(saved).toMatchObject({ location: 'Phòng PT 1', version: 0 });
      expect(await count('shift_events')).toBe(1);
    });

    it('US-24-TC02: id ca không tồn tại trả 404; id sai định dạng trả 400', async () => {
      const pt = await trainer();
      expect((await getOne(pt, new ObjectId().toHexString())).status).toBe(404);
      expect((await getOne(pt, 'khong-phai-objectid')).status).toBe(400);
    });

    it('US-24-TC02: body gửi trainerId, status hoặc createdBy bị 400, không tạo ca cho PT khác', async () => {
      const pt = await trainer();
      const other = await trainer();
      for (const extra of [{ trainerId: other.trainerId.toHexString() }, { status: 'CONFIRMED' }, { createdBy: other.accountId }]) {
        const response = await create(pt, { ...draft(), ...extra });
        expect(response.status).toBe(400);
      }
      expect(await count('work_shifts')).toBe(0);
    });

    it('US-24-TC02: account TRAINER chưa có hồ sơ PT tạo ca trả 409 PROFILE_REQUIRED, không ghi', async () => {
      const unlinked = await login('TRAINER');
      const response = await create(unlinked, draft());
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PROFILE_REQUIRED');
      expect(await count('work_shifts')).toBe(0);
      expect(await count('operation_requests')).toBe(0);
    });

    it('US-24-TC02: account TRAINER chưa có hồ sơ PT xem danh sách trả 200 profileLinked=false, items rỗng', async () => {
      const unlinked = await login('TRAINER');
      const response = await list(unlinked).expect(200);
      expect(response.body).toMatchObject({ profileLinked: false, items: [], total: 0, totalPages: 0 });
    });

    it('US-24-TC02: PT INACTIVE tạo ca trả 409 TRAINER_UNAVAILABLE, không ghi', async () => {
      const inactive = await trainer('INACTIVE');
      const response = await create(inactive, draft());
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('TRAINER_UNAVAILABLE');
      expect(await count('work_shifts')).toBe(0);
      expect(await count('shift_events')).toBe(0);
    });

    it('US-24-TC02: PT bị chuyển INACTIVE sau khi tạo ca thì sửa ca trả 409 TRAINER_UNAVAILABLE, ca giữ nguyên', async () => {
      const pt = await trainer();
      const { body } = await create(pt, draft()).expect(201);
      await db().collection('trainers').updateOne({ _id: pt.trainerId }, { $set: { status: 'INACTIVE' } });
      const response = await update(pt, body.id, { version: 0, ...draft('08:10', '10:40', 'Phòng mới') });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('TRAINER_UNAVAILABLE');
      expect(await shiftInDb(body.id)).toMatchObject({ location: 'Phòng PT 1', version: 0 });
    });

    it('US-24-TC02: danh sách chỉ trả ca của chính PT, sắp theo startAt tăng dần', async () => {
      const pt = await trainer();
      const other = await trainer();
      await create(pt, draft('14:00', '15:00')).expect(201);
      await create(pt, draft('08:00', '09:00')).expect(201);
      await create(other, draft('10:00', '11:00')).expect(201);
      const response = await list(pt).expect(200);
      expect(response.body).toMatchObject({ profileLinked: true, total: 2, page: 1, limit: 20, totalPages: 1 });
      expect(response.body.items.map((item: ShiftBody) => new Date(item.startAt).toISOString()))
        .toEqual([asDate('08:00').toISOString(), asDate('14:00').toISOString()]);
    });
  });

  describe('US-24-TC03: dữ liệu sai bị từ chối và không ghi gì', () => {
    async function expectRejected(body: Record<string, unknown>) {
      const pt = await trainer();
      const response = await create(pt, body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(await count('work_shifts')).toBe(0);
      expect(await count('shift_events')).toBe(0);
      expect(await count('operation_requests')).toBe(0);
    }

    it('US-24-TC03: endAt bằng startAt → 400', () => expectRejected(draft('08:10', '08:10')));
    it('US-24-TC03: endAt trước startAt → 400', () => expectRejected(draft('10:00', '09:00')));
    it('US-24-TC03: ca dưới 60 phút → 400', () => expectRejected(draft('08:00', '08:59')));
    it('US-24-TC03: ngày quá khứ → 400', () =>
      expectRejected({ startAt: `${vnDay(-1)}T08:00:00+07:00`, endAt: `${vnDay(-1)}T09:00:00+07:00`, location: 'Phòng PT 1' }));
    it('US-24-TC03: thời điểm thiếu offset → 400', () =>
      expectRejected({ startAt: `${day}T08:00:00`, endAt: `${day}T09:00:00`, location: 'Phòng PT 1' }));
    it('US-24-TC03: thiếu location → 400', () => expectRejected({ startAt: at('08:00'), endAt: at('09:00') }));

    it('US-24-TC03: thiếu Idempotency-Key → 400, không ghi', async () => {
      const pt = await trainer();
      expect((await create(pt, draft(), null)).status).toBe(400);
      expect(await count('work_shifts')).toBe(0);
    });

    it('US-24-TC03: Idempotency-Key không phải UUID → 400, không ghi', async () => {
      const pt = await trainer();
      expect((await create(pt, draft(), 'khong-phai-uuid')).status).toBe(400);
      expect(await count('work_shifts')).toBe(0);
    });

    it('US-24-TC03: sửa ca với dữ liệu sai (dưới 60 phút) → 400, ca giữ nguyên version', async () => {
      const pt = await trainer();
      const { body } = await create(pt, draft()).expect(201);
      const response = await update(pt, body.id, { version: 0, ...draft('08:10', '08:40') });
      expect(response.status).toBe(400);
      expect(await shiftInDb(body.id)).toMatchObject({ version: 0 });
      expect(await count('shift_events')).toBe(1);
    });

    it('US-24-TC03: danh sách với khoảng ngày quá 31 ngày hoặc ngày không có thật → 400', async () => {
      const pt = await trainer();
      expect((await list(pt, { fromDate: vnDay(1), toDate: vnDay(40) })).status).toBe(400);
      expect((await list(pt, { fromDate: '2026-02-30', toDate: '2026-03-02' })).status).toBe(400);
    });

    it('US-24-TC03: danh sách với query ngoài allowlist → 400', async () => {
      const pt = await trainer();
      expect((await list(pt, { trainerId: new ObjectId().toHexString() })).status).toBe(400);
    });
  });

  describe('US-24-TC04: ranh giới nửa đêm Việt Nam qua API', () => {
    it('US-24-TC04: ca 22:30–00:30 qua nửa đêm → 400, không ghi', async () => {
      const pt = await trainer();
      const response = await create(pt, { startAt: at('22:30'), endAt: at('00:30', nextDay), location: 'Phòng PT 1' });
      expect(response.status).toBe(400);
      expect(await count('work_shifts')).toBe(0);
    });

    it('US-24-TC04: ca 23:00–00:00 ngày kế tiếp → 201', async () => {
      const pt = await trainer();
      const response = await create(pt, { startAt: at('23:00'), endAt: at('00:00', nextDay), location: 'Phòng PT 1' });
      expect(response.status).toBe(201);
      expect(new Date(response.body.endAt).toISOString()).toBe(asDate('00:00', nextDay).toISOString());
    });
  });

  // =====================================================================
  // AC02: trạng thái và overlap (TC05–TC08)
  // =====================================================================
  describe('US-24-TC05: chồng ca còn hiệu lực và hai ca liền nhau', () => {
    it('US-24-TC05: tạo ca chồng lên ca SCHEDULED của chính PT → 409 SHIFT_OVERLAP, không ghi thêm', async () => {
      const pt = await trainer();
      await create(pt, draft('08:00', '10:00')).expect(201);
      const response = await create(pt, draft('09:00', '11:00'));
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SHIFT_OVERLAP');
      expect(await count('work_shifts')).toBe(1);
      expect(await count('shift_events')).toBe(1);
    });

    it('US-24-TC05: hai ca liền nhau 08:00–10:00 và 10:00–11:00 đều tạo được', async () => {
      const pt = await trainer();
      await create(pt, draft('08:00', '10:00')).expect(201);
      expect((await create(pt, draft('10:00', '11:00'))).status).toBe(201);
      expect((await create(pt, draft('07:00', '08:00'))).status).toBe(201);
      expect(await count('work_shifts')).toBe(3);
    });

    for (const status of ['CONFIRMED', 'COMPLETED'] as const) {
      it(`US-24-TC05: ca ${status} của chính PT cũng chặn chồng ca → 409 SHIFT_OVERLAP`, async () => {
        const pt = await trainer();
        await insertShift(pt.trainerId, asDate('08:00'), asDate('10:00'), status);
        const response = await create(pt, draft('09:00', '11:00'));
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('SHIFT_OVERLAP');
      });
    }

    it('US-24-TC05: ca CANCELLED không chặn, tạo trùng giờ được', async () => {
      const pt = await trainer();
      await insertShift(pt.trainerId, asDate('08:00'), asDate('10:00'), 'CANCELLED');
      expect((await create(pt, draft('08:00', '10:00'))).status).toBe(201);
    });

    it('US-24-TC05: ca của PT khác trùng giờ không chặn', async () => {
      const pt = await trainer();
      const other = await trainer();
      await create(other, draft('08:00', '10:00')).expect(201);
      expect((await create(pt, draft('08:00', '10:00'))).status).toBe(201);
    });

    it('US-24-TC05: sửa ca thành chồng lên ca khác → 409 SHIFT_OVERLAP, version giữ nguyên', async () => {
      const pt = await trainer();
      await create(pt, draft('08:00', '10:00')).expect(201);
      const { body } = await create(pt, draft('10:00', '11:00')).expect(201);
      const response = await update(pt, body.id, { version: 0, ...draft('09:30', '11:00') });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SHIFT_OVERLAP');
      const saved = await shiftInDb(body.id);
      expect(saved!.version).toBe(0);
      expect(saved!.start_at.toISOString()).toBe(asDate('10:00').toISOString());
    });
  });

  describe('US-24-TC06: sửa nháp không tự xung đột với chính nó', () => {
    it('US-24-TC06: giữ nguyên khoảng giờ, đổi location → 200, version tăng 1', async () => {
      const pt = await trainer();
      const { body } = await create(pt, draft('08:00', '10:00')).expect(201);
      const response = await update(pt, body.id, { version: 0, ...draft('08:00', '10:00', 'Phòng PT 2') });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: body.id, location: 'Phòng PT 2', status: 'SCHEDULED', version: 1 });
      expect(await shiftInDb(body.id)).toMatchObject({ location: 'Phòng PT 2', version: 1 });
    });

    it('US-24-TC06: thu hẹp hoặc dời ca trong khoảng cũ của chính nó → 200 (loại chính id khi kiểm overlap)', async () => {
      const pt = await trainer();
      const { body } = await create(pt, draft('08:00', '10:00')).expect(201);
      const first = await update(pt, body.id, { version: 0, ...draft('08:30', '10:00') });
      expect(first.status).toBe(200);
      const second = await update(pt, body.id, { version: 1, ...draft('08:00', '09:30') });
      expect(second.status).toBe(200);
      expect(second.body.version).toBe(2);
    });

    it('US-24-TC06: sửa ghi audit UPDATED có before/after, updated_by là account PT', async () => {
      const pt = await trainer();
      const { body } = await create(pt, draft('08:00', '10:00')).expect(201);
      await update(pt, body.id, { version: 0, ...draft('08:00', '10:00', 'Phòng PT 2') }).expect(200);
      const updated = await db().collection('shift_events').findOne({ shift_id: new ObjectId(body.id), action: 'UPDATED' });
      expect(updated!.before).toMatchObject({ location: 'Phòng PT 1', version: 0 });
      expect(updated!.after).toMatchObject({ location: 'Phòng PT 2', version: 1 });
      expect((await shiftInDb(body.id))!.updated_by.toHexString()).toBe(pt.accountId);
    });
  });

  describe('US-24-TC07: không sửa ca đã công bố/hoàn tất/hủy hoặc nháp có BOOKED', () => {
    for (const status of ['CONFIRMED', 'COMPLETED', 'CANCELLED'] as const) {
      it(`US-24-TC07: sửa ca ${status} → 409 SHIFT_NOT_EDITABLE, ca giữ nguyên`, async () => {
        const pt = await trainer();
        const id = await insertShift(pt.trainerId, asDate('08:00'), asDate('10:00'), status);
        const response = await update(pt, id.toHexString(), { version: 0, ...draft('08:00', '10:00', 'Phòng mới') });
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('SHIFT_NOT_EDITABLE');
        expect(await db().collection('work_shifts').findOne({ _id: id })).toMatchObject({ status, location: 'Phòng PT 1', version: 0 });
        expect(await count('shift_events')).toBe(0);
      });
    }

    it('US-24-TC07: sửa nháp đã bắt đầu → 409 SHIFT_NOT_EDITABLE', async () => {
      const pt = await trainer();
      const started = new Date(Math.floor(Date.now() / 60000) * 60000 - 30 * 60000);
      const id = await insertShift(pt.trainerId, started, new Date(started.getTime() + 2 * 60 * 60000));
      const response = await update(pt, id.toHexString(), { version: 0, ...draft('08:00', '10:00') });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SHIFT_NOT_EDITABLE');
    });

    it('US-24-TC07: nháp có lịch đặt BOOKED tham chiếu → 409 SHIFT_HAS_BOOKINGS, ca và booking giữ nguyên', async () => {
      const pt = await trainer();
      const { body } = await create(pt, draft('08:00', '10:00')).expect(201);
      const bookingId = new ObjectId();
      await db().collection('pt_bookings').insertOne({
        _id: bookingId, id: bookingId, membership_id: new ObjectId(), trainer_id: pt.trainerId, shift_id: new ObjectId(body.id),
        start_at: asDate('08:00'), end_at: asDate('09:00'), status: 'BOOKED', request_key: 'us24-tc07-booking', created_at: new Date(),
      });
      const response = await update(pt, body.id, { version: 0, ...draft('09:00', '10:00') });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SHIFT_HAS_BOOKINGS');
      const saved = await shiftInDb(body.id);
      expect(saved!.version).toBe(0);
      expect(saved!.start_at.toISOString()).toBe(asDate('08:00').toISOString());
      expect(await db().collection('pt_bookings').findOne({ _id: bookingId })).toMatchObject({ status: 'BOOKED', shift_id: new ObjectId(body.id) });
    });

    it('US-24-TC07: không có API xóa ca (DELETE không xóa được), ca vẫn còn', async () => {
      const pt = await trainer();
      const { body } = await create(pt, draft()).expect(201);
      const response = await http().delete(`${base}/${body.id}`).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`);
      expect(response.status).toBe(404);
      expect(await count('work_shifts')).toBe(1);
    });
  });

  describe('US-24-TC08: nháp phủ một lớp PUBLISHED cùng PT', () => {
    it('US-24-TC08: tạo ca 08:00–11:00 phủ lớp 09:00–10:00 → 201, lớp giữ nguyên', async () => {
      const pt = await trainer();
      const classId = new ObjectId();
      await db().collection('public_sessions').insertOne({
        _id: classId, id: classId, trainer_id: pt.trainerId, title: 'Yoga sáng', location: 'Phòng PT 1',
        start_at: asDate('09:00'), end_at: asDate('10:00'), status: 'PUBLISHED',
      });
      const response = await create(pt, draft('08:00', '11:00'));
      expect(response.status).toBe(201);
      expect(await db().collection('public_sessions').findOne({ _id: classId })).toMatchObject({ status: 'PUBLISHED', title: 'Yoga sáng' });
      expect(await count('public_sessions')).toBe(1);
    });
  });

  // =====================================================================
  // AC03: đồng thời, replay (TC09–TC11). Bản hai instance thuộc bước 4 (EN-05).
  // =====================================================================
  describe('US-24-TC09: hai lệnh tạo khác key cùng PT chồng ca gửi đồng thời', () => {
    it('US-24-TC09: chỉ một lệnh thành công, lệnh kia 409 SHIFT_OVERLAP, không write skew (lặp 5 lần)', async () => {
      for (let round = 0; round < 5; round += 1) {
        const pt = await trainer();
        const [a, b] = await Promise.all([create(pt, draft('08:00', '10:00')), create(pt, draft('09:00', '11:00'))]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        const loser = a.status === 409 ? a : b;
        expect(loser.body.error.code).toBe('SHIFT_OVERLAP');
        expect(await count('work_shifts', { trainer_id: pt.trainerId })).toBe(1);
        expect(await count('operation_requests', { actor_id: new ObjectId(pt.accountId) })).toBe(1);
      }
    });
  });

  describe('US-24-TC10: hai PATCH cùng version; gửi lại cùng key', () => {
    it('US-24-TC10: hai PATCH cùng version gửi đồng thời → một 200, một 409 VERSION_CONFLICT, chỉ một audit UPDATED', async () => {
      const pt = await trainer();
      const { body } = await create(pt, draft('08:00', '10:00')).expect(201);
      const [a, b] = await Promise.all([
        update(pt, body.id, { version: 0, ...draft('08:00', '10:00', 'Phòng A') }),
        update(pt, body.id, { version: 0, ...draft('08:00', '10:00', 'Phòng B') }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      const winner = a.status === 200 ? a : b;
      expect(loser.body.error.code).toBe('VERSION_CONFLICT');
      expect(await shiftInDb(body.id)).toMatchObject({ version: 1, location: winner.body.location });
      expect(await count('shift_events', { action: 'UPDATED' })).toBe(1);
    });

    it('US-24-TC10: PATCH với version cũ → 409 VERSION_CONFLICT, không ghi đè', async () => {
      const pt = await trainer();
      const { body } = await create(pt, draft('08:00', '10:00')).expect(201);
      await update(pt, body.id, { version: 0, ...draft('08:00', '10:00', 'Phòng A') }).expect(200);
      const stale = await update(pt, body.id, { version: 0, ...draft('08:00', '10:00', 'Phòng B') });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
      expect(await shiftInDb(body.id)).toMatchObject({ version: 1, location: 'Phòng A' });
    });

    it('US-24-TC10: gửi lại POST cùng key cùng payload → cùng status/body gốc, không thêm ca hay audit', async () => {
      const pt = await trainer();
      const key = randomUUID();
      const first = await create(pt, draft(), key).expect(201);
      const second = await create(pt, draft(), key);
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(await count('work_shifts')).toBe(1);
      expect(await count('shift_events')).toBe(1);
      expect(await count('operation_requests')).toBe(1);
    });

    it('US-24-TC10: gửi lại PATCH cùng key cùng payload → body gốc, version không tăng thêm, không thêm audit', async () => {
      const pt = await trainer();
      const { body } = await create(pt, draft('08:00', '10:00')).expect(201);
      const key = randomUUID();
      const payload = { version: 0, ...draft('08:00', '10:00', 'Phòng A') };
      const first = await update(pt, body.id, payload, key).expect(200);
      const second = await update(pt, body.id, payload, key);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(await shiftInDb(body.id)).toMatchObject({ version: 1 });
      expect(await count('shift_events', { action: 'UPDATED' })).toBe(1);
    });

    it('US-24-TC10: cùng key nhưng khác payload → 409 IDEMPOTENCY_CONFLICT, không ghi thêm', async () => {
      const pt = await trainer();
      const key = randomUUID();
      await create(pt, draft('08:00', '10:00'), key).expect(201);
      const response = await create(pt, draft('14:00', '15:00'), key);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await count('work_shifts')).toBe(1);
    });

    it('US-24-TC10: tra cứu key SHIFT_CREATE đã commit trả COMMITTED với status 201 gốc', async () => {
      const pt = await trainer();
      const key = randomUUID();
      const { body } = await create(pt, draft(), key).expect(201);
      const response = await http().get(`/api/operations/SHIFT_CREATE/${key}`).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'COMMITTED', responseStatus: 201, responseBody: body });
    });
  });

  describe('US-24-TC11: lỗi ghi audit/key trước commit', () => {
    it('US-24-TC11: ghi shift_events lỗi → 503, không có ca dở dang hay bản ghi idempotency; tra cứu key là chưa biết', async () => {
      const pt = await trainer();
      const key = randomUUID();
      await failInsert('shift_events');
      const response = await create(pt, draft(), key);
      expect(response.status).toBe(503);
      expect(JSON.stringify(response.body)).not.toContain('Giả lập DB lỗi');
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
      expect(await count('work_shifts')).toBe(0);
      expect(await count('operation_requests')).toBe(0);
      const lookup = await http().get(`/api/operations/SHIFT_CREATE/${key}`).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`);
      expect(lookup.status).toBe(404);
      expect(lookup.body.error.code).toBe('OPERATION_UNKNOWN');
    });

    it('US-24-TC11: ghi operation_requests lỗi → 503, không có ca hay audit dở dang', async () => {
      const pt = await trainer();
      await failInsert('operation_requests');
      const response = await create(pt, draft());
      expect(response.status).toBe(503);
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
      expect(await count('work_shifts')).toBe(0);
      expect(await count('shift_events')).toBe(0);
    });

    it('US-24-TC11: sau lỗi, gửi lại đúng key → 201 và chỉ có một ca, một audit', async () => {
      const pt = await trainer();
      const key = randomUUID();
      await failInsert('shift_events');
      expect((await create(pt, draft(), key)).status).toBe(503);
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
      const retry = await create(pt, draft(), key);
      expect(retry.status).toBe(201);
      expect(await count('work_shifts')).toBe(1);
      expect(await count('shift_events')).toBe(1);
      expect(await count('operation_requests')).toBe(1);
    });

    it('US-24-TC11: PATCH lỗi ghi audit → 503, ca giữ nguyên version và giờ cũ', async () => {
      const pt = await trainer();
      const { body } = await create(pt, draft('08:00', '10:00')).expect(201);
      await failInsert('shift_events');
      const response = await update(pt, body.id, { version: 0, ...draft('08:30', '10:00') });
      expect(response.status).toBe(503);
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
      const saved = await shiftInDb(body.id);
      expect(saved!.version).toBe(0);
      expect(saved!.start_at.toISOString()).toBe(asDate('08:00').toISOString());
    });
  });
});
