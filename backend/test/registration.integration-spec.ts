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
import { RegistrationLimiter } from '../src/modules/auth/registration.guard';
import { Account } from '../src/modules/users/schemas/account.schema';
import { Role } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const password = '  Mật khẩu US-01 😀  ';
const input = { fullName: '  Nguyễn   Văn A  ', phone: '0901234567', password };

describe('US-01 registration with real MongoDB indexes and US-02 login', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication;
  let connection: Connection;
  let accounts: Model<Account>;
  let roles: Model<Role>;
  let repository: UsersRepository;
  let log: jest.SpyInstance;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: '8.0.17' },
      instance: { dbName: 'gym_management_test_us01', args: ['--setParameter', 'enableTestCommands=1'] } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(),
      MONGODB_DB: 'gym_management_test_us01', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: '' });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    accounts = app.get<Model<Account>>(getModelToken('Account'));
    roles = app.get<Model<Role>>(getModelToken('Role'));
    repository = app.get(UsersRepository);
  }, 600000);

  beforeEach(async () => {
    log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = new RegistrationLimiter();
    jest.spyOn(app.get(RegistrationLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    await Promise.all(['accounts', 'roles', 'members', 'memberships', 'trainers', 'auth_sessions']
      .map(name => connection.collection(name).deleteMany({})));
    await repository.ensureRole('MEMBER', 'Hội viên');
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = savedEnv; });

  function register(body: object = input) { return request(app.getHttpServer()).post('/api/auth/register').send(body); }
  async function assertOnlyAccount() {
    expect(await accounts.countDocuments()).toBe(1);
    for (const name of ['members', 'memberships', 'trainers', 'auth_sessions']) {
      expect(await connection.collection(name).countDocuments()).toBe(0);
    }
  }

  it.each([undefined, '', '  MEMBER@EXAMPLE.COM  '])('TC01–02/05: creates only MEMBER account (email=%s), then logs in through US-02', async email => {
    const response = await register({ ...input, ...(email === undefined ? {} : { email }) }).expect(201);
    expect(response.body).toEqual({ id: expect.stringMatching(/^[a-f\d]{24}$/), nextAction: 'LOGIN' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    const account = await accounts.findById(response.body.id).select('+password_hash').orFail();
    const role = await roles.findById(account.role_id).orFail();
    expect(role.code).toBe('MEMBER');
    expect(account).toMatchObject({ full_name: 'Nguyễn Văn A', phone: '+84901234567', status: 'ACTIVE', version: 0, auth_version: 0 });
    expect(account.id.equals(account._id)).toBe(true);
    expect(account.created_at).toBeInstanceOf(Date); expect(account.updated_at).toBeInstanceOf(Date);
    expect(account.email).toBe(email ? 'member@example.com' : undefined);
    const raw = await connection.collection('accounts').findOne({ _id: account._id });
    expect(Object.hasOwn(raw!, 'email')).toBe(!!email);
    expect(account.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const passwords = app.get(PasswordService);
    expect(await passwords.verify(account.password_hash, password)).toBe(true);
    expect(await passwords.verify(account.password_hash, password.trim())).toBe(false);
    await assertOnlyAccount();
    const login = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone: input.phone, password }).expect(200);
    expect(login.body.user).toMatchObject({ id: response.body.id, roleCode: 'MEMBER' });
    await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`).expect(200, login.body.user);
    expect(JSON.stringify(response.body)).not.toMatch(/password|hash|token|role|memberId/i);
    expect(JSON.stringify(log.mock.calls)).not.toContain(password);
    expect(JSON.stringify(log.mock.calls)).not.toContain(account.password_hash);
  });

  it.each([
    { fullName: '' }, { fullName: 'A' }, { fullName: 'A'.repeat(121) }, { phone: 901234567 }, { phone: '(0901234567' },
    { phone: '0'.repeat(33) }, { password: 'short' }, { password: '😀'.repeat(129) }, { email: null }, { email: 123 },
    { email: 'invalid' }, { email: 'a'.repeat(180) + '@example.com' },
    { roleCode: 'ADMIN' }, { role_id: new Types.ObjectId().toHexString() }, { status: 'ACTIVE' },
    { id: new Types.ObjectId().toHexString() }, { account_id: new Types.ObjectId().toHexString() },
    { version: 1 }, { auth_version: 1 }, { confirmPassword: password },
  ])('TC03–04: rejects invalid/forbidden fields %j', async patch => {
    const response = await register({ ...input, ...patch }).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await accounts.countDocuments()).toBe(0);
    expect(JSON.stringify(response.body)).not.toContain(password);
    expect(JSON.stringify(log.mock.calls)).not.toContain(password);
  });

  it('TC03/05: rejects non-object/non-JSON bodies and missing fields, accepts Unicode boundaries', async () => {
    await register({}).expect(400);
    await register([input]).expect(400);
    await request(app.getHttpServer()).post('/api/auth/register').type('text').send('not JSON').expect(400);
    await request(app.getHttpServer()).post('/api/auth/register').type('json').send('{').expect(400);
    await register({ ...input, password: '😀'.repeat(128), fullName: '😀'.repeat(120) }).expect(201);
  });

  it.each(['phone', 'email'] as const)('TC06: returns one generic conflict for equivalent %s even on LOCKED staff accounts', async field => {
    const role = await repository.ensureRole('STAFF', 'Nhân viên');
    const account = await repository.createAccount({ roleId: role.id.toHexString(), fullName: 'Private Staff', phone: input.phone,
      email: 'staff@example.com', passwordHash: await app.get(PasswordService).hash(password) });
    await accounts.updateOne({ _id: account._id }, { $set: { status: 'LOCKED' } });
    const response = await register({ ...input, phone: field === 'phone' ? '+84 901 234 567' : '0907654321',
      ...(field === 'email' ? { email: ' STAFF@EXAMPLE.COM ' } : {}) }).expect(409);
    expect(response.body.error).toEqual({ code: 'REGISTRATION_CONFLICT', message: expect.any(String) });
    expect(JSON.stringify(response.body)).not.toMatch(/LOCKED|STAFF|Private Staff|staff@example.com|memberId/);
    expect(await accounts.countDocuments()).toBe(1);
  });

  it.each(['phone', 'email'] as const)('TC07: concurrent normalized %s registration has exactly one winner', async field => {
    const responses = await Promise.all([
      register({ ...input, email: 'race@example.com' }),
      register({ ...input, phone: field === 'phone' ? '+84 901 234 567' : '0907654321', email: ' RACE@EXAMPLE.COM ' }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect(responses.find(response => response.status === 409)!.body.error.code).toBe('REGISTRATION_CONFLICT');
    await assertOnlyAccount();
  });

  it.each([undefined, null])('TC08: unlinked offline member (account_id=%s) needs help without linking or disclosing the profile', async accountId => {
    const member = { phone: '+84901234567', full_name: 'Private Member', member_code: 'PRIVATE',
      ...(accountId === undefined ? {} : { account_id: accountId }) };
    const result = await connection.collection('members').insertOne(member);
    const before = await connection.collection('members').findOne({ _id: result.insertedId });
    const response = await register().expect(409);
    expect(response.body.error).toEqual({ code: 'REGISTRATION_NEEDS_HELP', message: expect.stringContaining('quầy') });
    expect(JSON.stringify(response.body)).not.toMatch(/Private Member|PRIVATE|memberId|account_id/);
    expect(await accounts.countDocuments()).toBe(0);
    expect(await connection.collection('members').findOne({ _id: result.insertedId })).toEqual(before);
  });

  it('TC09: desk creation after the offline check never links or overwrites either record', async () => {
    const passwords = app.get(PasswordService);
    const hash = passwords.hash.bind(passwords);
    jest.spyOn(passwords, 'hash').mockImplementationOnce(async value => {
      // Hàng rào xác định: quầy ghi sau khi kiểm tra members, trước khi account insert.
      await connection.collection('members').insertOne({ phone: '+84901234567', full_name: 'Offline Member' });
      return hash(value);
    });
    const response = await register().expect(201);
    const member = await connection.collection('members').findOne({ phone: '+84901234567' });
    expect(member!.account_id).toBeUndefined();
    expect(member!.full_name).toBe('Offline Member');
    expect(await accounts.findById(response.body.id).orFail()).toMatchObject({ full_name: 'Nguyễn Văn A' });
  });

  it('TC10: missing MEMBER is a configuration conflict and never seeds roles', async () => {
    await roles.deleteMany({});
    expect((await register().expect(409)).body.error.code).toBe('ROLE_NOT_CONFIGURED');
    expect(await roles.countDocuments()).toBe(0); expect(await accounts.countDocuments()).toBe(0);
  });

  it('TC11: native MongoDB insert failure returns 503 without account, cookie or false success', async () => {
    await connection.db!.admin().command({ configureFailPoint: 'failCommand', mode: { times: 1 }, data: { failCommands: ['insert'], errorCode: 91 } });
    const response = await register().expect(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await accounts.countDocuments()).toBe(0);
    expect(JSON.stringify(response.body)).not.toMatch(/Mongo|password|stack|uri|hash/i);
  });

  it('TC12: sixth request is limited even with forged forwarding headers; login remains independent', async () => {
    await register().expect(201);
    for (let index = 0; index < 4; index++) await register().expect(409);
    const response = await register().set('X-Forwarded-For', '192.0.2.3').expect(429);
    expect(response.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect((await accounts.findOne().orFail()).status).toBe('ACTIVE');
    await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone: input.phone, password }).expect(200);
  });

  it('documents the public DTO/response and member phone lookup index', async () => {
    const document = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(Object.keys(document.body.components.schemas.RegisterDto.properties).sort()).toEqual(['email', 'fullName', 'password', 'phone']);
    expect(document.body.components.schemas.RegisterResponseDto.properties.nextAction.enum).toEqual(['LOGIN']);
    expect(document.body.paths['/api/auth/register'].post.responses['201']).toBeDefined();
    expect((await connection.collection('members').listIndexes().toArray()).some(index => index.key.phone === 1)).toBe(true);
  });

  it('TC11: losing the real DB connection fails safely with SERVICE_UNAVAILABLE', async () => {
    await connection.close();
    const response = await register().expect(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});

describe('US-01 registration limit window', () => {
  it('separates IPs and permits requests when the 60-second window expires', () => {
    const limiter = new RegistrationLimiter();
    for (let count = 0; count < 5; count++) expect(limiter.consume('ip-a', 1000)).toBe(0);
    expect(limiter.consume('ip-a', 1001)).toBe(60);
    expect(limiter.consume('ip-b', 1001)).toBe(0);
    expect(limiter.consume('ip-a', 61000)).toBe(0);
  });
});
