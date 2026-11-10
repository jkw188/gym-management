// Tầng kiểm thử backend (Jest + hai Nest app ở hai process + MongoDB replica set thật): US-25 bước 4 theo EN-05 bản đơn giản.
// Kiểm tra race hủy ca với đặt lịch (TC09), confirm/cancel cùng version và replay key (TC10), auth hiện hành (TC02) khi request chia hai app.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { ChildProcess, execSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { UsersRepository } from '../src/modules/users/users.repository';
// Môi trường giống US-24 bước 4 (EN-05 bản đơn giản):
//   - App A: Nest app trong process Jest; App B: process Node riêng chạy `node dist/main.js` (build mới từ src trước khi test).
//   - Hai app cùng MONGODB_URI/MONGODB_DB và JWT secret, không chia sẻ bộ nhớ.
// Writer đặt lịch giả (thay cho US-28 chưa có), làm đúng hợp đồng S04-G01 trong spec US-28:
//   trong MỘT transaction: tăng schedule_guards {_id:"global", revision:Int64} → đọc ca CONFIRMED chưa bắt đầu
//   → chèn pt_bookings BOOKED; ca không còn CONFIRMED thì trả SHIFT_UNAVAILABLE và không chèn gì.
//   Khi có US-28 thật, TC09 phải chạy lại với API đặt lịch thật.
// Hợp đồng API giống bước 2 (work-shifts-transition-api.integration-spec.ts).

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us25_concurrency';
const password = 'MậtKhẩuUS-25-123';
const base = '/api/me/work-shifts';
const reason = 'PT bận việc gia đình';
const backendRoot = path.resolve(__dirname, '..');

// Tìm một cổng TCP còn trống cho App B.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

// Chạy App B ở process riêng, chờ log APPLICATION_STARTED của main.ts.
function startSecondApp(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/main.js'], { cwd: backendRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => reject(new Error(`App B không khởi động kịp: ${output}`)), 60000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('APPLICATION_STARTED')) { clearTimeout(timer); resolve(child); }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`App B thoát sớm (mã ${code}): ${output}`)); });
  });
}

