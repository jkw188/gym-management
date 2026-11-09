// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ, HAI app NestJS chung một DB): US-09 bước 4.
// Kiểm tra liên kết hồ sơ khi tranh chấp qua hai instance, cạnh tranh với đổi role/khóa account (US-07/08) và rollback khi lỗi giữa
// transaction; đăng nhập thật qua API (TC10, TC11, TC12).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { AccessCatalogService } from '../src/modules/users/access-catalog.service';
import { ACCOUNT_ADMINISTRATION } from '../src/modules/users/schemas/security-state.schema';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng test (US-09 bước 4, theo mục 2 "Nguyên tử và tranh chấp role" của spec):
//   Dùng lại API đã có: POST /api/members (bước 1), POST /api/members/:id/link (bước 3),
//   PATCH /api/users/:id/role {roleCode, version, reason} (US-08), PATCH /api/users/:id/status {status, version, reason} (US-07).
//   Liên kết và đổi role/khóa dùng chung khóa security_state nên luôn chạy lần lượt: kết quả phải khớp MỘT thứ tự hợp lệ.
//   US-08 chặn đổi role account đã được members tham chiếu (409 ROLE_IN_USE).
//   Lỗi hạ tầng giữa transaction: 503, body an toàn theo EN01-D03 (không lộ lỗi DB thô), toàn bộ ghi bị rollback,
//   không lưu kết quả idempotency nên gửi lại cùng key sau khi DB hết lỗi vẫn liên kết được.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us09_race';
const password = 'MậtKhẩuUS-09-123';
const note = 'Khách mở ứng dụng, đối chiếu tên và số điện thoại tại quầy';
const reason = 'Điều chỉnh tài khoản theo yêu cầu quản lý';
const ROUNDS = 5;

type Auth = { accessToken: string };
type RoleCode = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';

