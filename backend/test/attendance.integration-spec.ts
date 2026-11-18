import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId, MongoServerError } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { UsersRepository } from '../src/modules/users/users.repository';
import { TrainerActivityRepository } from '../src/modules/trainers/trainer-activity.repository';
import { ensureTrainerActivityIndexes } from '../src/modules/trainers/trainer-activity-indexes';
import { AttendanceRepository } from '../src/modules/attendance/attendance.repository';
import { ensureAttendanceIntegrity } from '../src/modules/attendance/attendance-migration';

describe('US-63 / UC-34: attendance, two Nest instances and real replica set', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  let secondApp: INestApplication;
  const savedEnv = { ...process.env };
  const auth: Record<string, { token: string; id: ObjectId }> = {};
  const db = () => connection.db!;
  const password = 'US63-Password-123!';
  const origin = 'http://localhost:5173';
  let trainerId: ObjectId;
  let shiftId: ObjectId;
  let bookingId: ObjectId;
  const get = (path = '/api/admin/trainers/activity', role = 'ADMIN') => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${auth[role].token}`);

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_test_us63', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'), SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'test@gym.test' });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    await ensureTrainerActivityIndexes(connection);
    secondApp = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(secondApp); await secondApp.init();
    const users = app.get(UsersRepository);
    const hash = await app.get(PasswordService).hash(password);
    let sequence = 0;
    for (const code of ['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'] as const) {
      const role = await users.ensureRole(code, code);
      const account = await users.createAccount({ roleId: String(role.id), fullName: `US63 ${code}`, phone: `098320000${++sequence}`, passwordHash: hash });
      const response = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
      auth[code] = { token: response.body.accessToken, id: new ObjectId(String(account.id)) };
    }
  }, 600000);
  const now = new Date('2026-11-17T03:00:00Z');
  const base = () => `/api/work-shifts/${shiftId}/attendance`;
  const post = (action: string, body = {}, role = 'STAFF', key = randomUUID(), other = false) =>
    request((other ? secondApp : app).getHttpServer()).post(`${base()}/${action}`)
      .set('Authorization', `Bearer ${auth[role].token}`).set('Idempotency-Key', key).send(body);
  const read = (role = 'STAFF') => get(base(), role);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(ServerClock.prototype, 'now').mockReturnValue(now);
    for (const name of ['trainers', 'work_shifts', 'trainer_attendance', 'attendance_events', 'pt_bookings', 'memberships', 'operation_requests', 'schedule_guards']) await db().collection(name).deleteMany({});
    trainerId = new ObjectId(); shiftId = new ObjectId(); bookingId = new ObjectId();
    await db().collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
    await db().collection('trainers').insertOne({ _id: trainerId, id: trainerId, account_id: auth.TRAINER.id, status: 'ACTIVE' });
    await db().collection('work_shifts').insertOne({ _id: shiftId, id: shiftId, trainer_id: trainerId, version: 0,
      start_at: new Date('2026-11-17T04:00:00Z'), end_at: new Date('2026-11-17T06:00:00Z'), status: 'CONFIRMED', location: 'Gym' });
    await db().collection('pt_bookings').insertOne({ _id: bookingId, trainer_id: trainerId, shift_id: shiftId, status: 'BOOKED', start_at: new Date('2026-11-17T04:00:00Z') });
    await db().collection('memberships').insertOne({ sessions_used: 2, sessions_quota: 10 });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await secondApp?.close(); await app?.close(); await mongo?.stop(); process.env = savedEnv; });

  it('TC01/06/11: early in, late out use server clock, leave shift/booking/quota intact and update US-32', async () => {
    const original = await db().collection('work_shifts').findOne({ _id: shiftId });
    const entered = await post('check-in', { note: '  Đã đối chiếu  ' }).expect(201);
    expect(entered.body).toMatchObject({ checkInAt: now.toISOString(), version: 0, state: 'OPEN', note: 'Đã đối chiếu' });
    await post('check-out', { version: 0 }).expect(409); // Equal to in.
    jest.spyOn(ServerClock.prototype, 'now').mockReturnValue(new Date('2026-11-17T07:00:00Z'));
    const closed = await post('check-out', { version: 0 }).expect(200);
    expect(closed.body).toMatchObject({ checkOutAt: '2026-11-17T07:00:00.000Z', checkedOutBy: String(auth.STAFF.id), version: 1 });
    expect(await db().collection('work_shifts').findOne({ _id: shiftId })).toEqual(original);
    expect((await db().collection('pt_bookings').findOne({ _id: bookingId }))?.status).toBe('BOOKED');
    expect((await db().collection('memberships').findOne())?.sessions_used).toBe(2);
    const activity = await get(`/api/admin/trainers/${trainerId}/activity`).query({ fromDate: '2026-11-17', toDate: '2026-11-17' }).expect(200);
    expect(activity.body.summary).toMatchObject({ actualMinutesTotal: 240, completedCount: 0, pendingCompletionCount: 1 });
    const admin = await read('ADMIN').expect(200);
    expect(admin.body.events.map((e: { action: string }) => e.action)).toEqual(['CHECK_IN', 'CHECK_OUT']);
    expect((await read().expect(200)).body.events).toBeUndefined();
  });
  it('TC02: role boundaries, current session/account/auth_version are checked before replay', async () => {
    const key = randomUUID(); await post('check-in', {}, 'STAFF', key).expect(201);
    for (const role of ['TRAINER', 'MEMBER']) {
      await post('check-in', {}, role).expect(403); await read(role).expect(403);
      await post('corrections', {}, role).expect(403);
    }
    await post('corrections', {}, 'STAFF').expect(403);
    await request(app.getHttpServer()).post(`${base()}/check-in`).send({}).expect(401);
    for (const patch of [{ status: 'LOCKED' }, { auth_version: 1 }]) {
      await db().collection('accounts').updateOne({ _id: auth.STAFF.id }, { $set: patch });
      await post('check-in', {}, 'STAFF', key).expect(401);
      await db().collection('accounts').updateOne({ _id: auth.STAFF.id }, { $set: { status: 'ACTIVE', auth_version: 0 } });
    }
    await db().collection('auth_sessions').updateMany({ account_id: auth.STAFF.id }, { $set: { revoked_at: now } });
    await post('check-in', {}, 'STAFF', key).expect(401);
    await db().collection('auth_sessions').updateMany({ account_id: auth.STAFF.id }, { $unset: { revoked_at: '' } });
    await get('/api/admin/trainers/activity', 'STAFF').expect(403);
  });
  it.each(['SCHEDULED', 'CANCELLED'])('TC03: %s cannot be recorded', async status => {
    await db().collection('work_shifts').updateOne({ _id: shiftId }, { $set: { status } });
    expect((await post('check-in').expect(409)).body.error.code).toBe('SHIFT_NOT_ELIGIBLE');
  });
  it('TC03/06: expired in rejected, out without in rejected; missing/invalid IDs do not leak DB errors', async () => {
    await post('check-out', { version: 0 }).expect(409);
    await db().collection('work_shifts').updateOne({ _id: shiftId }, { $set: { end_at: now } });
    await post('check-in').expect(409);
    await get('/api/work-shifts/bad/attendance', 'STAFF').expect(400);
    await get(`/api/work-shifts/${new ObjectId()}/attendance`, 'STAFF').expect(404);
  });
  it.each([{ timestamp: now.toISOString() }, { trainerId: new ObjectId().toHexString() }, { note: 'x'.repeat(256) }, { note: null }])('TC04: rejects client source/time or invalid note %j', async body => {
    await post('check-in', body).expect(400);
    expect(await db().collection('trainer_attendance').countDocuments()).toBe(0);
  });
  it('TC05/10: distinct keys across instances yield exactly one record; identical key replays original result', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => post('check-in', {}, i % 2 ? 'ADMIN' : 'STAFF', randomUUID(), Boolean(i % 2))));
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    expect(results.filter(r => r.status === 409 && r.body.error.code === 'ATTENDANCE_ALREADY_EXISTS')).toHaveLength(5);
    expect(await db().collection('trainer_attendance').countDocuments()).toBe(1);
    expect(await db().collection('attendance_events').countDocuments()).toBe(1);
  });
  it('TC10: replay before checking current version, normalized payload/target, lookup and closed guard', async () => {
    const key = randomUUID(); const first = await post('check-in', { note: ' hello ' }, 'STAFF', key).expect(201);
    jest.spyOn(ServerClock.prototype, 'now').mockReturnValue(new Date('2026-11-17T04:00:00Z'));
    const outKey = randomUUID(); const out = await post('check-out', { version: 0 }, 'STAFF', outKey).expect(200);
    expect((await post('check-in', { note: 'hello' }, 'STAFF', key, true).expect(201)).body).toEqual(first.body);
    expect((await post('check-out', { version: 0 }, 'STAFF', outKey, true).expect(200)).body).toEqual(out.body);
    expect((await post('check-in', { note: 'different' }, 'STAFF', key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await post('check-out', { version: 1 }).expect(409)).body.error.code).toBe('ATTENDANCE_ALREADY_CLOSED');
    const result = await get(`/api/operations/ATTENDANCE_CHECK_OUT/${outKey}`, 'STAFF').expect(200);
    expect(result.body.responseBody).toEqual(out.body);
  });
  it('TC05/10: simultaneous same-key requests across instances replay one committed attendance/event', async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => post('check-in', {}, 'STAFF', key, Boolean(i % 2))));
    expect(results.every(result => result.status === 201)).toBe(true);
    for (const result of results) expect(result.body).toEqual(results[0].body);
    expect(await db().collection('trainer_attendance').countDocuments()).toBe(1);
    expect(await db().collection('attendance_events').countDocuments()).toBe(1);
    expect(await db().collection('operation_requests').countDocuments()).toBe(1);
  });
  it('TC10: checkout competing with correction CAS cannot overwrite the winning version', async () => {
    await post('check-in').expect(201);
    jest.spyOn(ServerClock.prototype, 'now').mockReturnValue(new Date('2026-11-17T05:00:00Z'));
    const result = await Promise.all([
      post('check-out', { version: 0 }), post('corrections', { version: 0, checkInAt: '2026-11-17T09:00:00+07:00', reason: 'Sửa lại giờ công ghi sai' }, 'ADMIN', randomUUID(), true),
    ]);
    expect(result.filter(r => r.status === 200)).toHaveLength(1);
    expect(result.filter(r => r.status === 409 && r.body.error.code === 'VERSION_CONFLICT')).toHaveLength(1);
    expect((await db().collection('trainer_attendance').findOne())?.version).toBe(1);
    expect(await db().collection('attendance_events').countDocuments()).toBe(2);
  });
  it('TC07/08/10/11: Admin correction preserves original event/creator and is CAS protected', async () => {
    const entered = await post('check-in').expect(201);
    const input = { version: 0, checkInAt: '2026-11-17T08:00:00+07:00', checkOutAt: '2026-11-17T09:00:00+07:00', reason: '  Sửa giờ vào ra bị ghi sai  ' };
    const key = randomUUID();
    const corrected = await post('corrections', input, 'ADMIN', key).expect(200);
    expect(corrected.body).toMatchObject({ version: 1, recordedBy: entered.body.recordedBy, createdAt: entered.body.createdAt, lastCorrectedBy: String(auth.ADMIN.id) });
    expect((await post('corrections', input, 'ADMIN', key, true).expect(200)).body).toEqual(corrected.body);
    await post('corrections', input, 'ADMIN').expect(409);
    const source = await read('ADMIN').expect(200);
    expect(source.body.events[0].after.checkInAt).toBe(now.toISOString());
    expect(source.body.events[1]).toMatchObject({ action: 'CORRECT', reason: input.reason.trim(), occurredAt: now.toISOString(), before: { version: 0 }, after: { version: 1 } });
    const activity = await get(`/api/admin/trainers/${trainerId}/activity`).query({ fromDate: '2026-11-17', toDate: '2026-11-17' }).expect(200);
    expect(activity.body.summary.actualMinutesTotal).toBe(60);
    await post('corrections', { version: 1, checkInAt: input.checkInAt, reason: input.reason }, 'ADMIN').expect(200);
    expect((await read().expect(200)).body.state).toBe('OPEN');
  });
  it('TC07: missed attendance can be added to a past COMPLETED shift even if trainer account is inactive', async () => {
    await db().collection('work_shifts').updateOne({ _id: shiftId }, { $set: { status: 'COMPLETED', start_at: new Date('2026-11-17T00:00:00Z') } });
    await db().collection('accounts').updateOne({ _id: auth.TRAINER.id }, { $set: { status: 'LOCKED' } });
    try {
      const corrected = await post('corrections', { checkInAt: '2026-11-17T07:00:00+07:00', reason: 'Bổ sung công bị bỏ sót' }, 'ADMIN').expect(201);
      expect(corrected.body.version).toBe(0);
      expect((await read('ADMIN').expect(200)).body.events[0]).toMatchObject({ action: 'CORRECT', before: null });
    } finally { await db().collection('accounts').updateOne({ _id: auth.TRAINER.id }, { $set: { status: 'ACTIVE' } }); }
  });
  it.each([
    { checkInAt: '2026-11-17T11:00:00+07:00', reason: 'Thời gian nằm ở tương lai' },
    { checkInAt: '2026-11-17T08:00:00+07:00', checkOutAt: '2026-11-17T08:00:00+07:00', reason: 'Giờ ra bằng với giờ vào' },
    { checkInAt: '2026-11-17T08:00:00', reason: 'Không có múi giờ hợp lệ' },
    { checkInAt: '2026-02-30T08:00:00+07:00', reason: 'Ngày không tồn tại thật' },
    { checkInAt: '2026-11-17T08:00:00+99:00', reason: 'Múi giờ không hợp lệ' },
    { checkInAt: '2026-11-17T08:00:00+07:00', reason: '   ' },
  ])('TC08: invalid correction %j leaves data intact', async input => {
    await post('check-in').expect(201);
    const response = await post('corrections', { version: 0, ...input }, 'ADMIN');
    expect([400, 409]).toContain(response.status);
    expect((await db().collection('trainer_attendance').findOne())?.version).toBe(0);
    expect(await db().collection('attendance_events').countDocuments()).toBe(1);
  });
  it('TC09: check-in racing real shift cancellation has only a valid serial outcome', async () => {
    await db().collection('pt_bookings').deleteMany({});
    const [entered, cancelled] = await Promise.all([
      post('check-in'), request(secondApp.getHttpServer()).post(`/api/me/work-shifts/${shiftId}/cancel`)
        .set('Authorization', `Bearer ${auth.TRAINER.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0, reason: 'Hủy ca vì bận công việc' }),
    ]);
    expect([[201, 409], [409, 200]]).toContainEqual([entered.status, cancelled.status]);
    if (entered.status === 201) expect(cancelled.body.error.code).toBe('SHIFT_HAS_ATTENDANCE');
    else expect(entered.body.error.code).toBe('SHIFT_NOT_ELIGIBLE');
  });
  it('TC09: existing attendance blocks cancellation and editing, including anomalous draft data', async () => {
    await post('check-in').expect(201);
    await db().collection('work_shifts').updateOne({ _id: shiftId }, { $set: { status: 'SCHEDULED' } });
    const result = await request(app.getHttpServer()).patch(`/api/me/work-shifts/${shiftId}`)
      .set('Authorization', `Bearer ${auth.TRAINER.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0,
        startAt: '2026-11-17T12:00:00+07:00', endAt: '2026-11-17T14:00:00+07:00', location: 'Gym' }).expect(409);
    expect(result.body.error.code).toBe('SHIFT_HAS_ATTENDANCE');
  });
  it('TC10: audit infrastructure failure rolls back attendance and operation; same key remains usable', async () => {
    const key = randomUUID();
    const spy = jest.spyOn(app.get(AttendanceRepository), 'event').mockRejectedValueOnce(new MongoServerError({ message: 'test audit unavailable' }));
    await post('check-in', {}, 'STAFF', key).expect(503);
    for (const collection of ['trainer_attendance', 'attendance_events', 'operation_requests']) expect(await db().collection(collection).countDocuments()).toBe(0);
    spy.mockRestore(); await post('check-in', {}, 'STAFF', key).expect(201);
  });
  it('TC12: Staff picker filters dates/PT and MISSING is explicit with no fabricated minutes', async () => {
    const response = await get('/api/work-shifts', 'STAFF').query({ fromDate: '2026-11-17', toDate: '2026-11-17', trainerId: String(trainerId) }).expect(200);
    expect(response.body.items[0].attendance).toMatchObject({ state: 'MISSING', actualMinutes: null });
    expect(response.body.trainers[0]).toEqual({ id: String(trainerId), displayName: 'US63 TRAINER' });
    await get('/api/work-shifts', 'STAFF').query({ trainerId: 'bad' }).expect(400);
    await get('/api/work-shifts', 'STAFF').query({ ownerId: String(trainerId) }).expect(400);
  });
  it('migration: reconciles legacy ownership/version without changing original times or fabricating audit', async () => {
    await db().collection('trainer_attendance').insertOne({ shift_id: shiftId, check_in_at: now, recorded_by: auth.ADMIN.id, created_at: now });
    await ensureAttendanceIntegrity(connection);
    const guardAfterBackfill = await db().collection('schedule_guards').findOne({});
    await ensureAttendanceIntegrity(connection);
    expect(await db().collection('schedule_guards').findOne({})).toEqual(guardAfterBackfill);
    const record = await db().collection('trainer_attendance').findOne();
    expect(record).toMatchObject({ trainer_id: trainerId, version: 0, check_in_at: now, created_at: now, updated_at: now });
    expect(record!.id).toEqual(record!._id);
    expect(await db().collection('attendance_events').countDocuments()).toBe(0);
  });
  it('migration: empty attendance validates/indexes without advancing the schedule guard', async () => {
    const before = await db().collection('schedule_guards').findOne({});
    await ensureAttendanceIntegrity(connection);
    expect(await db().collection('schedule_guards').findOne({})).toEqual(before);
  });
  it('migration: invalid source stops all backfill', async () => {
    await db().collection('trainer_attendance').insertOne({ shift_id: shiftId, trainer_id: new ObjectId(), check_in_at: now, recorded_by: auth.ADMIN.id, created_at: now });
    await expect(ensureAttendanceIntegrity(connection)).rejects.toThrow('ATTENDANCE_MIGRATION_REQUIRES_RECONCILIATION');
    expect((await db().collection('trainer_attendance').findOne())?.version).toBeUndefined();
  });
});