describe('US-25 bước 4: công bố/hủy ca trên hai app instance cùng DB (EN-05 bản đơn giản)', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  let secondApp: ChildProcess | undefined;
  let secondUrl: string;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName },
    });
    const shared = {
      NODE_ENV: 'test',
      FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      // Ứng dụng bắt buộc có cấu hình SMTP/pepper khi khởi động (US-05); test này không gửi thư.
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'us25-test', SMTP_PASS: 'us25-test', SMTP_FROM: 'no-reply@gym.test',
    };
    Object.assign(process.env, shared, { PORT: '3000' });

    // App A trong process Jest.
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http');
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));

    // App B: build mới từ src để chạy đúng code hiện tại, rồi mở ở process riêng.
    execSync('npx nest build', { cwd: backendRoot, stdio: 'pipe' });
    const port = await freePort();
    secondApp = await startSecondApp({ ...process.env, ...shared, PORT: String(port) });
    secondUrl = `http://127.0.0.1:${port}`;
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Giới hạn đăng nhập của App A lưu trong bộ nhớ: mỗi test dùng bộ mới (chỉ đăng nhập qua App A).
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await connection.db!.collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    // US-28-G02: writer ca (US-24/25) lấy khóa lịch schedule_guards; môi trường thật do lệnh ensure-indexes tạo sẵn.
    await connection.db!.collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    secondApp?.kill();
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const count = (name: string, filter: Record<string, unknown> = {}) => db().collection(name).countDocuments(filter);
  const appA = () => request(app.getHttpServer());
  const appB = () => request(secondUrl);
  // Request i chẵn vào App A, lẻ vào App B.
  const appFor = (index: number) => (index % 2 === 0 ? appA() : appB());
  type Agent = ReturnType<typeof appA>;

  // ---------- Thời gian: ngày tương lai theo lịch Việt Nam ----------
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const asDate = (hhmm: string, onDay = vnDay(10)) => new Date(`${onDay}T${hhmm}:00+07:00`);

  // ---------- Chuẩn bị: PT mẫu (account TRAINER + hồ sơ trainers), đăng nhập thật qua App A ----------
  let phoneSeq = 0;
  async function trainer() {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole('TRAINER', 'TRAINER');
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0912520${String(phoneSeq).padStart(3, '0')}`;
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName: `US25 PT ${phoneSeq}`, passwordHash });
    const response = await appA().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: account.id, specialty: 'Thể hình', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
    return { accountId: account.id.toHexString(), accessToken: response.body.accessToken as string, trainerId };
  }
  type Pt = Awaited<ReturnType<typeof trainer>>;

  // Ghi thẳng một ca (mặc định CONFIRMED 08:00–12:00 ngày tương lai `day` ngày nữa, version 0).
  async function insertShift(trainerId: ObjectId, status = 'CONFIRMED', day = 10) {
    const id = new ObjectId();
    const now = new Date();
    await db().collection('work_shifts').insertOne({
      _id: id, id, trainer_id: trainerId, start_at: asDate('08:00', vnDay(day)), end_at: asDate('12:00', vnDay(day)), location: 'Phòng PT 1',
      status, version: 0, created_by: new ObjectId(), updated_by: new ObjectId(), created_at: now, updated_at: now,
    });
    return id;
  }

  const confirmOn = (agent: Agent, pt: Pt, id: ObjectId, body: Record<string, unknown>, key = randomUUID()) =>
    agent.post(`${base}/${id.toHexString()}/confirm`).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`)
      .set('Idempotency-Key', key).send(body);
  const cancelOn = (agent: Agent, pt: Pt, id: ObjectId, body: Record<string, unknown>, key = randomUUID()) =>
    agent.post(`${base}/${id.toHexString()}/cancel`).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`)
      .set('Idempotency-Key', key).send(body);
  const shiftInDb = (id: ObjectId) => db().collection('work_shifts').findOne({ _id: id });
  const bookedOf = (id: ObjectId) => count('pt_bookings', { shift_id: id, status: 'BOOKED' });

  // Writer đặt lịch giả theo S04-G01 (xem comment đầu file). Chạy bằng client MongoDB riêng của test, song song với hai app.
  async function fakeBook(shiftId: ObjectId, trainerId: ObjectId, slotStart: Date): Promise<'BOOKED' | 'SHIFT_UNAVAILABLE'> {
    const session = connection.getClient().startSession();
    let result: 'BOOKED' | 'SHIFT_UNAVAILABLE' = 'SHIFT_UNAVAILABLE';
    try {
      await session.withTransaction(async () => {
        await db().collection<{ _id: string; revision: Long }>('schedule_guards')
          .updateOne({ _id: 'global' }, { $inc: { revision: Long.fromNumber(1) } }, { upsert: true, session });
        const shift = await db().collection('work_shifts').findOne({ _id: shiftId, status: 'CONFIRMED' }, { session });
        if (!shift || shift.start_at.getTime() <= Date.now()) {
          result = 'SHIFT_UNAVAILABLE';
          return;
        }
        const id = new ObjectId();
        await db().collection('pt_bookings').insertOne({
          _id: id, id, membership_id: new ObjectId(), trainer_id: trainerId, shift_id: shiftId,
          start_at: slotStart, end_at: new Date(slotStart.getTime() + 60 * 60000), status: 'BOOKED',
          request_key: `us25-fake-${id.toHexString()}`, created_at: new Date(),
        }, { session });
        result = 'BOOKED';
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      return result;
    } finally {
      await session.endSession();
    }
  }

  // Hai app thật sự là hai process khác nhau, cùng phục vụ API công bố/hủy.
  it('US-25-TC09: chuẩn bị – App B là process riêng, công bố ở App B thì App A thấy CONFIRMED', async () => {
    expect(secondApp!.pid).toBeDefined();
    expect(secondApp!.pid).not.toBe(process.pid);
    const pt = await trainer();
    const id = await insertShift(pt.trainerId, 'SCHEDULED');
    await confirmOn(appB(), pt, id, { version: 0 }).expect(200);
    const seenFromA = await appA().get(`${base}/${id.toHexString()}`).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`);
    expect(seenFromA.status).toBe(200);
    expect(seenFromA.body).toMatchObject({ status: 'CONFIRMED', version: 1 });
  });

  // =====================================================================
  // TC09: hủy ca và đặt lịch chạy đồng thời
  // =====================================================================
  describe('US-25-TC09: hủy ca và đặt lịch chạy đồng thời', () => {
    it('US-25-TC09: một lệnh hủy (luân phiên hai app) và một lệnh đặt lịch cùng lúc → chỉ "ca còn book" hoặc "ca hủy không book mới" (lặp 10 vòng)', async () => {
      const pt = await trainer();
      for (let round = 0; round < 10; round += 1) {
        const id = await insertShift(pt.trainerId, 'CONFIRMED', 10 + round);
        const [cancelled, booking] = await Promise.all([
          cancelOn(appFor(round), pt, id, { version: 0, reason }),
          fakeBook(id, pt.trainerId, asDate('08:00', vnDay(10 + round))),
        ]);
        const shift = await shiftInDb(id);
        const booked = await bookedOf(id);
        if (shift!.status === 'CANCELLED') {
          // Hủy thắng: booking recheck ca thấy đã hủy, không có BOOKED mới.
          expect(cancelled.status).toBe(200);
          expect(booking).toBe('SHIFT_UNAVAILABLE');
          expect(booked).toBe(0);
          expect(await count('shift_events', { shift_id: id, action: 'CANCELLED' })).toBe(1);
        } else {
          // Booking thắng: hủy ca bị chặn 409 SHIFT_HAS_BOOKINGS, ca vẫn CONFIRMED, booking giữ nguyên.
          expect(shift!.status).toBe('CONFIRMED');
          expect(cancelled.status).toBe(409);
          expect(cancelled.body.error.code).toBe('SHIFT_HAS_BOOKINGS');
          expect(booking).toBe('BOOKED');
          expect(booked).toBe(1);
          expect(await count('shift_events', { shift_id: id })).toBe(0);
        }
      }
    });

    it('US-25-TC09: hai lệnh hủy (App A và App B, khác key) cùng bốn lệnh đặt lịch → không bao giờ có ca CANCELLED còn BOOKED (lặp 5 vòng)', async () => {
      const pt = await trainer();
      for (let round = 0; round < 5; round += 1) {
        const onDay = vnDay(20 + round);
        const id = await insertShift(pt.trainerId, 'CONFIRMED', 20 + round);
        const slots = ['08:00', '09:00', '10:00', '11:00'].map(hhmm => asDate(hhmm, onDay));
        const [fromA, fromB, ...bookings] = await Promise.all([
          cancelOn(appA(), pt, id, { version: 0, reason }),
          cancelOn(appB(), pt, id, { version: 0, reason }),
          ...slots.map(slot => fakeBook(id, pt.trainerId, slot)),
        ]) as [request.Response, request.Response, ...Array<'BOOKED' | 'SHIFT_UNAVAILABLE'>];
        const shift = await shiftInDb(id);
        const booked = await bookedOf(id);
        const cancelSuccesses = [fromA, fromB].filter(response => response.status === 200).length;
        // Số BOOKED trong DB đúng bằng số lệnh đặt báo thành công.
        expect(booked).toBe(bookings.filter(result => result === 'BOOKED').length);
        expect(cancelSuccesses).toBeLessThanOrEqual(1);
        if (shift!.status === 'CANCELLED') {
          expect(cancelSuccesses).toBe(1);
          expect(booked).toBe(0);
        } else {
          expect(shift!.status).toBe('CONFIRMED');
          expect(cancelSuccesses).toBe(0);
          expect(booked).toBeGreaterThanOrEqual(1);
        }
        for (const response of [fromA, fromB].filter(entry => entry.status !== 200)) {
          expect(response.status).toBe(409);
          expect(['SHIFT_HAS_BOOKINGS', 'VERSION_CONFLICT', 'INVALID_SHIFT_STATE']).toContain(response.body.error.code);
        }
        expect(await count('shift_events', { shift_id: id, action: 'CANCELLED' })).toBe(cancelSuccesses);
      }
    });

    it('US-25-TC09: ca đã hủy ở App B thì lệnh đặt lịch sau đó trả SHIFT_UNAVAILABLE, không có BOOKED', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      await cancelOn(appB(), pt, id, { version: 0, reason }).expect(200);
      expect(await fakeBook(id, pt.trainerId, asDate('08:00'))).toBe('SHIFT_UNAVAILABLE');
      expect(await bookedOf(id)).toBe(0);
    });
  });

  // =====================================================================
  // TC10: confirm/cancel cùng version và replay key trên hai app
  // =====================================================================
  describe('US-25-TC10: version CAS và gửi lại cùng key trên hai app', () => {
    it('US-25-TC10: 10 lệnh công bố cùng version, khác key, chia đều hai app → đúng một 200, còn lại 409, một audit CONFIRMED (lặp 3 vòng)', async () => {
      for (let round = 0; round < 3; round += 1) {
        const pt = await trainer();
        const id = await insertShift(pt.trainerId, 'SCHEDULED');
        const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => confirmOn(appFor(index), pt, id, { version: 0 })));
        const statuses = responses.map(response => response.status);
        expect(statuses.filter(status => status === 200)).toHaveLength(1);
        expect(statuses.filter(status => status === 409)).toHaveLength(9);
        for (const response of responses.filter(entry => entry.status === 409)) {
          expect(['VERSION_CONFLICT', 'INVALID_SHIFT_STATE']).toContain(response.body.error.code);
        }
        expect(await shiftInDb(id)).toMatchObject({ status: 'CONFIRMED', version: 1 });
        expect(await count('shift_events', { shift_id: id })).toBe(1);
        expect(await count('operation_requests', { actor_id: new ObjectId(pt.accountId) })).toBe(1);
      }
    });

    it('US-25-TC10: công bố ở App A và hủy ở App B cùng version → đúng một transition thắng, một audit (lặp 5 vòng)', async () => {
      const pt = await trainer();
      for (let round = 0; round < 5; round += 1) {
        const id = await insertShift(pt.trainerId, 'SCHEDULED', 10 + round);
        const [confirmed, cancelled] = await Promise.all([
          confirmOn(appA(), pt, id, { version: 0 }),
          cancelOn(appB(), pt, id, { version: 0, reason }),
        ]);
        expect([confirmed.status, cancelled.status].sort()).toEqual([200, 409]);
        const winner = confirmed.status === 200 ? confirmed : cancelled;
        expect(await shiftInDb(id)).toMatchObject({ status: winner.body.status, version: 1 });
        expect(await count('shift_events', { shift_id: id })).toBe(1);
      }
    });

    it('US-25-TC10: 20 lệnh hủy cùng key cùng payload chia đều hai app → một transition, một audit, một bản ghi key; mọi 200 cùng body', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      const key = randomUUID();
      const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => cancelOn(appFor(index), pt, id, { version: 0, reason }, key)));
      // EN-02: request thua cuộc đua có thể trả 503 OPERATION_OUTCOME_UNKNOWN; khi đó tra cứu key phải ra COMMITTED.
      for (const response of responses) {
        expect([200, 503]).toContain(response.status);
        if (response.status === 503) expect(response.body.error.code).toBe('OPERATION_OUTCOME_UNKNOWN');
      }
      const succeeded = responses.filter(response => response.status === 200);
      expect(succeeded.length).toBeGreaterThan(0);
      for (const response of succeeded) expect(response.body).toEqual(succeeded[0].body);
      expect(await shiftInDb(id)).toMatchObject({ status: 'CANCELLED', version: 1 });
      expect(await count('shift_events', { shift_id: id })).toBe(1);
      expect(await count('operation_requests', { actor_id: new ObjectId(pt.accountId) })).toBe(1);
      const lookup = await appB().get(`/api/operations/SHIFT_CANCEL/${key}`).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`);
      expect(lookup.status).toBe(200);
      expect(lookup.body).toMatchObject({ status: 'COMMITTED', responseStatus: 200, responseBody: succeeded[0].body });
    });

    it('US-25-TC10: công bố ở App A, gửi lại cùng key ở App B → body gốc, không thêm audit', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, 'SCHEDULED');
      const key = randomUUID();
      const first = await confirmOn(appA(), pt, id, { version: 0 }, key).expect(200);
      const replay = await confirmOn(appB(), pt, id, { version: 0 }, key);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect(await count('shift_events', { shift_id: id })).toBe(1);
    });
  });

  // =====================================================================
  // TC02: auth hiện hành trên hai app (không cache quyền trong một process)
  // =====================================================================
  describe('US-25-TC02: auth hiện hành khi request chia hai app', () => {
    it('US-25-TC02: auth_version tăng (đổi mật khẩu/role ở bất kỳ app nào) → cả App A và App B trả 401, không transition', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, 'SCHEDULED');
      // Token còn dùng được trên cả hai app trước khi thu hồi.
      await appB().get(`${base}/${id.toHexString()}`).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`).expect(200);
      await db().collection('accounts').updateOne({ _id: new ObjectId(pt.accountId) }, { $inc: { auth_version: 1 } });
      expect((await confirmOn(appB(), pt, id, { version: 0 })).status).toBe(401);
      expect((await cancelOn(appA(), pt, id, { version: 0, reason })).status).toBe(401);
      expect(await shiftInDb(id)).toMatchObject({ status: 'SCHEDULED', version: 0 });
      expect(await count('shift_events')).toBe(0);
    });

    it('US-25-TC02: đăng xuất ở App A thì token đó bị từ chối ở App B', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, 'SCHEDULED');
      // Gọi đăng xuất giống test US-02: body JSON rỗng.
      const logout = await appA().post('/api/auth/logout').set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`).send({});
      expect(logout.status).toBe(204);
      expect((await confirmOn(appB(), pt, id, { version: 0 })).status).toBe(401);
      expect(await shiftInDb(id)).toMatchObject({ status: 'SCHEDULED', version: 0 });
    });

    it('US-25-TC02: PT bị chuyển INACTIVE thì App B trả 409 TRAINER_UNAVAILABLE ngay, không dùng dữ liệu cũ', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId);
      await appB().get(`${base}/${id.toHexString()}`).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`).expect(200);
      await db().collection('trainers').updateOne({ _id: pt.trainerId }, { $set: { status: 'INACTIVE' } });
      const response = await cancelOn(appB(), pt, id, { version: 0, reason });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('TRAINER_UNAVAILABLE');
      expect(await shiftInDb(id)).toMatchObject({ status: 'CONFIRMED', version: 0 });
    });

    it('US-25-TC02: gửi lại cùng key ở App B sau khi phiên bị thu hồi → 401, không trả lại body gốc', async () => {
      const pt = await trainer();
      const id = await insertShift(pt.trainerId, 'SCHEDULED');
      const key = randomUUID();
      await confirmOn(appA(), pt, id, { version: 0 }, key).expect(200);
      await db().collection('accounts').updateOne({ _id: new ObjectId(pt.accountId) }, { $inc: { auth_version: 1 } });
      const replay = await confirmOn(appB(), pt, id, { version: 0 }, key);
      expect(replay.status).toBe(401);
      expect(JSON.stringify(replay.body)).not.toContain(id.toHexString());
    });
  });
});
