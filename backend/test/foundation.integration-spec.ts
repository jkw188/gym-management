import 'reflect-metadata';
import { Body, Controller, Get, INestApplication, Module, Post, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { IsInt, IsString } from 'class-validator';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Model } from 'mongoose';
import request from 'supertest';
import { spawn } from 'node:child_process';
import { configureHttp } from '../src/common/http/configure-http';
import { mapError } from '../src/common/http/http-error.filter';
import { PasswordService } from '../src/common/security/password.service';
import { Account } from '../src/modules/users/schemas/account.schema';
import { Role } from '../src/modules/users/schemas/role.schema';
import { SeedAdminService } from '../src/modules/users/seed-admin.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { UsersService } from '../src/modules/users/users.service';
import { readConfiguration } from '../src/config/configuration';
import { readAuthConfiguration } from '../src/config/auth.configuration';
import { Public } from '../src/modules/auth/auth.decorators';
import { randomBytes } from 'node:crypto';

class ProbeDto {
  @IsString() name!: string;
  @IsInt() version!: number;
}
@Controller('probe')
@Public()
class ProbeController {
  @Post() validate(@Body() dto: ProbeDto) { return dto; }
  @Get('error') fail() { throw new Error('Authorization Cookie password password_hash mongodb://secret token'); }
}

const seedInput = { phone: '0901234567', fullName: '  Admin   Test ', password: '  Test mật khẩu 123  ', email: ' ADMIN@EXAMPLE.COM ' };

