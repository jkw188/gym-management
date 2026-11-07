// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-26 bước 1.
// Kiểm tra API công khai xem lớp miễn phí: chỉ PUBLISHED, projection an toàn, lọc ngày Việt Nam/bộ môn/PT, phân trang, đọc thuần (TC01–TC11).
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
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng test đặt ra cho Builder (US-26 bước 1, theo mục 2 của spec; sinh viên chốt 07/11: US-26 tạo phần đọc tối thiểu,
// US-66 sau này dùng lại schema và taxonomy):
//   Route công khai, KHÔNG cần đăng nhập (có token hợp lệ cũng trả như Guest):
//   GET /api/public-session-subjects -> 200 [{code,label}] đúng thứ tự taxonomy S04 của US-66:
//        YOGA "Yoga", AEROBICS "Aerobics", ZUMBA "Zumba", FUNCTIONAL "Tập chức năng", OTHER "Khác".
//   GET /api/public-sessions?fromDate&toDate&subjectCode?&trainerId?&page?&limit?
//        -> 200 {items, page, limit, total, totalPages}; page mặc định 1, limit 20, tối đa 100; sắp startAt ASC rồi id ASC.
//        fromDate/toDate là ngày Việt Nam YYYY-MM-DD, bao gồm hai đầu, tối đa 31 ngày; lớp được trả nếu GIAO khoảng ngày lọc.
//   GET /api/public-sessions/:id -> 200 detail; không phải PUBLISHED hoặc không tồn tại -> 404 SESSION_NOT_FOUND; id sai định dạng -> 400.
//   Mỗi item/detail CHỈ có: id, title, subjectCode, subjectLabel, trainerId, trainerName, startAt, endAt, location, status, ended.
//        trainerName = accounts.full_name của PT (trainers.account_id); ended = endAt <= giờ server.
//   Dữ liệu đọc từ collection 'public_sessions' (field theo mục 4.2.17 + US-66: subject_code, status DRAFT/PUBLISHED/CANCELLED, version, audit).
//   US-66 chưa có nên test chèn lớp thẳng vào DB. Lỗi 400 VALIDATION_ERROR cho query sai, không tự bỏ qua filter.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us26_api';
const password = 'MậtKhẩuUS-26-123';
const base = '/api/public-sessions';
const PUBLIC_FIELDS = ['endAt', 'ended', 'id', 'location', 'startAt', 'status', 'subjectCode', 'subjectLabel', 'title', 'trainerId', 'trainerName'];

describe('US-26 bước 1: API công khai xem lớp miễn phí', () => {
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
    // Bộ giới hạn đăng nhập (US-02) lưu trong bộ nhớ: mỗi test dùng bộ mới để không bị 429.
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
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

  // ---------- Thời gian theo lịch Việt Nam ----------
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  // Ngày Việt Nam (YYYY-MM-DD) cách hôm nay `days` ngày.
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const day = vnDay(10);
  const nextDay = vnDay(11);
  const asDate = (hhmm: string, onDay = day) => new Date(`${onDay}T${hhmm}:00+07:00`);

  // ---------- Chuẩn bị dữ liệu ----------
  let phoneSeq = 0;
  async function account(roleCode: 'MEMBER' | 'TRAINER', fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0912600${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { id: created.id, phone };
  }

  // PT mẫu (thay US-23): account TRAINER + hồ sơ trainers.
  async function trainer(fullName = 'PT Nguyễn Văn An') {
    const owner = await account('TRAINER', fullName);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: owner.id, specialty: 'Yoga', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: owner.id, phone: owner.phone };
  }

  // Lớp mẫu (thay US-66), field theo mục 4.2.17 + US-66.
  async function insertClass(trainerId: ObjectId, options: {
    title?: string; subject?: string; status?: string; from?: Date; to?: Date; location?: string; id?: ObjectId;
  } = {}) {
    const id = options.id ?? new ObjectId();
    const now = new Date();
    const status = options.status ?? 'PUBLISHED';
    const adminId = new ObjectId();
    await db().collection('public_sessions').insertOne({
      _id: id, id, trainer_id: trainerId,
      title: options.title ?? 'Yoga buổi sáng', subject_code: options.subject ?? 'YOGA', location: options.location ?? 'Phòng 1',
      start_at: options.from ?? asDate('08:00'), end_at: options.to ?? asDate('09:00'), status, version: 1,
      created_at: now, updated_at: now, created_by: adminId, updated_by: adminId,
      ...(status === 'PUBLISHED' ? { published_at: now } : {}),
      ...(status === 'CANCELLED' ? { cancelled_at: now, cancelled_by: adminId, cancellation_reason: 'Lý do nội bộ của Admin' } : {}),
    });
    return id.toHexString();
  }

  const list = (query: Record<string, string | number> = {}, token?: string) => {
    const call = http().get(base).query({ fromDate: day, toDate: day, ...query });
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };
  const detail = (id: string, token?: string) => {
    const call = http().get(`${base}/${id}`);
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };
  type Item = Record<string, unknown> & { id: string; startAt: string };
  const ids = (body: { items: Item[] }) => body.items.map(item => item.id);

  // Đếm số document của mọi collection (để chứng minh GET không ghi gì).
  async function snapshot() {
    const result: Record<string, number> = {};
    for (const collection of await db().collections()) result[collection.collectionName] = await collection.countDocuments();
    return result;
  }

  // =====================================================================
  // AC01: nguồn PUBLISHED và dữ liệu công khai (TC01–TC04)
  // =====================================================================
  describe('US-26-TC01: Guest tải lịch lớp đã công bố', () => {
    it('US-26-TC01: Guest không đăng nhập gọi list → 200, lớp lấy từ DB với đúng PT, giờ, địa điểm, bộ môn', async () => {
      const pt = await trainer('PT Nguyễn Văn An');
      const id = await insertClass(pt.trainerId, { title: 'Yoga buổi sáng', subject: 'YOGA', location: 'Phòng 1' });
      const response = await list();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
      expect(response.body.items).toHaveLength(1);
      const item = response.body.items[0];
      expect(item).toMatchObject({
        id, title: 'Yoga buổi sáng', subjectCode: 'YOGA', subjectLabel: 'Yoga', trainerId: pt.trainerId.toHexString(),
        trainerName: 'PT Nguyễn Văn An', location: 'Phòng 1', status: 'PUBLISHED', ended: false,
      });
      expect(new Date(item.startAt).toISOString()).toBe(asDate('08:00').toISOString());
      expect(new Date(item.endAt).toISOString()).toBe(asDate('09:00').toISOString());
      expect(item.startAt).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
    });

    it('US-26-TC01: Guest xem chi tiết lớp → 200 cùng dữ liệu như trong list', async () => {
      const pt = await trainer();
      const id = await insertClass(pt.trainerId);
      const fromList = (await list().expect(200)).body.items[0];
      const response = await detail(id);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(fromList);
    });

    it('US-26-TC01: danh mục bộ môn công khai đúng taxonomy S04 của US-66, đúng thứ tự', async () => {
      const response = await http().get('/api/public-session-subjects');
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        { code: 'YOGA', label: 'Yoga' },
        { code: 'AEROBICS', label: 'Aerobics' },
        { code: 'ZUMBA', label: 'Zumba' },
        { code: 'FUNCTIONAL', label: 'Tập chức năng' },
        { code: 'OTHER', label: 'Khác' },
      ]);
    });

    it('US-26-TC01: subjectLabel lấy theo taxonomy cho từng bộ môn', async () => {
      const pt = await trainer();
      await insertClass(pt.trainerId, { subject: 'FUNCTIONAL', from: asDate('07:00'), to: asDate('08:00') });
      await insertClass(pt.trainerId, { subject: 'OTHER', from: asDate('09:00'), to: asDate('10:00') });
      const response = await list().expect(200);
      expect(response.body.items.map((item: Item) => [item.subjectCode, item.subjectLabel]))
        .toEqual([['FUNCTIONAL', 'Tập chức năng'], ['OTHER', 'Khác']]);
    });
  });

  describe('US-26-TC02: lớp DRAFT/CANCELLED và đoán id trực tiếp', () => {
    it('US-26-TC02: list chỉ trả lớp PUBLISHED, không trả DRAFT/CANCELLED', async () => {
      const pt = await trainer();
      const published = await insertClass(pt.trainerId, { from: asDate('08:00'), to: asDate('09:00') });
      await insertClass(pt.trainerId, { status: 'DRAFT', from: asDate('10:00'), to: asDate('11:00') });
      await insertClass(pt.trainerId, { status: 'CANCELLED', from: asDate('12:00'), to: asDate('13:00') });
      const response = await list().expect(200);
      expect(ids(response.body)).toEqual([published]);
      expect(response.body.total).toBe(1);
    });

    for (const status of ['DRAFT', 'CANCELLED'] as const) {
      it(`US-26-TC02: đoán id lớp ${status} → 404 SESSION_NOT_FOUND, không lộ audit hay lý do hủy`, async () => {
        const pt = await trainer();
        const id = await insertClass(pt.trainerId, { status });
        const response = await detail(id);
        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('SESSION_NOT_FOUND');
        const text = JSON.stringify(response.body);
        expect(text).not.toContain('Lý do nội bộ');
        expect(text).not.toContain('Yoga buổi sáng');
        expect(text).not.toContain(pt.trainerId.toHexString());
      });
    }

    it('US-26-TC02: id không tồn tại → 404 SESSION_NOT_FOUND; id sai định dạng → 400', async () => {
      const missing = await detail(new ObjectId().toHexString());
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('SESSION_NOT_FOUND');
      expect((await detail('khong-phai-objectid')).status).toBe(400);
    });
  });

  describe('US-26-TC03: Member chưa có membership xem lớp', () => {
    it('US-26-TC03: Member đăng nhập, chưa mua gói → 200 và cùng nội dung như Guest', async () => {
      const pt = await trainer();
      const id = await insertClass(pt.trainerId);
      const member = await account('MEMBER', 'Hội viên Trần Thị Bình');
      const login = await http().post('/api/auth/login').set('Origin', origin).send({ phone: member.phone, password }).expect(200);
      const token = login.body.accessToken as string;
      const asGuest = await list().expect(200);
      const asMember = await list({}, token);
      expect(asMember.status).toBe(200);
      expect(asMember.body).toEqual(asGuest.body);
      const detailAsMember = await detail(id, token);
      expect(detailAsMember.status).toBe(200);
      expect(detailAsMember.body).toEqual((await detail(id)).body);
    });
  });

  describe('US-26-TC04: lịch trống hoặc lớp quá khứ PUBLISHED', () => {
    it('US-26-TC04: khoảng ngày không có lớp → 200 list rỗng, total 0, totalPages 0', async () => {
      const response = await list();
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
    });

    it('US-26-TC04: lớp PUBLISHED đã kết thúc vẫn xem được và có ended=true; lớp tương lai ended=false', async () => {
      const pt = await trainer();
      const pastDay = vnDay(-3);
      const past = await insertClass(pt.trainerId, { from: asDate('08:00', pastDay), to: asDate('09:00', pastDay) });
      const future = await insertClass(pt.trainerId);
      const pastList = await list({ fromDate: pastDay, toDate: pastDay }).expect(200);
      expect(pastList.body.items).toHaveLength(1);
      expect(pastList.body.items[0]).toMatchObject({ id: past, ended: true });
      expect((await detail(past).expect(200)).body.ended).toBe(true);
      expect((await detail(future).expect(200)).body.ended).toBe(false);
    });
  });

  // =====================================================================
  // AC02: lọc ngày, bộ môn và an toàn dữ liệu (TC05–TC08)
  // =====================================================================
  describe('US-26-TC05: lọc ngày/bộ môn/PT kết hợp và phân trang', () => {
    it('US-26-TC05: lọc bộ môn và PT kết hợp AND với khoảng ngày', async () => {
      const first = await trainer('PT Một');
      const second = await trainer('PT Hai');
      const match = await insertClass(first.trainerId, { subject: 'YOGA', from: asDate('08:00'), to: asDate('09:00') });
      await insertClass(first.trainerId, { subject: 'ZUMBA', from: asDate('10:00'), to: asDate('11:00') });
      await insertClass(second.trainerId, { subject: 'YOGA', from: asDate('12:00'), to: asDate('13:00') });
      await insertClass(first.trainerId, { subject: 'YOGA', from: asDate('08:00', nextDay), to: asDate('09:00', nextDay) });
      const response = await list({ subjectCode: 'YOGA', trainerId: first.trainerId.toHexString() }).expect(200);
      expect(ids(response.body)).toEqual([match]);
    });

    it('US-26-TC05: filter không có kết quả → 200 list rỗng (không trả "tất cả")', async () => {
      const pt = await trainer();
      await insertClass(pt.trainerId, { subject: 'YOGA' });
      const response = await list({ subjectCode: 'ZUMBA' }).expect(200);
      expect(response.body).toMatchObject({ items: [], total: 0, totalPages: 0 });
    });

    it('US-26-TC05: sắp startAt tăng dần rồi id tăng dần', async () => {
      const pt = await trainer();
      const late = await insertClass(pt.trainerId, { from: asDate('15:00'), to: asDate('16:00') });
      const idLow = new ObjectId('000000000000000000000001');
      const idHigh = new ObjectId('ffffffffffffffffffffffff');
      await insertClass(pt.trainerId, { id: idHigh, from: asDate('08:00'), to: asDate('09:00') });
      await insertClass(pt.trainerId, { id: idLow, from: asDate('08:00'), to: asDate('09:00') });
      const response = await list().expect(200);
      expect(ids(response.body)).toEqual([idLow.toHexString(), idHigh.toHexString(), late]);
    });

    it('US-26-TC05: phân trang 5 lớp cùng giờ với limit 2 → 3 trang, không rơi và không trùng lớp', async () => {
      const pt = await trainer();
      const created: string[] = [];
      for (let index = 0; index < 5; index += 1) created.push(await insertClass(pt.trainerId, { from: asDate('08:00'), to: asDate('09:00') }));
      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const response = await list({ page, limit: 2 }).expect(200);
        expect(response.body).toMatchObject({ page, limit: 2, total: 5, totalPages: 3 });
        seen.push(...ids(response.body));
      }
      expect(seen).toHaveLength(5);
      expect([...seen].sort()).toEqual([...created].sort());
      expect(seen).toEqual([...created].sort());
    });

    it('US-26-TC05: limit đúng 100 được chấp nhận', async () => {
      expect((await list({ limit: 100 })).status).toBe(200);
    });
  });

  describe('US-26-TC06: ranh giới ngày Việt Nam', () => {
    it('US-26-TC06: lớp 06:00 sáng ngày D (23:00 UTC ngày D-1) thuộc ngày D, không thuộc ngày D-1', async () => {
      const pt = await trainer();
      const id = await insertClass(pt.trainerId, { from: asDate('06:00'), to: asDate('07:00') });
      expect(ids((await list({ fromDate: day, toDate: day }).expect(200)).body)).toEqual([id]);
      expect(ids((await list({ fromDate: vnDay(9), toDate: vnDay(9) }).expect(200)).body)).toEqual([]);
    });

    it('US-26-TC06: lớp 23:00–00:00 thuộc ngày D; lớp bắt đầu 00:00 ngày D+1 không thuộc ngày D', async () => {
      const pt = await trainer();
      const lateNight = await insertClass(pt.trainerId, { from: asDate('23:00'), to: asDate('00:00', nextDay) });
      const midnight = await insertClass(pt.trainerId, { from: asDate('00:00', nextDay), to: asDate('01:00', nextDay) });
      expect(ids((await list({ fromDate: day, toDate: day }).expect(200)).body)).toEqual([lateNight]);
      expect(ids((await list({ fromDate: nextDay, toDate: nextDay }).expect(200)).body)).toEqual([midnight]);
    });

    it('US-26-TC06: lọc hai ngày D đến D+1 bao gồm cả hai đầu', async () => {
      const pt = await trainer();
      const first = await insertClass(pt.trainerId, { from: asDate('00:00'), to: asDate('01:00') });
      const last = await insertClass(pt.trainerId, { from: asDate('23:00', nextDay), to: asDate('23:59', nextDay) });
      expect(ids((await list({ fromDate: day, toDate: nextDay }).expect(200)).body)).toEqual([first, last]);
    });
  });

  describe('US-26-TC07: bộ môn lạ, ngày sai, khoảng trên 31 ngày, query status', () => {
    const cases: Array<[string, Record<string, string | number>]> = [
      ['bộ môn không có trong taxonomy', { subjectCode: 'BOXING' }],
      ['bộ môn viết thường', { subjectCode: 'yoga' }],
      ['ngày không có thật', { fromDate: '2026-02-30', toDate: '2026-03-02' }],
      ['ngày sai định dạng', { fromDate: '07/11/2026', toDate: '08/11/2026' }],
      ['khoảng 32 ngày', { fromDate: vnDay(1), toDate: vnDay(32) }],
      ['fromDate sau toDate', { fromDate: vnDay(5), toDate: vnDay(4) }],
      ['tự gửi status', { status: 'DRAFT' }],
      ['field ngoài allowlist', { includeDrafts: 'true' }],
      ['trainerId sai định dạng', { trainerId: 'khong-phai-objectid' }],
      ['page = 0', { page: 0 }],
      ['limit = 101', { limit: 101 }],
    ];
    for (const [name, query] of cases) {
      it(`US-26-TC07: ${name} → 400 VALIDATION_ERROR, không bỏ qua filter sai`, async () => {
        const pt = await trainer();
        await insertClass(pt.trainerId);
        const response = await list(query);
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.items).toBeUndefined();
      });
    }

    it('US-26-TC07: khoảng đúng 31 ngày → 200', async () => {
      expect((await list({ fromDate: vnDay(1), toDate: vnDay(31) })).status).toBe(200);
    });
  });

  describe('US-26-TC08: payload an toàn và title có markup', () => {
    it('US-26-TC08: item và detail chỉ có đúng các field allowlist, không có phone/email/accountId hay audit', async () => {
      const pt = await trainer();
      const id = await insertClass(pt.trainerId);
      const item = (await list().expect(200)).body.items[0];
      const one = (await detail(id).expect(200)).body;
      for (const payload of [item, one]) {
        expect(Object.keys(payload).sort()).toEqual(PUBLIC_FIELDS);
        const text = JSON.stringify(payload);
        expect(text).not.toContain(pt.phone);
        expect(text).not.toContain(pt.accountId.toHexString());
      }
    });

    it('US-26-TC08: title và location có markup được trả nguyên văn dạng text, không bị đổi thành HTML', async () => {
      const pt = await trainer();
      const title = '<script>alert(1)</script> Yoga & <b>Thiền</b>';
      const id = await insertClass(pt.trainerId, { title, location: 'Phòng <i>2</i>' });
      const one = (await detail(id).expect(200)).body;
      expect(one.title).toBe(title);
      expect(one.location).toBe('Phòng <i>2</i>');
    });
  });

  // =====================================================================
  // AC03: đọc thuần (phần backend của TC09–TC11)
  // =====================================================================
  describe('US-26-TC09: lớp bị hủy giữa list và detail', () => {
    it('US-26-TC09: list thấy lớp, sau khi lớp bị hủy thì detail 404 SESSION_NOT_FOUND và list không còn lớp', async () => {
      const pt = await trainer();
      const id = await insertClass(pt.trainerId);
      expect(ids((await list().expect(200)).body)).toEqual([id]);
      await db().collection('public_sessions').updateOne({ _id: new ObjectId(id) }, { $set: { status: 'CANCELLED', cancelled_at: new Date() } });
      const response = await detail(id);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('SESSION_NOT_FOUND');
      expect(ids((await list().expect(200)).body)).toEqual([]);
      expect(await db().collection('pt_bookings').countDocuments()).toBe(0);
    });
  });

  describe('US-26-TC10: GET nhiều lần, đổi login hoặc xem chi tiết không ghi gì', () => {
    it('US-26-TC10: gọi list/detail/subjects nhiều lần, có và không có token → số document mọi collection không đổi, lớp giữ nguyên', async () => {
      const pt = await trainer();
      const id = await insertClass(pt.trainerId);
      const member = await account('MEMBER', 'Hội viên Lê Văn Cường');
      const login = await http().post('/api/auth/login').set('Origin', origin).send({ phone: member.phone, password }).expect(200);
      const token = login.body.accessToken as string;
      const before = await snapshot();
      const classBefore = await db().collection('public_sessions').findOne({ _id: new ObjectId(id) });
      for (let round = 0; round < 3; round += 1) {
        await list().expect(200);
        await list({}, token).expect(200);
        await detail(id).expect(200);
        await detail(id, token).expect(200);
        await http().get('/api/public-session-subjects').expect(200);
      }
      expect(await snapshot()).toEqual(before);
      expect(await db().collection('public_sessions').findOne({ _id: new ObjectId(id) })).toEqual(classBefore);
    });

    it('US-26-TC10: không có route đăng ký chỗ cho lớp (POST enrollment không tồn tại)', async () => {
      const pt = await trainer();
      const id = await insertClass(pt.trainerId);
      const response = await http().post(`${base}/${id}/enrollments`).set('Origin', origin).send({});
      expect(response.status).toBe(404);
      expect((await snapshot())['enrollments'] ?? 0).toBe(0);
    });
  });

  describe('US-26-TC11: PT bị khóa sau khi lớp đã diễn ra', () => {
    it('US-26-TC11: account PT LOCKED và hồ sơ INACTIVE → lớp quá khứ vẫn hiển thị với tên PT, không có dữ liệu liên hệ', async () => {
      const pt = await trainer('PT Phạm Thị Dung');
      const pastDay = vnDay(-2);
      const id = await insertClass(pt.trainerId, { from: asDate('08:00', pastDay), to: asDate('09:00', pastDay) });
      await db().collection('accounts').updateOne({ _id: pt.accountId }, { $set: { status: 'LOCKED' } });
      await db().collection('trainers').updateOne({ _id: pt.trainerId }, { $set: { status: 'INACTIVE' } });
      const item = (await list({ fromDate: pastDay, toDate: pastDay }).expect(200)).body.items[0];
      expect(item).toMatchObject({ id, trainerName: 'PT Phạm Thị Dung', ended: true });
      const one = (await detail(id).expect(200)).body;
      expect(Object.keys(one).sort()).toEqual(PUBLIC_FIELDS);
      expect(JSON.stringify(one)).not.toContain(pt.phone);
    });
  });
});
