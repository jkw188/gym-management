// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-26 bước 4.
// Bổ sung các ca chưa có ở bước 1: tuần mặc định và lớp vắt qua nửa đêm (ngày VN), cách ly trạng thái khi kết hợp filter,
// không lộ giá trị nhạy cảm, dữ liệu thay đổi sau khi list, DB lỗi trả 503 an toàn (TC02, TC04, TC06, TC08, TC09, TC11, TC12).
// Hợp đồng giữ nguyên như bước 1 (xem public-sessions-api.integration-spec.ts). Thêm theo spec:
//   - Thiếu fromDate/toDate → mặc định tuần hiện tại thứ Hai → Chủ nhật theo ngày Việt Nam (US-26-F01, mục 2).
//   - Lỗi theo EN01-D03 {error:{code,message,details?},requestId}; 503 khi DB không sẵn sàng, không trả lỗi MongoDB thô.
//   - Không cache cũ: GET ngay sau khi dữ liệu đổi phải thấy dữ liệu mới (US-26-F05).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us26_hardening';
const password = 'MậtKhẩuUS-26-456';
const base = '/api/public-sessions';
const dbErrorText = 'Gia lap DB loi US-26-TC12';
const internalReason = 'Lý do nội bộ của Admin US-26';

describe('US-26 bước 4: ngày VN, cách ly trạng thái, riêng tư và thay đổi sau list', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      // enableTestCommands=1 để dùng failpoint giả lập DB lỗi (US-26-TC12), giống US-47-TC12.
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
      SMTP_USER: 'us26-test', SMTP_PASS: 'us26-test', SMTP_FROM: 'no-reply@gym.test',
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

  // ---------- Thời gian theo lịch Việt Nam ----------
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Ngày Việt Nam (YYYY-MM-DD) cách hôm nay `days` ngày.
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10);
  const day = vnDay(10);
  const nextDay = vnDay(11);
  const asDate = (hhmm: string, onDay = day) => new Date(`${onDay}T${hhmm}:00+07:00`);
  // Tuần hiện tại theo ngày Việt Nam: số ngày từ thứ Hai đến hôm nay (thứ Hai = 0 … Chủ nhật = 6).
  const daysSinceMonday = () => (new Date(Date.now() + VN_OFFSET_MS).getUTCDay() + 6) % 7;

  // ---------- Chuẩn bị dữ liệu ----------
  let phoneSeq = 0;
  async function trainer(fullName = 'PT Lê Thị Bình', email = 'pt.binh@gym.test') {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole('TRAINER', 'TRAINER');
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0912640${String(phoneSeq).padStart(3, '0')}`;
    const owner = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    await db().collection('accounts').updateOne({ _id: new ObjectId(owner.id) }, { $set: { email } });
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: owner.id, specialty: 'Yoga', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: String(owner.id), phone, email };
  }

  const adminId = new ObjectId();
  // Lớp mẫu (thay US-66), field theo mục 4.2.17 + US-66.
  async function insertClass(trainerId: ObjectId, options: {
    title?: string; subject?: string; status?: string; from?: Date; to?: Date; location?: string;
  } = {}) {
    const id = new ObjectId();
    const now = new Date();
    const status = options.status ?? 'PUBLISHED';
    await db().collection('public_sessions').insertOne({
      _id: id, id, trainer_id: trainerId,
      title: options.title ?? 'Yoga buổi sáng', subject_code: options.subject ?? 'YOGA', location: options.location ?? 'Phòng 1',
      start_at: options.from ?? asDate('08:00'), end_at: options.to ?? asDate('09:00'), status, version: 1,
      created_at: now, updated_at: now, created_by: adminId, updated_by: adminId,
      ...(status === 'PUBLISHED' ? { published_at: now } : {}),
      ...(status === 'CANCELLED' ? { cancelled_at: now, cancelled_by: adminId, cancellation_reason: internalReason } : {}),
    });
    return id.toHexString();
  }
  const updateClass = (id: string, set: Record<string, unknown>) =>
    db().collection('public_sessions').updateOne({ _id: new ObjectId(id) }, { $set: { ...set, updated_at: new Date() } });

  const list = (query: Record<string, string | number> = {}) => http().get(base).query({ fromDate: day, toDate: day, ...query });
  const detail = (id: string) => http().get(`${base}/${id}`);
  type Item = Record<string, unknown> & { id: string };
  const ids = (body: { items: Item[] }) => body.items.map(item => item.id);

  // Giả lập DB lỗi khi đọc collection public_sessions (mã 1 = lỗi thường, driver không coi server đã tắt).
  async function failReads() {
    await db().admin().command({
      configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: ['find', 'aggregate', 'count', 'distinct'], namespace: `${databaseName}.public_sessions`, errorCode: 1, errmsg: dbErrorText },
    });
  }

  // Lỗi đúng khuôn EN01-D03, không lộ stack/lỗi MongoDB.
  function expectSafeError(response: request.Response, status: number) {
    expect(response.status).toBe(status);
    expect(Object.keys(response.body).sort()).toEqual(['error', 'requestId']);
    expect(Object.keys(response.body.error).every(key => ['code', 'message', 'details'].includes(key))).toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(/Mongo|failCommand|stack|E11000|Cast to ObjectId/i);
    expect(JSON.stringify(response.body)).not.toContain(dbErrorText);
  }

  // =====================================================================
  // Ngày Việt Nam (TC04, TC06)
  // =====================================================================
  describe('US-26-TC06: ngày Việt Nam và tuần mặc định', () => {
    it('US-26-TC04: thiếu fromDate/toDate → lấy tuần hiện tại thứ Hai 00:00 đến Chủ nhật 24:00 giờ Việt Nam', async () => {
      const pt = await trainer();
      const offset = daysSinceMonday();
      const monday = vnDay(-offset);
      const sunday = vnDay(6 - offset);
      await insertClass(pt.trainerId, { title: 'Chủ nhật tuần trước', from: asDate('23:00', vnDay(-offset - 1)), to: asDate('23:59', vnDay(-offset - 1)) });
      const first = await insertClass(pt.trainerId, { title: 'Thứ Hai 00:00', from: asDate('00:00', monday), to: asDate('01:00', monday) });
      const last = await insertClass(pt.trainerId, { title: 'Chủ nhật 23:00', from: asDate('23:00', sunday), to: asDate('23:59', sunday) });
      await insertClass(pt.trainerId, { title: 'Thứ Hai tuần sau', from: asDate('00:00', vnDay(7 - offset)), to: asDate('01:00', vnDay(7 - offset)) });

      const response = await http().get(base).expect(200);
      expect(ids(response.body)).toEqual([first, last]);
    });

    it('US-26-TC06: lớp 23:30 ngày D đến 00:30 ngày D+1 giao cả hai ngày nên có trong lọc ngày D và lọc ngày D+1', async () => {
      const pt = await trainer();
      const crossing = await insertClass(pt.trainerId, { from: asDate('23:30'), to: asDate('00:30', nextDay) });
      expect(ids((await list({ fromDate: day, toDate: day }).expect(200)).body)).toEqual([crossing]);
      expect(ids((await list({ fromDate: nextDay, toDate: nextDay }).expect(200)).body)).toEqual([crossing]);
    });

    it('US-26-TC06: hai lớp liền nhau 07:00–08:00 và 08:00–09:00 đều được trả, đúng thứ tự giờ', async () => {
      const pt = await trainer();
      const second = await insertClass(pt.trainerId, { from: asDate('08:00'), to: asDate('09:00') });
      const first = await insertClass(pt.trainerId, { from: asDate('07:00'), to: asDate('08:00') });
      expect(ids((await list().expect(200)).body)).toEqual([first, second]);
    });

    it('US-26-TC06: startAt/endAt trả dạng ISO 8601 có Z hoặc offset, đúng thời điểm đã lưu', async () => {
      const pt = await trainer();
      await insertClass(pt.trainerId, { from: asDate('06:00'), to: asDate('07:00') });
      const [item] = (await list().expect(200)).body.items as Array<{ startAt: string; endAt: string }>;
      expect(item.startAt).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
      expect(item.endAt).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
      expect(new Date(item.startAt).getTime()).toBe(asDate('06:00').getTime());
      expect(new Date(item.endAt).getTime()).toBe(asDate('07:00').getTime());
    });
  });

  // =====================================================================
  // Cách ly trạng thái (TC02)
  // =====================================================================
  describe('US-26-TC02: cách ly trạng thái khi kết hợp filter và phân trang', () => {
    it('US-26-TC02: lọc đúng bộ môn + PT + ngày của lớp DRAFT/CANCELLED vẫn chỉ trả lớp PUBLISHED; total chỉ đếm PUBLISHED', async () => {
      const pt = await trainer();
      const a = await insertClass(pt.trainerId, { from: asDate('07:00'), to: asDate('08:00') });
      await insertClass(pt.trainerId, { status: 'DRAFT', from: asDate('07:00'), to: asDate('08:00') });
      await insertClass(pt.trainerId, { status: 'CANCELLED', from: asDate('07:00'), to: asDate('08:00') });
      const b = await insertClass(pt.trainerId, { from: asDate('09:00'), to: asDate('10:00') });
      await insertClass(pt.trainerId, { status: 'DRAFT', from: asDate('09:00'), to: asDate('10:00') });

      const response = await list({ subjectCode: 'YOGA', trainerId: pt.trainerId.toHexString() }).expect(200);
      expect(ids(response.body)).toEqual([a, b]);
      expect(response.body.total).toBe(2);
      expect(response.body.totalPages).toBe(1);
    });

    it('US-26-TC02: phân trang limit 1 chỉ đi qua lớp PUBLISHED (2 trang), không có trang chứa DRAFT/CANCELLED', async () => {
      const pt = await trainer();
      const a = await insertClass(pt.trainerId, { from: asDate('07:00'), to: asDate('08:00') });
      await insertClass(pt.trainerId, { status: 'DRAFT', from: asDate('07:30'), to: asDate('08:30') });
      await insertClass(pt.trainerId, { status: 'CANCELLED', from: asDate('08:00'), to: asDate('09:00') });
      const b = await insertClass(pt.trainerId, { from: asDate('09:00'), to: asDate('10:00') });

      const page1 = (await list({ limit: 1, page: 1 }).expect(200)).body;
      const page2 = (await list({ limit: 1, page: 2 }).expect(200)).body;
      const page3 = (await list({ limit: 1, page: 3 }).expect(200)).body;
      expect([page1.total, page1.totalPages]).toEqual([2, 2]);
      expect([...ids(page1), ...ids(page2)]).toEqual([a, b]);
      expect(ids(page3)).toEqual([]);
    });

    it('US-26-TC02: detail lớp DRAFT, CANCELLED và id không tồn tại trả cùng một lỗi 404, không cho đoán trạng thái', async () => {
      const pt = await trainer();
      const draft = await insertClass(pt.trainerId, { status: 'DRAFT' });
      const cancelled = await insertClass(pt.trainerId, { status: 'CANCELLED' });
      const errors = [];
      for (const id of [draft, cancelled, new ObjectId().toHexString()]) {
        const response = await detail(id);
        expectSafeError(response, 404);
        errors.push(response.body.error);
      }
      expect(errors[0].code).toBe('SESSION_NOT_FOUND');
      expect(errors[1]).toEqual(errors[0]);
      expect(errors[2]).toEqual(errors[0]);
      expect(JSON.stringify(errors)).not.toMatch(/DRAFT|CANCELLED|hủy|nháp/i);
    });
  });

  // =====================================================================
  // Riêng tư (TC08, TC11)
  // =====================================================================
  describe('US-26-TC08: không lộ giá trị nhạy cảm', () => {
    it('US-26-TC08: list, detail, subjects không chứa phone/email/accountId của PT, id Admin hay field audit', async () => {
      const pt = await trainer('PT Phạm Văn Cường', 'pt.cuong.private@gym.test');
      const id = await insertClass(pt.trainerId);
      const texts = [
        (await list().expect(200)).text,
        (await detail(id).expect(200)).text,
        (await http().get('/api/public-session-subjects').expect(200)).text,
      ];
      for (const text of texts) {
        expect(text).not.toContain(pt.phone);
        expect(text).not.toContain(pt.email);
        expect(text).not.toContain(pt.accountId);
        expect(text).not.toContain(adminId.toHexString());
        expect(text).not.toMatch(/created_by|updated_by|createdBy|updatedBy|published_?[aA]t|version|password|role/);
      }
      expect(texts[1]).toContain('PT Phạm Văn Cường');
    });

    it('US-26-TC11: PT bị khóa và có email: lớp cũ PUBLISHED vẫn hiện tên PT, không có email/phone trong phản hồi', async () => {
      const pt = await trainer('PT Đã Nghỉ', 'pt.nghi@gym.test');
      const id = await insertClass(pt.trainerId, { from: asDate('08:00', vnDay(-3)), to: asDate('09:00', vnDay(-3)) });
      await db().collection('accounts').updateOne({ _id: new ObjectId(pt.accountId) }, { $set: { status: 'LOCKED' } });
      await db().collection('trainers').updateOne({ _id: pt.trainerId }, { $set: { status: 'INACTIVE' } });
      const response = await detail(id).expect(200);
      expect(response.body.trainerName).toBe('PT Đã Nghỉ');
      expect(response.body.ended).toBe(true);
      expect(response.text).not.toContain(pt.email);
      expect(response.text).not.toContain(pt.phone);
    });

    it('US-26-TC08: lỗi 400 và 404 đúng khuôn {error:{code,message,details?},requestId}, không lộ stack hay lỗi MongoDB', async () => {
      expectSafeError(await list({ subjectCode: 'BOXING' }), 400);
      expectSafeError(await detail('khong-phai-id'), 400);
      expectSafeError(await detail(new ObjectId().toHexString()), 404);
    });
  });

  // =====================================================================
  // Dữ liệu thay đổi sau khi list (TC09)
  // =====================================================================
  describe('US-26-TC09: dữ liệu thay đổi sau khi list', () => {
    it('US-26-TC09: Admin đổi giờ và địa điểm sau khi list → list và detail ngay sau đó trả dữ liệu mới, không cache cũ', async () => {
      const pt = await trainer();
      const id = await insertClass(pt.trainerId, { from: asDate('08:00'), to: asDate('09:00'), location: 'Phòng 1' });
      await list().expect(200);
      await detail(id).expect(200);
      await updateClass(id, { start_at: asDate('15:00'), end_at: asDate('16:00'), location: 'Phòng 2', version: 2 });

      const item = (await list().expect(200)).body.items[0];
      const fresh = (await detail(id).expect(200)).body;
      for (const body of [item, fresh]) {
        expect(new Date(body.startAt).getTime()).toBe(asDate('15:00').getTime());
        expect(body.location).toBe('Phòng 2');
      }
    });

    it('US-26-TC09: lớp bị gỡ công bố về DRAFT sau khi list → detail 404 SESSION_NOT_FOUND, list không còn lớp', async () => {
      const pt = await trainer();
      const id = await insertClass(pt.trainerId);
      expect(ids((await list().expect(200)).body)).toEqual([id]);
      await updateClass(id, { status: 'DRAFT' });
      expect((await detail(id)).body.error.code).toBe('SESSION_NOT_FOUND');
      expect(ids((await list().expect(200)).body)).toEqual([]);
    });

    it('US-26-TC09: lớp mới được công bố sau khi list → lần list tiếp theo có ngay', async () => {
      const pt = await trainer();
      const id = await insertClass(pt.trainerId, { status: 'DRAFT' });
      expect(ids((await list().expect(200)).body)).toEqual([]);
      await updateClass(id, { status: 'PUBLISHED', published_at: new Date() });
      expect(ids((await list().expect(200)).body)).toEqual([id]);
      await detail(id).expect(200);
    });

    it('US-26-TC09: PT đổi tên sau khi list → trainerName lấy theo tên hiện tại của account', async () => {
      const pt = await trainer('PT Tên Cũ');
      const id = await insertClass(pt.trainerId);
      expect((await detail(id).expect(200)).body.trainerName).toBe('PT Tên Cũ');
      await db().collection('accounts').updateOne({ _id: new ObjectId(pt.accountId) }, { $set: { full_name: 'PT Tên Mới' } });
      expect((await detail(id).expect(200)).body.trainerName).toBe('PT Tên Mới');
      expect((await list().expect(200)).body.items[0].trainerName).toBe('PT Tên Mới');
    });
  });

  // =====================================================================
  // DB lỗi (TC12)
  // =====================================================================
  describe('US-26-TC12: DB không sẵn sàng', () => {
    it('US-26-TC12: DB lỗi khi đọc lịch → list và detail trả 503 an toàn, không trả list rỗng giả hay 404', async () => {
      const pt = await trainer();
      const id = await insertClass(pt.trainerId);
      await failReads();
      const listResponse = await list();
      expectSafeError(listResponse, 503);
      expect(listResponse.body.items).toBeUndefined();
      expectSafeError(await detail(id), 503);
    });

    it('US-26-TC12: DB hồi phục thì đọc lại được ngay, dữ liệu không bị đổi', async () => {
      const pt = await trainer();
      const id = await insertClass(pt.trainerId);
      await failReads();
      expect((await list()).status).toBe(503);
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
      expect(ids((await list().expect(200)).body)).toEqual([id]);
      expect((await db().collection('public_sessions').findOne({ _id: new ObjectId(id) }))?.status).toBe('PUBLISHED');
    });
  });
});
