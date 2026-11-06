// Tầng kiểm thử backend (Jest + hai Nest app ở hai process + MongoDB replica set thật): US-24 bước 4 theo EN-05 bản đơn giản.
// Kiểm tra chồng ca và version CAS khi request chia đều hai app cùng DB (TC05, TC09, TC10) và ranh giới ngày Việt Nam khi lọc lịch (TC04).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { ChildProcess, execSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { UsersRepository } from '../src/modules/users/users.repository';
// Môi trường theo EN-05 (bản đơn giản):
//   - App A: Nest app tạo trong process Jest; App B: process Node riêng chạy `node dist/main.js` (build mới từ src trước khi test).
//   - Hai app cùng MONGODB_URI/MONGODB_DB và JWT secret, không chia sẻ bộ nhớ (không mutex trong process).
//   - Request gửi gần đồng thời bằng Promise.all, chia đều hai app; mọi request settled rồi mới kiểm DB.
//   - Chưa có ClockProvider: dùng ngày tương lai tương đối theo đồng hồ thật (EN-05 yêu cầu clock cố định, ghi ở "Đề xuất").
// Hợp đồng API giống bước 2 (work-shifts-api.integration-spec.ts).

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us24_concurrency';
const password = 'MậtKhẩuUS-24-123';
const base = '/api/me/work-shifts';
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

