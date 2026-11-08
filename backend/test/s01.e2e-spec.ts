import request from 'supertest';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { SecurityEvent } from '../src/modules/users/schemas/security-event.schema';
import { RoleCode, ROLE_CODES } from '../src/modules/users/schemas/role.schema';
import { S01Fixture, origin, password, reason } from './helpers/s01-fixture';

const fixture = new S01Fixture();
type Method = 'get' | 'post' | 'patch';
const matrix: { method: Method; path: string; roles: readonly RoleCode[]; status: number; body?: object }[] = [
  { method: 'get', path: '/api/auth/me', roles: ROLE_CODES, status: 200 },
  { method: 'get', path: '/api/users', roles: ['ADMIN'], status: 200 },
  { method: 'get', path: '/api/users/roles', roles: ['ADMIN'], status: 200 },
  { method: 'get', path: '/api/users/:id', roles: ['ADMIN'], status: 200 },
  { method: 'get', path: '/api/access/roles', roles: ['ADMIN'], status: 200 },
  { method: 'post', path: '/api/users', roles: ['ADMIN'], status: 201,
    body: { fullName: 'EN04 Created', phone: '0981234567', password, roleCode: 'MEMBER' } },
  { method: 'patch', path: '/api/users/:id', roles: ['ADMIN'], status: 200, body: { fullName: 'EN04 Updated', version: 0 } },
  { method: 'patch', path: '/api/users/:id/status', roles: ['ADMIN'], status: 200, body: { status: 'LOCKED', version: 0, reason } },
  { method: 'patch', path: '/api/users/:id/role', roles: ['ADMIN'], status: 200, body: { roleCode: 'STAFF', version: 0, reason } },
  { method: 'get', path: '/api/profile/me', roles: ['MEMBER', 'TRAINER'], status: 200 },
  { method: 'patch', path: '/api/profile/me', roles: ['MEMBER', 'TRAINER'], status: 200, body: { fullName: 'EN04 Profile', version: 0 } },
];

