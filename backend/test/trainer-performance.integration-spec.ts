import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken } from '@nestjs/mongoose';
import { Document, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { UsersRepository } from '../src/modules/users/users.repository';
import { TrainerPerformanceRepository } from '../src/modules/reports/trainer-performance.repository';

describe('US-52 / UC-38 / S08-P01: real MongoDB snapshot and JWT', () => {
  let mongo: MongoMemoryReplSet, app: INestApplication, connection: Connection;
  const savedEnv = { ...process.env }, auth: Record<string, { token: string; id: ObjectId }> = {};
  const observedAt = '2026-11-18T05:00:00.000Z', base = '/api/reports/trainers';
  const db = () => connection.db!;
  const get = (path = '/performance', role = 'ADMIN') => request(app.getHttpServer()).get(base + path).set('Authorization', `Bearer ${auth[role].token}`);
  const at = (time: string, date = '2026-11-02') => new Date(`${date}T${time}:00+07:00`);
  let trainer: ObjectId, member: ObjectId, first: ObjectId, second: ObjectId;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: 'http://localhost:5173',
      MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_us52', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'), SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'test@gym.test' });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app); await app.init(); connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(m => m.init()));
    const users = app.get(UsersRepository), password = 'US52-Password-123!';
    const hash = await app.get(PasswordService).hash(password);
    let n = 0;
    for (const roleCode of ['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as const) {
      const role = await users.ensureRole(roleCode, roleCode);
      const account = await users.createAccount({ roleId: String(role.id), fullName: `US52 ${roleCode}`, phone: `098520000${++n}`, passwordHash: hash });
      const response = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', 'http://localhost:5173').send({ phone: account.phone, password }).expect(200);
      auth[roleCode] = { token: response.body.accessToken, id: new ObjectId(String(account.id)) };
    }
  }, 600000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(ServerClock.prototype, 'now').mockReturnValue(new Date(observedAt));
    for (const name of ['trainers', 'work_shifts', 'trainer_attendance', 'pt_bookings', 'trainer_reviews', 'members', 'memberships']) await db().collection(name).deleteMany({});
    trainer = new ObjectId(); member = new ObjectId();
    await db().collection('trainers').insertOne({ _id: trainer, account_id: auth.TRAINER.id, status: 'INACTIVE' });
    await db().collection('members').insertOne({ _id: member });
    first = await shift('08:00', '10:00'); second = await shift('10:00', '12:00');
    await booking(first, '08:00', '09:00'); await booking(second, '10:00', '11:00');
    await attendance(first, '07:50', '10:10'); await attendance(second, '10:00');
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = savedEnv; });
  async function shift(start: string, end: string, patch: Document = {}) {
    const _id = new ObjectId(); await db().collection('work_shifts').insertOne({ _id, id: _id, trainer_id: trainer,
      start_at: at(start), end_at: at(end), status: 'CONFIRMED', created_at: at('00:00'), ...patch }); return _id;
  }
  async function booking(shiftId: ObjectId, start: string, end: string, patch: Document = {}) {
    const _id = new ObjectId(); await db().collection('pt_bookings').insertOne({ _id, id: _id, trainer_id: trainer, member_id: member,
      request_key: String(_id), shift_id: shiftId, start_at: at(start), end_at: at(end), status: 'COMPLETED', completed_at: at('13:00'), completed_by: auth.TRAINER.id,
      created_at: at('00:00'), ...patch }); return _id;
  }
  async function attendance(shiftId: ObjectId, start: string, end?: string, patch: Document = {}) {
    const _id = new ObjectId(); await db().collection('trainer_attendance').insertOne({ _id, id: _id, shift_id: shiftId, trainer_id: trainer,
      check_in_at: at(start), ...(end ? { check_out_at: at(end) } : {}), recorded_by: auth.ADMIN.id, created_at: at('07:00'), ...patch }); return _id;
  }
  it('TC01/02/04: 240/120=50%, known140/open1, completedShift0; BOOKED and carried usage excluded', async () => {
    await booking(first, '09:00', '10:00', { status: 'BOOKED' });
    await db().collection('memberships').insertMany([1, 2].map(n => ({ _id: new ObjectId(), service_sale_id: new ObjectId(), sessions_used: 99 * n })));
    const result = (await get().expect(200)).body;
    expect(result).toMatchObject({ metricVersion: 'S08-V1', observedAt, total: 1, dataQuality: 'PARTIAL', totals: {
      plannedMilliseconds: '14400000', plannedMinutes: '240', completedBookingMilliseconds: '7200000', completedBookingMinutes: '120',
      knownActualMilliseconds: '8400000', actualTotalMilliseconds: null, completedShiftMilliseconds: '0', utilizationRate: 50,
      completedBookingCount: 2, openCount: 1, missingCount: 0, reviewCount: 0, averageRating: null } });
    expect(result.items[0].status).toBe('INACTIVE');
    const oracle = require('./helpers/en08-report-oracle.cjs') as { trainerOracle: (s: Record<string, Document[]>, f: string, t: string, o: string) => { rows: Record<string, unknown>[]; totals: Record<string, unknown> } };
    const committed: Record<string, Document[]> = {};
    for (const name of ['trainers', 'work_shifts', 'pt_bookings', 'trainer_attendance', 'trainer_reviews']) committed[name] = await db().collection(name).find().toArray();
    const expected = oracle.trainerOracle(JSON.parse(JSON.stringify(committed)), '2026-11-01', '2026-11-18', observedAt);
    for (const field of ['plannedMilliseconds', 'completedBookingMilliseconds', 'knownActualMilliseconds', 'actualTotalMilliseconds', 'completedShiftMilliseconds',
      'utilizationRate', 'completedBookingCount', 'missingCount', 'openCount', 'reviewCount', 'averageRating']) expect(result.items[0].summary[field]).toEqual(expected.rows[0][field]);
    expect(result.totals.utilizationRate).toBe(expected.totals.utilizationRate);
  });
  it('TC03/05: late completion uses booking interval, reviews use submission date of a booking outside W', async () => {
    const old = await booking(first, '08:00', '09:00', { start_at: at('08:00', '2026-10-20'), end_at: at('09:00', '2026-10-20'), completed_at: at('15:00', '2026-11-10') });
    await db().collection('trainer_reviews').insertOne({ _id: new ObjectId(), booking_id: old, trainer_id: trainer, member_id: member, rating: 4, created_at: at('14:00'), created_by: auth.MEMBER.id });
    const nov = (await get(`/${trainer}/performance`).expect(200)).body;
    expect(nov.summary).toMatchObject({ completedBookingCount: 2, reviewCount: 1, averageRating: 4, ratingDistribution: { '4': 1 } });
    expect(nov.sourcePages.reviews.items[0].bookingId).toBe(String(old));
    expect(nov.sourcePages.reviews.items[0].sourceLink).toBe(`/api/admin/trainer-reviews/${nov.sourcePages.reviews.items[0].id}`);
    const oct = (await get(`/${trainer}/performance`).query({ fromDate: '2026-10-20', toDate: '2026-10-20' }).expect(200)).body;
    expect(oct.summary.completedBookingCount).toBe(1); expect(oct.sourcePages.bookings.items[0].completedAt).toBe(at('15:00', '2026-11-10').toISOString());
  });
  it('TC06: selects intersecting sources even when starting before W; half-open boundaries excluded', async () => {
    await shift('23:00', '01:00', { start_at: at('23:00', '2026-10-31'), end_at: at('01:00', '2026-11-01') });
    await shift('22:00', '00:00', { start_at: at('22:00', '2026-10-31'), end_at: at('00:00', '2026-11-01') });
    await shift('00:00', '01:00', { start_at: at('00:00', '2026-11-02'), end_at: at('01:00', '2026-11-02') });
    const body = (await get(`/${trainer}/performance`).query({ fromDate: '2026-11-01', toDate: '2026-11-01' }).expect(200)).body;
    expect(body.summary).toMatchObject({ plannedMilliseconds: '3600000', shiftCount: 1 });
    expect(body.sourcePages.shifts.items[0]).toMatchObject({ rawMilliseconds: '7200000', clippedMilliseconds: '3600000' });
  });
  it('TC07: union avoids duplicate hours but reports overlapping shifts/bookings and null rate', async () => {
    await shift('09:00', '11:00'); await booking(first, '08:30', '09:30');
    const body = (await get().expect(200)).body;
    expect(body.totals).toMatchObject({ plannedMinutes: '240', completedBookingMinutes: '150', overlappingShiftCount: 2, overlappingBookingCount: 1,
      utilizationRate: null, utilizationStatus: 'DATA_INCONSISTENT' });
    expect(body.warningCodes).toContain('OVERLAPPING_SHIFTS');
    expect(body.warningCodes).toContain('OVERLAPPING_BOOKINGS');
    const detail = (await get(`/${trainer}/performance`).expect(200)).body;
    expect(detail.sourcePages.shifts.items.every((s: { dataIssue: string[] }) => s.dataIssue.includes('OVERLAPPING_SHIFTS'))).toBe(true);
    expect(detail.sourcePages.bookings.items.filter((s: { dataIssue: string[] }) => s.dataIssue.includes('OVERLAPPING_BOOKINGS'))).toHaveLength(2);
  });
  it('TC08/12: per-trainer capacity, weighted total25%, pagination does not change totals or multiply reviews', async () => {
    await db().collection('work_shifts').deleteMany({}); await db().collection('pt_bookings').deleteMany({}); await db().collection('trainer_attendance').deleteMany({});
    const s = await shift('08:00', '09:00'); await booking(s, '08:00', '09:00');
    const other = new ObjectId(); await db().collection('trainers').insertOne({ _id: other, account_id: auth.MEMBER.id, status: 'ACTIVE' });
    await shift('08:00', '11:00', { trainer_id: other });
    const body = (await get().query({ limit: 1, page: 2 }).expect(200)).body;
    expect(body).toMatchObject({ total: 2, totalPages: 2, totals: { plannedMinutes: '240', completedBookingMinutes: '60', utilizationRate: 25 } });
    expect(body.items).toHaveLength(1);
    expect((await get().query({ trainerId: String(trainer) }).expect(200)).body.totals.utilizationRate).toBe(100);
    expect((await get().query({ q: ' .* ' }).expect(200)).body).toMatchObject({ total: 0, totalPages: 0, filter: { q: '.*' }, totals: { utilizationRate: 25 } });
  });
  it('TC09: missing/open/closed retain absence; actual union includes overtime outside planned shift', async () => {
    await db().collection('trainer_attendance').deleteOne({ shift_id: second });
    expect((await get().expect(200)).body.totals).toMatchObject({ knownActualMinutes: '140', actualTotalMinutes: null, missingCount: 1, openCount: 0 });
    await attendance(second, '10:00', '12:30');
    expect((await get().expect(200)).body.totals).toMatchObject({ knownActualMinutes: '280', actualTotalMinutes: '280', missingCount: 0, openCount: 0 });
    await db().collection('work_shifts').updateOne({ _id: first }, { $set: { status: 'COMPLETED' } });
    expect((await get().expect(200)).body.totals.completedShiftMinutes).toBe('120');
    const outside = await shift('22:00', '23:59', { start_at: at('22:00', '2026-10-31'), end_at: at('23:59', '2026-10-31') });
    await attendance(outside, '22:00', '01:00', { check_in_at: at('22:00', '2026-10-31'), check_out_at: at('01:00', '2026-11-01') });
    expect((await get().query({ fromDate: '2026-11-01', toDate: '2026-11-01' }).expect(200)).body.totals)
      .toMatchObject({ plannedMinutes: '0', actualTotalMinutes: '60', knownActualMinutes: '60' });
  });
  it('TC10: zero denominator and current period cap at one observedAt; never computes future hours', async () => {
    expect((await get().query({ fromDate: '2026-09-01', toDate: '2026-09-01' }).expect(200)).body.totals)
      .toMatchObject({ plannedMinutes: '0', utilizationRate: null, utilizationStatus: 'NOT_APPLICABLE' });
    await shift('11:00', '14:00', { start_at: at('11:00', '2026-11-18'), end_at: at('14:00', '2026-11-18') });
    await shift('14:00', '16:00', { start_at: at('14:00', '2026-11-18'), end_at: at('16:00', '2026-11-18') });
    const today = (await get().query({ fromDate: '2026-11-18' }).expect(200)).body;
    expect(today.range.effectiveTo).toBe(observedAt); expect(today.totals.plannedMinutes).toBe('60');
  });
  it('TC13: orphan, cancelled attendance and invalid timestamps are issues, never repaired in GET', async () => {
    const missingTrainer = new ObjectId();
    await booking(new ObjectId(), '08:00', '09:00', { trainer_id: missingTrainer });
    await attendance(new ObjectId(), '08:00', '09:00');
    await db().collection('work_shifts').updateOne({ _id: second }, { $set: { status: 'CANCELLED' } });
    await shift('15:00', '16:00', { start_at: 'not-a-date' });
    const body = (await get().expect(200)).body;
    expect(body.total).toBe(2); expect(body.totals.plannedMilliseconds).toBeNull(); expect(body.totals.utilizationRate).toBeNull();
    expect(body.warningCodes).toEqual(expect.arrayContaining(['TRAINER_MISSING', 'BOOKING_SHIFT_INVALID', 'ATTENDANCE_SOURCE_INVALID', 'SHIFT_INTERVAL_INVALID']));
    const detail = (await get(`/${missingTrainer}/performance`).expect(200)).body;
    expect(detail.sourcePages.bookings.total).toBe(1);
  });
  it('TC12: independent source pagination, safe projection and deterministic time/id order', async () => {
    for (let i = 0; i < 5; i++) await shift('15:00', '16:00');
    const body = (await get(`/${trainer}/performance`).query({ limit: 1, shiftPage: 2 }).expect(200)).body;
    expect(body.sourcePages.shifts).toMatchObject({ page: 2, limit: 1, total: 7, totalPages: 7 });
    expect(body.sourcePages.bookings).toMatchObject({ page: 1, total: 2 });
    expect(body.sourcePages.attendance).toMatchObject({ total: 2 });
    expect(body.summary.shiftCount).toBe(7);
    expect(JSON.stringify(body)).not.toMatch(/phone|password|request_key|health|bank/i);
    const bookingSource = body.sourcePages.bookings.items[0];
    expect(bookingSource.sourceLink).toBe(`/api/admin/pt-bookings/${bookingSource.id}`);
    await request(app.getHttpServer()).get(bookingSource.sourceLink).set('Authorization', `Bearer ${auth.STAFF.token}`).expect(403);
  });
  it.each([{ fromDate: '2026-02-30' }, { toDate: '2026-11-19' }, { fromDate: '2026-11-10', toDate: '2026-11-01' },
    { fromDate: '2025-01-01' }, { trainerId: 'invalid' }, { unknown: 'ignored?' }, { page: '1.5' }, { limit: 101 }, { q: 'x'.repeat(121) }])('validates allowlist and filters %j', async query => {
    await get().query(query).expect(400);
  });
  it('TC11: JWT/roles, account ACTIVE, auth_version, revoked and expired session enforced for both routes', async () => {
    for (const path of ['/performance', `/${trainer}/performance`]) {
      for (const role of ['STAFF', 'TRAINER', 'MEMBER']) await get(path, role).expect(403);
      await request(app.getHttpServer()).get(base + path).expect(401);
    }
    await db().collection('accounts').updateOne({ _id: auth.ADMIN.id }, { $set: { status: 'LOCKED' } });
    await get().expect(401); await db().collection('accounts').updateOne({ _id: auth.ADMIN.id }, { $set: { status: 'ACTIVE' } });
    await db().collection('accounts').updateOne({ _id: auth.ADMIN.id }, { $inc: { auth_version: 1 } }); await get().expect(401);
    await db().collection('accounts').updateOne({ _id: auth.ADMIN.id }, { $inc: { auth_version: -1 } });
    await db().collection('auth_sessions').updateMany({ account_id: auth.ADMIN.id }, { $set: { revoked_at: new Date() } }); await get().expect(401);
    await db().collection('auth_sessions').updateMany({ account_id: auth.ADMIN.id }, { $unset: { revoked_at: '' } });
    const payload = JSON.parse(Buffer.from(auth.ADMIN.token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const expired = new JwtService().sign({ ...payload, exp: Math.floor(Date.now() / 1000) - 1 }, { secret: process.env.JWT_ACCESS_SECRET });
    for (const path of ['/performance', `/${trainer}/performance`])
      await request(app.getHttpServer()).get(base + path).set('Authorization', `Bearer ${expired}`).expect(401);
    await get('/invalid/performance').expect(400); await get(`/${new ObjectId()}/performance`).expect(404);
    await get(`/${trainer}/performance`).query({ reviewPage: 0 }).expect(400);
    await get(`/${trainer}/performance`).query({ trainerId: String(trainer) }).expect(400);
    expect((await get(`/${String(trainer).toUpperCase()}/performance`).expect(200)).body.trainer.id).toBe(String(trainer));
  });
  it('TC14/15: shared snapshot survives a concurrent completion commit and refresh gets new committed status', async () => {
    // Force a commit after the first real snapshot read using a monitored cursor (not a mocked report).
    const collection = db().collection('trainers'), originalFind = collection.find.bind(collection);
    const originalCollection = db().collection.bind(db());
    const spy = jest.spyOn(db(), 'collection').mockImplementation((...args: Parameters<typeof originalCollection>) => {
      if (args[0] !== 'trainers') return originalCollection(...args);
      const proxy = Object.create(collection) as typeof collection;
      proxy.find = ((...findArgs: Parameters<typeof originalFind>) => {
        const cursor = originalFind(...findArgs), originalToArray = cursor.toArray.bind(cursor);
        cursor.toArray = async () => { const rows = await originalToArray();
          await originalCollection('pt_bookings').updateMany({}, { $set: { status: 'BOOKED' } }); return rows; };
        return cursor;
      }) as typeof collection.find;
      return proxy;
    });
    const body = (await get(`/${trainer}/performance`).expect(200)).body;
    expect(body.summary.completedBookingCount).toBe(2); expect(body.sourcePages.bookings.total).toBe(2);
    spy.mockRestore(); jest.mocked(ServerClock.prototype.now).mockReturnValue(new Date('2026-11-18T05:01:00Z'));
    const refreshed = (await get().expect(200)).body;
    expect(refreshed.totals.completedBookingCount).toBe(0); expect(refreshed.observedAt).not.toBe(body.observedAt);
  });
  it('TC15: repeated GET never writes business sources; infrastructure failures return sanitized503', async () => {
    const read = async () => { const values = []; for (const name of ['work_shifts', 'pt_bookings', 'trainer_attendance', 'trainer_reviews', 'memberships']) values.push(await db().collection(name).find().toArray()); return values; };
    const before = await read(); await get().expect(200); await get(`/${trainer}/performance`).expect(200); await get().expect(200);
    expect(await read()).toEqual(before);
    const error = new Error('mongodb://private-secret'); error.name = 'MongoNetworkError';
    jest.spyOn(app.get(TrainerPerformanceRepository), 'sources').mockRejectedValueOnce(error);
    const response = await get().expect(503);
    expect(response.body).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' }, requestId: expect.any(String) });
    expect(response.body.totals).toBeUndefined(); expect(JSON.stringify(response.body)).not.toContain('private-secret');
  });
  it('TC08/13: weighted review average and invalid review timestamp/rating never become a zero or NaN', async () => {
    const ownBooking = await db().collection('pt_bookings').findOne({ trainer_id: trainer });
    await db().collection('trainer_reviews').insertOne({ _id: new ObjectId(), id: new ObjectId(), booking_id: ownBooking!._id,
      trainer_id: trainer, member_id: member, rating: 5, created_at: at('14:00') });
    const other = new ObjectId(); await db().collection('trainers').insertOne({ _id: other, account_id: auth.MEMBER.id, status: 'ACTIVE' });
    for (let i = 0; i < 3; i++) {
      const b = await booking(first, '15:00', '16:00', { trainer_id: other });
      await db().collection('trainer_reviews').insertOne({ _id: new ObjectId(), id: new ObjectId(), booking_id: b,
        trainer_id: other, member_id: member, rating: 1, created_at: at('14:00') });
    }
    expect((await get().expect(200)).body.totals).toMatchObject({ reviewCount: 4, averageRating: 2, ratingDistribution: { '1': 3, '5': 1 } });
    await db().collection('trainer_reviews').updateOne({ trainer_id: trainer }, { $set: { created_at: 'invalid', rating: 99 } });
    const bad = (await get().expect(200)).body;
    expect(bad.totals).toMatchObject({ reviewCount: null, averageRating: null, ratingDistribution: null, knownReviewCount: 3 });
    expect(bad.warningCodes).toEqual(expect.arrayContaining(['REVIEW_TIMESTAMP_INVALID', 'REVIEW_RATING_INVALID']));
  });
  it('source indexes and Swagger expose the read contract; getMore retains all sources before page slicing', async () => {
    const docs = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body;
    expect(docs.paths['/api/reports/trainers/performance'].get.responses['200']).toBeTruthy();
    expect(docs.paths['/api/reports/trainers/{id}/performance'].get.parameters.map((p: { name: string }) => p.name))
      .toEqual(expect.arrayContaining(['shiftPage', 'attendancePage', 'bookingPage', 'reviewPage', 'fromDate', 'toDate', 'limit']));
    for (const name of ['work_shifts', 'pt_bookings']) {
      const explain = await db().collection(name).find({ trainer_id: trainer, status: { $in: ['CONFIRMED', 'COMPLETED'] },
        start_at: { $lt: new Date(observedAt) }, end_at: { $gt: at('00:00', '2026-11-01') } })
        .hint(`${name}_trainer_status_time`).explain('executionStats');
      expect(JSON.stringify(explain.queryPlanner.winningPlan)).toContain('IXSCAN');
    }
    for (let i = 0; i < 105; i++) await shift('15:00', '16:00');
    const detail = (await get(`/${trainer}/performance`).query({ limit: 1, shiftPage: 107 }).expect(200)).body;
    expect(detail.summary).toMatchObject({ shiftCount: 107, plannedMinutes: '300', overlappingShiftCount: 104 });
    expect(detail.sourcePages.shifts).toMatchObject({ total: 107, page: 107 }); expect(detail.sourcePages.shifts.items).toHaveLength(1);
  });
});
