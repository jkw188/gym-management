import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import { Long, ObjectId } from 'mongodb';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { DataGuardsService } from '../src/infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { MembersRepository } from '../src/modules/members/members.repository';
import { UsersRepository } from '../src/modules/users/users.repository';
import { Account } from '../src/modules/users/schemas/account.schema';
import { ROLE_CODES, RoleCode } from '../src/modules/users/schemas/role.schema';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';

const origin = 'http://localhost:5173';
const password = 'US09 test password 123';
const verification = { verificationMethod: 'IN_PERSON_ACCOUNT', verificationNote: 'Đối chiếu chủ tài khoản trực tiếp tại quầy' };

describe('US-09: counter members, real JWT, transactions and two instances', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let second: INestApplication;
  let connection: Connection;
  let hash: string;
  let staffToken: string;
  let adminToken: string;
  let staff: Account;
  let sequence = 0;
  const savedEnv = { ...process.env };
  const db = () => connection.db!;

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' },
      replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_us09',
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: '',
      SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '' });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    second = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(second); await second.init();
    expect(second.get(getConnectionToken())).not.toBe(connection);
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
    staff = await account('STAFF');
    staffToken = await login(staff);
    adminToken = await login(await account('ADMIN'));
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await second?.close(); await app?.close(); await mongo?.stop(); process.env = savedEnv; });

  async function account(roleCode: RoleCode = 'MEMBER', phone?: string) {
    const repository = app.get(UsersRepository);
    const role = await repository.findRoleByCode(roleCode);
    return repository.createAccount({ roleId: role!.id.toHexString(), fullName: `US09 ${roleCode}`,
      phone: phone ?? `090${String(++sequence).padStart(7, '0')}`, passwordHash: hash });
  }
  async function login(target: Account) {
    const response = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin)
      .send({ phone: target.phone, password }).expect(200);
    return response.body.accessToken as string;
  }
  const input = (phone = `091${String(++sequence).padStart(7, '0')}`) => ({ fullName: 'Hội viên tại quầy', phone });
  function create(body: object = input(), key: string = randomUUID(), token = staffToken, instance = app) {
    return request(instance.getHttpServer()).post('/api/members').set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key).send(body);
  }
  function link(id: string, accountId: string, key: string = randomUUID(), extra: object = {}, token = staffToken, instance = app) {
    return request(instance.getHttpServer()).post(`/api/members/${id}/link`).set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key).send({ accountId, version: 0, ...verification, ...extra });
  }
  async function pair() {
    const target = await account();
    const created = await create(input(target.phone)).expect(201);
    return { target, member: created.body as { id: string; memberCode: string; phone: string; version: number } };
  }

  it.each(['STAFF', 'ADMIN'] as const)('TC01/04: %s creates independent profiles with server ids and BSON Int64 revision', async role => {
    const before = await db().collection('accounts').countDocuments();
    const result = await create({ ...input(), birthDate: '2000-02-29', address: '  Quận 1  ' }, randomUUID(), role === 'ADMIN' ? adminToken : staffToken).expect(201);
    expect(result.body).toMatchObject({ memberCode: `HV-${result.body.id}`, version: 0, birthDate: '2000-02-29', address: 'Quận 1' });
    expect(result.body.memberCode).toHaveLength(27);
    expect(result.body).not.toHaveProperty('accountId');
    const record = await db().collection('members').findOne({ _id: new ObjectId(result.body.id) });
    expect(record!.id).toEqual(record!._id);
    expect(record).not.toHaveProperty('account_id');
    expect(await db().collection('members').countDocuments({ service_revision: { $type: 'long' } })).toBe(1);
    await create().expect(201);
    expect(await db().collection('accounts').countDocuments()).toBe(before);
    for (const name of ['memberships', 'transactions', 'pt_bookings']) expect(await db().collection(name).countDocuments()).toBe(0);
  });

  it.each(['MEMBER', 'TRAINER'] as const)('TC02: rejects %s for create, lookup and link', async role => {
    const token = await login(await account(role));
    await create(input(), randomUUID(), token).expect(403);
    await link(new ObjectId().toHexString(), new ObjectId().toHexString(), randomUUID(), {}, token).expect(403);
    await request(app.getHttpServer()).get('/api/members/link-candidates?phone=0901234567').set('Authorization', `Bearer ${token}`).expect(403);
    expect(await db().collection('members').countDocuments()).toBe(0);
  });

  it('TC02: revoked session and missing authentication cannot write', async () => {
    await db().collection('auth_sessions').updateMany({ account_id: staff._id }, { $set: { revoked_at: new Date() } });
    await create().expect(401);
    await link(new ObjectId().toHexString(), new ObjectId().toHexString()).expect(401);
    await request(app.getHttpServer()).post('/api/members').send(input()).expect(401);
  });

  it.each([
    { fullName: 'A' }, { fullName: null }, { phone: 'abc' }, { birthDate: '2001-02-29' },
    { birthDate: '2999-01-01' }, { birthDate: null }, { address: 'a'.repeat(256) }, { address: null },
    { memberCode: 'HV-CLIENT' }, { accountId: new ObjectId().toHexString() }, { membershipId: new ObjectId().toHexString() },
    { version: 0 }, { id: new ObjectId().toHexString() },
  ])('TC03: rejects invalid or extra fields %j', async extra => {
    const result = await create({ ...input(), ...extra }).expect(400);
    expect(result.body.error.details.length).toBeGreaterThan(0);
    expect(await db().collection('members').countDocuments()).toBe(0);
  });

  it('TC03: requires a UUID v4 key', async () => {
    await create(input(), 'not-a-key').expect(400);
    await request(app.getHttpServer()).post('/api/members').set('Authorization', `Bearer ${staffToken}`).send(input()).expect(400);
  });

  it('TC02: actor state is rechecked after the HTTP guard and before creating a member', async () => {
    const guards = app.get(DataGuardsService);
    const acquire = guards.acquire.bind(guards);
    jest.spyOn(guards, 'acquire').mockImplementationOnce(async (session, targets) => {
      await request(second.getHttpServer()).patch(`/api/users/${staff.id.toHexString()}/status`)
        .set('Authorization', `Bearer ${adminToken}`).send({ status: 'LOCKED', version: 0, reason: 'Kiểm tra lại actor trong transaction' }).expect(200);
      await acquire(session, targets);
    });
    await create().expect(401);
    expect(await db().collection('members').countDocuments()).toBe(0);
  });

  it('missing administration guard is reported as infrastructure unavailability without partial creation', async () => {
    await db().collection('security_state').deleteMany({});
    await create().expect(503);
    expect(await db().collection('members').countDocuments()).toBe(0);
  });

  it('TC05: concurrent normalized phones with distinct keys produce one profile', async () => {
    const results = await Promise.all([create(input('0901234567')), create(input('+84 901 234 567'), randomUUID(), staffToken, second)]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    expect(results.find(result => result.status === 409)!.body.error.code).toBe('MEMBER_PHONE_EXISTS');
    expect(await db().collection('members').countDocuments()).toBe(1);
  });

  it('TC06/07: concurrent same key replays original; changed payload conflicts; operation lookup recovers lost response', async () => {
    const key = randomUUID(); const body = input();
    const [one, two] = await Promise.all([create(body, key), create(body, key, staffToken, second)]);
    expect(one.status).toBe(201); expect(two.status).toBe(201); expect(two.body).toEqual(one.body);
    await create({ ...body, fullName: 'Tên khác' }, key).expect(409).expect(response => expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT'));
    const lookup = await request(app.getHttpServer()).get(`/api/operations/MEMBER_CREATE/${key}`).set('Authorization', `Bearer ${staffToken}`).expect(200);
    expect(lookup.body.responseBody).toEqual(one.body);
    expect(await db().collection('members').countDocuments()).toBe(1);
    await request(app.getHttpServer()).get(`/api/operations/MEMBER_CREATE/${key}`).set('Authorization', `Bearer ${adminToken}`).expect(404);
  });

  it('TC08: explicit link records server actor/time and replays without a second audit', async () => {
    const { target, member } = await pair(); const key = randomUUID();
    const result = await link(member.id, target.id.toHexString(), key).expect(200);
    expect(result.body).toMatchObject({ linked: true, member: { id: member.id, accountId: target.id.toHexString(), version: 1 } });
    const event = await db().collection('member_link_events').findOne({ member_id: new ObjectId(member.id) });
    expect(event).toMatchObject({ account_id: target._id, verified_by: staff._id, verification_method: 'IN_PERSON_ACCOUNT' });
    expect(event!.verified_at).toBeInstanceOf(Date);
    expect(event!.request_key).toMatch(/^[a-f\d]{64}$/);
    expect((await link(member.id, target.id.toHexString(), key).expect(200)).body).toEqual(result.body);
    await link(member.id, target.id.toHexString(), key, { verificationNote: 'Ghi nhận đối chiếu khác với yêu cầu đầu' }).expect(409)
      .expect(response => expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT'));
    await link(member.id, target.id.toHexString()).expect(409).expect(response => expect(response.body.error.code).toBe('MEMBER_ALREADY_LINKED'));
    expect(await db().collection('member_link_events').countDocuments()).toBe(1);
  });

  it('TC09: exact phone lookup exposes only the candidate allowlist, with no pre-link', async () => {
    const { target, member } = await pair();
    const lookup = (phone: string) => request(app.getHttpServer()).get('/api/members/link-candidates').query({ phone }).set('Authorization', `Bearer ${staffToken}`);
    expect((await lookup(target.phone).expect(200)).body).toEqual({ items: [{ id: target.id.toHexString(), fullName: target.full_name, phone: target.phone, canLink: true }] });
    await lookup('090').expect(400);
    await request(app.getHttpServer()).get('/api/users').set('Authorization', `Bearer ${staffToken}`).expect(403);
    expect((await db().collection('members').findOne({ _id: new ObjectId(member.id) }))!.account_id).toBeUndefined();
    await link(member.id, target.id.toHexString()).expect(200);
    expect((await lookup(target.phone).expect(200)).body.items[0].canLink).toBe(false);
    expect((await lookup('+84999999999').expect(200)).body).toEqual({ items: [] });
  });

  it.each(['LOCKED', 'STAFF', 'TRAINER_PROFILE', 'PHONE_MISMATCH', 'LINKED'] as const)('TC09: rejects target condition %s', async condition => {
    const { target, member } = await pair();
    let expected = 'ACCOUNT_NOT_ELIGIBLE';
    if (condition === 'LOCKED') await db().collection('accounts').updateOne({ _id: target._id }, { $set: { status: 'LOCKED' } });
    if (condition === 'STAFF') {
      const role = await app.get(UsersRepository).findRoleByCode('STAFF');
      await db().collection('accounts').updateOne({ _id: target._id }, { $set: { role_id: role!._id } });
    }
    if (condition === 'TRAINER_PROFILE') await db().collection('trainers').insertOne({ account_id: target._id });
    if (condition === 'PHONE_MISMATCH') {
      await app.get(UsersRepository).updateAccount(target.id.toHexString(), 0, { phone: '0998888777' }); expected = 'IDENTITY_MISMATCH';
    }
    if (condition === 'LINKED') {
      const other = await create().expect(201);
      await db().collection('members').updateOne({ _id: new ObjectId(other.body.id) }, { $set: { account_id: target._id } }); expected = 'ACCOUNT_ALREADY_LINKED';
    }
    await link(member.id, target.id.toHexString()).expect(409).expect(response => expect(response.body.error.code).toBe(expected));
    expect(await db().collection('member_link_events').countDocuments()).toBe(0);
    expect((await db().collection('members').findOne({ _id: new ObjectId(member.id) }))!.account_id).toBeUndefined();
  });

  it.each([{ verificationMethod: undefined }, { verificationMethod: 'SELF' }, { verificationNote: 'short' },
    { verificationNote: ' '.repeat(20) }, { verificationNote: 'x'.repeat(501) }, { verifiedBy: new ObjectId().toHexString() }])('TC09: rejects missing/invalid verification or actor override %j', async extra => {
    const { target, member } = await pair();
    await link(member.id, target.id.toHexString(), randomUUID(), extra).expect(400);
    expect(await db().collection('member_link_events').countDocuments()).toBe(0);
  });

  it('TC09: validates ids, member version and missing resources', async () => {
    const { target, member } = await pair();
    await link('bad-id', target.id.toHexString()).expect(400);
    await link(member.id, 'bad-id').expect(400);
    await link(new ObjectId().toHexString(), target.id.toHexString()).expect(404);
    await link(member.id, new ObjectId().toHexString()).expect(404);
    await link(member.id, target.id.toHexString(), randomUUID(), { version: 1 }).expect(409)
      .expect(response => expect(response.body.error.code).toBe('VERSION_CONFLICT'));
  });

  it('TC10: two instances competing to link commit exactly one audit; account index prevents a second member reference', async () => {
    const { target, member } = await pair();
    const results = await Promise.all([link(member.id, target.id.toHexString()),
      link(member.id, target.id.toHexString(), randomUUID(), {}, staffToken, second)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(await db().collection('member_link_events').countDocuments()).toBe(1);
    const other = await create().expect(201);
    await expect(db().collection('members').updateOne({ _id: new ObjectId(other.body.id) }, { $set: { account_id: target._id } })).rejects.toMatchObject({ code: 11000 });
  });

  it.each(['role', 'status'] as const)('TC11: concurrent link and %s mutation follow one valid commit order', async change => {
    const { target, member } = await pair();
    const mutation = request(second.getHttpServer()).patch(`/api/users/${target.id.toHexString()}/${change}`)
      .set('Authorization', `Bearer ${adminToken}`).send({ version: 0, reason: 'Kiểm tra tranh chấp US09',
        ...(change === 'role' ? { roleCode: 'STAFF' } : { status: 'LOCKED' }) });
    const [linked, changed] = await Promise.all([link(member.id, target.id.toHexString()), mutation]);
    const eventCount = await db().collection('member_link_events').countDocuments();
    if (change === 'role') {
      expect([linked.status, changed.status].sort()).toEqual([200, 409]);
      if (linked.status === 200) { expect(changed.body.error.code).toBe('ROLE_IN_USE'); expect(eventCount).toBe(1); }
      else { expect(linked.body.error.code).toBe('ACCOUNT_NOT_ELIGIBLE'); expect(eventCount).toBe(0); }
    } else {
      expect(changed.status).toBe(200);
      expect([200, 409]).toContain(linked.status);
      expect(eventCount).toBe(linked.status === 200 ? 1 : 0);
    }
  });

  it('TC12: audit failure rolls back link, version, guard revisions and operation result', async () => {
    const { target, member } = await pair(); const key = randomUUID();
    const before = await db().collection('members').findOne({ _id: new ObjectId(member.id) });
    jest.spyOn(app.get(MembersRepository), 'insertLinkEvent').mockRejectedValueOnce(new Error('AUDIT_TEST_FAILURE'));
    await link(member.id, target.id.toHexString(), key).expect(503);
    expect(await db().collection('members').findOne({ _id: new ObjectId(member.id) })).toEqual(before);
    expect(await db().collection('member_link_events').countDocuments()).toBe(0);
    expect(await db().collection('operation_requests').countDocuments({ operation: 'MEMBER_LINK' })).toBe(0);
    await link(member.id, target.id.toHexString(), key).expect(200);
  });

  it('TC13: editing an account after link leaves member contact fields and link unchanged', async () => {
    const { target, member } = await pair();
    await link(member.id, target.id.toHexString()).expect(200);
    await request(app.getHttpServer()).patch(`/api/users/${target.id.toHexString()}`).set('Authorization', `Bearer ${adminToken}`)
      .send({ version: 0, fullName: 'Tên tài khoản mới', phone: '0987777666' }).expect(200);
    const stored = await app.get(MembersRepository).findById(new Types.ObjectId(member.id));
    expect(stored).toMatchObject({ phone: member.phone, full_name: 'Hội viên tại quầy', account_id: target._id });
  });

  it('TC14 contract: competing EN-02 member guard serializes recipient capture before link', async () => {
    const { target, member } = await pair();
    let release!: () => void; let entered!: () => void;
    let linkEntered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const linkReady = new Promise<void>(resolve => { linkEntered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const secondGuards = second.get(DataGuardsService);
    const acquire = secondGuards.acquire.bind(secondGuards);
    jest.spyOn(secondGuards, 'acquire').mockImplementation(async (session, targets) => {
      if (targets.members?.some(id => id.toHexString() === member.id)) linkEntered();
      await acquire(session, targets);
    });
    // Settlement module is not implemented yet; exercise its documented member-guard contract.
    const capture = app.get(TransactionRunner).run(async session => {
      await app.get(DataGuardsService).acquire(session, { members: [new ObjectId(member.id)] });
      const recipient = (await app.get(MembersRepository).findById(new Types.ObjectId(member.id), session))!.account_id;
      entered(); await gate;
      return recipient;
    });
    await ready;
    const linking = link(member.id, target.id.toHexString(), randomUUID(), {}, staffToken, second).then(result => result);
    // Do not release until the other instance has started acquiring this same guard.
    try { await Promise.race([linkReady, linking.then(() => { throw new Error('LINK_DID_NOT_ACQUIRE_MEMBER_GUARD'); })]); }
    finally { release(); }
    expect(await capture).toBeUndefined();
    expect((await linking).status).toBe(200);
    const recipientAfter = await app.get(TransactionRunner).run(async session => {
      await app.get(DataGuardsService).acquire(session, { members: [new ObjectId(member.id)] });
      return (await app.get(MembersRepository).findById(new Types.ObjectId(member.id), session))!.account_id;
    });
    expect(recipientAfter).toEqual(target._id);
  });
});
