import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { AuthSessionsRepository } from '../src/modules/auth/auth-sessions.repository';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { AuthSession } from '../src/modules/auth/schemas/auth-session.schema';
import { Account } from '../src/modules/users/schemas/account.schema';
import { Role, ROLE_CODES, RoleCode } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const phone = '0901234567';
const password = 'Mật khẩu US-03 123';
type Login = { body: { accessToken: string }; headers: Record<string, unknown> };

describe('US-03 logout against an isolated real mongod', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication;
  let accounts: Model<Account>;
  let roles: Model<Role>;
  let sessions: Model<AuthSession>;
  let repository: UsersRepository;
  let hash: string;
  let log: jest.SpyInstance;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: '8.0.17' }, instance: { dbName: 'gym_management_test_us03' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(),
      MONGODB_DB: 'gym_management_test_us03', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url') });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    accounts = app.get<Model<Account>>(getModelToken('Account'));
    roles = app.get<Model<Role>>(getModelToken('Role'));
    sessions = app.get<Model<AuthSession>>(getModelToken('AuthSession'));
    repository = app.get(UsersRepository);
    hash = await app.get(PasswordService).hash(password);
  }, 600000);

  beforeEach(async () => {
    log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    await Promise.all([accounts.deleteMany({}), roles.deleteMany({}), sessions.deleteMany({})]);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = savedEnv; });

  async function fixture(code: RoleCode = 'MEMBER') {
    const role = await repository.ensureRole(code, code);
    return repository.createAccount({ roleId: role.id.toHexString(), phone, fullName: 'US03 Test', passwordHash: hash });
  }
  function login() {
    return request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
  }
  function cookie(response: Login): string {
    return (response.headers['set-cookie'] as string[])[0].split(';')[0];
  }
  function logout(options: { bearer?: string; cookie?: string; body?: object; origin?: string | null } = {}) {
    const call = request(app.getHttpServer()).post('/api/auth/logout');
    if (options.origin !== null) call.set('Origin', options.origin ?? origin);
    if (options.bearer) call.set('Authorization', `Bearer ${options.bearer}`);
    if (options.cookie) call.set('Cookie', options.cookie);
    return call.send(options.body ?? {});
  }
  function refresh(value: string) {
    return request(app.getHttpServer()).post('/api/auth/refresh').set('Origin', origin).set('Cookie', value).send({});
  }
  function me(token: string) {
    return request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  }
  function sessionIdOf(token: string): string {
    return (app.get(JwtService).decode(token) as { sid: string }).sid;
  }
  async function revokedAt(sid: string) {
    return (await sessions.findById(sid).orFail()).revoked_at;
  }
  function expiredToken(source: string, overrides: Record<string, unknown> = {}) {
    const { sub, sid, av } = app.get(JwtService).decode(source) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    return app.get(JwtService).signAsync({ sub, sid, av, iat: now - 1000, exp: now - 100, ...overrides });
  }
  function expectCookieCleared(response: { headers: Record<string, unknown> }) {
    const raw = (response.headers['set-cookie'] as unknown as string[])[0];
    expect(raw).toMatch(/^gym_refresh=;/);
    expect(raw).toMatch(/Path=\/api\/auth/); expect(raw).toMatch(/HttpOnly/); expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).toMatch(/Expires=Thu, 01 Jan 1970/); expect(raw).not.toMatch(/Domain=/);
  }

  it.each(ROLE_CODES)('TC01–02: %s logout revokes the session on the server; old access and refresh get 401', async code => {
    await fixture(code);
    const session = await login();
    const token = session.body.accessToken;
    const response = await logout({ bearer: token, cookie: cookie(session) }).expect(204);
    expect(response.body).toEqual({});
    expect(response.headers['cache-control']).toBe('no-store');
    expectCookieCleared(response);
    expect(await revokedAt(sessionIdOf(token))).toBeInstanceOf(Date);
    await me(token).expect(401);
    await refresh(cookie(session)).expect(401);
  });

  it('TC03: logging out one device leaves the other session working', async () => {
    await fixture();
    const deviceA = await login();
    const deviceB = await login();
    await logout({ bearer: deviceA.body.accessToken }).expect(204);
    expect(await revokedAt(sessionIdOf(deviceA.body.accessToken))).toBeInstanceOf(Date);
    expect(await revokedAt(sessionIdOf(deviceB.body.accessToken))).toBeUndefined();
    await me(deviceB.body.accessToken).expect(200);
    await refresh(cookie(deviceB)).expect(200);
  });

  it('TC04: an expired but correctly signed Bearer can only log out, never access business APIs', async () => {
    await fixture();
    const session = await login();
    const expired = await expiredToken(session.body.accessToken);
    await me(expired).expect(401);
    await logout({ bearer: expired }).expect(204);
    expect(await revokedAt(sessionIdOf(session.body.accessToken))).toBeInstanceOf(Date);
  });

  it('TC04: a locked account can still log out', async () => {
    await fixture();
    const session = await login();
    await accounts.updateOne({}, { status: 'LOCKED' });
    await logout({ bearer: session.body.accessToken }).expect(204);
    expect(await revokedAt(sessionIdOf(session.body.accessToken))).toBeInstanceOf(Date);
  });

  it('TC05: repeated logout returns 204 and keeps the first timestamp; no credential returns 204', async () => {
    await fixture();
    const session = await login();
    const other = await login();
    const token = session.body.accessToken;
    await logout({ bearer: token }).expect(204);
    const first = await revokedAt(sessionIdOf(token));
    await new Promise(resolve => setTimeout(resolve, 20));
    await logout({ bearer: token }).expect(204);
    expect(await revokedAt(sessionIdOf(token))).toEqual(first);
    expectCookieCleared(await logout().expect(204));
    expect(await revokedAt(sessionIdOf(other.body.accessToken))).toBeUndefined();
  });

  it('TC06: fake JWT, wrong sid/sub, rotated cookie, or a bad Bearer with a good cookie all get 401 without side effects', async () => {
    await fixture();
    const session = await login();
    const token = session.body.accessToken;
    const otherSecret = new JwtService({ secret: randomBytes(32).toString('base64url'), signOptions: { algorithm: 'HS256', issuer: 'gym-api', audience: 'gym-web' } });
    const { sub, sid, av } = app.get(JwtService).decode(token) as Record<string, unknown>;
    const invalidBearers = [
      'not-a-jwt',
      await otherSecret.signAsync({ sub, sid, av }),
      await expiredToken(token, { sid: new Types.ObjectId().toHexString() }),
      await expiredToken(token, { sub: new Types.ObjectId().toHexString() }),
    ];
    for (const bearer of invalidBearers) {
      const response = await logout({ bearer, cookie: cookie(session) }).expect(401);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    const rotated = await refresh(cookie(session)).expect(200);
    await logout({ cookie: cookie(session) }).expect(401);
    expect(await revokedAt(sid as string)).toBeUndefined();
    await me(rotated.body.accessToken).expect(200);
    await logout({ cookie: cookie(rotated) }).expect(204);
    expect(await revokedAt(sid as string)).toBeInstanceOf(Date);
  });

  it('TC07: wrong/missing Origin gets 403 and a body with sessionId gets 400; the session is unchanged', async () => {
    await fixture();
    const session = await login();
    const token = session.body.accessToken;
    for (const source of [null, 'http://evil.example']) {
      expect((await logout({ bearer: token, origin: source }).expect(403)).body.error.code).toBe('INVALID_ORIGIN');
    }
    await logout({ bearer: token, body: { sessionId: sessionIdOf(token) } }).expect(400);
    await request(app.getHttpServer()).post('/api/auth/logout').set('Origin', origin).type('form').send('a=1').expect(400);
    expect(await revokedAt(sessionIdOf(token))).toBeUndefined();
    await me(token).expect(200);
  });

  it('TC09: refresh wins first; logout with the old signed sid revokes the rotated session and blocks the new token', async () => {
    await fixture();
    const session = await login();
    const rotated = await refresh(cookie(session)).expect(200);
    await logout({ bearer: session.body.accessToken }).expect(204);
    await me(rotated.body.accessToken).expect(401);
    await refresh(cookie(rotated)).expect(401);
  });

  it('TC10: logout wins while a refresh is in flight; refresh cannot clear revoked_at or revive the session', async () => {
    await fixture();
    const session = await login();
    const sessionsRepository = app.get(AuthSessionsRepository);
    const originalRotate = sessionsRepository.rotate.bind(sessionsRepository);
    jest.spyOn(sessionsRepository, 'rotate').mockImplementationOnce(async (...args) => {
      await logout({ bearer: session.body.accessToken }).expect(204);
      return originalRotate(...args);
    });
    await refresh(cookie(session)).expect(401);
    const sid = sessionIdOf(session.body.accessToken);
    expect(await revokedAt(sid)).toBeInstanceOf(Date);
    await me(session.body.accessToken).expect(401);
  });

  it('TC11: a database failure returns 503, keeps the cookie and allows a safe retry', async () => {
    await fixture();
    const session = await login();
    jest.spyOn(app.get(AuthSessionsRepository), 'revoke').mockRejectedValueOnce(Object.assign(new Error('private detail'), { name: 'MongoNetworkError' }));
    const failed = await logout({ bearer: session.body.accessToken, cookie: cookie(session) }).expect(503);
    expect(failed.headers['set-cookie']).toBeUndefined();
    expect(await revokedAt(sessionIdOf(session.body.accessToken))).toBeUndefined();
    await logout({ bearer: session.body.accessToken, cookie: cookie(session) }).expect(204);
    const first = await revokedAt(sessionIdOf(session.body.accessToken));
    await logout({ bearer: session.body.accessToken, cookie: cookie(session) }).expect(204);
    expect(await revokedAt(sessionIdOf(session.body.accessToken))).toEqual(first);
  });

  it('TC13: many logouts keep history, never bump auth_version and never log credentials', async () => {
    await fixture();
    const sessionsLoggedIn = [await login(), await login(), await login()];
    for (const session of sessionsLoggedIn) await logout({ bearer: session.body.accessToken, cookie: cookie(session) }).expect(204);
    await logout({ bearer: 'sensitive-fake-token' }).expect(401);
    expect(await sessions.countDocuments()).toBe(3);
    expect(await sessions.countDocuments({ revoked_at: { $type: 'date' } })).toBe(3);
    expect((await accounts.findOne().orFail()).auth_version).toBe(0);
    for (const [line] of log.mock.calls) {
      expect(Object.keys(JSON.parse(line as string)).sort()).toEqual(['code', 'requestId', 'status', 'timestamp']);
      expect(line).not.toMatch(/sensitive|Cookie|Authorization|gym_refresh|Bearer/);
    }
  });
});
