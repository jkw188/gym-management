import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Model, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import { ClientSession, MongoServerError } from 'mongodb';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { PUBLIC_ROUTE, REQUIRED_ROLES } from '../src/modules/auth/auth.decorators';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { ProfileController } from '../src/modules/profile/profile.controller';
import { AccessCatalogService } from '../src/modules/users/access-catalog.service';
import { AccessController } from '../src/modules/users/access.controller';
import { ACCESS_POLICY, FIXED_PERMISSION, PermissionCode } from '../src/modules/users/access.policy';
import { AccountSecurityService } from '../src/modules/users/account-security.service';
import { Account } from '../src/modules/users/schemas/account.schema';
import { Permission, RolePermission } from '../src/modules/users/schemas/permission.schema';
import { ROLE_CODES, RoleCode } from '../src/modules/users/schemas/role.schema';
import { SecurityEvent } from '../src/modules/users/schemas/security-event.schema';
import { ACCOUNT_ADMINISTRATION, SecurityState } from '../src/modules/users/schemas/security-state.schema';
import { UsersController } from '../src/modules/users/users.controller';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const password = 'US08 test password 123';
const reason = 'Điều chỉnh trách nhiệm tài khoản';
const savedEnv = { ...process.env };

describe('US-08 TC01–16: real DB, RBAC/session, two applications sharing the US-07 lock', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let secondApp: INestApplication;
  let connection: Connection;
  let accounts: Model<Account>;
  let events: Model<SecurityEvent>;
  let state: Model<SecurityState>;
  let permissions: Model<Permission>;
  let mappings: Model<RolePermission>;
  let repository: UsersRepository;
  let catalog: AccessCatalogService;
  let admin: Account;
  let token: string;
  let hash: string;
  let sequence = 0;

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_us08', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url') });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    accounts = app.get(getModelToken('Account')); events = app.get(getModelToken('SecurityEvent'));
    state = app.get(getModelToken('SecurityState')); permissions = app.get(getModelToken('Permission')); mappings = app.get(getModelToken('RolePermission'));
    repository = app.get(UsersRepository); catalog = app.get(AccessCatalogService);
    secondApp = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(secondApp); await secondApp.init();
    expect(secondApp.get(getConnectionToken())).not.toBe(connection);
    hash = await app.get(PasswordService).hash(password);
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const instance of [app, secondApp]) {
      const limiter = new LoginLimiter();
      jest.spyOn(instance.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    }
    await Promise.all([accounts.deleteMany({}), events.deleteMany({}), state.deleteMany({}),
      connection.collection('auth_sessions').deleteMany({}), connection.collection('members').deleteMany({}),
      connection.collection('trainers').deleteMany({}), connection.collection('roles').deleteMany({}),
      permissions.deleteMany({}), mappings.deleteMany({})]);
    await catalog.seed();
    await state.create({ _id: ACCOUNT_ADMINISTRATION, revision: 0n });
    admin = await fixture('ADMIN'); token = (await login(admin.phone).expect(200)).body.accessToken;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await secondApp?.close(); await app?.close(); await mongo?.stop(); process.env = savedEnv; });

  async function fixture(roleCode: RoleCode = 'STAFF') {
    const role = await repository.findRoleByCode(roleCode);
    return repository.createAccount({ roleId: role!.id.toHexString(), fullName: `Test ${roleCode}`,
      phone: `091${String(++sequence).padStart(7, '0')}`, passwordHash: hash });
  }
  const login = (phone: string) => request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password });
  const cookie = (response: { headers: Record<string, unknown> }) => (response.headers['set-cookie'] as string[])[0].split(';')[0];
  const refresh = (value: string) => request(app.getHttpServer()).post('/api/auth/refresh').set('Origin', origin).set('Cookie', value).send({});
  const getCatalog = (bearer = token) => request(app.getHttpServer()).get('/api/access/roles').set('Authorization', `Bearer ${bearer}`);
  function patch(target: Account | string, body: object = { roleCode: 'ADMIN', version: 0, reason }, bearer = token, instance = app) {
    return request(instance.getHttpServer()).patch(`/api/users/${typeof target === 'string' ? target : target.id.toHexString()}/role`).set('Authorization', `Bearer ${bearer}`).send(body);
  }
  const revision = async () => (await state.findById(ACCOUNT_ADMINISTRATION).orFail()).revision;
  const activeAdmins = async () => accounts.countDocuments({ role_id: (await repository.findRoleByCode('ADMIN'))!.id, status: 'ACTIVE' });

  it('TC01: ordered catalog matches roles used by US-06, sorted permissions, ADMIN only', async () => {
    const response = await getCatalog().expect(200);
    expect(response.body.items.map((role: { code: string }) => role.code)).toEqual(ROLE_CODES);
    const basic = await request(app.getHttpServer()).get('/api/users/roles').set('Authorization', `Bearer ${token}`).expect(200);
    expect(response.body.items.map(({ code, name }: { code: string; name: string }) => ({ code, name }))).toEqual(basic.body.items);
    for (const role of response.body.items) {
      const expected = Object.keys(ACCESS_POLICY).filter(key => (ACCESS_POLICY[key as PermissionCode].roles as readonly string[]).includes(role.code)).sort();
      expect(role.permissions.map((item: { code: string }) => item.code)).toEqual(expected);
    }
    expect(response.body.items[2].name).toBe('PT');
    await getCatalog('').expect(401);
    for (const code of ['STAFF', 'TRAINER', 'MEMBER'] as const) {
      const actor = await fixture(code);
      const auth = await login(actor.phone).expect(200);
      await getCatalog(auth.body.accessToken).expect(403);
      await patch(admin, undefined, auth.body.accessToken).expect(403);
    }
  });

  it('TC02: every declared S01 endpoint decorator and stored mapping derive from the single fixed policy', async () => {
    const endpoints: [object, string, PermissionCode][] = [
      [UsersController.prototype, 'list', 'accounts.read'], [UsersController.prototype, 'roles', 'accounts.read'],
      [UsersController.prototype, 'detail', 'accounts.read'], [UsersController.prototype, 'create', 'accounts.create'],
      [UsersController.prototype, 'update', 'accounts.update'], [UsersController.prototype, 'changeStatus', 'accounts.changeStatus'],
      [UsersController.prototype, 'changeRole', 'accounts.changeRole'], [AccessController.prototype, 'roles', 'accounts.changeRole'],
      [ProfileController.prototype, 'me', 'profile.readOwn'], [ProfileController.prototype, 'update', 'profile.updateOwn'],
      [AuthController.prototype, 'me', 'auth.me'], [AuthController.prototype, 'logout', 'auth.logout'],
    ];
    for (const [prototype, method, permission] of endpoints) {
      const handler: unknown = Object.getOwnPropertyDescriptor(prototype, method)?.value;
      expect(Reflect.getMetadata(FIXED_PERMISSION, handler as object)).toBe(permission);
      if (permission === 'auth.logout') expect(Reflect.getMetadata(PUBLIC_ROUTE, handler as object)).toBe(true);
      else expect(Reflect.getMetadata(REQUIRED_ROLES, handler as object)).toEqual(ACCESS_POLICY[permission].roles);
    }
    expect(await permissions.countDocuments()).toBe(Object.keys(ACCESS_POLICY).length);
    expect(await mappings.countDocuments()).toBe(Object.values(ACCESS_POLICY).reduce((count, rule) => count + rule.roles.length, 0));
    for (const name of ['register', 'login', 'refresh']) {
      const handler = Object.getOwnPropertyDescriptor(AuthController.prototype, name)!.value as object;
      expect(Reflect.getMetadata(PUBLIC_ROUTE, handler)).toBe(true);
      expect(Reflect.getMetadata(FIXED_PERMISSION, handler)).toBeUndefined();
    }
  });

  it('TC03/07: strict DTO, ID and missing account validation never modifies data', async () => {
    const target = await fixture();
    for (const body of [{ roleCode: 'OTHER', version: 0, reason }, { roleCode: ['ADMIN'], version: 0, reason },
      { roleCode: 'ADMIN', version: '0', reason }, { roleCode: 'ADMIN', version: -1, reason }, { roleCode: 'ADMIN', version: 0.1, reason },
      { roleCode: 'ADMIN', version: 2147483648, reason }, { roleCode: 'ADMIN', reason }, { version: 0, reason },
      { roleCode: 'ADMIN', version: 0, reason: ' short ' }, { roleCode: 'ADMIN', version: 0, reason: 'x'.repeat(501) },
      { roleCode: 'ADMIN', version: 0, reason: null },
      ...['permissions', 'roleCodes', 'actorId', 'status', 'auth_version', 'updated_at'].map(field => ({ roleCode: 'ADMIN', version: 0, reason, [field]: 'forbidden' }))]) {
      await patch(target, body).expect(400);
    }
    expect((await patch('bad').expect(400)).body.error.code).toBe('INVALID_ID');
    expect((await patch(new Types.ObjectId().toHexString()).expect(404)).body.error.code).toBe('USER_NOT_FOUND');
    expect(await events.countDocuments()).toBe(0); expect(await revision()).toBe(0n);
  });

  it('TC04: STAFF→ADMIN atomically audits/increments and revokes every old access/refresh; login gets new privileges', async () => {
    const target = await fixture();
    const old = await login(target.phone).expect(200);
    const other = await login(target.phone).expect(200);
    const response = await patch(target, { roleCode: 'ADMIN', version: 0, reason: `  ${reason}  ` }).expect(200);
    expect(response.body).toMatchObject({ changed: true, reauthenticationRequired: false, user: { roleCode: 'ADMIN', version: 1, status: 'ACTIVE' } });
    expect(JSON.stringify(response.body)).not.toMatch(/auth_version|authVersion|password|token|sessionId/);
    const stored = await accounts.findById(target.id).orFail();
    expect(Number(stored.auth_version)).toBe(1); expect(stored.updated_at.getTime()).toBeGreaterThanOrEqual(target.updated_at.getTime());
    const audit = await events.findOne({ target_id: target.id }).lean().orFail();
    expect(audit).toMatchObject({ action: 'CHANGE_ROLE', actor_id: admin.id, target_id: target.id,
      before: { roleCode: 'STAFF' }, after: { roleCode: 'ADMIN' }, reason, request_id: response.headers['x-request-id'] });
    expect(Object.keys(audit).sort()).toEqual(['_id', 'actor_id', 'target_id', 'action', 'before', 'after', 'reason', 'created_at', 'request_id'].sort());
    for (const auth of [old, other]) {
      await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${auth.body.accessToken}`).expect(401);
      await refresh(cookie(auth)).expect(401);
    }
    const fresh = await login(target.phone).expect(200);
    expect(fresh.body.user.roleCode).toBe('ADMIN'); await getCatalog(fresh.body.accessToken).expect(200);
  });

  it('TC05: changing a LOCKED account preserves its status and prevents login', async () => {
    const target = await fixture();
    await request(app.getHttpServer()).patch(`/api/users/${target.id}/status`).set('Authorization', `Bearer ${token}`).send({ status: 'LOCKED', version: 0, reason }).expect(200);
    const response = await patch(target, { roleCode: 'TRAINER', version: 1, reason }).expect(200);
    expect(response.body.user).toMatchObject({ roleCode: 'TRAINER', status: 'LOCKED', version: 2 });
    await login(target.phone).expect(401);
  });

  it('TC06: self-demotion requires reauthentication; old access and refresh cannot restore Admin', async () => {
    await fixture('ADMIN');
    const auth = await login(admin.phone).expect(200);
    expect((await patch(admin, { roleCode: 'STAFF', version: 0, reason }, auth.body.accessToken).expect(200)).body.reauthenticationRequired).toBe(true);
    await getCatalog(auth.body.accessToken).expect(401); await refresh(cookie(auth)).expect(401);
    const fresh = await login(admin.phone).expect(200);
    expect(fresh.body.user.roleCode).toBe('STAFF'); await getCatalog(fresh.body.accessToken).expect(403);
  });

  it('TC07: no-op preserves timestamp, versions and audit; stale version always conflicts', async () => {
    const target = await fixture();
    const response = await patch(target, { roleCode: 'STAFF', version: 0, reason }).expect(200);
    expect(response.body).toMatchObject({ changed: false, reauthenticationRequired: false, user: { version: 0 } });
    expect((await accounts.findById(target.id).orFail()).updated_at).toEqual(target.updated_at);
    expect(Number((await accounts.findById(target.id).orFail()).auth_version)).toBe(0);
    expect(await events.countDocuments()).toBe(0);
    await patch(target).expect(200);
    expect((await patch(target, { roleCode: 'ADMIN', version: 0, reason }).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
  });

  it('TC08: simultaneous changes to one version through two instances produce exactly one audit', async () => {
    const target = await fixture();
    const responses = await Promise.all([patch(target), patch(target, { roleCode: 'TRAINER', version: 0, reason }, token, secondApp)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(responses.find(response => response.status === 409)!.body.error.code).toBe('VERSION_CONFLICT');
    expect(await events.countDocuments()).toBe(1); expect(await revision()).toBe(1n);
  });

  it.each(['members', 'trainers'])('TC09: %s reference blocks every real role change, with no-op allowed and data preserved', async collection => {
    const target = await fixture(collection === 'members' ? 'MEMBER' : 'TRAINER');
    const profile = { _id: new Types.ObjectId(), account_id: target.id, full_name: target.full_name, phone: target.phone, status: 'ACTIVE' };
    await connection.collection(collection).insertOne(profile);
    const before = await connection.collection(collection).findOne({ _id: profile._id });
    expect((await patch(target).expect(409)).body.error.code).toBe('ROLE_IN_USE');
    expect((await patch(target, { roleCode: target.role_id.equals((await repository.findRoleByCode('MEMBER'))!.id) ? 'MEMBER' : 'TRAINER', version: 0, reason }).expect(200)).body.changed).toBe(false);
    expect(await connection.collection(collection).findOne({ _id: profile._id })).toEqual(before);
    expect((await accounts.findById(target.id).orFail()).role_id).toEqual(target.role_id);
    expect(await events.countDocuments()).toBe(0);
  });

  it.each(['MEMBER', 'TRAINER'] as const)('TC10: %s without a profile can login; role change does not create operational records', async roleCode => {
    const target = await fixture();
    await patch(target, { roleCode, version: 0, reason }).expect(200);
    const auth = await login(target.phone).expect(200);
    expect(auth.body.user.roleCode).toBe(roleCode);
    for (const name of ['members', 'trainers', 'memberships']) expect(await connection.collection(name).countDocuments({ account_id: target.id })).toBe(0);
  });

  it('TC11: last ACTIVE Admin cannot be demoted', async () => {
    expect((await patch(admin, { roleCode: 'MEMBER', version: 0, reason }).expect(409)).body.error.code).toBe('LAST_ACTIVE_ADMIN');
    expect(await activeAdmins()).toBe(1); expect(await events.countDocuments()).toBe(0); expect(await revision()).toBe(0n);
  });

  it.each(['role', 'status'])('TC12–13: mutual demotion versus %s across two apps preserves the last Admin and revalidates the losing actor', async operation => {
    const other = await fixture('ADMIN');
    const otherToken = (await login(other.phone).expect(200)).body.accessToken;
    const first = operation === 'role' ? patch(other, { roleCode: 'STAFF', version: 0, reason }) :
      request(app.getHttpServer()).patch(`/api/users/${other.id}/status`).set('Authorization', `Bearer ${token}`).send({ status: 'LOCKED', version: 0, reason });
    const responses = await Promise.all([first, patch(admin, { roleCode: 'STAFF', version: 0, reason }, otherToken, secondApp)]);
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    expect([401, 403, 409]).toContain(responses.find(response => response.status !== 200)!.status);
    expect(await activeAdmins()).toBe(1); expect(await events.countDocuments()).toBe(1); expect(await revision()).toBe(1n);
  });

  it('TC12: a request authenticated before waiting cannot write after its actor has been demoted', async () => {
    const other = await fixture('ADMIN'); const target = await fixture();
    const otherToken = (await login(other.phone).expect(200)).body.accessToken;
    const runner = app.get(TransactionRunner); const run = runner.run.bind(runner);
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    jest.spyOn(runner, 'run').mockImplementationOnce(async work => { entered(); await gate; return run(work); });
    const pending = patch(target).then(response => response);
    await waiting;
    try { await patch(admin, { roleCode: 'STAFF', version: 0, reason }, otherToken, secondApp).expect(200); }
    finally { release(); }
    expect((await pending).status).toBe(401);
    expect((await accounts.findById(target.id).orFail()).role_id).toEqual(target.role_id);
    expect(await events.countDocuments()).toBe(1);
  });

  it.each(['audit', 'before-commit'])('TC14: %s failure rolls back role, timestamp, both versions, audit and shared revision', async failure => {
    const target = await fixture();
    if (failure === 'audit') jest.spyOn(events, 'create').mockRejectedValueOnce(new Error('audit failpoint'));
    else {
      const runner = app.get(TransactionRunner); const run = runner.run.bind(runner);
      jest.spyOn(runner, 'run').mockImplementation(work => run(async session => { await work(session); throw new Error('before commit failpoint'); }));
    }
    await patch(target).expect(503);
    const stored = await accounts.findById(target.id).orFail();
    expect(stored.role_id).toEqual(target.role_id); expect(stored.updated_at).toEqual(target.updated_at);
    expect(Number(stored.version)).toBe(0); expect(Number(stored.auth_version)).toBe(0);
    expect(await events.countDocuments()).toBe(0); expect(await revision()).toBe(0n);
  });

  it('TC14: transient audit failure retries the transaction and commits exactly one change', async () => {
    const target = await fixture(); const create = events.create.bind(events);
    jest.spyOn(events, 'create').mockImplementationOnce(async (...args: Parameters<typeof create>) => {
      await create(...args);
      throw new MongoServerError({ message: 'transient audit failpoint', errorLabels: ['TransientTransactionError'] });
    });
    await patch(target).expect(200);
    expect(await events.countDocuments()).toBe(1); expect(await revision()).toBe(1n);
    expect(Number((await accounts.findById(target.id).orFail()).auth_version)).toBe(1);
  });

  it('TC14: unknown commit is bounded by the shared deadline and never claims a definite failure', async () => {
    const target = await fixture();
    jest.spyOn(ClientSession.prototype, 'commitTransaction').mockRejectedValue(new MongoServerError({ message: 'commit failpoint', errorLabels: ['UnknownTransactionCommitResult'] }));
    const started = Date.now();
    const response = await patch(target).expect(503);
    expect(response.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: expect.stringContaining('Chưa xác định') });
    expect(Date.now() - started).toBeLessThan(12500);
    expect((await accounts.findById(target.id).orFail()).role_id).toEqual(target.role_id);
    expect(await events.countDocuments()).toBe(0);
  }, 30000);

  it('TC15: missing target role returns 409; missing catalog role/mapping/permission fails closed without HTTP seed', async () => {
    const target = await fixture();
    await connection.collection('roles').deleteOne({ code: 'TRAINER' });
    expect((await patch(target, { roleCode: 'TRAINER', version: 0, reason }).expect(409)).body.error.code).toBe('ROLE_NOT_CONFIGURED');
    expect((await getCatalog().expect(503)).body.error.code).toBe('PERMISSION_CATALOG_NOT_READY');
    expect(await connection.collection('roles').countDocuments()).toBe(3);
    await catalog.seed();
    await mappings.deleteOne({});
    const count = await mappings.countDocuments();
    expect((await getCatalog().expect(503)).body.error.code).toBe('PERMISSION_CATALOG_NOT_READY');
    expect(await mappings.countDocuments()).toBe(count);
    await catalog.seed(); await permissions.deleteOne({ code: 'auth.me' });
    expect((await getCatalog().expect(503)).body.error.code).toBe('PERMISSION_CATALOG_NOT_READY');
  });

  it('TC15: unexpected mapping cannot grant wildcard/extra privileges; catalog refuses drift', async () => {
    const member = await repository.findRoleByCode('MEMBER'); const permission = await permissions.findOne({ code: 'accounts.changeRole' }).orFail();
    await mappings.create({ role_id: member!.id, permission_id: permission.id });
    expect((await getCatalog().expect(503)).body.error.code).toBe('PERMISSION_CATALOG_NOT_READY');
    const actor = await fixture('MEMBER'); const auth = await login(actor.phone).expect(200);
    await patch(admin, undefined, auth.body.accessToken).expect(403);
  });

  it('TC15: missing shared state returns 503 without changing role', async () => {
    const target = await fixture(); await state.deleteMany({});
    expect((await patch(target).expect(503)).body.error.code).toBe('SECURITY_STATE_NOT_READY');
    expect((await accounts.findById(target.id).orFail()).role_id).toEqual(target.role_id);
    expect(await events.countDocuments()).toBe(0);
  });

  it('TC15: CLI ensure-indexes/seed-access are repeatable with unique indexes and no account modification', async () => {
    await mappings.deleteMany({}); await permissions.deleteMany({});
    const command = (name: string) => execFileSync(process.execPath, ['scripts/admin.cjs', name], {
      cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
    expect(command('ensure-indexes')).toContain('INDEXES_ENSURED');
    expect(command('seed-access')).toContain('ACCESS_CATALOG_SEEDED');
    const first = await permissions.find().sort({ code: 1 }).lean();
    const count = await mappings.countDocuments();
    expect(command('seed-access')).toContain('ACCESS_CATALOG_SEEDED');
    expect(await permissions.find().sort({ code: 1 }).lean()).toEqual(first);
    expect(await mappings.countDocuments()).toBe(count);
    expect((await accounts.findById(admin.id).orFail()).updated_at).toEqual(admin.updated_at);
    await getCatalog().expect(200);
    const indexes = await mappings.collection.listIndexes().toArray();
    expect(indexes).toEqual(expect.arrayContaining([expect.objectContaining({ key: { role_id: 1, permission_id: 1 }, unique: true })]));
  });

  it('OpenAPI documents both role endpoints and a separate strict role DTO', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build());
    expect(document.paths['/api/users/{id}/role'].patch?.responses).toHaveProperty('409');
    expect(document.paths['/api/access/roles'].get?.security).toEqual([{ bearer: [] }]);
    expect(document.components?.schemas?.ChangeRoleDto).toMatchObject({ required: ['roleCode', 'version', 'reason'] });
  });

  // Passport shares its registered strategy in this in-process harness. Close the
  // second app's DB only after all HTTP checks; two real server processes do not share it.
  it('TC15: disconnected database rejects the real HTTP request without changing role', async () => {
    const target = await fixture();
    await secondApp.get<Connection>(getConnectionToken()).close();
    expect((await patch(target, undefined, token, secondApp).expect(503)).body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect((await accounts.findById(target.id).orFail()).role_id).toEqual(target.role_id);
    expect(await events.countDocuments()).toBe(0);
  });
});

describe('US-08 TC15: standalone refuses role changes', () => {
  it('requires transaction support and never falls back to a partial write', async () => {
    const mongo = await MongoMemoryServer.create({ binary: { version: '8.0.17' } });
    let app: INestApplication | undefined;
    try {
      Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin,
        MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_us08_standalone', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url') });
      const { AppModule } = await import('../src/app.module');
      app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
      configureHttp(app); await app.init();
      await Promise.all(Object.values(app.get<Connection>(getConnectionToken()).models).map(model => model.init()));
      await app.get(AccessCatalogService).seed();
      const repository = app.get(UsersRepository); const role = await repository.findRoleByCode('ADMIN');
      const actor = await repository.createAccount({ roleId: role!.id.toHexString(), fullName: 'Standalone Admin', phone: '0901234567', passwordHash: await app.get(PasswordService).hash(password) });
      const auth = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone: actor.phone, password }).expect(200);
      const response = await request(app.getHttpServer()).patch(`/api/users/${actor.id}/role`).set('Authorization', `Bearer ${auth.body.accessToken}`).send({ roleCode: 'STAFF', version: 0, reason }).expect(503);
      expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect((await repository.findAccountById(actor.id.toHexString()))!.role_id).toEqual(actor.role_id);
      expect(await app.get<Model<SecurityEvent>>(getModelToken('SecurityEvent')).countDocuments()).toBe(0);
    } finally { await app?.close(); await mongo.stop(); process.env = savedEnv; }
  }, 600000);
});