describe('US-24 bước 4: ca nháp trên hai app instance cùng DB (EN-05 bản đơn giản)', () => {
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
      SMTP_USER: 'us24-test', SMTP_PASS: 'us24-test', SMTP_FROM: 'no-reply@gym.test',
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
  // Request i chẵn vào App A, lẻ vào App B.
  const appFor = (index: number) => (index % 2 === 0 ? request(app.getHttpServer()) : request(secondUrl));
  const appA = () => request(app.getHttpServer());
  const appB = () => request(secondUrl);

  // ---------- Thời gian: ngày tương lai theo lịch Việt Nam ----------
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const day = vnDay(10);
  const at = (hhmm: string, onDay = day) => `${onDay}T${hhmm}:00+07:00`;
  const draft = (from: string, to: string, location = 'Phòng PT 1') => ({ startAt: at(from), endAt: at(to), location });

  // ---------- Chuẩn bị: PT mẫu (account TRAINER + hồ sơ trainers), đăng nhập thật ----------
  let phoneSeq = 0;
  async function trainer() {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole('TRAINER', 'TRAINER');
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `09124100${String(phoneSeq).padStart(2, '0')}`;
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName: `US24 PT ${phoneSeq}`, passwordHash });
    const response = await appA().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: account.id, specialty: 'Thể hình', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
    return { accountId: account.id.toHexString(), accessToken: response.body.accessToken as string, trainerId };
  }

  type Pt = Awaited<ReturnType<typeof trainer>>;
  const createOn = (agent: ReturnType<typeof appA>, pt: Pt, body: Record<string, unknown>, key = randomUUID()) =>
    agent.post(base).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`).set('Idempotency-Key', key).send(body);
  const updateOn = (agent: ReturnType<typeof appA>, pt: Pt, id: string, body: Record<string, unknown>, key = randomUUID()) =>
    agent.patch(`${base}/${id}`).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`).set('Idempotency-Key', key).send(body);

  // Hai app thật sự là hai process khác nhau, cùng phục vụ API.
  it('US-24-TC09: chuẩn bị – App B là process riêng, cùng DB với App A', async () => {
    expect(secondApp!.pid).toBeDefined();
    expect(secondApp!.pid).not.toBe(process.pid);
    const pt = await trainer();
    const created = await createOn(appB(), pt, draft('08:00', '09:00')).expect(201);
    const seenFromA = await appA().get(`${base}/${created.body.id}`).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`);
    expect(seenFromA.status).toBe(200);
  });

  // =====================================================================
  // TC09: hai (nhiều) create khác key cùng PT chồng ca trên hai instance
  // =====================================================================
  describe('US-24-TC09: tạo ca chồng nhau gần đồng thời trên hai app', () => {
    // Các khoảng đều giao nhau ở 09:00–09:30, nên chỉ được phép đúng một ca.
    const overlapping = ['08:00-10:00', '09:00-11:00', '08:30-09:30', '09:00-10:00', '07:30-09:30'];

    it('US-24-TC09: 20 request khác key chia đều hai app → đúng một 201, còn lại 409 SHIFT_OVERLAP (lặp 3 vòng)', async () => {
      for (let round = 0; round < 3; round += 1) {
        const pt = await trainer();
        const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => {
          const [from, to] = overlapping[index % overlapping.length].split('-');
          return createOn(appFor(index), pt, draft(from, to));
        }));
        const statuses = responses.map(response => response.status);
        expect(statuses.filter(status => status === 201)).toHaveLength(1);
        expect(statuses.filter(status => status === 409)).toHaveLength(19);
        for (const response of responses.filter(entry => entry.status === 409)) expect(response.body.error.code).toBe('SHIFT_OVERLAP');
        expect(await count('work_shifts', { trainer_id: pt.trainerId })).toBe(1);
        expect(await count('shift_events', { actor_id: new ObjectId(pt.accountId) })).toBe(1);
        expect(await count('operation_requests', { actor_id: new ObjectId(pt.accountId) })).toBe(1);
      }
    });

    it('US-24-TC09: hai ca giao nhau, mỗi app nhận một ca → chỉ một ca được lưu (không write skew), lặp 10 vòng', async () => {
      for (let round = 0; round < 10; round += 1) {
        const pt = await trainer();
        const [a, b] = await Promise.all([createOn(appA(), pt, draft('08:00', '10:00')), createOn(appB(), pt, draft('09:00', '11:00'))]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        expect(await count('work_shifts', { trainer_id: pt.trainerId })).toBe(1);
      }
    });

    it('US-24-TC09: 10 ca liền nhau không chồng gửi đồng thời trên hai app → tất cả 201', async () => {
      const pt = await trainer();
      const hours = Array.from({ length: 10 }, (_, index) => String(8 + index).padStart(2, '0'));
      const responses = await Promise.all(hours.map((hour, index) =>
        createOn(appFor(index), pt, draft(`${hour}:00`, `${String(Number(hour) + 1).padStart(2, '0')}:00`))));
      expect(responses.map(response => response.status)).toEqual(Array(10).fill(201));
      expect(await count('work_shifts', { trainer_id: pt.trainerId })).toBe(10);
    });

    it('US-24-TC09: hai PT khác nhau tạo ca cùng giờ đồng thời trên hai app → cả hai 201', async () => {
      const first = await trainer();
      const second = await trainer();
      const [a, b] = await Promise.all([createOn(appA(), first, draft('08:00', '10:00')), createOn(appB(), second, draft('08:00', '10:00'))]);
      expect([a.status, b.status]).toEqual([201, 201]);
    });
  });

  // =====================================================================
  // TC05: overlap giữa hai app (tuần tự)
  // =====================================================================
  describe('US-24-TC05: chồng ca giữa hai app', () => {
    it('US-24-TC05: tạo ở App A rồi tạo chồng ở App B → 409 SHIFT_OVERLAP; ca liền nhau ở App B → 201', async () => {
      const pt = await trainer();
      await createOn(appA(), pt, draft('08:00', '10:00')).expect(201);
      const overlap = await createOn(appB(), pt, draft('09:00', '11:00'));
      expect(overlap.status).toBe(409);
      expect(overlap.body.error.code).toBe('SHIFT_OVERLAP');
      expect((await createOn(appB(), pt, draft('10:00', '11:00'))).status).toBe(201);
    });

    it('US-24-TC05: sửa ở App B thành chồng lên ca tạo ở App A → 409 SHIFT_OVERLAP, version giữ nguyên', async () => {
      const pt = await trainer();
      await createOn(appA(), pt, draft('08:00', '10:00')).expect(201);
      const { body } = await createOn(appB(), pt, draft('10:00', '11:00')).expect(201);
      const response = await updateOn(appB(), pt, body.id, { version: 0, ...draft('09:30', '11:00') });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SHIFT_OVERLAP');
      expect((await db().collection('work_shifts').findOne({ _id: new ObjectId(body.id) }))!.version).toBe(0);
    });
  });

  // =====================================================================
  // TC10: CAS và replay trên hai app
  // =====================================================================
  describe('US-24-TC10: version CAS và gửi lại cùng key trên hai app', () => {
    it('US-24-TC10: hai PATCH cùng version, mỗi app một lệnh → một 200, một 409 VERSION_CONFLICT, một audit UPDATED (lặp 5 vòng)', async () => {
      for (let round = 0; round < 5; round += 1) {
        const pt = await trainer();
        const { body } = await createOn(appA(), pt, draft('08:00', '10:00')).expect(201);
        const [a, b] = await Promise.all([
          updateOn(appA(), pt, body.id, { version: 0, ...draft('08:00', '10:00', 'Phòng A') }),
          updateOn(appB(), pt, body.id, { version: 0, ...draft('08:00', '10:00', 'Phòng B') }),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        const winner = a.status === 200 ? a : b;
        const loser = a.status === 409 ? a : b;
        expect(loser.body.error.code).toBe('VERSION_CONFLICT');
        expect(await db().collection('work_shifts').findOne({ _id: new ObjectId(body.id) })).toMatchObject({ version: 1, location: winner.body.location });
        expect(await count('shift_events', { shift_id: new ObjectId(body.id), action: 'UPDATED' })).toBe(1);
      }
    });

    it('US-24-TC10: 20 request cùng key cùng payload chia đều hai app → một ca, một audit, một bản ghi key; mọi 201 trả cùng body', async () => {
      const pt = await trainer();
      const key = randomUUID();
      const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => createOn(appFor(index), pt, draft('08:00', '10:00'), key)));
      // EN-02: request thua cuộc đua có thể trả 503 OPERATION_OUTCOME_UNKNOWN; khi đó tra cứu key phải ra COMMITTED.
      for (const response of responses) {
        expect([201, 503]).toContain(response.status);
        if (response.status === 503) expect(response.body.error.code).toBe('OPERATION_OUTCOME_UNKNOWN');
      }
      const succeeded = responses.filter(response => response.status === 201);
      expect(succeeded.length).toBeGreaterThan(0);
      for (const response of succeeded) expect(response.body).toEqual(succeeded[0].body);
      expect(await count('work_shifts', { trainer_id: pt.trainerId })).toBe(1);
      expect(await count('shift_events', { actor_id: new ObjectId(pt.accountId) })).toBe(1);
      expect(await count('operation_requests', { actor_id: new ObjectId(pt.accountId) })).toBe(1);
      const lookup = await appB().get(`/api/operations/SHIFT_CREATE/${key}`).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`);
      expect(lookup.status).toBe(200);
      expect(lookup.body).toMatchObject({ status: 'COMMITTED', responseStatus: 201, responseBody: succeeded[0].body });
    });

    it('US-24-TC10: tạo ở App A, gửi lại cùng key ở App B → body gốc, không thêm ca', async () => {
      const pt = await trainer();
      const key = randomUUID();
      const first = await createOn(appA(), pt, draft('08:00', '10:00'), key).expect(201);
      const replay = await createOn(appB(), pt, draft('08:00', '10:00'), key);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);
      expect(await count('work_shifts')).toBe(1);
    });
  });

  // =====================================================================
  // TC04: ranh giới ngày Việt Nam khi lọc lịch (ngày lọc là ngày VN, đổi sang UTC ở backend)
  // =====================================================================
  describe('US-24-TC04: ranh giới nửa đêm Việt Nam khi lọc danh sách', () => {
    const list = (agent: ReturnType<typeof appA>, pt: Pt, fromDate: string, toDate: string) =>
      agent.get(base).query({ fromDate, toDate }).set('Origin', origin).set('Authorization', `Bearer ${pt.accessToken}`);
    const startTimes = (body: { items: Array<{ startAt: string }> }) => body.items.map(item => new Date(item.startAt).toISOString()).sort();

    it('US-24-TC04: ca 06:00 sáng ngày D (23:00 UTC ngày D-1) thuộc ngày D, không thuộc ngày D-1', async () => {
      const pt = await trainer();
      const dayBefore = vnDay(9);
      await createOn(appA(), pt, { startAt: at('06:00'), endAt: at('07:00'), location: 'Phòng PT 1' }).expect(201);
      const onDay = await list(appB(), pt, day, day).expect(200);
      expect(startTimes(onDay.body)).toEqual([new Date(at('06:00')).toISOString()]);
      const onDayBefore = await list(appA(), pt, dayBefore, dayBefore).expect(200);
      expect(onDayBefore.body.items).toEqual([]);
    });

    it('US-24-TC04: ca 23:00–00:00 của ngày cuối được lọc vào; ca 00:00 ngày kế tiếp không vào', async () => {
      const pt = await trainer();
      const next = vnDay(11);
      await createOn(appA(), pt, { startAt: at('23:00'), endAt: at('00:00', next), location: 'Phòng PT 1' }).expect(201);
      await createOn(appB(), pt, { startAt: at('00:00', next), endAt: at('01:00', next), location: 'Phòng PT 1' }).expect(201);
      const onDay = await list(appA(), pt, day, day).expect(200);
      expect(startTimes(onDay.body)).toEqual([new Date(at('23:00')).toISOString()]);
      const onNext = await list(appB(), pt, next, next).expect(200);
      expect(startTimes(onNext.body)).toEqual([new Date(at('00:00', next)).toISOString()]);
    });

    it('US-24-TC04: ca kết thúc đúng 00:00 và ca bắt đầu 00:00 ngày kế tiếp là hai ca liền nhau, không chồng', async () => {
      const pt = await trainer();
      const next = vnDay(11);
      await createOn(appA(), pt, { startAt: at('23:00'), endAt: at('00:00', next), location: 'Phòng PT 1' }).expect(201);
      const response = await createOn(appB(), pt, { startAt: at('00:00', next), endAt: at('01:00', next), location: 'Phòng PT 1' });
      expect(response.status).toBe(201);
    });

    it('US-24-TC04: khoảng lọc đúng 31 ngày được, 32 ngày bị 400', async () => {
      const pt = await trainer();
      expect((await list(appA(), pt, vnDay(1), vnDay(31))).status).toBe(200);
      expect((await list(appB(), pt, vnDay(1), vnDay(32))).status).toBe(400);
    });
  });
});