describe('US-09 bước 4: tranh chấp, đổi role cạnh tranh và rollback khi liên kết', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let secondApp: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    // enableTestCommands=1 để dùng failpoint failCommand giả lập lỗi DB giữa transaction (US-09-TC12).
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName, args: ['--setParameter', 'enableTestCommands=1'] },
    });
    Object.assign(process.env, {
      NODE_ENV: 'test',
      PORT: '3000',
      FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      // Ứng dụng bắt buộc có cấu hình SMTP/pepper khi khởi động (US-05); test này không gửi thư.
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'us09-test', SMTP_PASS: 'us09-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    // Instance thứ hai: connection riêng, cùng DB (mô phỏng hai máy chủ chạy song song).
    secondApp = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(secondApp);
    await secondApp.init();
    expect(secondApp.get(getConnectionToken())).not.toBe(connection);
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Bộ giới hạn đăng nhập (US-02) lưu trong bộ nhớ từng instance: mỗi test dùng bộ mới để không bị 429.
    for (const instance of [app, secondApp]) {
      const limiter = new LoginLimiter();
      jest.spyOn(instance.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    }
    for (const collection of await connection.db!.collections()) await collection.deleteMany({});
    // Danh mục quyền S01 (US-08 trả 503 nếu thiếu) và khóa quản trị US-07, như lệnh seed/ensure-indexes ở môi trường thật.
    await app.get(AccessCatalogService).seed();
    await securityState().insertOne({ _id: ACCOUNT_ADMINISTRATION, revision: Long.fromNumber(0) });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await connection.db!.admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
  });

  afterAll(async () => {
    await secondApp?.close();
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const count = (name: string, filter: Record<string, unknown> = {}) => db().collection(name).countDocuments(filter);
  const securityState = () => db().collection<{ _id: string; revision: Long }>('security_state');
  const revision = async () => Number((await securityState().findOne({ _id: ACCOUNT_ADMINISTRATION }))!.revision);

  // ---------- Chuẩn bị ----------
  let phoneSeq = 0;
  const nextPhone = () => { phoneSeq += 1; return `+849107${String(phoneSeq).padStart(5, '0')}`; };

  async function createAccount(roleCode: RoleCode, phone = nextPhone()) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName: `US09 ${roleCode} ${phone}`, passwordHash });
    return { accountId: account.id as ObjectId, phone };
  }

  // Đăng nhập thật qua API US-02 (token dùng được ở cả hai instance vì chung DB và secret).
  async function login(roleCode: RoleCode) {
    const account = await createAccount(roleCode);
    const response = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin)
      .send({ phone: account.phone, password }).expect(200);
    return { ...account, accessToken: response.body.accessToken as string };
  }

  async function createMember(staff: Auth, phone: string) {
    const response = await request(app.getHttpServer()).post('/api/members').set('Origin', origin)
      .set('Authorization', `Bearer ${staff.accessToken}`).set('Idempotency-Key', randomUUID())
      .send({ fullName: 'Hội viên tại quầy', phone }).expect(201);
    return response.body.id as string;
  }

  function link(instance: INestApplication, user: Auth, memberId: string, accountId: ObjectId, key = randomUUID(), version = 0) {
    return request(instance.getHttpServer()).post(`/api/members/${memberId}/link`).set('Origin', origin)
      .set('Authorization', `Bearer ${user.accessToken}`).set('Idempotency-Key', key)
      .send({ accountId: accountId.toHexString(), version, verificationMethod: 'IN_PERSON_ACCOUNT', verificationNote: note });
  }

  function changeRole(instance: INestApplication, admin: Auth, accountId: ObjectId, roleCode: RoleCode) {
    return request(instance.getHttpServer()).patch(`/api/users/${accountId.toHexString()}/role`).set('Origin', origin)
      .set('Authorization', `Bearer ${admin.accessToken}`).send({ roleCode, version: 0, reason });
  }

  function lockAccount(instance: INestApplication, admin: Auth, accountId: ObjectId) {
    return request(instance.getHttpServer()).patch(`/api/users/${accountId.toHexString()}/status`).set('Origin', origin)
      .set('Authorization', `Bearer ${admin.accessToken}`).send({ status: 'LOCKED', version: 0, reason });
  }

  async function roleOf(accountId: ObjectId) {
    const account = await db().collection('accounts').findOne({ _id: accountId });
    const role = await db().collection('roles').findOne({ _id: account!.role_id });
    return role!.code as RoleCode;
  }
  async function memberDoc(memberId: string) {
    return db().collection('members').findOne({ _id: new ObjectId(memberId) });
  }

  function failNext(command: 'insert' | 'findAndModify' | 'update', collection: string) {
    // Mã 1 (InternalError): lỗi DB thường, không phải lỗi tạm thời nên không được tự chạy lại thành công.
    return db().admin().command({
      configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: [command], namespace: `${databaseName}.${collection}`, errorCode: 1, errmsg: 'Giả lập DB lỗi US-09-TC12' },
    });
  }

  function expectSafeError(body: Record<string, any>) {
    expect(typeof body.error?.code).toBe('string');
    expect(typeof body.error?.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
    const text = JSON.stringify(body);
    expect(text).not.toContain('Giả lập DB lỗi');
    expect(text).not.toMatch(/MongoServerError|stack|failCommand/i);
  }

  // =====================================================================
  // TC10 – Tranh chấp cùng account qua hai instance: chỉ một liên kết
  // =====================================================================

  describe('US-09-TC10', () => {
    it('US-09-TC10: hai nhân viên ở hai instance cùng liên kết một hồ sơ với một account (key khác nhau) → đúng một 200, một 409, một audit', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const [staffA, staffB] = [await login('STAFF'), await login('STAFF')];
        const account = await createAccount('MEMBER');
        const memberId = await createMember(staffA, account.phone);

        const responses = await Promise.all([
          link(app, staffA, memberId, account.accountId),
          link(secondApp, staffB, memberId, account.accountId),
        ]);

        expect(responses.map(item => item.status).sort()).toEqual([200, 409]);
        const loser = responses.find(item => item.status === 409)!;
        expect(['MEMBER_ALREADY_LINKED', 'VERSION_CONFLICT']).toContain(loser.body.error.code);
        expect(await count('member_link_events', { member_id: new ObjectId(memberId) })).toBe(1);
        expect((await memberDoc(memberId))!.version).toBe(1);
      }
    });

    it('US-09-TC10: hai hồ sơ ở hai instance cùng tranh một account → chỉ một hồ sơ được gắn, account chỉ có một hồ sơ', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const staff = await login('STAFF');
        const account = await createAccount('MEMBER');
        const memberA = await createMember(staff, account.phone);
        const memberB = await createMember(staff, nextPhone());

        const responses = await Promise.all([
          link(app, staff, memberA, account.accountId),
          link(secondApp, staff, memberB, account.accountId),
        ]);

        expect(responses.filter(item => item.status === 200)).toHaveLength(1);
        for (const item of responses.filter(response => response.status !== 200)) {
          expect(item.status).toBe(409);
          expect(['ACCOUNT_ALREADY_LINKED', 'IDENTITY_MISMATCH']).toContain(item.body.error.code);
        }
        expect(await count('members', { account_id: account.accountId })).toBe(1);
        expect(await count('member_link_events', { account_id: account.accountId })).toBe(1);
      }
    });

    it('US-09-TC10: cùng một key gửi đồng thời qua hai instance → một liên kết, một audit, kết quả giống nhau', async () => {
      const staff = await login('STAFF');
      const account = await createAccount('MEMBER');
      const memberId = await createMember(staff, account.phone);
      const key = randomUUID();

      const responses = await Promise.all([
        link(app, staff, memberId, account.accountId, key),
        link(secondApp, staff, memberId, account.accountId, key),
      ]);

      const succeeded = responses.filter(item => item.status === 200);
      expect(succeeded.length).toBeGreaterThanOrEqual(1);
      for (const item of succeeded) expect(item.body).toEqual(succeeded[0].body);
      expect(await count('member_link_events')).toBe(1);
      expect((await memberDoc(memberId))!.version).toBe(1);
    });

    it('US-09-TC10: partial unique index account_id chặn ngay ở DB việc gắn một account cho hồ sơ thứ hai', async () => {
      const staff = await login('STAFF');
      const account = await createAccount('MEMBER');
      const memberA = await createMember(staff, account.phone);
      const memberB = await createMember(staff, nextPhone());
      await link(app, staff, memberA, account.accountId).expect(200);

      // Ghi thẳng DB (bỏ qua service) vẫn bị MongoDB từ chối: lớp bảo vệ cuối cùng khi mọi kiểm tra khác bị lọt.
      await expect(db().collection('members').updateOne({ _id: new ObjectId(memberB) }, { $set: { account_id: account.accountId } }))
        .rejects.toMatchObject({ code: 11000 });
      expect(await count('members', { account_id: account.accountId })).toBe(1);
    });
  });

  // =====================================================================
  // TC11 – Liên kết cạnh tranh với đổi role hoặc khóa account
  // =====================================================================

  describe('US-09-TC11', () => {
    it('US-09-TC11: liên kết (instance 1) và Admin đổi role account MEMBER→TRAINER (instance 2) cùng lúc → đúng một thứ tự hợp lệ', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const [staff, admin] = [await login('STAFF'), await login('ADMIN')];
        const account = await createAccount('MEMBER');
        const memberId = await createMember(staff, account.phone);

        const [linked, roleChanged] = await Promise.all([
          link(app, staff, memberId, account.accountId),
          changeRole(secondApp, admin, account.accountId, 'TRAINER'),
        ]);

        const isLinked = 'account_id' in (await memberDoc(memberId))!;
        const role = await roleOf(account.accountId);
        if (linked.status === 200) {
          // Thứ tự 1: liên kết trước → đổi role bị chặn vì account đã có hồ sơ hội viên (US-08).
          expect(roleChanged.status).toBe(409);
          expect(roleChanged.body.error.code).toBe('ROLE_IN_USE');
          expect(isLinked).toBe(true);
          expect(role).toBe('MEMBER');
        } else {
          // Thứ tự 2: đổi role trước → liên kết bị từ chối vì account không còn là MEMBER.
          expect(roleChanged.status).toBe(200);
          expect(linked.status).toBe(409);
          expect(linked.body.error.code).toBe('ACCOUNT_NOT_ELIGIBLE');
          expect(isLinked).toBe(false);
          expect(role).toBe('TRAINER');
          expect(await count('member_link_events', { member_id: new ObjectId(memberId) })).toBe(0);
        }
        // Không bao giờ có hồ sơ hội viên gắn với account không phải MEMBER.
        expect(isLinked && role !== 'MEMBER').toBe(false);
      }
    });

    it('US-09-TC11: liên kết (instance 1) và Admin khóa account đích (instance 2) cùng lúc → khóa luôn thành công, liên kết chỉ thành công nếu chạy trước', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const [staff, admin] = [await login('STAFF'), await login('ADMIN')];
        const account = await createAccount('MEMBER');
        const memberId = await createMember(staff, account.phone);

        const [linked, locked] = await Promise.all([
          link(app, staff, memberId, account.accountId),
          lockAccount(secondApp, admin, account.accountId),
        ]);

        expect(locked.status).toBe(200);
        const isLinked = 'account_id' in (await memberDoc(memberId))!;
        if (linked.status === 200) {
          expect(isLinked).toBe(true);
          expect(await count('member_link_events', { member_id: new ObjectId(memberId) })).toBe(1);
        } else {
          expect(linked.status).toBe(409);
          expect(linked.body.error.code).toBe('ACCOUNT_NOT_ELIGIBLE');
          expect(isLinked).toBe(false);
          expect(await count('member_link_events', { member_id: new ObjectId(memberId) })).toBe(0);
        }
        expect((await db().collection('accounts').findOne({ _id: account.accountId }))!.status).toBe('LOCKED');
      }
    });

    it('US-09-TC11: Admin khóa chính nhân viên đang liên kết (hai instance) → liên kết thành công trước khi khóa, hoặc bị 401 và không ghi', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const [staff, admin] = [await login('STAFF'), await login('ADMIN')];
        const account = await createAccount('MEMBER');
        const memberId = await createMember(staff, account.phone);

        const [linked, locked] = await Promise.all([
          link(app, staff, memberId, account.accountId),
          lockAccount(secondApp, admin, staff.accountId),
        ]);

        expect(locked.status).toBe(200);
        const isLinked = 'account_id' in (await memberDoc(memberId))!;
        if (linked.status === 200) {
          expect(isLinked).toBe(true);
        } else {
          expect(linked.status).toBe(401);
          expect(isLinked).toBe(false);
          expect(await count('member_link_events', { member_id: new ObjectId(memberId) })).toBe(0);
        }
      }
    });
  });

  // =====================================================================
  // TC12 – Lỗi giữa transaction: rollback toàn bộ, không dở dang
  // =====================================================================

  describe('US-09-TC12', () => {
    async function ready() {
      const staff = await login('STAFF');
      const account = await createAccount('MEMBER');
      const memberId = await createMember(staff, account.phone);
      return { staff, account, memberId };
    }

    async function stateSnapshot(memberId: string) {
      const member = await memberDoc(memberId);
      return {
        hasAccount: 'account_id' in member!,
        version: member!.version,
        serviceRevision: Number(member!.service_revision),
        securityRevision: await revision(),
        events: await count('member_link_events'),
      };
    }

    it('US-09-TC12: ghi audit member_link_events lỗi → 503 an toàn; account_id, version, service_revision, khóa quản trị đều rollback', async () => {
      const { staff, account, memberId } = await ready();
      const before = await stateSnapshot(memberId);
      await failNext('insert', 'member_link_events');

      const response = await link(app, staff, memberId, account.accountId);

      expect(response.status).toBe(503);
      expectSafeError(response.body);
      expect(await stateSnapshot(memberId)).toEqual(before);
    });

    it('US-09-TC12: ghi hồ sơ members lỗi giữa transaction (sau khi đã giữ khóa) → 503, khóa quản trị cũng rollback', async () => {
      const { staff, account, memberId } = await ready();
      const before = await stateSnapshot(memberId);
      await failNext('findAndModify', 'members');

      const response = await link(app, staff, memberId, account.accountId);

      expect(response.status).toBe(503);
      expectSafeError(response.body);
      expect(await stateSnapshot(memberId)).toEqual(before);
    });

    it('US-09-TC12: sau lỗi, không lưu kết quả idempotency; DB hết lỗi thì gửi lại cùng key liên kết được đúng một lần', async () => {
      const { staff, account, memberId } = await ready();
      const key = randomUUID();
      await failNext('insert', 'member_link_events');
      expect((await link(app, staff, memberId, account.accountId, key)).status).toBe(503);
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });

      const lookup = await request(app.getHttpServer()).get(`/api/operations/MEMBER_LINK/${key}`)
        .set('Origin', origin).set('Authorization', `Bearer ${staff.accessToken}`);
      expect(lookup.status).toBe(404);

      const retry = await link(app, staff, memberId, account.accountId, key);
      expect(retry.status).toBe(200);
      expect(await count('member_link_events')).toBe(1);
      expect((await memberDoc(memberId))!.version).toBe(1);
    });
  });
});
