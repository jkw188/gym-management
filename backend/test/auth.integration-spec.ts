import 'reflect-metadata';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Model, Types } from 'mongoose';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { Roles } from '../src/modules/auth/auth.decorators';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuthSessionsRepository } from '../src/modules/auth/auth-sessions.repository';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { AuthSession } from '../src/modules/auth/schemas/auth-session.schema';
import { Account } from '../src/modules/users/schemas/account.schema';
import { Role, ROLE_CODES, RoleCode } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

@Controller('auth-probe')
class AuthProbeController {
  @Get('admin') @Roles('ADMIN') admin() { return { allowed: true }; }
}

const origin = 'http://localhost:5173';
const phone = '0901234567';
const password = '  Mật khẩu US-02 123  ';

describe('US-02 authentication against an isolated real mongod', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication;
  let connection: Connection;
  let accounts: Model<Account>;
  let roles: Model<Role>;
  let sessions: Model<AuthSession>;
  let repository: UsersRepository;
  let hash: string;
  let log: jest.SpyInstance;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: '8.0.17' }, instance: { dbName: 'gym_management_test_us02' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(),
      MONGODB_DB: 'gym_management_test_us02', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url') });
    const { AppModule } = await import('../src/app.module');
    @Module({ imports: [AppModule], controllers: [AuthProbeController] }) class HarnessModule {}
    app = await NestFactory.create(HarnessModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
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
    return repository.createAccount({ roleId: role.id.toHexString(), phone, fullName: 'US02 Test', passwordHash: hash });
  }
  function login(input: object = { phone, password }) {
    return request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send(input);
  }
  function cookie(response: { headers: Record<string, unknown> }): string {
    return (response.headers['set-cookie'] as string[])[0].split(';')[0];
  }
  function refresh(value?: string) {
    const call = request(app.getHttpServer()).post('/api/auth/refresh').set('Origin', origin);
    if (value) call.set('Cookie', value);
    return call.send({});
  }
  function me(token?: string) {
    const call = request(app.getHttpServer()).get('/api/auth/me');
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  }

  it.each(ROLE_CODES)('TC01/07–08: %s login creates a private hashed session and minimal HS256 JWT', async code => {
    const account = await fixture(code);
    const response = await login().expect(200);
    expect(response.body.user).toEqual({ id: account.id.toHexString(), fullName: 'US02 Test', phone: '+84901234567', roleCode: code });
    expect(response.body).toMatchObject({ accessToken: expect.any(String), tokenType: 'Bearer', expiresIn: 900 });
    expect(response.headers['cache-control']).toBe('no-store');
    const rawCookie = (response.headers['set-cookie'] as unknown as string[])[0];
    expect(rawCookie).toMatch(/Path=\/api\/auth/); expect(rawCookie).toMatch(/HttpOnly/); expect(rawCookie).toMatch(/SameSite=Lax/);
    expect(rawCookie).not.toMatch(/Secure|Domain=/);
    const token = cookie(response).split('=')[1];
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const session = await sessions.findOne().select('+refresh_hash').orFail();
    expect(session.id.equals(session._id)).toBe(true);
    expect(session.refresh_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(session)).not.toContain(session.refresh_hash);
    expect((await sessions.findOne().orFail()).refresh_hash).toBeUndefined();
    expect(session.expires_at.getTime() - session.created_at.getTime()).toBeLessThanOrEqual(604800000);
    const payload = app.get(JwtService).decode(response.body.accessToken) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['aud', 'av', 'exp', 'iat', 'iss', 'sid', 'sub']);
    expect(payload).toMatchObject({ sub: account.id.toHexString(), sid: session.id.toHexString(), av: 0, iss: 'gym-api', aud: 'gym-web' });
    expect(JSON.parse(Buffer.from(response.body.accessToken.split('.')[0], 'base64url').toString()).alg).toBe('HS256');
    expect(Number(payload.exp) - Number(payload.iat)).toBe(900);
    expect(JSON.stringify(response.body)).not.toMatch(/refreshToken|password|refresh_hash/);
    await me(response.body.accessToken).expect(200, response.body.user);
    const [bson] = await sessions.aggregate([{ $project: { authType: { $type: '$auth_version' } } }]);
    expect(bson.authType).toBe('int');
  });

  it('TC03: wrong/unknown/locked/broken-role credentials share the same failure, with dummy verify', async () => {
    await fixture();
    const wrong = await login({ phone, password: password.trim() }).expect(401);
    const verify = jest.spyOn(app.get(PasswordService), 'verify');
    const absent = await login({ phone: '0901234568', password }).expect(401);
    expect(verify).toHaveBeenCalledWith(expect.stringMatching(/^\$argon2id\$/), password);
    await accounts.updateOne({}, { status: 'LOCKED' });
    const locked = await login().expect(401);
    await accounts.updateOne({}, { status: 'ACTIVE', role_id: new Types.ObjectId() });
    const missingRole = await login().expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    for (const result of [absent, locked, missingRole]) expect(result.body.error).toEqual(wrong.body.error);
    expect(await sessions.countDocuments()).toBe(0);
  });

  it('TC04/20: rejects invalid input, forbidden fields, bad media types and Origin before issuing cookies', async () => {
    for (const body of [{ phone: 'invalid', password }, { phone, password: 123 }, { phone: 123, password }, { phone, password, roleCode: 'ADMIN' }]) {
      await login(body).expect(400);
    }
    for (const path of ['login', 'refresh']) {
      for (const source of [undefined, 'http://evil.example']) {
        const call = request(app.getHttpServer()).post(`/api/auth/${path}`);
        if (source) call.set('Origin', source);
        const result = await call.send({}).expect(403);
        expect(result.body.error.code).toBe('INVALID_ORIGIN');
        expect(result.headers['set-cookie']).toBeUndefined();
        expect(result.headers['cache-control']).toBe('no-store');
      }
      await request(app.getHttpServer()).post(`/api/auth/${path}`).set('Origin', origin).type('form').send({}).expect(400);
    }
    await request(app.getHttpServer()).post('/api/auth/refresh').set('Origin', origin).send({ token: 'untrusted' }).expect(400);
    await refresh().expect(401);
    await request(app.getHttpServer()).options('/api/auth/login').set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST').expect('Access-Control-Allow-Origin', origin).expect('Access-Control-Allow-Credentials', 'true').expect(204);
  });

  it('TC05–06: enforces normalized pair and IP limits without locking accounts', async () => {
    await fixture();
    for (let i = 0; i < 5; i++) await login({ phone: i % 2 ? '+84 901 234 567' : phone, password: 'wrong password' }).expect(401);
    const blocked = await login().expect(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await accounts.findOne().orFail()).status).toBe('ACTIVE');
    for (let i = 0; i < 15; i++) await login({ phone: `09012345${String(68 + i).padStart(2, '0')}`, password }).expect(401);
    await login({ phone: '0909999999', password }).expect(429);
  });

  it('TC09: session persistence errors issue neither access token nor cookie', async () => {
    await fixture();
    jest.spyOn(app.get(AuthSessionsRepository), 'create').mockRejectedValueOnce(Object.assign(new Error('private database detail'), { name: 'MongoNetworkError' }));
    const result = await login().expect(503);
    expect(result.body.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.body.accessToken).toBeUndefined();
    expect(await sessions.countDocuments()).toBe(0);
  });

  it('TC10: rejects missing/tampered/expired/incorrect algorithm, issuer, audience or claims', async () => {
    await fixture();
    const signed = await login().expect(200);
    const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET, signOptions: { algorithm: 'HS256' } });
    const payload = jwt.decode(signed.body.accessToken) as Record<string, unknown>;
    await me().expect(401);
    await me('bad.token.value').expect(401);
    for (const options of [{ secret: randomBytes(32).toString('base64url') }, { algorithm: 'HS384' as const }]) {
      await me(await jwt.signAsync(payload, options)).expect(401);
    }
    for (const extra of [{ iss: 'wrong' }, { aud: 'wrong' }, { exp: Number(payload.iat) - 1 }, { sub: 'not-object-id' }, { av: -1 }, { exp: undefined }]) {
      const invalid = { ...payload, ...extra };
      if (invalid.exp === undefined) delete invalid.exp;
      await me(await jwt.signAsync(invalid)).expect(401);
    }
  });

  it('TC11–12: validates session owner, revocation, absolute expiry and backend roles', async () => {
    await fixture();
    const result = await login().expect(200);
    const token = result.body.accessToken;
    await request(app.getHttpServer()).get('/api/auth-probe/admin').expect(401);
    await request(app.getHttpServer()).get('/api/auth-probe/admin').set('Authorization', `Bearer ${token}`).expect(403);
    const session = await sessions.findOne().orFail();
    // Raw fixture writes intentionally bypass immutable schema fields to simulate invalid historical records.
    for (const values of [{ revoked_at: new Date() }, { expires_at: new Date(Date.now() - 1000) }, { account_id: new Types.ObjectId() }]) {
      await sessions.collection.updateOne({ _id: session._id }, { $set: values });
      await me(token).expect(401);
      await sessions.collection.updateOne({ _id: session._id }, { $set: { account_id: session.account_id, expires_at: session.expires_at }, $unset: { revoked_at: '' } });
    }
    const adminRole = await repository.ensureRole('ADMIN', 'Admin');
    await accounts.updateOne({}, { role_id: adminRole.id });
    await request(app.getHttpServer()).get('/api/auth-probe/admin').set('Authorization', `Bearer ${token}`).expect(200);
    await roles.collection.updateOne({ _id: adminRole._id }, { $set: { code: 'BROKEN' } });
    await me(token).expect(401);
  });

  it('TC13–14: refresh rotates atomically, rejects replay without clearing cookie or revoking the winning session', async () => {
    await fixture();
    const first = await login().expect(200);
    const oldCookie = cookie(first);
    const results = await Promise.all([refresh(oldCookie), refresh(oldCookie)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 401]);
    const winner = results.find(result => result.status === 200)!;
    const loser = results.find(result => result.status === 401)!;
    expect(loser.headers['set-cookie']).toBeUndefined();
    const reused = await refresh(oldCookie).expect(401);
    expect(reused.headers['set-cookie']).toBeUndefined();
    expect((await sessions.findOne().orFail()).revoked_at).toBeUndefined();
    const next = await refresh(cookie(winner)).expect(200);
    await me(next.body.accessToken).expect(200);
    expect(await sessions.countDocuments()).toBe(1);
  });

  it('TC15: rotation preserves absolute expiry and caps access expiry at the remaining session lifetime', async () => {
    await fixture();
    const result = await login().expect(200);
    const expiresAt = new Date(Date.now() + 61000);
    await sessions.collection.updateOne({}, { $set: { expires_at: expiresAt } });
    const next = await refresh(cookie(result)).expect(200);
    const claims = app.get(JwtService).decode(next.body.accessToken) as { exp: number };
    expect(claims.exp).toBeLessThanOrEqual(Math.floor(expiresAt.getTime() / 1000));
    expect(next.body.expiresIn).toBeLessThanOrEqual(61);
    expect((await sessions.findOne().orFail()).expires_at.getTime()).toBe(expiresAt.getTime());
    await sessions.collection.updateOne({}, { $set: { expires_at: new Date(Date.now() - 1000) } });
    await refresh(cookie(next)).expect(401);
    await me(next.body.accessToken).expect(401);
  });

  it('TC16: profile changes remain valid; current status and auth_version invalidate access and refresh immediately', async () => {
    await fixture();
    const first = await login().expect(200);
    await accounts.updateOne({}, { $set: { full_name: 'Tên mới' }, $inc: { version: 1 } });
    expect((await me(first.body.accessToken).expect(200)).body.fullName).toBe('Tên mới');
    await accounts.updateOne({}, { $inc: { auth_version: 1 } });
    await me(first.body.accessToken).expect(401); await refresh(cookie(first)).expect(401);
    const second = await login().expect(200);
    await accounts.updateOne({}, { status: 'LOCKED' });
    await me(second.body.accessToken).expect(401); await refresh(cookie(second)).expect(401);
  });

  it('TC22: responses/logs are private, health stays public, and production contains no test endpoints', async () => {
    await fixture();
    const result = await login().expect(200);
    await login({ phone, password: 'sensitive-password' }).expect(401);
    const unauthorized = await me('sensitive-access-token').expect(401);
    expect(unauthorized.headers['cache-control']).toBe('no-store');
    for (const [line] of log.mock.calls) {
      expect(Object.keys(JSON.parse(line as string)).sort()).toEqual(['code', 'requestId', 'status', 'timestamp']);
      expect(line).not.toMatch(/sensitive|password|Cookie|Authorization|refresh/);
    }
    await request(app.getHttpServer()).get('/api/health/live').expect(200);
    const spec = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(spec.body.paths['/api/auth/me'].get.security).toEqual([{ bearer: [] }]);
    expect(spec.body.paths['/api/auth/login'].post.responses['429']).toBeDefined();
    expect((await me(result.body.accessToken).expect(200)).body).not.toHaveProperty('authVersion');
  });

  it('TC21: actual database outage yields safe 503 for login, me and refresh, then recovers', async () => {
    await fixture();
    const result = await login().expect(200);
    // Windows stops the fixture mongod forcibly; flush writes before simulating the outage.
    await connection.db!.admin().command({ fsync: 1 });
    await mongo.stop({ doCleanup: false });
    try {
      const responses = await Promise.all([login(), me(result.body.accessToken), refresh(cookie(result))]);
      for (const response of responses) {
        expect(response.status).toBe(503);
        expect(response.body.error.code).toBe('DATABASE_UNAVAILABLE');
        expect(response.body.requestId).toEqual(expect.any(String));
        expect(JSON.stringify(response.body)).not.toMatch(/mongodb|127\.0\.0\.1|password|refresh_hash/);
        expect(response.headers['set-cookie']).toBeUndefined();
      }
    } finally {
      await mongo.start(true);
      const deadline = Date.now() + 20000;
      while (connection.readyState !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
    }
    expect(await accounts.countDocuments()).toBe(1);
    expect(await sessions.countDocuments()).toBe(1);
    await me(result.body.accessToken).expect(200);
  });
});
