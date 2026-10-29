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
import { todayInVietnam } from '../src/modules/profile/profile.service';
import { Account } from '../src/modules/users/schemas/account.schema';
import { Role, RoleCode } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const password = 'Mật khẩu US-04 123';
const phones: Record<string, string> = { member: '0901111111', trainer: '0902222222', admin: '0903333333', staff: '0904444444', other: '0905555555' };

describe('US-04 own profile against an isolated real mongod', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication;
  let connection: Connection;
  let accounts: Model<Account>;
  let roles: Model<Role>;
  let sessions: Model<AuthSession>;
  let repository: UsersRepository;
  let hash: string;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: '8.0.17' }, instance: { dbName: 'gym_management_test_us04' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(),
      MONGODB_DB: 'gym_management_test_us04', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url') });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
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
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    await Promise.all([accounts.deleteMany({}), roles.deleteMany({}), sessions.deleteMany({}),
      connection.collection('members').deleteMany({}), connection.collection('trainers').deleteMany({})]);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = savedEnv; });

  async function account(key: keyof typeof phones, code: RoleCode, email?: string) {
    const role = await repository.ensureRole(code, code);
    return repository.createAccount({ roleId: role.id.toHexString(), phone: phones[key], fullName: `US04 ${key}`, email, passwordHash: hash });
  }
  async function login(phone: string) {
    const response = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    const cookie = (response.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    return { token: response.body.accessToken as string, cookie };
  }
  function getProfile(token?: string) {
    const call = request(app.getHttpServer()).get('/api/profile/me');
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  }
  function patchProfile(token: string | undefined, body: object) {
    const call = request(app.getHttpServer()).patch('/api/profile/me');
    if (token) call.set('Authorization', `Bearer ${token}`);
    return call.send(body);
  }
  function refresh(cookie: string) {
    return request(app.getHttpServer()).post('/api/auth/refresh').set('Origin', origin).set('Cookie', cookie).send({});
  }
  async function stored(id: Types.ObjectId) {
    return accounts.findById(id).orFail().lean();
  }
  function tomorrowInVietnam() {
    return todayInVietnam(new Date(Date.now() + 24 * 60 * 60 * 1000));
  }

  it.each([['member', 'MEMBER'], ['trainer', 'TRAINER']] as const)('TC01: %s without a business profile reads and edits their own account', async (key, code) => {
    const owner = await account(key, code);
    const other = await account('other', 'MEMBER');
    const { token } = await login(phones[key]);
    const read = await getProfile(token).expect(200);
    expect(read.body).toEqual({ id: owner.id.toHexString(), fullName: `US04 ${key}`, phone: owner.phone, roleCode: code,
      status: 'ACTIVE', version: 0, createdAt: expect.any(String), updatedAt: expect.any(String) });
    expect(JSON.stringify(read.body)).not.toMatch(/password|hash|auth_?version/i);
    const saved = await patchProfile(token, { version: 0, fullName: 'Tên Mới', birthDate: '2000-01-15', address: 'Quận 1' }).expect(200);
    expect(saved.body).toEqual({ reauthenticationRequired: false, profile: expect.objectContaining({
      fullName: 'Tên Mới', birthDate: '2000-01-15', address: 'Quận 1', version: 1 }) });
    expect((await stored(owner._id)).full_name).toBe('Tên Mới');
    expect((await stored(other._id)).full_name).toBe('US04 other');
  });

  it('TC02: anonymous gets 401, Admin/Staff get 403, and a subject id in the body is rejected', async () => {
    await account('admin', 'ADMIN');
    await account('staff', 'STAFF');
    const member = await account('member', 'MEMBER');
    const other = await account('other', 'MEMBER');
    expect((await getProfile().expect(401)).body.error.code).toBe('UNAUTHENTICATED');
    await patchProfile(undefined, { version: 0, fullName: 'X Y' }).expect(401);
    for (const key of ['admin', 'staff'] as const) {
      const { token } = await login(phones[key]);
      await getProfile(token).expect(403);
      await patchProfile(token, { version: 0, fullName: 'Không Được' }).expect(403);
    }
    const { token } = await login(phones.member);
    for (const extra of [{ accountId: other.id.toHexString() }, { id: other.id.toHexString() }]) {
      await patchProfile(token, { version: 0, fullName: 'Sửa Chéo', ...extra }).expect(400);
    }
    expect((await stored(other._id)).full_name).toBe('US04 other');
    expect((await stored(member._id)).version).toBe(0);
  });

  it('TC03: editing account information leaves linked member/trainer business records untouched', async () => {
    const member = await account('member', 'MEMBER');
    const trainer = await account('trainer', 'TRAINER');
    const memberRecord = { _id: new Types.ObjectId(), account_id: member._id, full_name: 'Hồ sơ HV', phone: '+84901111111', birth_date: '1990-01-01', address: 'Cũ' };
    const trainerRecord = { _id: new Types.ObjectId(), account_id: trainer._id, specialty: 'Yoga', status: 'ACTIVE' };
    await connection.collection('members').insertOne(memberRecord);
    await connection.collection('trainers').insertOne(trainerRecord);
    for (const key of ['member', 'trainer'] as const) {
      const { token } = await login(phones[key]);
      await patchProfile(token, { version: 0, fullName: 'Tên Tài Khoản', birthDate: '1995-05-05', address: 'Mới' }).expect(200);
    }
    expect(await connection.collection('members').findOne({ _id: memberRecord._id })).toEqual(memberRecord);
    expect(await connection.collection('trainers').findOne({ _id: trainerRecord._id })).toEqual(trainerRecord);
  });

  it('TC04: invalid calendar date, future date or a long address returns 400 on that field and saves nothing', async () => {
    const member = await account('member', 'MEMBER');
    const { token } = await login(phones.member);
    const cases: [object, string][] = [
      [{ birthDate: '2025-02-29' }, 'birthDate'], [{ birthDate: '2024-13-01' }, 'birthDate'], [{ birthDate: '15/01/2000' }, 'birthDate'],
      [{ birthDate: tomorrowInVietnam() }, 'birthDate'], [{ address: 'a'.repeat(256) }, 'address'],
    ];
    for (const [body, field] of cases) {
      const response = await patchProfile(token, { version: 0, ...body }).expect(400);
      expect(response.body.error.details).toEqual([expect.objectContaining({ field })]);
    }
    const unchanged = await stored(member._id);
    expect(unchanged.version).toBe(0);
    expect(unchanged.birth_date).toBeUndefined();
    expect(unchanged.address).toBeUndefined();
  });

  it('TC05: a leap day and today are valid; name and address are normalized', async () => {
    const member = await account('member', 'MEMBER');
    const { token } = await login(phones.member);
    const saved = await patchProfile(token, { version: 0, birthDate: '2024-02-29', fullName: '  Nguyễn   Văn  A ', address: '  12 Lê Lợi, Q1  ' }).expect(200);
    expect(saved.body.profile).toMatchObject({ birthDate: '2024-02-29', fullName: 'Nguyễn Văn A', address: '12 Lê Lợi, Q1' });
    await patchProfile(token, { version: 1, birthDate: todayInVietnam(), address: 'b'.repeat(255) }).expect(200);
    expect((await stored(member._id)).address).toHaveLength(255);
  });

  it('TC06: omit keeps, null/empty removes optional fields, and null name/phone are rejected', async () => {
    const member = await account('member', 'MEMBER', 'member@gym.test');
    const { token } = await login(phones.member);
    await patchProfile(token, { version: 0, birthDate: '2001-01-01', address: 'Hà Nội' }).expect(200);
    await patchProfile(token, { version: 1, fullName: 'Chỉ Đổi Tên' }).expect(200);
    expect(await stored(member._id)).toMatchObject({ email: 'member@gym.test', birth_date: '2001-01-01', address: 'Hà Nội' });
    await patchProfile(token, { version: 2, birthDate: null, address: '   ' }).expect(200);
    const cleared = await stored(member._id);
    expect(cleared.birth_date).toBeUndefined();
    expect(cleared.address).toBeUndefined();
    for (const body of [{ fullName: null }, { phone: null }, { fullName: '' }, { phone: '' }]) {
      await patchProfile(token, { version: 3, ...body }).expect(400);
    }
    await patchProfile(token, { version: 3 }).expect(400);
    const second = await login(phones.member);
    await patchProfile(second.token, { version: 3, email: '' }).expect(200);
    expect((await stored(member._id)).email).toBeUndefined();
  });

  it('TC07: forbidden fields return 400 and never change role, status or password', async () => {
    const member = await account('member', 'MEMBER');
    const before = await accounts.findById(member._id).select('+password_hash').orFail().lean();
    const { token } = await login(phones.member);
    for (const extra of [{ roleCode: 'ADMIN' }, { role_id: new Types.ObjectId().toHexString() }, { status: 'LOCKED' },
      { password: 'Mat khau moi 123' }, { auth_version: 9 }, { authVersion: 9 }, { account_id: 'x' }, { specialty: 'Yoga' }]) {
      await patchProfile(token, { version: 0, fullName: 'Thử Quyền', ...extra }).expect(400);
    }
    expect(await accounts.findById(member._id).select('+password_hash').orFail().lean()).toEqual(before);
  });

  it('TC08: duplicate phone/email (including a race) returns 409 and keeps the old data', async () => {
    const member = await account('member', 'MEMBER');
    const other = await account('other', 'MEMBER', 'other@gym.test');
    const { token } = await login(phones.member);
    expect((await patchProfile(token, { version: 0, phone: phones.other }).expect(409)).body.error.code).toBe('PHONE_ALREADY_EXISTS');
    expect((await patchProfile(token, { version: 0, email: 'OTHER@gym.test' }).expect(409)).body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    expect((await stored(member._id)).phone).toBe('+84901111111');

    const otherLogin = await login(phones.other);
    const race = await Promise.all([
      patchProfile(token, { version: 0, phone: '0909999999' }),
      patchProfile(otherLogin.token, { version: 0, phone: '0909999999' }),
    ]);
    expect(race.map(response => response.status).sort()).toEqual([200, 409]);
    expect(race.find(response => response.status === 409)!.body.error.code).toBe('PHONE_ALREADY_EXISTS');
    expect(await accounts.countDocuments({ phone: '+84909999999' })).toBe(1);
    const loser = race[0].status === 409 ? member : other;
    expect((await stored(loser._id)).phone).toBe(loser.phone);
  });

  it('TC09: two different PATCHes with the same version yield one 200 and one 409 VERSION_CONFLICT', async () => {
    const member = await account('member', 'MEMBER');
    const { token } = await login(phones.member);
    const results = await Promise.all([
      patchProfile(token, { version: 0, fullName: 'Bản Thứ Nhất' }),
      patchProfile(token, { version: 0, fullName: 'Bản Thứ Hai' }),
    ]);
    expect(results.map(response => response.status).sort()).toEqual([200, 409]);
    expect(results.find(response => response.status === 409)!.body.error.code).toBe('VERSION_CONFLICT');
    const winner = results.find(response => response.status === 200)!.body.profile.fullName;
    expect(await stored(member._id)).toMatchObject({ full_name: winner, version: 1 });
  });

  it('TC10: the same normalized data at the current version is a no-op', async () => {
    const member = await account('member', 'MEMBER', 'member@gym.test');
    const { token } = await login(phones.member);
    const before = await stored(member._id);
    const response = await patchProfile(token, { version: 0, phone: '+84 901 111 111', email: ' MEMBER@gym.test ', fullName: ' US04   member ' }).expect(200);
    expect(response.body.reauthenticationRequired).toBe(false);
    expect(response.body.profile.version).toBe(0);
    const after = await stored(member._id);
    expect(after).toMatchObject({ version: 0, auth_version: 0 });
    expect(after.updated_at).toEqual(before.updated_at);
    await getProfile(token).expect(200);
  });

  it('TC11: changing phone revokes both devices; login works only with the new phone', async () => {
    const member = await account('member', 'MEMBER');
    const deviceA = await login(phones.member);
    const deviceB = await login(phones.member);
    const response = await patchProfile(deviceA.token, { version: 0, phone: '0908888888' }).expect(200);
    expect(response.body).toMatchObject({ reauthenticationRequired: true, profile: { phone: '+84908888888', version: 1 } });
    expect((await stored(member._id)).auth_version).toBe(1);
    for (const device of [deviceA, deviceB]) {
      await getProfile(device.token).expect(401);
      await refresh(device.cookie).expect(401);
    }
    await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone: phones.member, password }).expect(401);
    const renewed = await login('0908888888');
    await getProfile(renewed.token).expect(200);
  });

  it('TC11: changing email also requires re-authentication', async () => {
    await account('member', 'MEMBER');
    const { token } = await login(phones.member);
    const response = await patchProfile(token, { version: 0, email: 'moi@gym.test' }).expect(200);
    expect(response.body.reauthenticationRequired).toBe(true);
    await getProfile(token).expect(401);
  });

  it('TC12: changing only name/birth date/address bumps version but keeps the session', async () => {
    const member = await account('member', 'MEMBER');
    const { token, cookie } = await login(phones.member);
    const response = await patchProfile(token, { version: 0, fullName: 'Tên Khác', birthDate: '1999-09-09', address: 'Đà Nẵng' }).expect(200);
    expect(response.body.reauthenticationRequired).toBe(false);
    expect(await stored(member._id)).toMatchObject({ version: 1, auth_version: 0 });
    await getProfile(token).expect(200);
    await refresh(cookie).expect(200);
  });

  it('TC13: a database failure returns 503 without saving; a resend after a lost response gets 409, not a second write', async () => {
    const member = await account('member', 'MEMBER');
    const { token } = await login(phones.member);
    jest.spyOn(repository, 'updateAccount').mockRejectedValueOnce(Object.assign(new Error('private detail'), { name: 'MongoNetworkError' }));
    const failed = await patchProfile(token, { version: 0, fullName: 'Lỗi DB' }).expect(503);
    expect(failed.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(failed.body)).not.toMatch(/private detail|mongodb/);
    expect((await stored(member._id)).version).toBe(0);
    await patchProfile(token, { version: 0, fullName: 'Đã Lưu' }).expect(200);
    await patchProfile(token, { version: 0, fullName: 'Đã Lưu Lần Hai' }).expect(409);
    expect((await getProfile(token).expect(200)).body).toMatchObject({ fullName: 'Đã Lưu', version: 1 });
  });
});