describe('EN-04 S01 acceptance: real login, HTTP bootstrap, replica set and two instances', () => {
  beforeAll(() => fixture.start(), 120000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await fixture.reset();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => fixture.close());

  // Explicit expected roles, independent of ACCESS_POLICY, detect accidental allow-all policy changes.
  describe.each(matrix)('$method $path', endpoint => {
    it.each([undefined, ...ROLE_CODES])('endpoint × role %s', async role => {
      const path = endpoint.path.replace(':id', fixture.users.MEMBER.id.toHexString());
      const call = request(fixture.app.getHttpServer())[endpoint.method](path);
      if (role) call.set('Authorization', `Bearer ${fixture.sessions[role].token}`);
      if (endpoint.body) call.send(endpoint.body);
      await call.expect(!role ? 401 : endpoint.roles.includes(role) ? endpoint.status : 403);
    });
  });

  const refresh = (cookie: string) => request(fixture.app.getHttpServer()).post('/api/auth/refresh')
    .set('Origin', origin).set('Cookie', cookie).send({});
  const me = (token: string) => request(fixture.app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  const patch = (path: string, body: object, instance = 0, token = fixture.sessions.ADMIN.token) =>
    request(fixture.apps[instance].getHttpServer()).patch(path).set('Authorization', `Bearer ${token}`).send(body);

  it('EN-01/US-01: index/hash/private mapping and public registration cannot elevate or link profiles', async () => {
    const indexes = await fixture.accounts.collection.listIndexes().toArray();
    expect(indexes.find(index => index.name === 'accounts_phone_unique')?.unique).toBe(true);
    expect((await fixture.accounts.findById(fixture.users.ADMIN.id).select('+password_hash').orFail()).password_hash).toMatch(/^\$argon2id\$/);
    const input = { fullName: 'EN04 Register', phone: '0971234567', password };
    await request(fixture.app.getHttpServer()).post('/api/auth/register').send({ ...input, roleCode: 'ADMIN' }).expect(400);
    const response = await request(fixture.app.getHttpServer()).post('/api/auth/register').send(input).expect(201);
    const session = await fixture.login(input.phone);
    const user = await me(session.token).expect(200);
    expect(user.body).toMatchObject({ id: response.body.id, roleCode: 'MEMBER' });
    expect(JSON.stringify(user.body)).not.toMatch(/password|hash|auth_version|refresh/);
    for (const name of ['members', 'trainers', 'memberships']) expect(await fixture.connection.collection(name).countDocuments()).toBe(0);
  });

  it('US-02: two requests race refresh CAS, exactly one wins and the old cookie cannot replay', async () => {
    const old = fixture.sessions.MEMBER;
    const responses = await Promise.all([refresh(old.cookie), refresh(old.cookie)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 401]);
    await refresh(old.cookie).expect(401);
    await me(responses.find(response => response.status === 200)!.body.accessToken).expect(200);
  });

  it('US-03: logout revokes old access/refresh through the real session and remains idempotent', async () => {
    const old = fixture.sessions.MEMBER;
    for (let index = 0; index < 2; index++) await request(fixture.app.getHttpServer()).post('/api/auth/logout')
      .set('Origin', origin).set('Authorization', `Bearer ${old.token}`).send({}).expect(204);
    await me(old.token).expect(401); await refresh(old.cookie).expect(401);
  });

  it('US-04: own profile rejects another account ID and identity updates revoke old tokens', async () => {
    const old = fixture.sessions.MEMBER;
    await patch('/api/profile/me', { fullName: 'EN04 Other', version: 0, accountId: fixture.users.TRAINER.id }, 0, old.token).expect(400);
    const profile = await request(fixture.app.getHttpServer()).get('/api/profile/me').set('Authorization', `Bearer ${old.token}`).expect(200);
    expect(profile.body.id).toBe(fixture.users.MEMBER.id.toHexString());
    await patch('/api/profile/me', { phone: '0961234567', version: 0 }, 0, old.token).expect(200);
    await me(old.token).expect(401); await refresh(old.cookie).expect(401);
    expect((await fixture.accounts.findById(fixture.users.TRAINER.id).orFail()).version).toBe(0);
  });

  it('US-06: independent connections enforce unique identities and version CAS', async () => {
    expect(fixture.apps[1].get<Connection>(getConnectionToken())).not.toBe(fixture.connection);
    const input = { fullName: 'EN04 Concurrent', phone: '0951234567', password, roleCode: 'MEMBER' };
    const create = (index: number) => request(fixture.apps[index].getHttpServer()).post('/api/users')
      .set('Authorization', `Bearer ${fixture.sessions.ADMIN.token}`).send(input);
    expect((await Promise.all([create(0), create(1)])).map(response => response.status).sort()).toEqual([201, 409]);
    const path = `/api/users/${fixture.users.MEMBER.id}`;
    const responses = await Promise.all([patch(path, { fullName: 'EN04 First', version: 0 }), patch(path, { fullName: 'EN04 Second', version: 0 }, 1)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(responses.find(response => response.status === 409)!.body.error.code).toBe('VERSION_CONFLICT');
  });

  it.each(['status', 'role'] as const)('US-07/08: %s change revokes access/refresh and a fresh login follows current state', async operation => {
    const target = fixture.users.MEMBER;
    const old = fixture.sessions.MEMBER;
    await patch(`/api/users/${target.id}/${operation}`, operation === 'status' ? { status: 'LOCKED', version: 0, reason } : { roleCode: 'STAFF', version: 0, reason }).expect(200);
    await me(old.token).expect(401); await refresh(old.cookie).expect(401);
    if (operation === 'status') {
      await request(fixture.app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone: target.phone, password }).expect(401);
      await patch(`/api/users/${target.id}/status`, { status: 'ACTIVE', version: 1, reason }).expect(200);
      await me(old.token).expect(401); await refresh(old.cookie).expect(401);
    }
    const current = await me((await fixture.login(target.phone)).token).expect(200);
    expect(current.body.roleCode).toBe(operation === 'status' ? 'MEMBER' : 'STAFF');
  });

  it.each(['status', 'role'] as const)('US-07/08: last Admin %s is protected with no audit', async operation => {
    const result = await patch(`/api/users/${fixture.users.ADMIN.id}/${operation}`, operation === 'status' ?
      { status: 'LOCKED', version: 0, reason } : { roleCode: 'STAFF', version: 0, reason }).expect(409);
    expect(result.body.error.code).toBe('LAST_ACTIVE_ADMIN');
    expect(await fixture.connection.collection('security_events').countDocuments()).toBe(0);
  });

  it.each(['status', 'role'] as const)('US-07/08: two instances race %s versus role; one active Admin survives', async operation => {
    const other = await fixture.account('ADMIN');
    const auth = await fixture.login(other.phone, fixture.apps[1]);
    const responses = await Promise.all([
      patch(`/api/users/${other.id}/${operation}`, operation === 'status' ? { status: 'LOCKED', version: 0, reason } : { roleCode: 'STAFF', version: 0, reason }),
      patch(`/api/users/${fixture.users.ADMIN.id}/role`, { roleCode: 'STAFF', version: 0, reason }, 1, auth.token),
    ]);
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    expect([401, 403, 409]).toContain(responses.find(response => response.status !== 200)!.status);
    expect(await fixture.accounts.countDocuments({ role_id: fixture.users.ADMIN.role_id, status: 'ACTIVE' })).toBe(1);
    expect(await fixture.connection.collection('security_events').countDocuments()).toBe(1);
  });

  it('US-07/08: audit failure rolls back account, revision and event in the real transaction', async () => {
    const events = fixture.app.get<Model<SecurityEvent>>(getModelToken('SecurityEvent'));
    const failpoint = jest.spyOn(events, 'create').mockRejectedValueOnce(new Error('EN04 audit failpoint'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await patch(`/api/users/${fixture.users.MEMBER.id}/status`, { status: 'LOCKED', version: 0, reason }).expect(503);
      expect(await fixture.accounts.findById(fixture.users.MEMBER.id).lean()).toMatchObject({ status: 'ACTIVE', version: 0, auth_version: 0 });
      expect(await events.countDocuments()).toBe(0);
      expect(await fixture.connection.collection('security_state').findOne({})).toMatchObject({ revision: 0 });
    } finally { failpoint.mockRestore(); log.mockRestore(); }
  });
});
