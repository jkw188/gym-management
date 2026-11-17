import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { UsersRepository } from '../src/modules/users/users.repository';
import { TrainerActivityRepository } from '../src/modules/trainers/trainer-activity.repository';
import { ensureTrainerActivityIndexes } from '../src/modules/trainers/trainer-activity-indexes';
import { ActivityDetail, ActivityList } from '../src/modules/trainers/trainer-activity.types';

describe('US-32 / UC-34: independent activity sources (real MongoDB snapshot + HTTP/JWT)', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };
  const auth: Record<string, { token: string; id: ObjectId }> = {};
  const db = () => connection.db!;
  const password = 'US32-Password-123!';
  const origin = 'http://localhost:5173';
  const range = { fromDate: '2026-11-01', toDate: '2026-11-01' };
  let trainerId: ObjectId;
  let shiftId: ObjectId;
  let bookingId: ObjectId;
  const get = (path = '/api/admin/trainers/activity', role = 'ADMIN') => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${auth[role].token}`);

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_us32', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'), SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'test@gym.test' });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    await ensureTrainerActivityIndexes(connection);
    const users = app.get(UsersRepository);
    const hash = await app.get(PasswordService).hash(password);
    let sequence = 0;
    for (const code of ['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as const) {
      const role = await users.ensureRole(code, code);
      const account = await users.createAccount({ roleId: String(role.id), fullName: `US32 ${code}`, phone: `098320000${++sequence}`, passwordHash: hash });
      const response = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
      auth[code] = { token: response.body.accessToken, id: new ObjectId(String(account.id)) };
    }
  }, 600000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(ServerClock.prototype, 'now').mockReturnValue(new Date('2026-11-17T03:00:00Z'));
    for (const name of ['trainers', 'work_shifts', 'trainer_attendance', 'attendance_events', 'pt_bookings', 'booking_events',
      'members', 'memberships', 'service_sales', 'transactions', 'operation_requests', 'schedule_guards']) await db().collection(name).deleteMany({});
    trainerId = new ObjectId(); shiftId = new ObjectId(); bookingId = new ObjectId();
    await db().collection('trainers').insertOne({ _id: trainerId, id: trainerId, account_id: auth.TRAINER.id, specialty: 'PT', status: 'INACTIVE', created_at: new Date('2026-01-01Z') });
    await db().collection('work_shifts').insertOne({ _id: shiftId, id: shiftId, trainer_id: trainerId,
      start_at: new Date('2026-11-01T01:00:00Z'), end_at: new Date('2026-11-01T03:00:00Z'), status: 'COMPLETED', location: 'Gym', created_at: new Date() });
    await db().collection('pt_bookings').insertOne({ _id: bookingId, id: bookingId, trainer_id: trainerId, shift_id: shiftId,
      member_id: new ObjectId(), membership_id: new ObjectId(), start_at: new Date('2026-11-01T01:00:00Z'), end_at: new Date('2026-11-01T02:00:00Z'),
      status: 'BOOKED', version: 0, completion_revision: 0, request_key: randomBytes(32).toString('hex'), created_at: new Date() });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = savedEnv; });
  async function detail(query: Record<string, string | number> = {}) {
    const response = await get(`/api/admin/trainers/${trainerId}/activity`).query({ ...range, ...query }).expect(200);
    return response.body as ActivityDetail;
  }
  async function attendance(closed = false) {
    const id = new ObjectId();
    await db().collection('trainer_attendance').insertOne({ _id: id, id, shift_id: shiftId, trainer_id: trainerId,
      check_in_at: new Date('2026-11-01T01:00:00Z'), ...(closed ? { check_out_at: new Date('2026-11-01T02:30:00Z'), checked_out_by: auth.ADMIN.id } : {}),
      recorded_by: auth.ADMIN.id, version: 0, created_at: new Date('2026-11-02T00:00:00Z') });
    return id;
  }

  it('TC01/05/07: inactive PT, COMPLETED shift and overdue BOOKED remain MISSING / unconfirmed', async () => {
    const body = await detail();
    expect(body.trainer.status).toBe('INACTIVE');
    expect(body.summary).toMatchObject({ shiftCount: 1, attendanceMissing: 1, actualMinutesTotal: 0, bookingCount: 1, completedCount: 0, pendingCompletionCount: 1 });
    expect(body.shiftsPage.items[0].attendance).toMatchObject({ state: 'MISSING', actualMinutes: null });
    expect(body.bookingsPage.items[0]).toMatchObject({ status: 'BOOKED', completedAt: null, completedBy: null });
    expect(body.shiftsPage.asOf).toBe(body.asOf); expect(body.bookingsPage.asOf).toBe(body.asOf);
  });
  it('TC05/06: OPEN is null, valid CLOSED is 90 actual minutes independently of bookings', async () => {
    await attendance();
    expect((await detail()).shiftsPage.items[0].attendance).toMatchObject({ state: 'OPEN', actualMinutes: null });
    expect((await detail()).summary.attendanceOpen).toBe(1);
    await db().collection('trainer_attendance').updateOne({ shift_id: shiftId }, { $set: { check_out_at: new Date('2026-11-01T02:30:00Z') } });
    const body = await detail();
    expect(body.summary).toMatchObject({ attendanceClosed: 1, attendanceOpen: 0, actualMinutesTotal: 90, completedCount: 0 });
    expect(body.shiftsPage.items[0].attendance.actualMinutes).toBe(90);
  });
  it('TC03/04: VN boundaries use start_at, late confirmation/check-in creation do not move the period', async () => {
    await attendance(true);
    await db().collection('pt_bookings').updateOne({ _id: bookingId }, { $set: { status: 'COMPLETED', completed_at: new Date('2026-11-10Z'), completed_by: auth.ADMIN.id } });
    for (const start of ['2026-10-31T16:59:59.999Z', '2026-10-31T17:00:00Z', '2026-11-01T16:59:59.999Z', '2026-11-01T17:00:00Z']) {
      const id = new ObjectId();
      await db().collection('work_shifts').insertOne({ _id: id, id, trainer_id: trainerId, start_at: new Date(start), end_at: new Date('2026-11-02T01:00:00Z'), status: 'CONFIRMED' });
    }
    const body = await detail();
    expect(body.summary.shiftCount).toBe(3); expect(body.summary.completedCount).toBe(1);
    expect(body.bookingsPage.items[0].completedAt).toBe('2026-11-10T00:00:00.000Z');
    expect(body.shiftsPage.items.some(shift => shift.endAt === '2026-11-02T01:00:00.000Z')).toBe(true);
    expect((await get().expect(200)).body.range).toEqual({ fromDate: '2026-10-19', toDate: '2026-11-17' });
    await get().query({ fromDate: '2025-11-01', toDate: '2026-11-01' }).expect(200);
    await get().query({ fromDate: '2025-10-31', toDate: '2026-11-01' }).expect(400);
  });
  it.each([{ fromDate: '2026-02-30' }, { fromDate: '2026-11-02', toDate: '2026-11-01' },
    { fromDate: '2025-01-01', toDate: '2026-11-01' }, { limit: 101 }, { page: '1.5' }, { trainerId: 'bad' }, { ownerId: 'bad' }])('TC04: invalid filter returns 400 %j', async query => {
    await get().query(query).expect(400);
  });
  it('TC02: real JWT rejects other roles, no token, revoked session, locked account and changed auth_version', async () => {
    for (const role of ['STAFF', 'TRAINER', 'MEMBER']) {
      await get(undefined, role).expect(403);
      await get(`/api/admin/trainers/${trainerId}/activity`, role).expect(403);
      await get(`/api/work-shifts/${shiftId}/attendance`, role).expect(403);
      await get(`/api/admin/pt-bookings/${bookingId}`, role).expect(403);
    }
    await request(app.getHttpServer()).get('/api/admin/trainers/activity').expect(401);
    for (const patch of [{ status: 'LOCKED' }, { auth_version: 1 }]) {
      await db().collection('accounts').updateOne({ _id: auth.ADMIN.id }, { $set: patch });
      await get().expect(401);
      await db().collection('accounts').updateOne({ _id: auth.ADMIN.id }, { $set: { status: 'ACTIVE', auth_version: 0 } });
    }
    await db().collection('auth_sessions').updateMany({ account_id: auth.ADMIN.id }, { $set: { revoked_at: new Date() } });
    await get().expect(401);
    await db().collection('auth_sessions').updateMany({ account_id: auth.ADMIN.id }, { $unset: { revoked_at: '' } });
  });
  it('TC08: trainer and source pagination never changes whole-filter totals; empty totalPages=0', async () => {
    await attendance(true);
    await db().collection('work_shifts').insertOne({ trainer_id: trainerId, start_at: new Date('2026-11-01T03:00:00Z'), status: 'CONFIRMED' });
    await db().collection('trainers').insertOne({ account_id: new ObjectId(), status: 'INACTIVE', created_at: new Date() });
    const cancelledId = new ObjectId();
    await db().collection('pt_bookings').insertOne({ _id: cancelledId, id: cancelledId, trainer_id: trainerId,
      start_at: new Date('2026-11-01T03:00:00Z'), status: 'CANCELLED', request_key: randomBytes(32).toString('hex') });
    const first = (await get().query({ ...range, limit: 1 }).expect(200)).body as ActivityList;
    const second = (await get().query({ ...range, limit: 1, page: 2 }).expect(200)).body as ActivityList;
    expect(first.total).toBe(2); expect(first.items).toHaveLength(1); expect(first.summary).toEqual(second.summary);
    expect(first.summary.actualMinutesTotal).toBe(90);
    expect(first.summary).toMatchObject({ bookingCount: 2, cancelledCount: 1, completedCount: 0, pendingCompletionCount: 1 });
    const body = await detail({ shiftPage: 2, bookingPage: 3, limit: 1 });
    expect(body.shiftsPage.items).toHaveLength(1); expect(body.shiftsPage.total).toBe(2);
    expect(body.bookingsPage.items).toHaveLength(0); expect(body.bookingsPage.total).toBe(2); expect(body.summary.shiftCount).toBe(2);
    const empty = (await get().query({ ...range, trainerId: new ObjectId().toHexString() }).expect(200)).body;
    expect(empty.totalPages).toBe(0); expect(empty.summary.shiftCount).toBe(0);
    await get(`/api/admin/trainers/${new ObjectId()}/activity`).query(range).expect(404);
  });
  it('TC09: refresh reads committed attendance correction and allowlisted audit without changing booking/quota', async () => {
    const attendanceId = await attendance(true);
    const before = await db().collection('pt_bookings').findOne({ _id: bookingId });
    // US-63 writer is not implemented: these are committed source fixtures, not a simulated claim of command integration.
    await db().collection('trainer_attendance').updateOne({ _id: attendanceId }, { $set: {
      check_out_at: new Date('2026-11-01T03:00:00Z'), version: 1, last_corrected_by: auth.ADMIN.id, last_corrected_at: new Date() } });
    await db().collection('attendance_events').insertOne({ shift_id: shiftId, attendance_id: attendanceId, action: 'CORRECT', actor_id: auth.ADMIN.id,
      occurred_at: new Date(), reason: 'Đối chiếu phiếu chấm công gốc', operation_id: 'SECRET', before: { version: 0, arbitrary: 'SECRET' }, after: { version: 1 } });
    expect((await detail()).summary.actualMinutesTotal).toBe(120);
    const source = (await get(`/api/work-shifts/${shiftId}/attendance`).expect(200)).body;
    expect(source.events[0]).toMatchObject({ action: 'CORRECT', before: { version: 0 }, after: { version: 1 } });
    expect(JSON.stringify(source)).not.toContain('SECRET');
    expect(await db().collection('pt_bookings').findOne({ _id: bookingId })).toEqual(before);
  });
  it('TC09: real US-64 Admin COMPLETE then REOPEN refreshes report and keeps completion history', async () => {
    const memberId = new ObjectId(), membershipId = new ObjectId(), saleId = new ObjectId(), transactionId = new ObjectId();
    await db().collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
    await db().collection('members').insertOne({ _id: memberId, id: memberId, service_revision: Long.ZERO });
    await db().collection('memberships').insertOne({ _id: membershipId, id: membershipId, service_sale_id: saleId, sessions_used: 0, status: 'ACTIVE' });
    await db().collection('service_sales').insertOne({ _id: saleId, id: saleId, member_id: memberId, transaction_id: transactionId, sessions_snapshot: 10 });
    await db().collection('transactions').insertOne({ _id: transactionId, id: transactionId, member_id: memberId, kind: 'PT', status: 'SETTLED' });
    await db().collection('pt_bookings').updateOne({ _id: bookingId }, { $set: { member_id: memberId, membership_id: membershipId } });
    for (const [action, version] of [['COMPLETE', 0], ['REOPEN', 1]] as const) {
      await request(app.getHttpServer()).post(`/api/admin/pt-bookings/${bookingId}/corrections`).set('Authorization', `Bearer ${auth.ADMIN.token}`)
        .set('Idempotency-Key', randomUUID()).send({ action, version, reason: 'Đối chiếu bằng chứng buổi dạy tại quầy' }).expect(200);
      const body = await detail();
      expect(body.summary.completedCount).toBe(action === 'COMPLETE' ? 1 : 0);
      expect(body.summary.attendanceMissing).toBe(1);
    }
    const source = (await get(`/api/admin/pt-bookings/${bookingId}`).expect(200)).body;
    expect(source.events.map((event: { action: string }) => event.action)).toEqual(['COMPLETE', 'REOPEN']);
    expect(source.quotaSource.sessionsUsed).toBe(0);
  });
  it('TC08 snapshot: concurrent source commit between summary and page is visible only on the next GET', async () => {
    await attendance();
    const repository = app.get(TrainerActivityRepository), original = repository.page.bind(repository);
    const spy = jest.spyOn(repository, 'page').mockImplementationOnce(async (...args) => {
      await db().collection('trainer_attendance').updateOne({ shift_id: shiftId }, { $set: { check_out_at: new Date('2026-11-01T02:30:00Z') } });
      return original(...args);
    });
    const body = await detail();
    expect(body.summary.attendanceOpen).toBe(1); expect(body.shiftsPage.items[0].attendance.state).toBe('OPEN');
    spy.mockRestore(); expect((await detail()).summary.actualMinutesTotal).toBe(90);
  });
  it('TC10: orphan sources and invalid in/out expose dataIssue and never fabricate minutes', async () => {
    await attendance(true);
    await db().collection('trainer_attendance').updateOne({ shift_id: shiftId }, { $set: { check_out_at: new Date('2026-11-01T00:00:00Z') } });
    let body = await detail(); expect(body.shiftsPage.items[0].attendance.actualMinutes).toBeNull(); expect(body.summary.actualMinutesTotal).toBe(0);
    expect(body.shiftsPage.items[0].dataIssue).toContain('ATTENDANCE_TIME_INVALID');
    await db().collection('trainer_attendance').updateOne({ shift_id: shiftId }, { $set: { check_out_at: 'broken-source-date' } });
    body = await detail(); expect(body.summary.actualMinutesTotal).toBe(0); expect(body.shiftsPage.items[0].attendance.actualMinutes).toBeNull();
    await db().collection('trainers').deleteOne({ _id: trainerId });
    body = await detail(); expect(body.trainer.dataIssue).toContain('TRAINER_MISSING');
    expect(body.bookingsPage.items[0].dataIssue).toContain('TRAINER_MISSING');
    await db().collection('work_shifts').deleteOne({ _id: shiftId });
    body = await detail(); expect(body.trainer.dataIssue).toContain('ATTENDANCE_SHIFT_MISSING_UNDATED');
    expect(body.summary.shiftCount).toBe(0);
  });
  it('TC11/12: no report mutation, source ID validation, sanitized DB errors and unique shift attendance', async () => {
    await request(app.getHttpServer()).patch('/api/admin/trainers/activity').set('Authorization', `Bearer ${auth.ADMIN.token}`).send({ summary: {} }).expect(404);
    await get('/api/admin/trainers/invalid/activity').expect(400);
    await get('/api/work-shifts/invalid/attendance').expect(400);
    await attendance(); await expect(attendance()).rejects.toMatchObject({ code: 11000 });
    const error = new Error('mongodb://secret-host'); error.name = 'MongoNetworkError';
    jest.spyOn(app.get(TrainerActivityRepository), 'trainers').mockRejectedValueOnce(error);
    const response = await get().query(range).expect(503);
    expect(response.body.error.code).toBe('DATABASE_UNAVAILABLE'); expect(JSON.stringify(response.body)).not.toContain('secret-host');
  });
});