function runProcess(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Child process did not exit')); }, 25000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}

describe('EN-01 integration with a real isolated mongod', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication;
  let connection: Connection;
  let accounts: Model<Account>;
  let roles: Model<Role>;
  let repository: UsersRepository;
  let seed: SeedAdminService;
  let users: UsersService;
  let passwordHash: string;
  const savedEnv = { ...process.env };
  let log: jest.SpyInstance;
  let harnessModule: Type<unknown>;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: '8.0.17' }, instance: { dbName: 'gym_management_test_en01' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_en01', PORT: '3000', FRONTEND_ORIGIN: 'http://localhost:5173', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url') });
    const { AppModule } = await import('../src/app.module');
    @Module({ imports: [AppModule], controllers: [ProbeController] })
    class HarnessModule {}
    harnessModule = HarnessModule;
    app = await NestFactory.create(HarnessModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    accounts = app.get<Model<Account>>(getModelToken('Account'));
    roles = app.get<Model<Role>>(getModelToken('Role'));
    repository = app.get(UsersRepository);
    seed = app.get(SeedAdminService);
    users = app.get(UsersService);
    passwordHash = await app.get(PasswordService).hash(seedInput.password);
  }, 600000);

  beforeEach(async () => {
    log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await Promise.all([accounts.deleteMany({}), roles.deleteMany({})]);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  async function createAccount(phone: string, email?: string) {
    const role = await repository.ensureRole('MEMBER', 'Hội viên');
    return repository.createAccount({ roleId: role.id.toHexString(), phone, fullName: 'Thành viên', passwordHash, email });
  }

  it('TC06–07: unique phone/email are atomic; optional emails are omitted; BSON counters are int32', async () => {
    const writes = await Promise.allSettled([createAccount('0901234567'), createAccount('+84 901 234 567')]);
    expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failure = writes.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(mapError(failure.reason).status).toBe(409);
    await createAccount('0901234568', '  ');
    expect(await accounts.countDocuments({ email: { $exists: false } })).toBe(2);
    await createAccount('0901234569', ' MEMBER@EXAMPLE.COM ');
    await expect(createAccount('0901234570', 'member@example.com')).rejects.toMatchObject({ code: 11000 });
    const account = await accounts.findOne().orFail();
    expect(account.id.equals(account._id)).toBe(true);
    expect(account.password_hash).toBeUndefined();
    const selected = await accounts.findOne().select('+password_hash').orFail();
    expect(JSON.stringify(selected)).not.toContain(passwordHash);
    const [types] = await accounts.aggregate([{ $project: { versionType: { $type: '$version' }, authType: { $type: '$auth_version' } } }]);
    expect(types).toMatchObject({ versionType: 'int', authType: 'int' });
    for (const field of ['version', 'auth_version']) {
      for (const value of [-1, 0.5, 2147483648]) {
        await expect(accounts.updateOne({ _id: account._id }, { [field]: value }, { runValidators: true })).rejects.toThrow();
      }
    }
  });

  it('TC09: seed twice preserves account and all existing password/profile data', async () => {
    expect(await seed.run(seedInput)).toBe('created');
    const first = await accounts.findOne().select('+password_hash').orFail();
    const before = first.toObject();
    expect(await seed.run({ ...seedInput, fullName: 'Different Name', password: 'A different password', email: 'other@example.com' })).toBe('unchanged');
    const after = await accounts.findOne().select('+password_hash').orFail();
    expect(after.toObject()).toEqual(before);
    expect(await roles.countDocuments()).toBe(4);
    expect(await accounts.countDocuments()).toBe(1);
    expect(await roles.findOne({ code: 'TRAINER' }).orFail()).toMatchObject({ name: 'PT' });
    expect(await users.findByPhone('84901234567')).toMatchObject({ phone: '+84901234567', fullName: 'Admin Test' });
    expect(JSON.stringify(await users.findByPhone('0901234567'))).not.toContain('password');
    const credentials = await users.findCredentialsByPhone(seedInput.phone);
    expect(await app.get(PasswordService).verify(credentials!.passwordHash, seedInput.password)).toBe(true);
  });

  it('TC10: a Member or locked Admin is never promoted/unlocked or overwritten', async () => {
    await createAccount(seedInput.phone);
    const member = await accounts.findOne().select('+password_hash').orFail();
    await expect(seed.run(seedInput)).rejects.toMatchObject({ status: 409, code: 'SEED_ADMIN_CONFLICT' });
    expect((await accounts.findOne().select('+password_hash').orFail()).toObject()).toEqual(member.toObject());
    await accounts.deleteMany({});
    await seed.run(seedInput);
    await accounts.updateOne({}, { status: 'LOCKED' });
    const locked = await accounts.findOne().select('+password_hash').orFail();
    await expect(seed.run(seedInput)).rejects.toMatchObject({ status: 409 });
    expect((await accounts.findOne().select('+password_hash').orFail()).toObject()).toEqual(locked.toObject());
  });

  it('TC11: simultaneous seeds converge; partial role failure can be retried', async () => {
    const original = repository.ensureRole.bind(repository);
    const interrupted = jest.spyOn(repository, 'ensureRole').mockImplementationOnce(original).mockRejectedValueOnce(new Error('simulated interruption'));
    await expect(seed.run(seedInput)).rejects.toThrow('simulated interruption');
    interrupted.mockRestore();
    expect(await roles.countDocuments()).toBe(1);
    const result = await Promise.all([seed.run(seedInput), seed.run(seedInput)]);
    expect(result.sort()).toEqual(['created', 'unchanged']);
    expect(await accounts.countDocuments()).toBe(1);
    expect(await roles.countDocuments()).toBe(4);
  });

  it('TC11: duplicate email without a matching Admin phone is a seed conflict', async () => {
    await createAccount('0901234568', 'admin@example.com');
    await expect(seed.run(seedInput)).rejects.toMatchObject({ status: 409 });
    expect(await accounts.countDocuments()).toBe(1);
  });

  it('TC12–13: strict DTO, malformed JSON, request IDs, safe errors and OpenAPI', async () => {
    const http = app.getHttpServer();
    await request(http).post('/api/probe').send({ name: 'Name', version: 1 }).expect(201);
    for (const body of [{ name: 'Name', version: '1' }, { name: 'Name', version: 1, extra: 'secret' }, { name: 12, version: 1 }]) {
      const response = await request(http).post('/api/probe').send(body).expect(400);
      expect(response.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' }, requestId: expect.any(String) });
      expect(response.headers['x-request-id']).toBe(response.body.requestId);
      expect(response.body.error.details.length).toBeGreaterThan(0);
      expect(JSON.stringify(response.body)).not.toContain('secret');
    }
    const malformed = await request(http).post('/api/probe').set('Content-Type', 'application/json').send('{"password":"secret",').expect(400);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
    const failure = await request(http).get('/api/probe/error').set('Authorization', 'secret-token').set('Cookie', 'secret-cookie').expect(500);
    expect(failure.body.requestId).toMatch(/^[a-f\d-]{36}$/);
    expect(JSON.stringify(failure.body)).not.toMatch(/secret|mongodb|password/);
    for (const [line] of log.mock.calls) {
      const record = JSON.parse(line as string);
      expect(record).toMatchObject({ timestamp: expect.any(String), requestId: expect.any(String), code: expect.any(String) });
      expect(line).not.toMatch(/secret|mongodb|password|Authorization|Cookie/);
    }
    await request(http).get('/api/absent').expect(404);
    const spec = await request(http).get('/api/docs-json').expect(200);
    expect(spec.body.paths).toHaveProperty('/api/health/live');
    expect(spec.body.paths['/api/health/ready'].get.responses['503']).toBeDefined();
    const live = await request(http).get('/api/health/live').set('Origin', 'http://localhost:5173').expect(200);
    expect(live.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(live.body).toEqual({ status: 'ok' });
    await request(http).get('/api/health/ready').expect(200, { status: 'ready' });
  });

  it('TC01–03: actual startup exits nonzero safely for missing/invalid config and unreachable DB', async () => {
    const cases = [
      { MONGODB_URI: '', expected: 'MONGODB_URI' },
      { PORT: 'abc', expected: 'PORT' },
      { FRONTEND_ORIGIN: 'https://example.com/path', expected: 'FRONTEND_ORIGIN' },
      { MONGODB_URI: 'mongodb://user:secret@127.0.0.1:1', expected: 'STARTUP_FAILED' },
    ];
    for (const { expected, ...env } of cases) {
      const result = await runProcess(['dist/main.js'], env);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain(expected);
      expect(result.output).not.toContain('secret');
      expect(result.output).not.toContain('mongodb://');
    }
  });

  it('TC09–11: seed and ensure-indexes CLI commands run successfully against real MongoDB', async () => {
    const env = { SEED_ADMIN_PHONE: seedInput.phone, SEED_ADMIN_NAME: seedInput.fullName, SEED_ADMIN_PASSWORD: seedInput.password, SEED_ADMIN_EMAIL: seedInput.email };
    const indexes = await runProcess(['scripts/admin.cjs', 'ensure-indexes'], env);
    expect(indexes).toMatchObject({ code: 0 });
    const results = await Promise.all([runProcess(['scripts/admin.cjs', 'seed-admin'], env), runProcess(['scripts/admin.cjs', 'seed-admin'], env)]);
    expect(results.map(result => result.code)).toEqual([0, 0]);
    expect(results.map(result => result.output).join('')).not.toContain(seedInput.password);
    expect(await accounts.countDocuments()).toBe(1);
    expect(await roles.countDocuments()).toBe(4);
  });

  it('TC13: production serves health while Swagger is disabled and missing indexes block startup', async () => {
    const productionConfig = new ConfigService({ ...readConfiguration({ ...process.env, NODE_ENV: 'production' }), ...readAuthConfiguration(process.env) });
    const createProduction = async () => {
      const module = await Test.createTestingModule({ imports: [harnessModule] })
        .overrideProvider(ConfigService).useValue(productionConfig).compile();
      const production = module.createNestApplication({ logger: false, bodyParser: false });
      configureHttp(production);
      return production;
    };
    const production = await createProduction();
    try {
      await production.init();
      await request(production.getHttpServer()).get('/api/health/ready').expect(200);
      await request(production.getHttpServer()).get('/api/docs-json').expect(404);
      await request(production.getHttpServer()).get('/api/docs').expect(404);
    } finally { await production.close(); }
    await accounts.collection.dropIndex('accounts_phone_unique');
    const withoutIndex = await createProduction();
    try { await expect(withoutIndex.init()).rejects.toThrow('DATABASE_INDEXES_REQUIRED'); }
    finally { await withoutIndex.close(); await accounts.createIndexes(); }
  });

  it('TC04: live remains 200 when MongoDB stops; ready becomes 503 and recovers after restart', async () => {
    await mongo.stop({ doCleanup: false });
    await request(app.getHttpServer()).get('/api/health/live').expect(200);
    const down = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
    expect(down.body).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' }, requestId: expect.any(String) });
    expect(JSON.stringify(down.body)).not.toContain('127.0.0.1');
    await mongo.start();
    const deadline = Date.now() + 20000;
    while (connection.readyState !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
    await request(app.getHttpServer()).get('/api/health/ready').expect(200);
  });
});
