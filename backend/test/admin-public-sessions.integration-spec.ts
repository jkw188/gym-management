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
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { AdminPublicSessionsRepository } from '../src/modules/public-sessions/admin-public-sessions.repository';
import { ensurePublicSessionsIntegrity } from '../src/modules/public-sessions/public-sessions-migration';

const base = '/api/admin/public-sessions';
const origin = 'http://localhost:5173';
const day = new Date(Date.now() + 7 * 3600000 + 10 * 86400000).toISOString().slice(0, 10);
const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const at = (time: string, date = day) => `${date}T${time}:00+07:00`;
type Actor = { id: string; token: string };

describe('US-66: lifecycle, projection, migration and transactional rollback', () => {
  let mongo: MongoMemoryReplSet, app: INestApplication, connection: Connection;
  let admin: Actor, pt: Actor, trainerId: ObjectId;
  const saved = { ...process.env };
  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());
  let sequence = 0;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_us66', FRONTEND_ORIGIN: origin,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'no-reply@gym.test' });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http'); configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = new LoginLimiter(); jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await db().collections()) if (collection.collectionName !== 'roles') await collection.deleteMany({});
    await db().collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
    await db().collection<{ _id: string; revision: Long }>('security_state').insertOne({ _id: 'account-administration', revision: Long.ZERO });
    admin = await login('ADMIN'); pt = await login('TRAINER'); trainerId = new ObjectId();
    await db().collection('trainers').insertOne({ _id: trainerId, id: trainerId, account_id: new ObjectId(pt.id), status: 'ACTIVE', specialty: 'Yoga', version: 0 });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = saved; });
  async function login(code: 'ADMIN' | 'TRAINER' | 'MEMBER' | 'STAFF'): Promise<Actor> {
    const users = app.get(UsersRepository), role = await users.ensureRole(code, code);
    const password = 'US66 test password 123', phone = `092660${String(++sequence).padStart(4, '0')}`;
    const account = await users.createAccount({ roleId: String(role.id), fullName: `US66 ${code}`, phone, passwordHash: await app.get(PasswordService).hash(password) });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { id: String(account._id), token: response.body.accessToken as string };
  }
  const draft = (start = '08:00', end = '08:45') => ({ title: ' Yoga sáng ', trainerId: String(trainerId), subjectCode: 'YOGA', location: ' Phòng 1 ', startAt: at(start), endAt: at(end) });
  const post = (path: string, body: object, key: string = randomUUID(), actor = admin) => http().post(`${base}${path}`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send(body);
  const patch = (id: string, body: object, key = randomUUID()) => http().patch(`${base}/${id}`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', key).send(body);
  const get = (path = '', actor = admin) => http().get(`${base}${path}`).set('Authorization', `Bearer ${actor.token}`);
  async function create(start = '08:00', end = '08:45') { return (await post('', draft(start, end)).expect(201)).body as { id: string; version: number }; }

  it('TC01/04/12: draft is private, 45-minute class outside shifts publishes and only safe fields are public', async () => {
    const row = await create();
    await http().get(`/api/public-sessions/${row.id}`).expect(404);
    const published = await post(`/${row.id}/publish`, { version: 0 }).expect(200);
    expect(published.body).toMatchObject({ status: 'PUBLISHED', version: 1, title: 'Yoga sáng', location: 'Phòng 1' });
    expect(published.body.publishedAt).toBeDefined();
    const detail = await http().get(`/api/public-sessions/${row.id}`).expect(200);
    expect(Object.keys(detail.body).sort()).toEqual(['id', 'title', 'subjectCode', 'subjectLabel', 'trainerId', 'trainerName', 'startAt', 'endAt', 'location', 'status', 'ended'].sort());
    expect(JSON.stringify(detail.body)).not.toMatch(/createdBy|updatedAt|phone|email|accountId|cancellation/i);
    const taxonomy = await http().get('/api/public-session-subjects').expect(200);
    expect(taxonomy.body.map((subject: { code: string }) => subject.code)).toEqual(['YOGA', 'AEROBICS', 'ZUMBA', 'FUNCTIONAL', 'OTHER']);
    const events = await db().collection('public_session_events').find({ session_id: new ObjectId(row.id) }).sort({ occurred_at: 1 }).toArray();
    expect(events.map(event => event.action)).toEqual(['CREATED', 'PUBLISHED']);
    expect(events[1].before.status).toBe('DRAFT'); expect(events[1].after.version).toBe(1);
    expect(await db().collection('notifications').countDocuments()).toBe(0);
  });
  it('TC02: only ADMIN may read/manage; trainer and account eligibility is rechecked at create/update/publish', async () => {
    await http().post(base).send(draft()).expect(401);
    for (const actor of [pt, await login('STAFF'), await login('MEMBER')]) {
      await post('', draft(), randomUUID(), actor).expect(403); await get('', actor).expect(403);
      for (const suffix of ['/publish', '/cancel']) await post(`/${new ObjectId()}${suffix}`, { version: 0, ...(suffix === '/cancel' ? { reason: 'Lý do hủy hợp lệ' } : {}) }, randomUUID(), actor).expect(403);
    }
    const row = await create();
    await db().collection('trainers').updateOne({ _id: trainerId }, { $set: { status: 'INACTIVE' } });
    expect((await post('', draft()).expect(409)).body.error.code).toBe('TRAINER_UNAVAILABLE');
    expect((await patch(row.id, { ...draft(), version: 0 }).expect(409)).body.error.code).toBe('TRAINER_UNAVAILABLE');
    expect((await post(`/${row.id}/publish`, { version: 0 }).expect(409)).body.error.code).toBe('TRAINER_UNAVAILABLE');
    await db().collection('trainers').updateOne({ _id: trainerId }, { $set: { status: 'ACTIVE' } });
    await db().collection('accounts').updateOne({ _id: new ObjectId(pt.id) }, { $set: { status: 'LOCKED' } });
    await post(`/${row.id}/publish`, { version: 0 }).expect(409);
    const memberRole = await db().collection('roles').findOne({ code: 'MEMBER' });
    await db().collection('accounts').updateOne({ _id: new ObjectId(pt.id) }, { $set: { status: 'ACTIVE', role_id: memberRole!._id } });
    await post(`/${row.id}/publish`, { version: 0 }).expect(409);
    expect(await db().collection('public_session_events').countDocuments()).toBe(1);
  });
  it('TC03: rejects unknown fields, malformed input, impossible dates, seconds, reversed/overnight time; midnight boundary is legal', async () => {
    for (const input of [{ title: '  ' }, { location: ' ' }, { title: 'a'.repeat(121) }, { subjectCode: 'PILATES' }, { trainerId: 'invalid' },
      { status: 'PUBLISHED' }, { version: 0 }, { startAt: `${day}T08:00:00` }, { startAt: at('08:00').replace(':00+07', ':01+07') },
      { startAt: '2035-02-30T08:00:00+07:00' }, { endAt: at('07:59') }, { endAt: at('01:00', nextDay) }]) {
      await post('', { ...draft(), ...input }).expect(400);
    }
    await http().post(base).set('Authorization', `Bearer ${admin.token}`).send(draft()).expect(400);
    await post('', draft(), 'not-uuid').expect(400);
    await post('', { ...draft('23:15'), endAt: at('00:00', nextDay) }).expect(201);
    const response = await post('', { ...draft(), startAt: '2000-01-01T08:00:00+07:00', endAt: '2000-01-01T08:45:00+07:00' }).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
  it('TC04/05: shifts may contain class; adjacency and different trainers at same location are allowed; published update is atomic', async () => {
    await db().collection('work_shifts').insertOne({ trainer_id: trainerId, start_at: new Date(at('07:00')), end_at: new Date(at('12:00')), status: 'CONFIRMED' });
    const first = await create(), second = await create('08:45', '09:30');
    await post(`/${first.id}/publish`, { version: 0 }).expect(200);
    await post(`/${second.id}/publish`, { version: 0 }).expect(200);
    const before = await db().collection('public_sessions').findOne({ _id: new ObjectId(second.id) });
    expect((await patch(second.id, { ...draft('08:30', '09:15'), version: 1 }).expect(409)).body.error.code).toBe('SESSION_OVERLAP');
    expect(await db().collection('public_sessions').findOne({ _id: before!._id })).toEqual(before);
    const otherPt = new ObjectId(), otherAccount = await login('TRAINER');
    await db().collection('trainers').insertOne({ _id: otherPt, account_id: new ObjectId(otherAccount.id), status: 'ACTIVE' });
    const other = await post('', { ...draft(), trainerId: String(otherPt) }).expect(201);
    await post(`/${other.body.id}/publish`, { version: 0 }).expect(200);
    await patch(second.id, { ...draft('09:00', '09:45'), version: 1 }).expect(200);
    expect((await get(`/${second.id}`)).body).toMatchObject({ status: 'PUBLISHED', version: 2 });
    expect(await db().collection('work_shifts').countDocuments()).toBe(1);
  });
  it('TC01/08: availability removes only PUBLISHED busy time and reloads after update/cancel', async () => {
    const member = await login('MEMBER');
    await db().collection('work_shifts').insertOne({ trainer_id: trainerId, start_at: new Date(at('08:00')), end_at: new Date(at('11:00')), status: 'CONFIRMED', location: 'Phòng 1' });
    const available = async () => (await http().get(`/api/me/pt-trainers/${trainerId}/availability?fromDate=${day}&toDate=${day}`)
      .set('Authorization', `Bearer ${member.token}`).expect(200)).body.slots as { startAt: string }[];
    const row = await create('08:30', '09:15');
    expect(await available()).toHaveLength(3);
    await post(`/${row.id}/publish`, { version: 0 }).expect(200);
    expect((await available()).map(slot => slot.startAt)).toEqual([new Date(at('10:00')).toISOString()]);
    await patch(row.id, { ...draft('10:00', '10:45'), version: 1 }).expect(200);
    expect((await available()).map(slot => slot.startAt)).toEqual([new Date(at('08:00')).toISOString(), new Date(at('09:00')).toISOString()]);
    await post(`/${row.id}/cancel`, { version: 2, reason: 'Thay đổi lịch tổ chức' }).expect(200);
    expect(await available()).toHaveLength(3);
  });
  it.each(['BOOKED', 'COMPLETED'])('TC05: %s blocks publish; drafts can overlap and preview returns no booking identity', async status => {
    const booking = new ObjectId();
    await db().collection('pt_bookings').insertOne({ _id: booking, trainer_id: trainerId, member_id: new ObjectId(), status, start_at: new Date(at('08:30')), end_at: new Date(at('09:30')) });
    const row = await create();
    const preview = await post('/preview', { ...draft(), sessionId: row.id }).expect(200);
    expect(preview.body.conflictCodes).toEqual(['BOOKING_CONFLICT']); expect(JSON.stringify(preview.body)).not.toContain(String(booking));
    expect((await post(`/${row.id}/publish`, { version: 0 }).expect(409)).body.error.code).toBe('BOOKING_CONFLICT');
    expect((await get(`/${row.id}`)).body).toMatchObject({ status: 'DRAFT', version: 0 });
  });
  it('TC09: version, immutable started history, terminal cancellation and 404/invalid ids', async () => {
    const row = await create();
    expect((await patch(row.id, { ...draft(), version: 1 }).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
    await patch(row.id, { ...draft('09:00', '09:45'), version: 0 }).expect(200);
    await post(`/${row.id}/cancel`, { version: 1, reason: ' quá ngắn ' }).expect(400);
    await post(`/${row.id}/cancel`, { version: 1, reason: ' Thay đổi lịch tổ chức ' }).expect(200);
    const cancelled = await get(`/${row.id}`).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', version: 2, cancellationReason: 'Thay đổi lịch tổ chức' });
    for (const suffix of ['/publish', '/cancel']) expect((await post(`/${row.id}${suffix}`, { version: 2, ...(suffix === '/cancel' ? { reason: 'Thay đổi lịch tổ chức' } : {}) }).expect(409)).body.error.code).toBe('INVALID_SESSION_STATE');
    await patch(row.id, { ...draft(), version: 2 }).expect(409); await http().get(`/api/public-sessions/${row.id}`).expect(404);
    const started = await create();
    jest.spyOn(ServerClock.prototype, 'now').mockReturnValue(new Date(at('08:00')));
    for (const suffix of ['/publish', '/cancel']) expect((await post(`/${started.id}${suffix}`, { version: 0, ...(suffix === '/cancel' ? { reason: 'Thay đổi lịch tổ chức' } : {}) }).expect(409)).body.error.code).toBe('SESSION_ALREADY_STARTED');
    await patch(started.id, { ...draft('10:00', '10:45'), version: 0 }).expect(409);
    await get(`/${new ObjectId()}`).expect(404); await get('/invalid').expect(400);
  });
  it('TC10: replay normalized payload returns original HTTP/body after start; changed payload or actor lookup cannot see committed result', async () => {
    const key = randomUUID(), input = draft();
    const first = await post('', input, key).expect(201);
    const row = first.body as { id: string };
    const publishKey = randomUUID(), published = await post(`/${row.id}/publish`, { version: 0 }, publishKey).expect(200);
    jest.spyOn(ServerClock.prototype, 'now').mockReturnValue(new Date(at('12:00')));
    expect((await post('', { ...input, title: input.title.trim(), startAt: new Date(input.startAt).toISOString() }, key).expect(201)).body).toEqual(first.body);
    expect((await post(`/${row.id}/publish`, { version: 0 }, publishKey).expect(200)).body).toEqual(published.body);
    expect((await post('', { ...input, location: 'Phòng 2' }, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    await http().get(`/api/operations/PUBLIC_SESSION_PUBLISH/${publishKey}`).set('Authorization', `Bearer ${admin.token}`).expect(200);
    const another = await login('ADMIN'); await http().get(`/api/operations/PUBLIC_SESSION_PUBLISH/${publishKey}`).set('Authorization', `Bearer ${another.token}`).expect(404);
    await http().get(`/api/operations/PUBLIC_SESSION_PUBLISH/${publishKey}`).set('Authorization', `Bearer ${pt.token}`).expect(403);
    expect(await db().collection('public_sessions').countDocuments()).toBe(1); expect(await db().collection('public_session_events').countDocuments()).toBe(2);
  });
  it('TC10: audit failure after writing aborts class, guard and operation; same key succeeds on retry', async () => {
    const row = await create(), key = randomUUID();
    const before = await db().collection('public_sessions').findOne({ _id: new ObjectId(row.id) });
    const guard = await db().collection('schedule_guards').findOne({});
    const repository = app.get(AdminPublicSessionsRepository), original = repository.insertEvent.bind(repository);
    const fault = jest.spyOn(repository, 'insertEvent').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('audit failure'); });
    await post(`/${row.id}/publish`, { version: 0 }, key).expect(500); fault.mockRestore();
    expect(await db().collection('public_sessions').findOne({ _id: new ObjectId(row.id) })).toEqual(before);
    expect(await db().collection('schedule_guards').findOne({})).toEqual(guard);
    expect(await db().collection('public_session_events').countDocuments()).toBe(1); expect(await db().collection('operation_requests').countDocuments()).toBe(1);
    await http().get(`/api/public-sessions/${row.id}`).expect(404);
    await post(`/${row.id}/publish`, { version: 0 }, key).expect(200);
  });
  it('list: VN overlap filters, stable pagination, all states and strict date/page validation', async () => {
    const first = await create(), second = await create('09:00', '09:45');
    await post(`/${second.id}/cancel`, { version: 0, reason: 'Thay đổi lịch tổ chức' }).expect(200);
    const query = `?fromDate=${day}&toDate=${day}`;
    const list = await get(`${query}&limit=1&page=1`).expect(200);
    expect(list.body).toMatchObject({ total: 2, totalPages: 2, items: [{ id: first.id }] });
    expect((await get(`${query}&status=CANCELLED&trainerId=${trainerId}&subjectCode=YOGA`).expect(200)).body.items[0].id).toBe(second.id);
    for (const suffix of ['&status=COMPLETED', '&page=0', '&limit=101', '&subjectCode=INVALID', '&trainerId=invalid', '&extra=1']) await get(`${query}${suffix}`).expect(400);
    await get('?fromDate=2035-02-30&toDate=2035-03-01').expect(400);
    await get('?fromDate=2035-01-01&toDate=2035-02-01').expect(400);
    expect((await get('?fromDate=2000-01-01&toDate=2000-01-01').expect(200)).body).toMatchObject({ items: [], totalPages: 0 });
  });
  it('migration: checks all rows before backfill; OTHER/version only when missing; repeat preserves timestamps/history', async () => {
    const row = await create();
    await db().collection('public_sessions').updateOne({ _id: new ObjectId(row.id) }, { $unset: { subject_code: '', version: '' } });
    const invalid = await create('10:00', '10:45');
    await db().collection('public_sessions').updateOne({ _id: new ObjectId(invalid.id) }, { $set: { subject_code: 'UNKNOWN' } });
    await expect(ensurePublicSessionsIntegrity(connection)).rejects.toThrow('PUBLIC_SESSION_DATA_INVALID');
    expect((await db().collection('public_sessions').findOne({ _id: new ObjectId(row.id) }))!.subject_code).toBeUndefined();
    await db().collection('public_sessions').updateOne({ _id: new ObjectId(invalid.id) }, { $set: { subject_code: 'ZUMBA' } });
    await ensurePublicSessionsIntegrity(connection);
    const migrated = await db().collection('public_sessions').findOne({ _id: new ObjectId(row.id) });
    expect(migrated).toMatchObject({ subject_code: 'OTHER', version: 0 });
    await ensurePublicSessionsIntegrity(connection);
    expect(await db().collection('public_sessions').findOne({ _id: new ObjectId(row.id) })).toEqual(migrated);
    expect(await db().collection('public_session_events').countDocuments()).toBe(2);
  });
});
