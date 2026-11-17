import 'reflect-metadata';
import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, MongoServerError, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { UsersRepository } from '../src/modules/users/users.repository';
import { AdminTrainerReviewsRepository } from '../src/modules/reviews/admin-trainer-reviews.repository';

describe('US-33 / UC-34: Admin tổng hợp review nguồn US-65', () => {
  let app: INestApplication;
  let mongo: MongoMemoryReplSet;
  let connection: Connection;
  const savedEnv = { ...process.env };
  const auth: Record<string, { token: string; id: ObjectId }> = {};
  const base = '/api/admin/trainer-reviews';
  const period = { fromDate: '2026-11-01', toDate: '2026-11-17' };
  const password = 'US33-Password-123!';
  const origin = 'http://localhost:5173';
  const db = () => connection.db!;
  const get = (path = '', role = 'ADMIN') => request(app.getHttpServer()).get(`${base}${path}`).set('Authorization', `Bearer ${auth[role].token}`);
  let ptA: ObjectId;
  let ptB: ObjectId;
  let emptyPt: ObjectId;
  let memberId: ObjectId;

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_us33', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'), SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'no-reply@gym.test' });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http');
    configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    const users = app.get(UsersRepository);
    let seq = 0;
    for (const code of ['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as const) {
      const role = await users.ensureRole(code, code);
      const phone = `090330000${++seq}`;
      const account = await users.createAccount({ roleId: String(role.id), phone, fullName: `${code} hiện tại`, passwordHash: await app.get(PasswordService).hash(password) });
      const login = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
      auth[code] = { token: login.body.accessToken, id: new ObjectId(String(account.id)) };
    }
  }, 600000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(app.get(ServerClock), 'now').mockReturnValue(new Date('2026-11-17T05:00:00Z'));
    for (const name of ['trainers', 'members', 'pt_bookings', 'trainer_reviews', 'schedule_guards']) await db().collection(name).deleteMany({});
    ptA = new ObjectId(); ptB = new ObjectId(); emptyPt = new ObjectId(); memberId = new ObjectId();
    await db().collection('trainers').insertMany([ptA, ptB, emptyPt].map((id, index) => ({
      _id: id, id, account_id: index === 0 ? auth.TRAINER.id : new ObjectId(), status: index === 1 ? 'INACTIVE' : 'ACTIVE', created_at: new Date('2026-10-01Z'),
    })));
    await db().collection('members').insertOne({ _id: memberId, id: memberId, account_id: auth.MEMBER.id, full_name: 'Tên hiện tại',
      phone: '0987654321', email: 'private@gym.test', health_profile: 'private health', service_revision: Long.ZERO });
    await db().collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = savedEnv; });

  async function booking(trainerId = ptA) {
    const id = new ObjectId();
    await db().collection('pt_bookings').insertOne({ _id: id, id, trainer_id: trainerId, member_id: memberId, membership_id: new ObjectId(),
      status: 'COMPLETED', start_at: new Date('2026-09-01T02:00:00Z'), end_at: new Date('2026-09-01T03:00:00Z'),
      completed_at: new Date('2026-09-01T03:00:00Z'), request_key: randomUUID(), version: 1, completion_revision: 1 });
    return id;
  }
  async function review(trainerId = ptA, rating: unknown = 5, createdAt = '2026-11-10T03:00:00Z', overrides: Record<string, unknown> = {}) {
    const bookingId = await booking(trainerId);
    const id = new ObjectId();
    await db().collection('trainer_reviews').insertOne({ _id: id, id, booking_id: bookingId, trainer_id: trainerId, member_id: memberId,
      created_by: auth.MEMBER.id, rating, comment: '<b>Gốc</b> https://outside.test', created_at: new Date(createdAt),
      trainer_name_snapshot: 'PT lúc gửi', member_display_name_snapshot: 'Học viên lúc gửi', ...overrides });
    return { id, bookingId };
  }

  it('TC04/05/06: trung bình có trọng số, phân bố, zero/null, PT INACTIVE, totals không phụ thuộc trang', async () => {
    await review(ptA, 5);
    for (let i = 0; i < 3; i++) await review(ptB, 1);
    const summary = (await get('/summary').query({ ...period, limit: 1, page: 2 }).expect(200)).body;
    expect(summary).toMatchObject({ total: 3, totalPages: 3, invalidReviewCount: 0,
      totals: { reviewCount: 4, ratingSum: 8, averageRating: 2, distribution: { '1': 3, '2': 0, '3': 0, '4': 0, '5': 1 } } });
    expect(summary.items).toHaveLength(1);
    const empty = (await get('/summary').query({ ...period, trainerId: String(emptyPt) }).expect(200)).body.items[0];
    expect(empty).toMatchObject({ reviewCount: 0, ratingSum: 0, averageRating: null });
    const inactive = (await get('/summary').query({ ...period, trainerId: String(ptB) }).expect(200)).body.items[0];
    expect(inactive).toMatchObject({ status: 'INACTIVE', reviewCount: 3, averageRating: 1 });
    const filtered = (await get('/summary').query({ ...period, rating: 5, page: 2, limit: 1 }).expect(200)).body;
    expect(filtered.totals).toMatchObject({ reviewCount: 1, ratingSum: 5, averageRating: 5 });
    const list = (await get().query({ ...period, rating: 1, limit: 1, page: 2 }).expect(200)).body;
    expect(list).toMatchObject({ total: 3, totalPages: 3, totals: { reviewCount: 3, ratingSum: 3, averageRating: 1 } });
    expect(list.items).toHaveLength(1);
    const beyond = (await get().query({ ...period, page: 10 }).expect(200)).body;
    expect(beyond.items).toEqual([]); expect(beyond.total).toBe(4);
  });

  it('TC01/03/09/11: nguồn thật US-65, snapshot, mã buổi, giữ text và không lộ dữ liệu riêng', async () => {
    const bookingId = await booking();
    const comment = '<img src=x onerror=alert(1)> https://outside.test';
    const created = await request(app.getHttpServer()).post(`/api/me/pt-bookings/${bookingId}/review`)
      .set('Authorization', `Bearer ${auth.MEMBER.token}`).set('Idempotency-Key', randomUUID()).send({ rating: 4, comment }).expect(201);
    await db().collection('members').updateOne({ _id: memberId }, { $set: { full_name: 'Đổi tên sau khi gửi' } });
    const listed = (await get().query(period).expect(200)).body;
    expect(listed.total).toBe(1);
    const detail = (await get(`/${created.body.id}`).expect(200)).body;
    expect(detail).toMatchObject({ id: created.body.id, comment, rating: 4, memberDisplayName: 'Tên hiện tại', trainerNameSnapshot: 'TRAINER hiện tại',
      booking: { id: String(bookingId), startAt: '2026-09-01T02:00:00.000Z' } });
    for (const text of [JSON.stringify(detail), JSON.stringify(listed)]) {
      for (const secret of ['0987654321', 'private@gym.test', 'private health', 'password_hash', 'created_by', 'account_id']) expect(text).not.toContain(secret);
    }
    expect((await get('/summary').query(period).expect(200)).body.totals).toMatchObject({ reviewCount: 1, averageRating: 4 });
    const own = await request(app.getHttpServer()).get('/api/me/trainer-reviews').query(period)
      .set('Authorization', `Bearer ${auth.TRAINER.token}`).expect(200);
    expect(own.body.summary).toEqual({ reviewCount: 1, averageRating: 4 });
    expect((await get(`/${new ObjectId()}`).expect(404)).body.error.code).toBe('NOT_FOUND');
  });

  it('TC07: loại null/sai điểm/mồ côi/sai chủ/buổi chưa hoàn tất, log ID, GET không ghi nguồn', async () => {
    await review();
    const invalid = [];
    for (const rating of [null, 0, 6, 1.5, '5']) invalid.push(await review(ptA, rating));
    invalid.push(await review(ptA, 5, undefined, { booking_id: new ObjectId() }));
    invalid.push(await review(ptA, 5, undefined, { trainer_id: new ObjectId() }));
    invalid.push(await review(ptA, 5, undefined, { member_id: new ObjectId() }));
    const notCompleted = await review(); invalid.push(notCompleted);
    await db().collection('pt_bookings').updateOne({ _id: notCompleted.bookingId }, { $set: { status: 'BOOKED' } });
    const before = await db().collection('trainer_reviews').find().toArray();
    const summary = (await get('/summary').query(period).expect(200)).body;
    const listed = (await get().query(period).expect(200)).body;
    for (const result of [summary, listed]) {
      expect(result.invalidReviewCount).toBe(invalid.length);
      expect(result.totals).toMatchObject({ reviewCount: 1, ratingSum: 5, distribution: { '5': 1 } });
    }
    for (const row of invalid) expect(Logger.prototype.warn).toHaveBeenCalledWith({ code: 'INVALID_TRAINER_REVIEW', reviewId: String(row.id) });
    await get(`/${invalid[0].id}`).expect(404);
    expect(await db().collection('trainer_reviews').find().toArray()).toEqual(before);
  });

  it('TC03/08: biên ngày Việt Nam, ngày gửi khác ngày buổi, mặc định 30 ngày và sort id', async () => {
    const before = await review(ptA, 5, '2026-10-31T16:59:59.999Z');
    const first = await review(ptA, 2, '2026-10-31T17:00:00Z');
    const last = await review(ptA, 4, '2026-11-01T16:59:59.999Z');
    const equal = await review(ptA, 3, '2026-11-01T16:59:59.999Z');
    await review(ptA, 1, '2026-11-01T17:00:00Z');
    const list = (await get().query({ fromDate: '2026-11-01', toDate: '2026-11-01' }).expect(200)).body;
    expect(list.items.map((item: { id: string }) => item.id)).toEqual([String(equal.id), String(last.id), String(first.id)]);
    expect(list.totals.reviewCount).toBe(3);
    expect(list.items.map((item: { id: string }) => item.id)).not.toContain(String(before.id));
    expect((await get('/summary').expect(200)).body.range).toEqual({ fromDate: '2026-10-19', toDate: '2026-11-17' });
  });

  it.each([
    { fromDate: '2026-02-30' }, { toDate: '2026-11-01T00:00:00Z' }, { fromDate: '2026-11-03', toDate: '2026-11-01' },
    { fromDate: '2025-01-01', toDate: '2026-01-02' }, { trainerId: 'bad-id' }, { rating: 6 }, { rating: '1.5' },
    { rating: '' }, { page: 0 }, { limit: 101 }, { page: Number.MAX_SAFE_INTEGER }, { author: 'fake' }, { ownerId: String(new ObjectId()) },
  ])('TC08/10: filter sai hoặc ngoài allowlist → 400: %j', async query => {
    for (const path of ['', '/summary']) {
      const result = await get(path).query(query).expect(400);
      expect(result.body).toMatchObject({ error: { code: expect.any(String) }, requestId: expect.any(String) });
    }
  });

  it('TC10: detail chặn query giả author/rating, ID sai, không PATCH/DELETE', async () => {
    const row = await review();
    await get(`/${row.id}`).query({ author: 'fake', rating: 1 }).expect(400);
    await get('/bad-id').expect(400);
    for (const method of ['patch', 'delete'] as const) await request(app.getHttpServer())[method](`${base}/${row.id}`)
      .set('Authorization', `Bearer ${auth.ADMIN.token}`).send({ rating: 1 }).expect(404);
    expect((await get(`/${row.id}`).expect(200)).body.rating).toBe(5);
  });

  it.each(['STAFF', 'TRAINER', 'MEMBER'])('TC02: %s bị chặn 403 trên cả ba route', async role => {
    for (const path of ['', '/summary', `/${new ObjectId()}`]) await get(path, role).expect(403);
  });

  it('TC02: phiên hết hiệu lực, account LOCKED, session thu hồi → 401 mỗi request', async () => {
    const account = await db().collection('accounts').findOne({ _id: auth.ADMIN.id });
    for (const change of [{ status: 'LOCKED' }, { auth_version: Number(account!.auth_version) + 1 }]) {
      await db().collection('accounts').updateOne({ _id: auth.ADMIN.id }, { $set: change });
      for (const path of ['', '/summary', `/${new ObjectId()}`]) await get(path).expect(401);
      await db().collection('accounts').updateOne({ _id: auth.ADMIN.id }, { $set: { status: account!.status, auth_version: account!.auth_version } });
    }
    const sessions = await db().collection('auth_sessions').find({ account_id: auth.ADMIN.id }).toArray();
    await db().collection('auth_sessions').deleteMany({ account_id: auth.ADMIN.id });
    try { for (const path of ['', '/summary', `/${new ObjectId()}`]) await get(path).expect(401); }
    finally { if (sessions.length) await db().collection('auth_sessions').insertMany(sessions); }
    await request(app.getHttpServer()).get(base).expect(401);
  });

  it('TC12: lỗi MongoDB trả 503 envelope, không lộ lỗi thô hoặc giả tổng bằng 0', async () => {
    jest.spyOn(app.get(AdminTrainerReviewsRepository), 'page').mockRejectedValueOnce(new MongoServerError({ message: 'private database diagnostic' }));
    const result = await get('/summary').expect(503);
    expect(result.body).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' }, requestId: expect.any(String) });
    expect(JSON.stringify(result.body)).not.toContain('private database diagnostic');
    await get('/summary').expect(200);
  });

  it('snapshot: đổi nguồn giữa hai lệnh đọc không làm lệch PT/items/totals trong response', async () => {
    await review();
    const repository = app.get(AdminTrainerReviewsRepository);
    const original = repository.page.bind(repository);
    jest.spyOn(repository, 'page').mockImplementationOnce(async (...args) => {
      const data = await original(...args);
      await db().collection('trainers').deleteOne({ _id: ptA });
      return data;
    });
    const body = (await get('/summary').query(period).expect(200)).body;
    expect(body.total).toBe(3);
    expect(body.items.find((item: { trainerId: string }) => item.trainerId === String(ptA))).toMatchObject({ reviewCount: 1, averageRating: 5 });
    expect(body.totals.reviewCount).toBe(1);
  });

  it('index kỳ toàn phòng được tạo bên cạnh unique booking và index theo PT', async () => {
    const indexes = await db().collection('trainer_reviews').indexes();
    expect(indexes.find(index => index.name === 'trainer_reviews_time')?.key).toEqual({ created_at: 1, _id: 1 });
    expect(indexes.find(index => index.name === 'trainer_reviews_booking_unique')?.unique).toBe(true);
  });
});
