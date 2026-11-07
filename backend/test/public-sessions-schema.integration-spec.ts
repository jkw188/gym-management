// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ): US-26 bước 2.
// Kiểm tra schema và index của public_sessions theo bảng "Dữ liệu hoặc index" của spec (TC01, TC05–TC08, TC10).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model } from 'mongoose';
import { randomBytes } from 'node:crypto';
// Hợp đồng test đặt ra cho Builder (US-26 bước 2):
//   Có model Mongoose cho collection 'public_sessions' (tên model tùy Builder; test tìm theo tên collection).
//   Field theo mục 4.2.17 + US-66: id = _id (unique), trainer_id, title (≤120), subject_code (enum taxonomy S04),
//   location (≤120), start_at, end_at, status (DRAFT/PUBLISHED/CANCELLED), version ≥ 0, created_by, updated_by,
//   published_at?, cancelled_at?, cancelled_by?, cancellation_reason?, created_at/updated_at do server ghi.
//   Index: (status,start_at,_id), (status,subject_code,start_at), (trainer_id,status,start_at,end_at).
//   S04 không có sức chứa/đăng ký chỗ: không có field capacity/enrolled… và không có collection enrollment.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us26_schema';

type IndexInfo = { key: Record<string, number>; unique?: boolean };

describe('US-26 bước 2: schema và index của public_sessions', () => {
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
    // Chờ Mongoose tạo xong index của mọi model trước khi kiểm.
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    // Chỉ xóa dữ liệu, giữ index (unique index phải còn để test có ý nghĩa).
    for (const collection of await connection.db!.collections()) await collection.deleteMany({});
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;

  // Tìm model Mongoose theo tên collection, không phụ thuộc tên class Builder đặt.
  function sessions(): Model<any> {
    const found = Object.values(connection.models).find(model => model.collection.collectionName === 'public_sessions');
    if (!found) throw new Error('Chưa có model Mongoose cho collection public_sessions');
    return found;
  }

  async function indexes(): Promise<IndexInfo[]> {
    return (await db().collection('public_sessions').listIndexes().toArray()) as unknown as IndexInfo[];
  }
  const hasIndex = (list: IndexInfo[], key: Record<string, number>, unique: boolean) =>
    list.some(index => JSON.stringify(index.key) === JSON.stringify(key) && Boolean(index.unique) === unique);

  function validSession(overrides: Record<string, unknown> = {}) {
    const admin = new ObjectId();
    return {
      trainer_id: new ObjectId(),
      title: 'Yoga buổi sáng',
      subject_code: 'YOGA',
      location: 'Phòng 1',
      start_at: new Date('2026-12-01T01:00:00.000Z'),
      end_at: new Date('2026-12-01T02:00:00.000Z'),
      status: 'PUBLISHED',
      version: 1,
      created_by: admin,
      updated_by: admin,
      published_at: new Date('2026-11-07T03:00:00.000Z'),
      ...overrides,
    };
  }

  // Tìm trong cây kế hoạch của explain: có bước nào quét cả collection (COLLSCAN) không.
  function stages(plan: unknown): string[] {
    if (!plan || typeof plan !== 'object') return [];
    const node = plan as Record<string, unknown>;
    const own = typeof node.stage === 'string' ? [node.stage] : [];
    const children = [node.inputStage, ...((node.inputStages as unknown[]) ?? [])];
    return [...own, ...children.flatMap(stages)];
  }

  // ---------- TC01: lưu lớp đủ field ----------
  describe('US-26-TC01: lưu lớp đã công bố đủ field', () => {
    it('US-26-TC01: lưu được lớp PUBLISHED, id bằng _id, có created_at và updated_at do server ghi', async () => {
      const created = await sessions().create(validSession());
      const raw = await db().collection('public_sessions').findOne({ _id: created._id });
      expect(raw).toMatchObject({ title: 'Yoga buổi sáng', subject_code: 'YOGA', location: 'Phòng 1', status: 'PUBLISHED', version: 1 });
      expect(raw!.id.equals(raw!._id)).toBe(true);
      expect(raw!.created_at).toBeInstanceOf(Date);
      expect(raw!.updated_at).toBeInstanceOf(Date);
      expect(raw!.start_at.toISOString()).toBe('2026-12-01T01:00:00.000Z');
    });

    it('US-26-TC01: lớp CANCELLED lưu được thời điểm, người hủy và lý do', async () => {
      const admin = new ObjectId();
      const created = await sessions().create(validSession({
        status: 'CANCELLED', cancelled_at: new Date('2026-11-07T04:00:00.000Z'), cancelled_by: admin, cancellation_reason: 'PT ốm',
      }));
      const raw = await db().collection('public_sessions').findOne({ _id: created._id });
      expect(raw).toMatchObject({ status: 'CANCELLED', cancellation_reason: 'PT ốm' });
      expect(raw!.cancelled_by.equals(admin)).toBe(true);
    });

    it('US-26-TC01: thiếu field bắt buộc (title, trainer_id, subject_code, start_at, end_at) bị từ chối', async () => {
      for (const field of ['title', 'trainer_id', 'subject_code', 'start_at', 'end_at']) {
        const data = validSession();
        delete (data as Record<string, unknown>)[field];
        await expect(sessions().create(data)).rejects.toThrow();
      }
      expect(await db().collection('public_sessions').countDocuments()).toBe(0);
    });

    it('US-26-TC01: id trùng bị unique index chặn', async () => {
      const id = new ObjectId();
      await db().collection('public_sessions').insertOne({ _id: id, id, ...validSession() });
      await expect(db().collection('public_sessions').insertOne({ _id: new ObjectId(), id, ...validSession() })).rejects.toThrow();
    });
  });

  // ---------- TC05, TC06: index cho lịch công khai ----------
  describe('US-26-TC05: index phục vụ lọc lịch', () => {
    it('US-26-TC05: có index unique của id', async () => {
      expect(hasIndex(await indexes(), { id: 1 }, true)).toBe(true);
    });

    it('US-26-TC05: có index (status, start_at, _id) để lọc PUBLISHED theo giờ và phân trang ổn định', async () => {
      expect(hasIndex(await indexes(), { status: 1, start_at: 1, _id: 1 }, false)).toBe(true);
    });

    it('US-26-TC05: có index (status, subject_code, start_at) để lọc theo bộ môn', async () => {
      expect(hasIndex(await indexes(), { status: 1, subject_code: 1, start_at: 1 }, false)).toBe(true);
    });

    it('US-26-TC05: có index (trainer_id, status, start_at, end_at) để lọc theo PT', async () => {
      expect(hasIndex(await indexes(), { trainer_id: 1, status: 1, start_at: 1, end_at: 1 }, false)).toBe(true);
    });

    it('US-26-TC06: truy vấn lịch theo khoảng ngày (giao khoảng, sắp start_at rồi _id) dùng index, không quét cả collection', async () => {
      const docs = Array.from({ length: 200 }, (_, index) => {
        const id = new ObjectId();
        const start = new Date(Date.UTC(2026, 11, 1 + (index % 60), 1));
        return { _id: id, id, ...validSession({ start_at: start, end_at: new Date(start.getTime() + 3600000), status: index % 3 ? 'PUBLISHED' : 'DRAFT' }) };
      });
      await db().collection('public_sessions').insertMany(docs);
      const explain = await db().collection('public_sessions')
        .find({ status: 'PUBLISHED', start_at: { $lt: new Date('2026-12-08T17:00:00.000Z') }, end_at: { $gt: new Date('2026-12-01T17:00:00.000Z') } })
        .sort({ start_at: 1, _id: 1 }).limit(20).explain('queryPlanner');
      const winning = (explain as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan;
      const used = stages(winning);
      expect(used).toContain('IXSCAN');
      expect(used).not.toContain('COLLSCAN');
    });
  });

  // ---------- TC07: enum bộ môn và trạng thái ----------
  describe('US-26-TC07: enum bộ môn và trạng thái', () => {
    it('US-26-TC07: subject_code chỉ nhận YOGA/AEROBICS/ZUMBA/FUNCTIONAL/OTHER', async () => {
      for (const code of ['YOGA', 'AEROBICS', 'ZUMBA', 'FUNCTIONAL', 'OTHER']) {
        await expect(sessions().create(validSession({ subject_code: code }))).resolves.toBeDefined();
      }
      await expect(sessions().create(validSession({ subject_code: 'BOXING' }))).rejects.toThrow();
      await expect(sessions().create(validSession({ subject_code: 'yoga' }))).rejects.toThrow();
      expect(await db().collection('public_sessions').countDocuments({ subject_code: { $in: ['BOXING', 'yoga'] } })).toBe(0);
    });

    it('US-26-TC07: status chỉ nhận DRAFT/PUBLISHED/CANCELLED', async () => {
      for (const status of ['DRAFT', 'PUBLISHED', 'CANCELLED']) {
        await expect(sessions().create(validSession({ status }))).resolves.toBeDefined();
      }
      await expect(sessions().create(validSession({ status: 'COMPLETED' }))).rejects.toThrow();
      expect(await db().collection('public_sessions').countDocuments({ status: 'COMPLETED' })).toBe(0);
    });

    it('US-26-TC07: version không được âm', async () => {
      await expect(sessions().create(validSession({ version: -1 }))).rejects.toThrow();
    });
  });

  // ---------- TC08: độ dài text do Admin nhập ----------
  describe('US-26-TC08: title và location là text có giới hạn', () => {
    it('US-26-TC08: title và location đúng 120 ký tự lưu được, 121 ký tự bị từ chối', async () => {
      await expect(sessions().create(validSession({ title: 'a'.repeat(120), location: 'b'.repeat(120) }))).resolves.toBeDefined();
      await expect(sessions().create(validSession({ title: 'a'.repeat(121) }))).rejects.toThrow();
      await expect(sessions().create(validSession({ location: 'b'.repeat(121) }))).rejects.toThrow();
    });

    it('US-26-TC08: title có markup được lưu nguyên văn dạng text', async () => {
      const title = '<script>alert(1)</script> Yoga & <b>Thiền</b>';
      const created = await sessions().create(validSession({ title }));
      expect((await db().collection('public_sessions').findOne({ _id: created._id }))!.title).toBe(title);
    });
  });

  // ---------- TC10: không có nghiệp vụ đăng ký chỗ ở S04 ----------
  describe('US-26-TC10: không có sức chứa hay đăng ký chỗ', () => {
    it('US-26-TC10: field capacity / enrolled_count / member_ids không có trong schema (bị từ chối, không lưu)', async () => {
      for (const extra of [{ capacity: 20 }, { enrolled_count: 0 }, { member_ids: [new ObjectId()] }]) {
        await expect(sessions().create(validSession(extra))).rejects.toThrow();
      }
      expect(await db().collection('public_sessions').countDocuments()).toBe(0);
    });

    it('US-26-TC10: không có model nào cho collection đăng ký lớp', () => {
      const names = Object.values(connection.models).map(model => model.collection.collectionName);
      expect(names.filter(name => /enroll|registration|attendance/i.test(name))).toEqual([]);
    });
  });
});
