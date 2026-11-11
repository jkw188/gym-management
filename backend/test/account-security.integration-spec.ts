import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Model, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import { ClientSession, MongoServerError } from 'mongodb';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { AuthService } from '../src/modules/auth/auth.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { AuthSession, AuthSessionSchema } from '../src/modules/auth/schemas/auth-session.schema';
import { AccountSecurityService } from '../src/modules/users/account-security.service';
import { Account, AccountSchema } from '../src/modules/users/schemas/account.schema';
import { Role, RoleCode, ROLE_CODES, RoleSchema } from '../src/modules/users/schemas/role.schema';
import { SecurityEvent, SecurityEventSchema } from '../src/modules/users/schemas/security-event.schema';
import { ACCOUNT_ADMINISTRATION, SecurityState, SecurityStateSchema } from '../src/modules/users/schemas/security-state.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const password = 'US-07 password 123';
const reason = 'Kiểm tra quyền truy cập';
const databaseName = 'gym_management_test_us07';

describe('US-07: real replica set, two independent Nest apps/connections, JWT and sessions', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let secondApp: INestApplication;
  let connection: Connection;
  let accounts: Model<Account>;
  let roles: Model<Role>;
  let sessions: Model<AuthSession>;
  let state: Model<SecurityState>;
  let events: Model<SecurityEvent>;
  let repository: UsersRepository;
  let hash: string;
  let admin: Account;
  let token: string;
  let phoneSequence = 0;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' },
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(), MONGODB_DB: databaseName, JWT_ACCESS_SECRET: randomBytes(32).toString('base64url') });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    accounts = app.get<Model<Account>>(getModelToken('Account'));
    roles = app.get<Model<Role>>(getModelToken('Role'));
    sessions = app.get<Model<AuthSession>>(getModelToken('AuthSession'));
    state = app.get<Model<SecurityState>>(getModelToken('SecurityState'));
    events = app.get<Model<SecurityEvent>>(getModelToken('SecurityEvent'));
    repository = app.get(UsersRepository);
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    secondApp = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(secondApp); await secondApp.init();
    expect(secondApp.get(getConnectionToken())).not.toBe(connection);
    hash = await app.get(PasswordService).hash(password);
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Each case gets a fresh real limiter window; JWT, sessions and RBAC remain active.
    for (const instance of [app, secondApp]) {
      const limiter = new LoginLimiter();
      jest.spyOn(instance.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    }
    await Promise.all([accounts.deleteMany({}), roles.deleteMany({}), sessions.deleteMany({}), events.deleteMany({}), state.deleteMany({})]);
    for (const code of ROLE_CODES) await repository.ensureRole(code, code);
    await state.create({ _id: ACCOUNT_ADMINISTRATION, revision: 0n });
    admin = await fixture('ADMIN');
    token = (await login(admin.phone).expect(200)).body.accessToken;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await secondApp?.close(); await app?.close(); await mongo?.stop(); process.env = savedEnv; });

  async function fixture(roleCode: RoleCode = 'MEMBER') {
    const role = await repository.findRoleByCode(roleCode);
    const phone = `090${String(++phoneSequence).padStart(7, '0')}`;
    return repository.createAccount({ roleId: role!.id.toHexString(), fullName: `Test ${roleCode}`, phone, passwordHash: hash });
  }
  function login(phone: string) { return request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password }); }
  function patch(target: Account | string, body: object = { status: 'LOCKED', version: 0, reason }, bearer = token, server = app) {
    const id = typeof target === 'string' ? target : target.id.toHexString();
    return request(server.getHttpServer()).patch(`/api/users/${id}/status`).set('Authorization', `Bearer ${bearer}`).send(body);
  }
  function get(id: string, bearer = token) { return request(app.getHttpServer()).get(`/api/users/${id}`).set('Authorization', `Bearer ${bearer}`); }
  const refresh = (cookie: string) => request(app.getHttpServer()).post('/api/auth/refresh').set('Origin', origin).set('Cookie', cookie).send({});
  const cookie = (result: { headers: Record<string, unknown> }) => (result.headers['set-cookie'] as string[])[0].split(';')[0];
  const revision = async () => (await state.findById(ACCOUNT_ADMINISTRATION).orFail()).revision;
  const activeAdmins = async () => accounts.countDocuments({ role_id: (await repository.findRoleByCode('ADMIN'))!.id, status: 'ACTIVE' });

  it.each(['MEMBER', 'STAFF', 'TRAINER'] as const)('TC01–03: lock/unlock %s, audit allowlist and preserve operational data', async roleCode => {
    const target = await fixture(roleCode);
    const related = ['trainers', 'memberships', 'pt_bookings', 'orders'];
    for (const name of related) await connection.collection(name).insertOne({ account_id: target.id, status: 'KEEP', test: 'US07',
      // EN-02 now installs a real unique membership->sale constraint in the CLI migration test.
      ...(name === 'memberships' ? { service_sale_id: new Types.ObjectId() } : {}) });
    const snapshots = await Promise.all(related.map(name => connection.collection(name).find({ test: 'US07' }).toArray()));
    const first = await patch(target, { status: 'LOCKED', version: 0, reason: `  ${reason}  ` }).expect(200);
    expect(first.body).toMatchObject({ changed: true, reauthenticationRequired: false, user: { status: 'LOCKED', version: 1 } });
    const second = await patch(target, { status: 'ACTIVE', version: 1, reason }).expect(200);
    expect(second.body.user).toMatchObject({ status: 'ACTIVE', version: 2 });
    expect(JSON.stringify(second.body)).not.toMatch(/auth_version|authVersion|password|token|sessionId/);
    const stored = await accounts.findById(target.id).orFail();
    expect(Number(stored.auth_version)).toBe(2);
    expect(stored.updated_at.getTime()).toBeGreaterThanOrEqual(target.updated_at.getTime());
    const audit = await events.find({ target_id: target.id }).sort({ created_at: 1, _id: 1 }).lean();
    expect(audit.map(item => item.action)).toEqual(['LOCK', 'UNLOCK']);
    expect(audit[0]).toMatchObject({ actor_id: admin.id, target_id: target.id, before: { status: 'ACTIVE' }, after: { status: 'LOCKED' }, reason,
      request_id: first.headers['x-request-id'] });
    expect(audit[0].created_at).toBeInstanceOf(Date);
    expect(Object.keys(audit[0]).sort()).toEqual(['_id', 'actor_id', 'target_id', 'action', 'before', 'after', 'reason', 'created_at', 'request_id'].sort());
    expect(await Promise.all(related.map(name => connection.collection(name).find({ test: 'US07' }).toArray()))).toEqual(snapshots);
    expect(await revision()).toBe(2n);
    const [bson] = await state.aggregate([{ $project: { revisionType: { $type: '$revision' } } }]);
    expect(bson.revisionType).toBe('long');
  });

  it('TC04–05: lock rejects login/access/refresh; unlock permits new login but never old tokens', async () => {
    const target = await fixture();
    const old = await login(target.phone).expect(200);
    await patch(target).expect(200);
    await login(target.phone).expect(401);
    await get(target.id.toHexString(), old.body.accessToken).expect(401);
    await refresh(cookie(old)).expect(401);
    await patch(target, { status: 'ACTIVE', version: 1, reason }).expect(200);
    await get(target.id.toHexString(), old.body.accessToken).expect(401);
    await refresh(cookie(old)).expect(401);
    await login(target.phone).expect(200);
  });

  it('TC06: two apps submit the same version, one succeeds and one returns VERSION_CONFLICT', async () => {
    const target = await fixture();
    const responses = await Promise.all([patch(target), patch(target, undefined, token, secondApp)]);
    expect(responses.map(result => result.status).sort()).toEqual([200, 409]);
    expect(responses.find(result => result.status === 409)!.body.error.code).toBe('VERSION_CONFLICT');
    expect(await events.countDocuments()).toBe(1);
    expect(await revision()).toBe(1n);
    expect(Number((await accounts.findById(target.id).orFail()).auth_version)).toBe(1);
  });

  it('TC07: correct-version no-op preserves account/timestamp/audit; stale no-op returns 409', async () => {
    const target = await fixture();
    await patch(target, { status: 'ACTIVE', version: 0, reason }).expect(200).expect(result => {
      expect(result.body).toMatchObject({ changed: false, reauthenticationRequired: false, user: { version: 0 } });
    });
    expect((await accounts.findById(target.id).orFail()).updated_at).toEqual(target.updated_at);
    expect(await events.countDocuments()).toBe(0);
    await patch(target).expect(200);
    const result = await patch(target).expect(409);
    expect(result.body.error.code).toBe('VERSION_CONFLICT');
    expect(await events.countDocuments()).toBe(1);
  });

  it('TC08–09: real guards and strict DTO reject invalid/missing ID, reason, version, extra fields and non-admin', async () => {
    await patch(admin, undefined, '').expect(401);
    for (const roleCode of ['STAFF', 'TRAINER', 'MEMBER'] as const) {
      const actor = await fixture(roleCode);
      await patch(admin, undefined, (await login(actor.phone).expect(200)).body.accessToken).expect(403);
    }
    for (const body of [{ status: 'LOCKED', version: 0, reason: 'short' }, { status: 'LOCKED', version: '0', reason },
      { status: 'LOCKED', version: -1, reason }, { status: 'LOCKED', version: 0.5, reason }, { status: 'LOCKED', version: 0, reason: null },
      { status: 'LOCKED', version: 0, reason: ` ${'a'.repeat(9)} ` }, { status: 'LOCKED', version: 0, reason: 'a'.repeat(501) },
      { status: 'OTHER', version: 0, reason }, { status: 'LOCKED', reason },
      ...['roleCode', 'actorId', 'created_at', 'auth_version'].map(field => ({ status: 'LOCKED', version: 0, reason, [field]: 'forbidden' }))]) {
      expect((await patch(admin, body).expect(400)).body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await patch('invalid').expect(400)).body.error.code).toBe('INVALID_ID');
    expect((await patch(new Types.ObjectId().toHexString()).expect(404)).body.error.code).toBe('USER_NOT_FOUND');
    expect(await revision()).toBe(0n);
    expect(await events.countDocuments()).toBe(0);
  });

  it('SEC03: revalidates actor status, role, auth_version and session inside the transaction', async () => {
    const target = await fixture();
    const service = app.get(AccountSecurityService);
    const auth = app.get(AuthService);
    for (const mutation of ['locked', 'demoted', 'auth-version', 'revoked', 'expired'] as const) {
      const actor = await fixture('ADMIN');
      const bearer = (await login(actor.phone).expect(200)).body.accessToken;
      const principal = await auth.validateAccessToken(bearer);
      if (mutation === 'locked') await service.changeStatus(await auth.validateAccessToken(token), actor.id.toHexString(), { status: 'LOCKED', version: 0, reason }, randomUUID());
      if (mutation === 'demoted') await service.changeRole(await auth.validateAccessToken(token), actor.id.toHexString(), { roleCode: 'STAFF', version: 0, reason }, randomUUID());
      if (mutation === 'auth-version') await accounts.updateOne({ _id: actor.id }, { $inc: { auth_version: 1 } });
      if (mutation === 'revoked') await sessions.updateMany({ account_id: actor.id }, { $set: { revoked_at: new Date() } });
      if (mutation === 'expired') await sessions.updateMany({ account_id: actor.id }, { $set: { expires_at: new Date(0) } }, { overwriteImmutable: true });
      const before = await revision();
      await expect(service.changeStatus(principal, target.id.toHexString(), { status: 'LOCKED', version: 0, reason }, randomUUID()))
        .rejects.toMatchObject({ status: 401 });
      expect(await revision()).toBe(before);
      await patch(target, undefined, bearer).expect(401);
    }
    expect((await accounts.findById(target.id).orFail()).status).toBe('ACTIVE');
  });

  it('TC10: cannot self-lock or demote the last active admin; locked admins do not count', async () => {
    const other = await fixture('ADMIN');
    await patch(other).expect(200);
    expect((await patch(admin).expect(409)).body.error.code).toBe('LAST_ACTIVE_ADMIN');
    const actor = await app.get(AuthService).validateAccessToken(token);
    await expect(app.get(AccountSecurityService).changeRole(actor, admin.id.toHexString(), { roleCode: 'STAFF', version: 0, reason }, randomUUID()))
      .rejects.toMatchObject({ status: 409, code: 'LAST_ACTIVE_ADMIN' });
    expect(await activeAdmins()).toBe(1);
    expect(await revision()).toBe(1n);
  });

  it('TC11: two admins lock one another through two app instances, preserving an active admin', async () => {
    const other = await fixture('ADMIN');
    const otherToken = (await login(other.phone).expect(200)).body.accessToken;
    const results = await Promise.all([patch(other), patch(admin, undefined, otherToken, secondApp)]);
    expect(results.filter(result => result.status === 200)).toHaveLength(1);
    expect([401, 409]).toContain(results.find(result => result.status !== 200)!.status);
    expect(await activeAdmins()).toBe(1);
    expect(await events.countDocuments()).toBe(1);
    expect(await revision()).toBe(1n);
  });

  it('TC12: lock races the shared US-08 role contract through independent connections', async () => {
    const other = await fixture('ADMIN');
    const otherToken = (await login(other.phone).expect(200)).body.accessToken;
    const principal = await secondApp.get(AuthService).validateAccessToken(otherToken);
    const results = await Promise.allSettled([
      patch(other).then(result => { if (result.status !== 200) throw result.body; return result.body; }),
      secondApp.get(AccountSecurityService).changeRole(principal, admin.id.toHexString(), { roleCode: 'STAFF', version: 0, reason }, randomUUID()),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await activeAdmins()).toBe(1);
    expect(await events.countDocuments()).toBe(1);
    expect(await revision()).toBe(1n);
  });

  it('TC12: two admins demote one another using the same shared DB write', async () => {
    const other = await fixture('ADMIN');
    const otherToken = (await login(other.phone).expect(200)).body.accessToken;
    const left = await app.get(AuthService).validateAccessToken(token);
    const right = await secondApp.get(AuthService).validateAccessToken(otherToken);
    const results = await Promise.allSettled([
      app.get(AccountSecurityService).changeRole(left, other.id.toHexString(), { roleCode: 'STAFF', version: 0, reason }, randomUUID()),
      secondApp.get(AccountSecurityService).changeRole(right, admin.id.toHexString(), { roleCode: 'MEMBER', version: 0, reason }, randomUUID()),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await activeAdmins()).toBe(1);
    expect(await events.countDocuments()).toBe(1);
  });

  it('TC13: audit insert failure rolls back account and security revision', async () => {
    const target = await fixture();
    jest.spyOn(events, 'create').mockRejectedValueOnce(new Error('application audit failpoint'));
    await patch(target).expect(503);
    const stored = await accounts.findById(target.id).orFail();
    expect(stored.status).toBe('ACTIVE'); expect(Number(stored.version)).toBe(0); expect(Number(stored.auth_version)).toBe(0);
    expect(stored.updated_at).toEqual(target.updated_at);
    expect(await revision()).toBe(0n); expect(await events.countDocuments()).toBe(0);
  });

  it('SEC04: driver retries a transient audit conflict, committing one account change and one audit', async () => {
    const target = await fixture();
    const create = events.create.bind(events);
    const transient = new MongoServerError({ message: 'application transient conflict', errorLabels: ['TransientTransactionError'] });
    jest.spyOn(events, 'create').mockImplementationOnce(async (...args: Parameters<typeof create>) => {
      await create(...args); throw transient;
    });
    await patch(target).expect(200);
    expect(await events.countDocuments()).toBe(1);
    expect(await revision()).toBe(1n);
    expect(Number((await accounts.findById(target.id).orFail()).version)).toBe(1);
  });

  it('TC14: unknown commit retries stop at the 10-second deadline and return an uncertain 503', async () => {
    const target = await fixture();
    const unknown = new MongoServerError({ message: 'application commit failpoint', errorLabels: ['UnknownTransactionCommitResult'] });
    jest.spyOn(ClientSession.prototype, 'commitTransaction').mockRejectedValue(unknown);
    const startedAt = Date.now();
    const response = await patch(target).expect(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.body.error.message).toContain('Chưa xác định');
    expect(Date.now() - startedAt).toBeLessThan(12500);
    // The failpoint never committed; a real unknown result must always be reconciled by GET.
    expect((await get(target.id.toHexString()).expect(200)).body.status).toBe('ACTIVE');
    expect(await events.countDocuments()).toBe(0); expect(await revision()).toBe(0n);
  }, 30000);

  it('TC13: error after account and audit writes but before commit rolls back all three documents', async () => {
    const target = await fixture();
    const runner = app.get(TransactionRunner);
    const run = runner.run.bind(runner);
    jest.spyOn(runner, 'run').mockImplementation(work => run(async session => {
      await work(session); throw new Error('application before-commit failpoint');
    }));
    await patch(target).expect(503);
    expect((await accounts.findById(target.id).orFail()).status).toBe('ACTIVE');
    expect(await revision()).toBe(0n); expect(await events.countDocuments()).toBe(0);
  });

  it('TC14: missing security_state fails closed with a distinct 503 code', async () => {
    const target = await fixture();
    await state.deleteMany({});
    expect((await patch(target).expect(503)).body.error.code).toBe('SECURITY_STATE_NOT_READY');
    expect((await accounts.findById(target.id).orFail()).status).toBe('ACTIVE');
    expect(await events.countDocuments()).toBe(0); expect(await state.countDocuments()).toBe(0);
  });

  it('TC15: self-lock returns reauthenticationRequired and revokes the current access/refresh', async () => {
    await fixture('ADMIN');
    const auth = await login(admin.phone).expect(200);
    expect((await patch(admin, undefined, auth.body.accessToken).expect(200)).body.reauthenticationRequired).toBe(true);
    await get(admin.id.toHexString(), auth.body.accessToken).expect(401);
    await refresh(cookie(auth)).expect(401);
    expect(await activeAdmins()).toBe(1);
  });

  it('ensure-indexes initializes Int64 security_state idempotently and preserves revision and audit indexes', async () => {
    await state.deleteMany({});
    // US-28 bước 2: migration lịch coi booking không có membership là mồ côi và dừng lệnh; dọn booking "rác" do TC01–03 để lại.
    await connection.collection('pt_bookings').deleteMany({ test: 'US07' });
    // Chạy BẤT ĐỒNG BỘ để Jest vẫn đọc log của mongod (execFileSync làm đầy pipe log, lệnh có thể treo; xem US-28 scheduling-migration).
    const command = () => new Promise<string>((resolve, reject) => execFile(process.execPath, ['scripts/admin.cjs', 'ensure-indexes'], {
      cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 30000, windowsHide: true,
    }, (error, stdout, stderr) => (error ? reject(new Error(`${stdout}${stderr}`)) : resolve(stdout))));
    expect(await command()).toContain('INDEXES_ENSURED');
    expect(await revision()).toBe(0n);
    await state.updateOne({ _id: ACCOUNT_ADMINISTRATION }, { $inc: { revision: 7n } });
    expect(await command()).toContain('INDEXES_ENSURED');
    expect(await revision()).toBe(7n);
    const indexes = await events.collection.listIndexes().toArray();
    expect(indexes.map(index => index.key)).toEqual(expect.arrayContaining([{ target_id: 1, created_at: -1, _id: -1 }, { actor_id: 1, created_at: -1 }]));
  });

  it('TC14: unavailable database in an HTTP guard returns 503 and never changes target data', async () => {
    const target = await fixture();
    await secondApp.get<Connection>(getConnectionToken()).close();
    expect((await patch(target, undefined, token, secondApp).expect(503)).body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect((await accounts.findById(target.id).orFail()).status).toBe('ACTIVE');
    expect(await events.countDocuments()).toBe(0); expect(await revision()).toBe(0n);
  });
});

describe('US-07: standalone cannot perform security writes', () => {
  it('TC14: returns 503 without changing account/state/audit when transactions are unavailable', async () => {
    const mongo = await MongoMemoryServer.create({ binary: { version: '8.0.17' } });
    const mongoose = await import('mongoose');
    const os = await import('node:os');
    const connection = await mongoose.createConnection(mongo.getUri(), { dbName: 'us07_standalone', runtimeAdapters: { os } }).asPromise();
    try {
      const accounts = connection.model('Account', AccountSchema);
      const roles = connection.model('Role', RoleSchema);
      const sessions = connection.model('AuthSession', AuthSessionSchema);
      const state = connection.model<SecurityState>('SecurityState', SecurityStateSchema);
      const events = connection.model<SecurityEvent>('SecurityEvent', SecurityEventSchema);
      await state.create({ _id: ACCOUNT_ADMINISTRATION, revision: 0n });
      const service = new AccountSecurityService(accounts, roles, sessions, state, events, new TransactionRunner(connection), new ConfigService());
      await expect(service.changeStatus({ id: new Types.ObjectId().toHexString(), fullName: 'Admin', phone: '+84901234567', roleCode: 'ADMIN' },
        new Types.ObjectId().toHexString(), { status: 'LOCKED', version: 0, reason }, randomUUID()))
        .rejects.toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
      expect((await state.findById(ACCOUNT_ADMINISTRATION).orFail()).revision).toBe(0n);
      expect(await events.countDocuments()).toBe(0);
    } finally { await connection.close(); await mongo.stop(); }
  }, 600000);
});
