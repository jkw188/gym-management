import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { DataGuardsService } from '../src/infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { AuthService } from '../src/modules/auth/auth.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { MembersRepository } from '../src/modules/members/members.repository';
import { MembersService } from '../src/modules/members/members.service';
import { Account } from '../src/modules/users/schemas/account.schema';
import { ROLE_CODES, RoleCode } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const password = 'US10 test password 123';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe('US-10: profile update with real MongoDB indexes, JWT and concurrent writers', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let second: INestApplication;
  let connection: Connection;
  let hash: string;
  let staff: Account;
  let token: string;
  let sequence = 0;
  const savedEnv = { ...process.env };
  const db = () => connection.db!;
  const memberDocument = (id: string) => db().collection('members').findOne({ _id: new ObjectId(id) });

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(),
      MONGODB_DB: 'gym_management_test_us10', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '' });
    const { AppModule } = await import('../src/app.module');
    for (let index = 0; index < 2; index++) {
      const instance = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
      if (index === 0) app = instance; else second = instance;
      configureHttp(instance); await instance.init();
      await Promise.all(Object.values(instance.get<Connection>(getConnectionToken()).models).map(model => model.init()));
    }
    connection = app.get<Connection>(getConnectionToken());
    hash = await app.get(PasswordService).hash(password);
  }, 600000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const instance of [app, second]) {
      const limiter = new LoginLimiter();
      jest.spyOn(instance.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    }
    for (const collection of await db().collections()) await collection.deleteMany({});
    for (const code of ROLE_CODES) await app.get(UsersRepository).ensureRole(code, code);
    await db().collection<{ _id: string; revision: Long }>('security_state').insertOne({ _id: 'account-administration', revision: Long.ZERO });
    staff = await account('STAFF'); token = await login(staff);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await second?.close(); await app?.close(); await mongo?.stop(); process.env = savedEnv; });

  async function account(code: RoleCode) {
    const users = app.get(UsersRepository);
    const role = await users.findRoleByCode(code);
    return users.createAccount({ roleId: role!.id.toHexString(), fullName: `US10 ${code}`,
      phone: `090${String(++sequence).padStart(7, '0')}`, passwordHash: hash });
  }
  async function login(target: Account) {
    const response = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin)
      .send({ phone: target.phone, password }).expect(200);
    return response.body.accessToken as string;
  }
  async function create(phone = `091${String(++sequence).padStart(7, '0')}`) {
    const result = await request(app.getHttpServer()).post('/api/members').set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID()).send({ fullName: 'Hội viên gốc', phone, birthDate: '2000-02-29', address: 'Quận 1' }).expect(201);
    return result.body as { id: string; version: number; phone: string };
  }
  function patch(id: string, body: object, bearer: string | null = token, instance = app) {
    const call = request(instance.getHttpServer()).patch(`/api/members/${id}`);
    return (bearer ? call.set('Authorization', `Bearer ${bearer}`) : call).send(body);
  }
  function get(id: string, bearer: string | null = token) {
    const call = request(app.getHttpServer()).get(`/api/members/${id}`);
    return bearer ? call.set('Authorization', `Bearer ${bearer}`) : call;
  }

  it.each(['STAFF', 'ADMIN'] as const)('TC01: %s changes exactly allowed fields with server version/actor/time', async role => {
    const member = await create();
    const bearer = role === 'STAFF' ? token : await login(await account('ADMIN'));
    const before = (await memberDocument(member.id))!;
    const result = await patch(member.id, { version: 0, fullName: '  Nguyễn   An ', phone: '0987654321',
      birthDate: '2004-02-29', address: '  TP HCM  ' }, bearer).expect(200);
    expect(result.body).toMatchObject({ changed: true, member: { fullName: 'Nguyễn An', phone: '+84987654321',
      birthDate: '2004-02-29', address: 'TP HCM', version: 1 } });
    const after = (await memberDocument(member.id))!;
    expect(after.updated_by.toHexString()).toBe((await app.get(AuthService).validateAccessToken(bearer)).id);
    expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
    for (const field of ['_id', 'id', 'member_code', 'service_revision', 'created_by', 'created_at']) expect(after[field]).toEqual(before[field]);
    const detail = await get(member.id).expect(200);
    expect(detail.body.member).toEqual(result.body.member);
    expect(detail.body.entitlementSummary).toEqual({ GYM: ['NONE'], PT: ['NONE'] });
    expect(Number.isNaN(Date.parse(detail.body.asOf))).toBe(false);
    expect(Object.keys(result.body.member).sort()).toEqual(['id', 'memberCode', 'fullName', 'phone', 'birthDate', 'address', 'version', 'createdAt', 'updatedAt'].sort());
  });

  it('TC02: denies missing bearer, Member/PT and locked accounts for both GET and PATCH', async () => {
    const member = await create(); const before = await memberDocument(member.id);
    await patch(member.id, { version: 0, fullName: 'Không được sửa' }, null).expect(401);
    await get(member.id, null).expect(401);
    for (const role of ['MEMBER', 'TRAINER'] as const) {
      const bearer = await login(await account(role));
      await patch(member.id, { version: 0, fullName: 'Không được sửa' }, bearer).expect(403);
      await get(member.id, bearer).expect(403);
    }
    await db().collection('accounts').updateOne({ _id: staff._id }, { $set: { status: 'LOCKED' } });
    await patch(member.id, { version: 0, fullName: 'Không được sửa' }).expect(401); await get(member.id).expect(401);
    expect(await memberDocument(member.id)).toEqual(before);
  });

  it('TC03/07: rejects extra fields and invalid types/version/empty payload without writing', async () => {
    const member = await create(); const before = await memberDocument(member.id);
    const extras = ['id', 'memberCode', 'accountId', 'status', 'role', 'password', 'membership', 'endDate', 'service_revision', 'updatedBy', 'createdBy', 'money'];
    for (const field of extras) await patch(member.id, { version: 0, fullName: 'Tên mới', [field]: 'forbidden' }).expect(400);
    for (const payload of [{ version: 0 }, { fullName: 'Tên mới' }, { version: -1, fullName: 'Tên mới' },
      { version: 0.5, phone: '0901234567' }, { version: '0', phone: '0901234567' },
      { version: 0, fullName: null }, { version: 0, fullName: ' ' }, { version: 0, phone: null },
      { version: 0, phone: '' }, { version: 0, phone: 901234567 }, { version: 0, phone: ' '.repeat(33) },
      { version: 0, address: 'x'.repeat(256) }, { version: 0, birthDate: 20000101 }]) {
      const result = await patch(member.id, payload).expect(400);
      expect(result.body.error.code).toBe('VALIDATION_ERROR'); expect(result.body.error.details.length).toBeGreaterThan(0);
    }
    expect(await memberDocument(member.id)).toEqual(before);
  });

  it('TC05/06: validates calendar and VN date; omit keeps data, null/blank removes optional fields', async () => {
    const member = await create();
    for (const birthDate of ['2001-02-29', '2000-02-30', '2000-13-01', '01/01/2000', '9999-01-01', '']) {
      const result = await patch(member.id, { version: 0, birthDate }).expect(400);
      expect(result.body.error.details[0].field).toBe('birthDate');
    }
    await patch(member.id, { version: 0, fullName: 'Tên mới' }).expect(200);
    expect(await memberDocument(member.id)).toMatchObject({ birth_date: '2000-02-29', address: 'Quận 1' });
    await patch(member.id, { version: 1, birthDate: null, address: '   ' }).expect(200);
    let stored = (await memberDocument(member.id))!;
    expect(stored).not.toHaveProperty('birth_date'); expect(stored).not.toHaveProperty('address');
    await patch(member.id, { version: 2, birthDate: '2004-02-29', address: 'Địa chỉ mới' }).expect(200);
    await patch(member.id, { version: 3, address: null }).expect(200);
    stored = (await memberDocument(member.id))!; expect(stored.birth_date).toBe('2004-02-29'); expect(stored).not.toHaveProperty('address');
  });

  it('TC08/09: unique index arbitrates normalized phones and simultaneous updates across instances', async () => {
    const a = await create(); const b = await create();
    const duplicate = await patch(a.id, { version: 0, phone: b.phone.replace('+84', '0') }).expect(409);
    expect(duplicate.body.error.code).toBe('MEMBER_PHONE_EXISTS');
    const results = await Promise.all([patch(a.id, { version: 0, fullName: 'Tên thứ nhất' }),
      patch(a.id, { version: 0, fullName: 'Tên thứ hai' }, token, second)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)!.body.error.code).toBe('VERSION_CONFLICT');
    const phones = await Promise.all([patch(a.id, { version: 1, phone: '0988888888' }),
      patch(b.id, { version: 0, phone: '+84988888888' }, token, second)]);
    expect(phones.map(result => result.status).sort()).toEqual([200, 409]);
    expect(phones.find(result => result.status === 409)!.body.error.code).toBe('MEMBER_PHONE_EXISTS');
  });

  it('TC10/11: normalized no-op keeps timestamp/actor/version, stale identical payload still conflicts', async () => {
    const member = await create(); const before = await memberDocument(member.id);
    const noop = await patch(member.id, { version: 0, fullName: ' Hội   viên gốc ', phone: member.phone.replace('+84', '0'), address: ' Quận 1 ' }).expect(200);
    expect(noop.body.changed).toBe(false); expect(await memberDocument(member.id)).toEqual(before);
    await patch(member.id, { version: 0, fullName: 'Tên mới' }).expect(200);
    const stale = await patch(member.id, { version: 0, fullName: 'Tên mới' }).expect(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await memberDocument(member.id))!.version).toBe(1);
  });

  it('TC04/12: real link race preserves account, auth and existing financial snapshots', async () => {
    const target = await account('MEMBER'); const member = await create(target.phone);
    const accountBefore = await db().collection('accounts').findOne({ _id: target._id });
    const snapshot = { _id: new ObjectId(), member_id: new ObjectId(member.id), full_name: 'Tên lúc bán', phone: target.phone, amount: 100000 };
    for (const name of ['service_sales', 'invoices', 'memberships']) await db().collection(name).insertOne({ ...snapshot });
    const results = await Promise.all([patch(member.id, { version: 0, fullName: 'Tên sau chỉnh sửa' }),
      request(second.getHttpServer()).post(`/api/members/${member.id}/link`).set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID()).send({ version: 0, accountId: target.id.toHexString(),
          verificationMethod: 'IN_PERSON_ACCOUNT', verificationNote: 'Đã đối chiếu trực tiếp tại quầy' })]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const current = (await memberDocument(member.id))!;
    if (!current.account_id) {
      await request(app.getHttpServer()).post(`/api/members/${member.id}/link`).set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID()).send({ version: 1, accountId: target.id.toHexString(),
          verificationMethod: 'IN_PERSON_ACCOUNT', verificationNote: 'Đã đối chiếu trực tiếp tại quầy' }).expect(200);
    }
    const linked = (await memberDocument(member.id))!;
    await patch(member.id, { version: Number(linked.version), fullName: 'Tên độc lập', phone: '0977777777', birthDate: null, address: null }).expect(200);
    expect((await memberDocument(member.id))!.account_id).toEqual(target._id);
    expect(await db().collection('accounts').findOne({ _id: target._id })).toEqual(accountBefore);
    for (const name of ['service_sales', 'invoices', 'memberships']) expect(await db().collection(name).findOne({ _id: snapshot._id })).toEqual(snapshot);
    await login(target); // Original account phone/password still works.
  });

  it('TC12: profile write waits for sale guard transaction and preserves its revision/snapshot', async () => {
    const member = await create(); const id = new Types.ObjectId(member.id);
    const locked = deferred(); const release = deferred(); const writing = deferred();
    const repository = second.get(MembersRepository); const original = repository.updateProfile.bind(repository);
    jest.spyOn(repository, 'updateProfile').mockImplementation((...args) => { writing.resolve(); return original(...args); });
    const sale = app.get(TransactionRunner).run(async session => {
      await app.get(DataGuardsService).acquire(session, { members: [id] });
      const snapshot = await app.get(MembersRepository).findById(id, session);
      locked.resolve(); await release.promise;
      await db().collection('service_sales').insertOne({ member_id: id, snapshot: { fullName: snapshot!.full_name, phone: snapshot!.phone } }, { session });
    });
    await locked.promise;
    const editing = patch(member.id, { version: 0, fullName: 'Tên sau bán' }, token, second).then(result => result);
    await writing.promise; release.resolve(); await sale;
    expect((await editing).status).toBe(200);
    const stored = (await memberDocument(member.id))!;
    expect(stored.full_name).toBe('Tên sau bán'); expect(stored.service_revision.toString()).toBe('1');
    expect(await db().collection('service_sales').findOne({ member_id: id })).toMatchObject({ snapshot: { fullName: 'Hội viên gốc', phone: member.phone } });
  });

  it('TC12: caller transaction retries re-read version instead of overwriting after a write conflict', async () => {
    const member = await create(); const read = deferred(); const release = deferred();
    const repository = app.get(MembersRepository); const original = repository.findById.bind(repository);
    let attempts = 0;
    jest.spyOn(repository, 'findById').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1] && ++attempts === 1) { read.resolve(); await release.promise; }
      return result;
    });
    const actor = await app.get(AuthService).validateAccessToken(token);
    const transaction = app.get(TransactionRunner).run(session => app.get(MembersService).update(actor, member.id,
      { version: 0, fullName: 'Không được ghi đè' }, session));
    const failure = transaction.catch(error => error);
    await read.promise;
    await patch(member.id, { version: 0, fullName: 'Bản đã lưu' }, token, second).expect(200);
    release.resolve();
    expect(await failure).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect(attempts).toBeGreaterThanOrEqual(2); expect((await memberDocument(member.id))!.full_name).toBe('Bản đã lưu');
  });

  it('TC13: safe 503 envelope/requestId, missing/invalid ids, and recovery through GET after response loss', async () => {
    const member = await create();
    await patch('invalid', { version: 0, fullName: 'Tên mới' }).expect(400);
    const missing = await patch(new ObjectId().toHexString(), { version: 0, fullName: 'Tên mới' }).expect(404);
    expect(missing.body.error.code).toBe('MEMBER_NOT_FOUND');
    await get(new ObjectId().toHexString()).expect(404); await get('invalid').expect(400);
    const spy = jest.spyOn(app.get(MembersRepository), 'findById').mockRejectedValueOnce(new Error('mongodb://private-credential'));
    const unavailable = await patch(member.id, { version: 0, fullName: 'Tên mới' }).expect(503);
    expect(unavailable.body.error.code).toBe('SERVICE_UNAVAILABLE'); expect(unavailable.body.requestId).toBeTruthy();
    expect(JSON.stringify(unavailable.body)).not.toContain('private-credential'); spy.mockRestore();
    // A lost response is represented by ignoring the successful response, then reading the committed document.
    await patch(member.id, { version: 0, fullName: 'Bản đã lưu' }).expect(200);
    expect((await get(member.id).expect(200)).body.member).toMatchObject({ version: 1, fullName: 'Bản đã lưu' });
  });

  it('TC11: a no-op racing a committed update still atomically rejects its stale version', async () => {
    const member = await create(); const read = deferred(); const release = deferred();
    const repository = app.get(MembersRepository); const original = repository.findById.bind(repository);
    jest.spyOn(repository, 'findById').mockImplementationOnce(async (...args) => {
      const snapshot = await original(...args); read.resolve(); await release.promise; return snapshot;
    });
    const noop = patch(member.id, { version: 0, fullName: 'Hội viên gốc' }).then(result => result);
    await read.promise;
    await patch(member.id, { version: 0, fullName: 'Bản mới' }, token, second).expect(200);
    release.resolve();
    expect((await noop).body.error.code).toBe('VERSION_CONFLICT');
    expect((await memberDocument(member.id))!.full_name).toBe('Bản mới');
  });

  it('TC13: actual database outage returns SERVICE_UNAVAILABLE even when JWT lookup fails first', async () => {
    const member = await create();
    await mongo.stop();
    for (const call of [() => patch(member.id, { version: 0, fullName: 'Không được báo thành công' }), () => get(member.id)]) {
      const result = await call().expect(503);
      expect(result.body.error.code).toBe('SERVICE_UNAVAILABLE'); expect(result.body.requestId).toBeTruthy();
      expect(JSON.stringify(result.body)).not.toMatch(/mongodb:|ECONNREFUSED|ServerSelection|password_hash/);
    }
  });
});
