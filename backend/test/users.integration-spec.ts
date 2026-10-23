import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Model, Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { AuthSession } from '../src/modules/auth/schemas/auth-session.schema';
import { Account } from '../src/modules/users/schemas/account.schema';
import { Role, ROLE_CODES, RoleCode } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const password = '  Mật khẩu US-06 123  ';
const input = { fullName: '  Nguyễn   Văn A  ', phone: '0901234567', password, roleCode: 'MEMBER' };
const publicFields = ['createdAt', 'email', 'fullName', 'id', 'phone', 'roleCode', 'roleName', 'status', 'updatedAt', 'version'];

describe('US-06 with real MongoDB, JWT, sessions and RBAC', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication;
  let connection: Connection;
  let accounts: Model<Account>;
  let roles: Model<Role>;
  let sessions: Model<AuthSession>;
  let repository: UsersRepository;
  let hash: string;
  let admin: Account;
  let token: string;
  let adminCookie: string;
  let log: jest.SpyInstance;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: '8.0.17' }, instance: { dbName: 'gym_management_test_us06' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(),
      MONGODB_DB: 'gym_management_test_us06', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url') });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    accounts = app.get<Model<Account>>(getModelToken('Account'));
    roles = app.get<Model<Role>>(getModelToken('Role'));
    sessions = app.get<Model<AuthSession>>(getModelToken('AuthSession'));
    repository = app.get(UsersRepository);
    hash = await app.get(PasswordService).hash(password);
  }, 600000);

  beforeEach(async () => {
    log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Reset the real limiter window per case; authentication and guards are never bypassed.
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    await Promise.all([accounts.deleteMany({}), roles.deleteMany({}), sessions.deleteMany({})]);
    for (const code of ROLE_CODES) await repository.ensureRole(code, code);
    admin = await fixture('ADMIN', '0909999999');
    const auth = await login('0909999999').expect(200);
    token = auth.body.accessToken;
    adminCookie = cookie(auth);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = savedEnv; });

  async function fixture(code: RoleCode = 'MEMBER', phone = input.phone, extra: { fullName?: string; email?: string } = {}) {
    const role = await repository.findRoleByCode(code);
    return repository.createAccount({ roleId: role!.id.toHexString(), fullName: 'Test User', phone, passwordHash: hash, ...extra });
  }
  function login(phone: string) { return request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password }); }
  function cookie(response: { headers: Record<string, unknown> }) { return (response.headers['set-cookie'] as string[])[0].split(';')[0]; }
  function get(path = '/api/users', bearer = token) { return request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${bearer}`); }
  function create(body: object = input, bearer = token) { return request(app.getHttpServer()).post('/api/users').set('Authorization', `Bearer ${bearer}`).send(body); }
  function patch(id: string, body: object, bearer = token) { return request(app.getHttpServer()).patch(`/api/users/${id}`).set('Authorization', `Bearer ${bearer}`).send(body); }
  function refresh(value: string) { return request(app.getHttpServer()).post('/api/auth/refresh').set('Origin', origin).set('Cookie', value).send({}); }
  function assertPublic(body: Record<string, unknown>) {
    expect(Object.keys(body).sort()).toEqual(publicFields.filter(key => key !== 'email' || body.email !== undefined));
    expect(JSON.stringify(body)).not.toMatch(/password|auth_version|authVersion|refresh|token|roleId|_id/);
  }

  it('TC01/05–07: Admin list/detail/roles/create uses public DTOs and creates only an account', async () => {
    expect((await get('/api/users/roles').expect(200)).body.items.map((role: { code: string }) => role.code)).toEqual(ROLE_CODES);
    const beforeSessions = await sessions.countDocuments();
    const profiles = ['members', 'trainers', 'memberships'];
    const beforeProfiles = await Promise.all(profiles.map(name => connection.db!.collection(name).countDocuments()));
    for (const [index, roleCode] of ['MEMBER', 'TRAINER'].entries()) {
      const result = await create({ ...input, phone: `090123456${index}`, roleCode, email: index ? undefined : ' A@EXAMPLE.COM ' }).expect(201);
      assertPublic(result.body);
      expect(result.body).toMatchObject({ fullName: 'Nguyễn Văn A', status: 'ACTIVE', version: 0, roleCode });
      const stored = await accounts.findOne({ id: new Types.ObjectId(result.body.id) }).select('+password_hash').orFail();
      expect(stored.id.equals(stored._id)).toBe(true);
      expect(Number(stored.auth_version)).toBe(0);
      expect(stored.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(await app.get(PasswordService).verify(stored.password_hash, password)).toBe(true);
      assertPublic((await get(`/api/users/${result.body.id}`).expect(200)).body);
    }
    expect(await sessions.countDocuments()).toBe(beforeSessions);
    expect(await Promise.all(profiles.map(name => connection.db!.collection(name).countDocuments()))).toEqual(beforeProfiles);
    const list = await get().expect(200);
    expect(list.body).toMatchObject({ page: 1, limit: 20, total: 3, totalPages: 1 });
    list.body.items.forEach(assertPublic);
    const [bson] = await accounts.aggregate([{ $project: { versionType: { $type: '$version' }, authType: { $type: '$auth_version' } } }]);
    expect(bson).toMatchObject({ versionType: 'int', authType: 'int' });
  });

  it('TC02: absent, malformed and revoked credentials return 401 for every route', async () => {
    for (const bearer of ['', 'bad.token.value', token]) {
      if (bearer === token) await sessions.updateMany({}, { revoked_at: new Date() });
      const responses = await Promise.all([get('/api/users', bearer), get('/api/users/roles', bearer),
        get(`/api/users/${admin.id}`, bearer), create(input, bearer), patch(admin.id.toHexString(), { version: 0, fullName: 'Blocked' }, bearer)]);
      for (const response of responses) {
        expect(response.status).toBe(401); expect(response.body.error.code).toBe('UNAUTHENTICATED');
      }
    }
    expect(await accounts.countDocuments()).toBe(1);
  });

  it.each(['STAFF', 'TRAINER', 'MEMBER'] as const)('TC02: real %s principal gets 403 on all Users endpoints', async code => {
    await fixture(code);
    const auth = await login(input.phone).expect(200);
    const bearer = auth.body.accessToken;
    for (const response of await Promise.all([get('/api/users', bearer), get('/api/users/roles', bearer), get(`/api/users/${admin.id}`, bearer),
      create({ ...input, phone: '0901234568' }, bearer), patch(admin.id.toHexString(), { version: 0, fullName: 'Blocked' }, bearer)])) {
      expect(response.status).toBe(403); expect(response.body.error.code).toBe('FORBIDDEN');
    }
    expect(await accounts.countDocuments()).toBe(2);
    expect(Number((await accounts.findOne({ id: admin.id }).orFail()).version)).toBe(0);
  });

  it('TC03–04: deterministic pagination, literal search, normalized identifiers and combined filters', async () => {
    const role = await repository.findRoleByCode('STAFF');
    await accounts.insertMany(Array.from({ length: 24 }, (_value, index) => ({ role_id: role!.id, full_name: `Staff ${index}`,
      phone: `+8490111${String(index).padStart(4, '0')}`, password_hash: hash, created_at: new Date('2026-10-23T00:00:00Z') })));
    await fixture('MEMBER', input.phone, { fullName: 'Literal [.*] Name', email: 'a@example.com' });
    const first = (await get('/api/users?roleCode=STAFF').expect(200)).body;
    const second = (await get('/api/users?roleCode=STAFF&page=2').expect(200)).body;
    expect(first).toMatchObject({ total: 24, totalPages: 2 });
    expect(first.items).toHaveLength(20); expect(second.items).toHaveLength(4);
    const ids = [...first.items, ...second.items].map((item: { id: string }) => item.id);
    expect(ids).toEqual([...ids].sort().reverse());
    expect((await get('/api/users?roleCode=STAFF').expect(200)).body.items).toEqual(first.items);
    for (const q of ['[.*]', ' A@EXAMPLE.COM ', '(090) 123-45.67', '090123', 'Literal   [.*]']) {
      const result = await get(`/api/users?roleCode=MEMBER&status=ACTIVE&q=${encodeURIComponent(q)}`).expect(200);
      expect(result.body.total).toBe(1);
    }
    const empty = await get('/api/users?q=absent').expect(200);
    expect(empty.body).toMatchObject({ items: [], total: 0, totalPages: 0 });
    expect((await get('/api/users?q=.').expect(200)).body.total).toBe(1);
    expect((await get('/api/users?q=-').expect(200)).body.total).toBe(0);
    expect((await get('/api/users?q=%28%29').expect(200)).body.total).toBe(0);
    for (const query of ['limit=101', 'page=0', 'page=1.5', 'page=1&page=2', 'roleCode=PT', 'status=DELETED', `q=${'a'.repeat(121)}`, 'extra=1']) {
      await get(`/api/users?${query}`).expect(400);
    }
  });

  it('TC05: ID syntax, missing documents and roles routing use distinct outcomes', async () => {
    expect((await get('/api/users/invalid').expect(400)).body.error.code).toBe('INVALID_ID');
    expect((await patch('invalid', { version: 0, fullName: 'New Name' }).expect(400)).body.error.code).toBe('INVALID_ID');
    const absent = new Types.ObjectId().toHexString();
    expect((await get(`/api/users/${absent}`).expect(404)).body.error.code).toBe('USER_NOT_FOUND');
    expect((await patch(absent, { version: 0, fullName: 'New Name' }).expect(404)).body.error.code).toBe('USER_NOT_FOUND');
    await get('/api/users/roles').expect(200);
  });

  it('TC08/15–16: strict operation validation rejects nulls, mass assignment and unsafe input', async () => {
    for (const extra of [{ password: 'short' }, { password: 123 }, { fullName: ' ' }, { fullName: 'a'.repeat(121) },
      { phone: 'bad' }, { phone: '0'.repeat(33) }, { email: 'bad' }, { email: null }, { roleCode: 'PT' }, { id: 'client-id' }, { status: 'LOCKED' }, { confirmPassword: password }]) {
      const response = await create({ ...input, ...extra }).expect(400);
      expect(JSON.stringify(response.body)).not.toContain(password);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    for (const body of [{ fullName: 'Name' }, { version: '0', fullName: 'Name' }, { version: -1, fullName: 'Name' }, { version: 0 },
      { version: 0, fullName: null }, { version: 0, phone: null }, { version: 0, fullName: '' }, { version: 0, phone: '' },
      ...['roleCode', 'roleId', 'role_id', 'status', 'password', 'password_hash', 'auth_version', 'id', '_id', 'created_at', 'account_id', 'member_id', 'trainer_id'].map(field => ({ version: 0, fullName: 'Name', [field]: 'forbidden' }))]) {
      await patch(admin.id.toHexString(), body).expect(400);
    }
    await request(app.getHttpServer()).delete(`/api/users/${admin.id}`).set('Authorization', `Bearer ${token}`).expect(404);
    expect(await accounts.countDocuments()).toBe(1);
  });

  it('TC09–10: normalized duplicates return the exact field; missing email is physically omitted', async () => {
    await create({ ...input, email: ' A@EXAMPLE.COM ' }).expect(201);
    expect((await create({ ...input, phone: '+84 901 234 567' }).expect(409)).body.error).toMatchObject({ code: 'PHONE_ALREADY_EXISTS', details: [{ field: 'phone', message: expect.any(String) }] });
    expect((await create({ ...input, phone: '0901234568', email: 'a@example.com' }).expect(409)).body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    for (const [phone, email] of [['0901234568', undefined], ['0901234569', '   ']]) {
      const response = await create({ ...input, phone, email }).expect(201);
      expect(response.body).not.toHaveProperty('email');
      const stored = await accounts.collection.findOne({ id: new Types.ObjectId(response.body.id) });
      expect(stored).not.toHaveProperty('email');
    }
  });

  it('TC11: simultaneous normalized phone creates and email updates preserve uniqueness', async () => {
    const posts = await Promise.all([create(), create({ ...input, phone: '+84901234567' })]);
    expect(posts.map(response => response.status).sort()).toEqual([201, 409]);
    expect(posts.find(response => response.status === 409)!.body.error.code).toBe('PHONE_ALREADY_EXISTS');
    const left = posts.find(response => response.status === 201)!.body;
    const right = (await create({ ...input, phone: '0901234568' }).expect(201)).body;
    const edits = await Promise.all([patch(left.id, { version: 0, email: 'race@example.com' }), patch(right.id, { version: 0, email: ' RACE@EXAMPLE.COM ' })]);
    expect(edits.map(response => response.status).sort()).toEqual([200, 409]);
    expect(edits.find(response => response.status === 409)!.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    expect(await accounts.countDocuments({ email: 'race@example.com' })).toBe(1);
    const loser = await accounts.findOne({ id: new Types.ObjectId(edits[0].status === 409 ? left.id : right.id) }).orFail();
    expect(Number(loser.version)).toBe(0); expect(Number(loser.auth_version)).toBe(0);
  });

  it('TC12–14: name changes, CAS races and normalized no-op preserve the correct versions', async () => {
    const account = await fixture();
    const id = account.id.toHexString();
    const unchanged = await patch(id, { version: 0, fullName: '  Test   User ', phone: '+84 901 234 567' }).expect(200);
    expect(unchanged.body.version).toBe(0);
    expect(new Date(unchanged.body.updatedAt).getTime()).toBe(account.updated_at.getTime());
    const results = await Promise.all([patch(id, { version: 0, fullName: 'First Name' }), patch(id, { version: 0, fullName: 'Second Name' })]);
    expect(results.map(response => response.status).sort()).toEqual([200, 409]);
    expect(results.find(response => response.status === 409)!.body.error.code).toBe('VERSION_CONFLICT');
    const stored = await accounts.findOne({ id: account.id }).orFail();
    expect(stored.full_name).toBe(results.find(response => response.status === 200)!.body.fullName);
    expect(Number(stored.version)).toBe(1); expect(Number(stored.auth_version)).toBe(0);
    expect(stored.updated_at.getTime()).toBeGreaterThan(account.updated_at.getTime());
    expect((await patch(id, { version: 0, fullName: stored.full_name }).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
  });

  it('TC10/17: removing email unsets it and increments auth_version only when changed', async () => {
    const account = await fixture('MEMBER', input.phone, { email: 'test@example.com' });
    const id = account.id.toHexString();
    const response = await patch(id, { version: 0, email: null }).expect(200);
    expect(response.body).not.toHaveProperty('email'); expect(response.body.version).toBe(1);
    const stored = await accounts.collection.findOne({ id: account.id });
    expect(stored).not.toHaveProperty('email'); expect(stored!.auth_version).toBe(1);
    expect((await patch(id, { version: 1, email: '' }).expect(200)).body.version).toBe(1);
  });

  it.each(['phone', 'email'] as const)('TC17: changing %s invalidates real existing access/refresh', async field => {
    const account = await fixture();
    const auth = await login(input.phone).expect(200);
    await patch(account.id.toHexString(), { version: 0, [field]: field === 'phone' ? '0901234568' : 'new@example.com' }).expect(200);
    const stored = await accounts.findOne({ id: account.id }).orFail();
    expect(Number(stored.auth_version)).toBe(1); expect(Number(stored.version)).toBe(1);
    await get('/api/auth/me', auth.body.accessToken).expect(401);
    await refresh(cookie(auth)).expect(401);
    await login(field === 'phone' ? '0901234568' : input.phone).expect(200);
  });

  it('TC18: own name keeps the session; own phone change requires real login with new phone', async () => {
    const id = admin.id.toHexString();
    await patch(id, { version: 0, fullName: 'New Admin Name' }).expect(200);
    expect((await get('/api/auth/me').expect(200)).body.fullName).toBe('New Admin Name');
    await patch(id, { version: 1, phone: '0908888888' }).expect(200);
    await get().expect(401); await refresh(adminCookie).expect(401);
    const auth = await login('0908888888').expect(200);
    await get('/api/users', auth.body.accessToken).expect(200);
  });

  it('TC19: a missing seeded role returns 409 without creating roles', async () => {
    await roles.deleteOne({ code: 'MEMBER' });
    expect((await create().expect(409)).body.error.code).toBe('ROLE_NOT_CONFIGURED');
    expect(await roles.countDocuments()).toBe(3); expect(await accounts.countDocuments()).toBe(1);
    expect((await get('/api/users?roleCode=MEMBER').expect(200)).body.total).toBe(0);
  });

  it('TC22: discarding a successful POST response, searching and resubmitting never creates a duplicate', async () => {
    await create().expect(201);
    const found = await get('/api/users?q=0901234567').expect(200);
    expect(found.body.total).toBe(1);
    await create().expect(409);
    expect(await accounts.countDocuments()).toBe(2);
  });

  it('OpenAPI documents the real secured routes and excludes forbidden writable fields', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    const spec = response.body;
    for (const [path, method] of [['/api/users', 'get'], ['/api/users', 'post'], ['/api/users/roles', 'get'], ['/api/users/{id}', 'get'], ['/api/users/{id}', 'patch']]) {
      expect(spec.paths[path][method].security).toEqual([{ bearer: [] }]);
      expect(spec.paths[path][method].responses['503']).toBeDefined();
    }
    expect(Object.keys(spec.components.schemas.UpdateUserDto.properties).sort()).toEqual(['email', 'fullName', 'phone', 'version']);
    expect(Object.keys(spec.components.schemas.UserResponseDto.properties).sort()).toEqual(publicFields);
  });

  it('TC20: actual MongoDB outage returns safe 503 for list/create/update and recovers', async () => {
    await connection.db!.admin().command({ fsync: 1 });
    await mongo.stop({ doCleanup: false });
    try {
      for (const response of await Promise.all([get(), create(), patch(admin.id.toHexString(), { version: 0, fullName: 'Blocked' })])) {
        expect(response.status).toBe(503); expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
        expect(response.body.requestId).toEqual(expect.any(String));
        expect(JSON.stringify(response.body)).not.toMatch(/mongodb|127\.0\.0\.1|password|hash/);
      }
      for (const [line] of log.mock.calls) {
        expect(Object.keys(JSON.parse(line as string)).sort()).toEqual(['code', 'requestId', 'status', 'timestamp']);
      }
    } finally {
      await mongo.start(true);
      const deadline = Date.now() + 20000;
      while (connection.readyState !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
    }
    expect(await accounts.countDocuments()).toBe(1);
    await get().expect(200);
  });
});
