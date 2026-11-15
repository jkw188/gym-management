import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { ApplicationError } from '../src/common/errors/application-error';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { TrainersRepository } from '../src/modules/trainers/trainers.repository';
import { TrainersService } from '../src/modules/trainers/trainers.service';
import { ensureTrainersIntegrity } from '../src/modules/trainers/trainers-migration';
import { UsersRepository } from '../src/modules/users/users.repository';
import { RoleCode } from '../src/modules/users/schemas/role.schema';

const origin = 'http://localhost:5173';
const password = 'US23 integration fixture 123';
const now = new Date('2035-11-15T00:00:00.000Z');
const base = '/api/trainers';
interface Actor { id: string; phone: string; token: string }

describe('US-23: API, MongoDB constraints, rollback and account/schedule integration', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  let passwordHash: string;
  let admin: Actor;
  let pt: Actor;
  let sequence = 0;
  const savedEnv = { ...process.env };
  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());
  const count = (name: string, filter: Record<string, unknown> = {}) => db().collection(name).countDocuments(filter);

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_us23', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'), SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'us23-test', SMTP_PASS: 'us23-test', SMTP_FROM: 'no-reply@gym.test' });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    passwordHash = await app.get(PasswordService).hash(password);
  }, 600000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // MembersModule also provides a clock; cover all instances used by the real module graph.
    jest.spyOn(ServerClock.prototype, 'now').mockImplementation(() => new Date(now));
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await db().collections()) if (collection.collectionName !== 'roles') await collection.deleteMany({});
    await db().collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
    await db().collection<{ _id: string; revision: Long }>('security_state').insertOne({ _id: 'account-administration', revision: Long.ZERO });
    admin = await actor('ADMIN'); pt = await actor('TRAINER');
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = savedEnv; });

  async function actor(roleCode: RoleCode, name?: string): Promise<Actor> {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const phone = `091230${String(++sequence).padStart(4, '0')}`;
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName: name ?? `US23 ${roleCode} ${sequence}`, passwordHash });
    const login = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { id: account.id.toHexString(), phone, token: login.body.accessToken as string };
  }
  const get = (path = '', user: Actor = admin) => http().get(`${base}${path}`).set('Authorization', `Bearer ${user.token}`);
  const create = (body: object = { accountId: pt.id, specialty: '  Yoga  ', status: 'ACTIVE' }, key: string = randomUUID(), user: Actor = admin) =>
    http().post(base).set('Authorization', `Bearer ${user.token}`).set('Idempotency-Key', key).send(body);
  const update = (id: string, body: object, key: string = randomUUID(), user: Actor = admin) =>
    http().patch(`${base}/${id}`).set('Authorization', `Bearer ${user.token}`).set('Idempotency-Key', key).send(body);
  const profile = async () => (await create().expect(201)).body as { id: string; accountId: string; version: number };

  it('TC01: creates a trimmed profile version Int32=0 and one audit, without copying contact', async () => {
    const { body } = await create().expect(201);
    expect(body).toMatchObject({ accountId: pt.id, specialty: 'Yoga', status: 'ACTIVE', version: 0 });
    const row = await db().collection('trainers').findOne({ _id: new ObjectId(body.id) });
    expect(row).toMatchObject({ created_by: new ObjectId(admin.id), updated_by: new ObjectId(admin.id) });
    expect(row).not.toHaveProperty('full_name'); expect(row).not.toHaveProperty('phone'); expect(row).not.toHaveProperty('email');
    const [types] = await db().collection('trainers').aggregate([{ $project: { versionType: { $type: '$version' } } }]).toArray();
    expect(types.versionType).toBe('int');
    expect(await count('trainer_events', { action: 'CREATED' })).toBe(1);
    expect(await count('operation_requests', { operation: 'TRAINER_CREATE' })).toBe(1);
    expect(JSON.stringify(body)).not.toMatch(/password|auth_version|session|secret/i);
    await db().collection('accounts').updateOne({ _id: new ObjectId(pt.id) }, { $set: { full_name: 'Tên tài khoản mới' } });
    expect((await get(`/${body.id}`).expect(200)).body.fullName).toBe('Tên tài khoản mới');
  });
  it.each(['MEMBER', 'STAFF', 'TRAINER'] as const)('TC02: %s cannot list/detail/create/update/blockers or lookup', async role => {
    const row = await profile(), user = await actor(role);
    await get('', user).expect(403); await get(`/${row.id}`, user).expect(403); await get(`/${row.id}/deactivation-blockers`, user).expect(403);
    await create({}, randomUUID(), user).expect(403); await update(row.id, { version: 0, specialty: 'B' }, randomUUID(), user).expect(403);
    await http().get(`/api/operations/TRAINER_CREATE/${randomUUID()}`).set('Authorization', `Bearer ${user.token}`).expect(403);
    expect(await count('trainer_events')).toBe(1);
  });
  it('TC02: anonymous and revoked sessions are rejected before mutation or replay', async () => {
    await http().get(base).expect(401);
    const key = randomUUID(); await create(undefined, key).expect(201);
    await db().collection('auth_sessions').updateMany({ account_id: new ObjectId(admin.id) }, { $set: { revoked_at: new Date() } });
    await create(undefined, key).expect(401); await get().expect(401);
    expect(await count('trainer_events')).toBe(1);
  });
  it('TC03: rejects missing, wrong-role, locked and linked accounts; allows initial INACTIVE', async () => {
    expect((await create({ accountId: new ObjectId().toHexString(), specialty: 'A', status: 'ACTIVE' }).expect(404)).body.error.code).toBe('ACCOUNT_NOT_FOUND');
    expect((await create({ accountId: admin.id, specialty: 'A', status: 'ACTIVE' }).expect(409)).body.error.code).toBe('ACCOUNT_NOT_ELIGIBLE');
    await db().collection('accounts').updateOne({ _id: new ObjectId(pt.id) }, { $set: { status: 'LOCKED' } });
    expect((await create().expect(409)).body.error.code).toBe('ACCOUNT_NOT_ELIGIBLE');
    await db().collection('accounts').updateOne({ _id: new ObjectId(pt.id) }, { $set: { status: 'ACTIVE' } });
    await create({ accountId: pt.id, specialty: 'A', status: 'INACTIVE' }).expect(201);
    expect((await create().expect(409)).body.error.code).toBe('ACCOUNT_ALREADY_LINKED');
    expect(await count('trainers')).toBe(1);
  });
  it('TC05: create requires a valid key and rejects contact, owner and unknown input fields', async () => {
    const input = { accountId: pt.id, specialty: 'Yoga', status: 'ACTIVE' };
    await http().post(base).set('Authorization', `Bearer ${admin.token}`).send(input).expect(400);
    await create(input, 'invalid-key').expect(400);
    for (const extra of [{ phone: pt.phone }, { ownerId: admin.id }, { specialty: null }, { status: 'LOCKED' }]) {
      await create({ ...input, ...extra }).expect(400);
    }
    expect(await count('trainers')).toBe(0); expect(await count('trainer_events')).toBe(0);
  });
  it('TC04: actual account_id unique index rejects a second raw document', async () => {
    await profile();
    const row = await db().collection('trainers').findOne({ account_id: new ObjectId(pt.id) });
    await expect(db().collection('trainers').insertOne({ ...row!, _id: new ObjectId(), id: new ObjectId() })).rejects.toMatchObject({ code: 11000 });
    expect(await count('trainers')).toBe(1);
  });
  it.each([{ specialty: '' }, { specialty: '   ' }, { specialty: 'a'.repeat(256) }, { specialty: null },
    { accountId: 'a'.repeat(24) }, { fullName: 'Other' }, { status: 'LOCKED' }, { version: -1, specialty: 'B' },
    { version: '0', specialty: 'B' }, { version: 2147483648, specialty: 'B' }, {}])('TC05: rejects invalid update %j without modifying profile', async change => {
    const row = await profile(); await update(row.id, { version: 0, ...change }).expect(400);
    expect((await get(`/${row.id}`).expect(200)).body).toMatchObject({ specialty: 'Yoga', version: 0 });
    expect(await count('trainer_events')).toBe(1);
  });
  it('TC06: stale version conflicts; account is immutable; unchanged payload is rejected', async () => {
    const row = await profile();
    await update(row.id, { version: 0, specialty: '  Boxing ' }).expect(200);
    expect((await update(row.id, { version: 0, specialty: 'Yoga' }).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
    await update(row.id, { version: 1, specialty: 'Boxing' }).expect(400);
    const detail = (await get(`/${row.id}`).expect(200)).body;
    expect(detail).toMatchObject({ accountId: pt.id, specialty: 'Boxing', version: 1 });
  });
  it('TC07/12: paginates blockers across all three kinds, rechecks new/ongoing blockers, reveals no member data', async () => {
    const row = await profile(), trainer_id = new ObjectId(row.id);
    expect((await get(`/${row.id}/deactivation-blockers`).expect(200)).body.total).toBe(0);
    for (const [collection, status] of [['pt_bookings', 'BOOKED'], ['work_shifts', 'SCHEDULED'], ['public_sessions', 'PUBLISHED']]) {
      const schedules = [
        { trainer_id, status, start_at: new Date(now.getTime() - 60000), end_at: new Date(now.getTime() + 60000), member_id: new ObjectId(), private: 'hidden', request_key: randomBytes(32).toString('hex') },
        { trainer_id, status, start_at: new Date(now.getTime() - 120000), end_at: now, request_key: randomBytes(32).toString('hex') },
        { trainer_id, status: 'CANCELLED', start_at: now, end_at: new Date(now.getTime() + 60000), request_key: randomBytes(32).toString('hex') },
      ];
      await db().collection(collection).insertMany(schedules.map(schedule => {
        const id = new ObjectId(); return { _id: id, id, version: 0, created_at: now, updated_at: now,
          created_by: new ObjectId(admin.id), updated_by: new ObjectId(admin.id), location: 'PT 1', ...schedule };
      }));
    }
    const blockers = (await get(`/${row.id}/deactivation-blockers?limit=1`).expect(200)).body;
    expect(blockers).toMatchObject({ counts: { BOOKING: 1, SHIFT: 1, PUBLIC_SESSION: 1 }, total: 3, totalPages: 3, asOf: now.toISOString() });
    expect(blockers.items[0].kind).toBe('BOOKING');
    expect(JSON.stringify(blockers)).not.toMatch(/member_id|private|hidden/);
    expect((await get(`/${row.id}/deactivation-blockers?kind=SHIFT`).expect(200)).body.total).toBe(1);
    const failure = (await update(row.id, { version: 0, status: 'INACTIVE' }).expect(409)).body.error;
    expect(failure.code).toBe('TRAINER_HAS_ACTIVE_SCHEDULE');
    expect(failure.details).toContainEqual({ field: 'counts.BOOKING', message: '1' });
    expect(JSON.stringify(failure)).not.toMatch(/member_id|hidden/);
    expect(await count('trainer_events')).toBe(1);
    expect((await get(`/${row.id}`).expect(200)).body.status).toBe('ACTIVE');
  });
  it('TC08: retains past BOOKED and history, deactivates/reactivates and gates new shifts/availability', async () => {
    const row = await profile(), trainerId = new ObjectId(row.id);
    await db().collection('pt_bookings').insertOne({ trainer_id: trainerId, status: 'BOOKED', end_at: now, start_at: new Date(now.getTime() - 3600000) });
    await update(row.id, { version: 0, status: 'INACTIVE' }).expect(200);
    const member = await actor('MEMBER');
    const available = () => http().get('/api/me/pt-trainers').set('Authorization', `Bearer ${member.token}`);
    expect((await available().expect(200)).body.items).toHaveLength(0);
    const draft = { startAt: '2035-11-16T08:00:00+07:00', endAt: '2035-11-16T09:00:00+07:00', location: 'PT 1' };
    const shift = () => http().post('/api/me/work-shifts').set('Authorization', `Bearer ${pt.token}`).set('Idempotency-Key', randomUUID()).send(draft);
    expect((await shift().expect(409)).body.error.code).toBe('TRAINER_UNAVAILABLE');
    await update(row.id, { version: 1, status: 'ACTIVE' }).expect(200); await shift().expect(201);
    expect((await available().expect(200)).body.items).toHaveLength(1);
    expect(await count('pt_bookings', { status: 'BOOKED' })).toBe(1);
    expect(await count('trainer_events', { action: 'DEACTIVATED' })).toBe(1);
    expect(await count('trainer_events', { action: 'REACTIVATED' })).toBe(1);
  });
  it('TC10: a failure after inserting the audit rolls back profile, audit, key and guards', async () => {
    const repository = app.get(TrainersRepository), original = repository.insertEvent.bind(repository);
    const inject = jest.spyOn(repository, 'insertEvent').mockImplementationOnce(async (...args) => {
      await original(...args); throw new ApplicationError(503, 'TEST_AUDIT_FAILURE', 'Injected audit failure');
    });
    const key = randomUUID(); await create(undefined, key).expect(503);
    expect(await count('trainers')).toBe(0); expect(await count('trainer_events')).toBe(0); expect(await count('operation_requests')).toBe(0);
    expect(Number((await db().collection('schedule_guards').findOne({ _id: 'global' as unknown as ObjectId }))!.revision)).toBe(0);
    inject.mockRestore(); await create(undefined, key).expect(201);
    const row = await db().collection('trainers').findOne({});
    jest.spyOn(repository, 'insertEvent').mockRejectedValueOnce(new ApplicationError(503, 'TEST_AUDIT_FAILURE', 'Injected audit failure'));
    await update(String(row!._id), { version: 0, specialty: 'B' }).expect(503);
    expect((await get(`/${row!._id}`).expect(200)).body).toMatchObject({ specialty: 'Yoga', version: 0 });
  });
  it('TC10: post-commit response loss resolves through actor-owned lookup/replay; changed payload conflicts', async () => {
    const service = app.get(TrainersService), original = service.create.bind(service), key = randomUUID();
    jest.spyOn(service, 'create').mockImplementationOnce(async (...args) => {
      await original(...args); throw new ApplicationError(503, 'OPERATION_OUTCOME_UNKNOWN', 'Response lost after commit');
    });
    await create(undefined, key).expect(503);
    const lookup = await http().get(`/api/operations/TRAINER_CREATE/${key}`).set('Authorization', `Bearer ${admin.token}`).expect(200);
    const replay = await create(undefined, key).expect(201); expect(replay.body).toEqual(lookup.body.responseBody);
    expect((await create({ accountId: pt.id, specialty: 'Other', status: 'ACTIVE' }, key).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const another = await actor('ADMIN');
    await http().get(`/api/operations/TRAINER_CREATE/${key}`).set('Authorization', `Bearer ${another.token}`).expect(404);
    expect(await count('trainer_events')).toBe(1);
  });
  it('TC10: update replay returns the original body after later edits and binds the key to the resource', async () => {
    const row = await profile(), key = randomUUID();
    const first = await update(row.id, { version: 0, specialty: 'Boxing' }, key).expect(200);
    await update(row.id, { version: 1, specialty: 'Pilates' }).expect(200);
    expect((await update(row.id, { specialty: '  Boxing  ', version: 0 }, key).expect(200)).body).toEqual(first.body);
    const changedTarget = await update(new ObjectId().toHexString(), { version: 0, specialty: 'Boxing' }, key).expect(409);
    expect(changedTarget.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await get(`/${row.id}`).expect(200)).body).toMatchObject({ specialty: 'Pilates', version: 2 });
    expect(await count('trainer_events')).toBe(3);
  });
  it('TC11/US08: linked-account role change is blocked and account lock preserves trainer/schedule history', async () => {
    const row = await profile();
    const changeRole = await http().patch(`/api/users/${pt.id}/role`).set('Authorization', `Bearer ${admin.token}`)
      .send({ version: 0, roleCode: 'STAFF', reason: 'Kiểm thử bảo vệ liên kết PT' }).expect(409);
    expect(changeRole.body.error.code).toBe('ROLE_IN_USE');
    await http().patch(`/api/users/${pt.id}/status`).set('Authorization', `Bearer ${admin.token}`)
      .send({ version: 0, status: 'LOCKED', reason: 'Kiểm thử khóa tài khoản PT' }).expect(200);
    expect((await get(`/${row.id}`).expect(200)).body).toMatchObject({ status: 'ACTIVE', accountStatus: 'LOCKED' });
    await http().get('/api/me/work-shifts').set('Authorization', `Bearer ${pt.token}`).expect(401);
    const member = await actor('MEMBER');
    expect((await http().get('/api/me/pt-trainers').set('Authorization', `Bearer ${member.token}`).expect(200)).body.items).toHaveLength(0);
  });
  it('TC12: empty list, literal search, stable sorting, filters and strict query/ID validation', async () => {
    expect((await get().expect(200)).body).toEqual({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
    await profile();
    expect((await get('?q=.*').expect(200)).body.total).toBe(0);
    expect((await get('?q=Yoga&limit=1').expect(200)).body.total).toBe(1);
    expect((await get(`?q=${encodeURIComponent(pt.phone)}`).expect(200)).body.total).toBe(1);
    expect((await get('?status=INACTIVE').expect(200)).body.totalPages).toBe(0);
    const earlierName = await actor('TRAINER', 'AAA PT');
    await create({ accountId: earlierName.id, specialty: 'Boxing', status: 'ACTIVE' }).expect(201);
    expect((await get('?limit=1').expect(200)).body.items[0].accountId).toBe(earlierName.id);
    expect((await get('?limit=1&page=2').expect(200)).body.items[0].accountId).toBe(pt.id);
    for (const query of ['limit=101', 'page=0', 'q=' + 'a'.repeat(121), 'ownerId=x']) await get(`?${query}`).expect(400);
    await get('/invalid').expect(400); await get(`/${new ObjectId()}`).expect(404);
    await http().delete(`${base}/${new ObjectId()}`).set('Authorization', `Bearer ${admin.token}`).expect(404);
  });
  it('migration preflights legacy data, backfills absent id/version and preserves creator/history', async () => {
    const row = await profile();
    await db().collection('trainers').updateOne({ _id: new ObjectId(row.id) }, { $unset: { version: '', id: '' } });
    await ensureTrainersIntegrity(connection); await ensureTrainersIntegrity(connection);
    const migrated = await db().collection('trainers').findOne({ _id: new ObjectId(row.id) });
    expect(migrated).toMatchObject({ id: new ObjectId(row.id), version: 0, created_by: new ObjectId(admin.id) });
    await db().collection('trainers').updateOne({ _id: new ObjectId(row.id) }, { $unset: { created_by: '', version: '' } });
    await expect(ensureTrainersIntegrity(connection)).rejects.toThrow('TRAINER_DATA_INVALID');
    expect(await db().collection('trainers').findOne({ _id: new ObjectId(row.id) })).not.toHaveProperty('version');
  });
});
