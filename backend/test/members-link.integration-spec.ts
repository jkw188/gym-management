// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-09 bước 3.
// Kiểm tra API liên kết hồ sơ hội viên với account POST /api/members/:id/link: quyền, xác minh, điều kiện account,
// audit member_link_events, khóa quản trị, chống gửi lặp MEMBER_LINK và không đồng bộ ngầm với account (TC02, TC08, TC09, TC13).
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
import { ACCOUNT_ADMINISTRATION } from '../src/modules/users/schemas/security-state.schema';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng test đặt ra cho Builder (US-09 bước 3, theo mục 2–3 của spec):
//   POST /api/members/:id/link: role STAFF/ADMIN; header Idempotency-Key (UUID v4, operation MEMBER_LINK theo EN-02);
//     body {accountId, version, verificationMethod: 'IN_PERSON_ACCOUNT'|'IN_PERSON_DOCUMENT', verificationNote 10–500}.
//     200 {member: MemberDto (accountId đã gắn, version + 1), linked: true}.
//   Trong một transaction: ghi security_state 'account-administration' (khóa quản trị US-07, revision tăng), ghi
//     members.service_revision (tăng), kiểm account MEMBER + ACTIVE + chưa member nào tham chiếu + không có hồ sơ trainers,
//     phone account = phone member, member version khớp; set account_id, version + 1, updated_at, updated_by;
//     insert member_link_events {member_id, account_id, verified_by (actor từ phiên), verified_at, verification_method,
//     verification_note, request_key}. Index member_link_events: member_id unique, request_key unique.
//   Lỗi EN01-D03: 400 VALIDATION_ERROR (details[].field), 401, 403, 404 hồ sơ không tồn tại,
//     409 IDENTITY_MISMATCH (phone khác), ACCOUNT_NOT_ELIGIBLE (role khác MEMBER, LOCKED, có hồ sơ PT),
//     ACCOUNT_ALREADY_LINKED (account đã gắn hồ sơ khác), MEMBER_ALREADY_LINKED (hồ sơ đã liên kết), VERSION_CONFLICT,
//     IDEMPOTENCY_CONFLICT. Liên kết KHÔNG sửa document accounts (không đồng bộ tên/phone).
//   TC10, TC11, TC12 (tranh chấp hai instance, đổi role cạnh tranh, rollback) thuộc bước 4.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us09_link';
const password = 'MậtKhẩuUS-09-123';
const note = 'Khách mở ứng dụng, đối chiếu tên và số điện thoại tại quầy';

type Auth = { accessToken: string };
type RoleCode = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';

describe('US-09 bước 3: liên kết hồ sơ hội viên với tài khoản', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName },
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
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http');
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Bộ giới hạn đăng nhập (US-02) lưu trong bộ nhớ: mỗi test dùng bộ mới để không bị 429 khi đăng nhập nhiều lần.
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    // Chỉ xóa dữ liệu, giữ index.
    for (const collection of await connection.db!.collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    // Khóa quản trị US-07 (lệnh ensure-indexes tạo sẵn trong môi trường thật): revision Int64 = 0.
    await securityState().insertOne({ _id: ACCOUNT_ADMINISTRATION, revision: Long.fromNumber(0) });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());
  const count = (name: string, filter: Record<string, unknown> = {}) => db().collection(name).countDocuments(filter);
  const securityState = () => db().collection<{ _id: string; revision: Long }>('security_state');
  const revision = async () => Number((await securityState().findOne({ _id: ACCOUNT_ADMINISTRATION }))!.revision);

  // ---------- Chuẩn bị ----------
  // Account thật (không đăng nhập), phone lưu dạng chuẩn hóa +84… như US-06.
  async function createAccount(roleCode: RoleCode, phone: string, fullName = `US09 ${roleCode} ${phone}`) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    const account = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: account.id as ObjectId, phone, fullName };
  }

  // Nhân viên đăng nhập thật qua API US-02.
  let staffSeq = 0;
  async function login(roleCode: RoleCode) {
    staffSeq += 1;
    const phone = `+8491080${String(staffSeq).padStart(4, '0')}`;
    const account = await createAccount(roleCode, phone);
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { ...account, accessToken: response.body.accessToken as string };
  }

  // Hồ sơ hội viên tạo qua API bước 1.
  async function createMember(staff: Auth, phone: string, fullName = 'Hội viên tại quầy') {
    const response = await http().post('/api/members').set('Origin', origin)
      .set('Authorization', `Bearer ${staff.accessToken}`).set('Idempotency-Key', randomUUID())
      .send({ fullName, phone }).expect(201);
    return { memberId: response.body.id as string, version: response.body.version as number };
  }

  function link(user: Auth | undefined, memberId: string, body: Record<string, unknown>, key: string | null = randomUUID()) {
    let call = http().post(`/api/members/${memberId}/link`).set('Origin', origin);
    if (user) call = call.set('Authorization', `Bearer ${user.accessToken}`);
    if (key !== null) call = call.set('Idempotency-Key', key);
    return call.send(body);
  }

  const linkBody = (accountId: ObjectId | string, overrides: Record<string, unknown> = {}) => ({
    accountId: typeof accountId === 'string' ? accountId : accountId.toHexString(),
    version: 0, verificationMethod: 'IN_PERSON_ACCOUNT', verificationNote: note, ...overrides,
  });

  // Tình huống chuẩn: Staff, account MEMBER ACTIVE và hồ sơ cùng số điện thoại.
  async function readyToLink(roleCode: 'STAFF' | 'ADMIN' = 'STAFF') {
    const staff = await login(roleCode);
    const account = await createAccount('MEMBER', '+84901234567', 'Lê Thị Khách');
    const member = await createMember(staff, '0901234567');
    return { staff, account, ...member };
  }

  async function memberDoc(memberId: string) {
    return db().collection('members').findOne({ _id: new ObjectId(memberId) });
  }

  // Hồ sơ vẫn ở trạng thái chưa liên kết và không có audit nào.
  async function expectNotLinked(memberId: string) {
    const doc = await memberDoc(memberId);
    expect(doc).not.toBeNull();
    expect('account_id' in doc!).toBe(false);
    expect(doc!.version).toBe(0);
    expect(await count('member_link_events')).toBe(0);
  }

  function expectErrorShape(body: Record<string, any>, code?: string) {
    expect(typeof body.error?.code).toBe('string');
    expect(typeof body.error?.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
    if (code) expect(body.error.code).toBe(code);
  }

  // =====================================================================
  // TC02 – Quyền liên kết
  // =====================================================================

  describe('US-09-TC02 (liên kết)', () => {
    it.each(['MEMBER', 'TRAINER'] as const)('US-09-TC02: role %s gọi liên kết → 403, không ghi', async roleCode => {
      const { account, memberId } = await readyToLink();
      const user = await login(roleCode);

      const response = await link(user, memberId, linkBody(account.accountId));

      expect(response.status).toBe(403);
      expectErrorShape(response.body);
      await expectNotLinked(memberId);
    });

    it('US-09-TC02: không có token → 401, không ghi', async () => {
      const { account, memberId } = await readyToLink();

      const response = await link(undefined, memberId, linkBody(account.accountId));

      expect(response.status).toBe(401);
      expectErrorShape(response.body);
      await expectNotLinked(memberId);
    });

    it('US-09-TC02: Staff có phiên đã bị thu hồi → 401, không ghi', async () => {
      const { staff, account, memberId } = await readyToLink();
      await db().collection('auth_sessions').updateMany({ account_id: staff.accountId }, { $set: { revoked_at: new Date() } });

      const response = await link(staff, memberId, linkBody(account.accountId));

      expect(response.status).toBe(401);
      expectErrorShape(response.body);
      await expectNotLinked(memberId);
    });
  });

  // =====================================================================
  // TC08 – Liên kết thành công: account_id và audit commit cùng nhau
  // =====================================================================

  describe('US-09-TC08', () => {
    it.each(['STAFF', 'ADMIN'] as const)('US-09-TC08: %s liên kết account MEMBER ACTIVE phone khớp → 200 {member, linked:true}, version 1', async roleCode => {
      const { staff, account, memberId } = await readyToLink(roleCode);

      const response = await link(staff, memberId, linkBody(account.accountId)).expect(200);

      expect(response.body.linked).toBe(true);
      expect(response.body.member).toMatchObject({
        id: memberId, accountId: account.accountId.toHexString(), version: 1, phone: '+84901234567',
      });
    });

    it('US-09-TC08: DB có account_id, version + 1, updated_by là nhân viên và đúng một bản ghi member_link_events', async () => {
      const { staff, account, memberId } = await readyToLink();
      const before = await memberDoc(memberId);

      await link(staff, memberId, linkBody(account.accountId, { verificationMethod: 'IN_PERSON_DOCUMENT' })).expect(200);

      const after = await memberDoc(memberId);
      expect(after!.account_id.toHexString()).toBe(account.accountId.toHexString());
      expect(after!.version).toBe(1);
      expect(after!.updated_by.toHexString()).toBe(staff.accountId.toHexString());
      expect(after!.updated_at.getTime()).toBeGreaterThanOrEqual(before!.updated_at.getTime());
      // Khóa bán gói/link của hồ sơ: service_revision phải được ghi (tăng).
      expect(Number(after!.service_revision)).toBeGreaterThan(Number(before!.service_revision));

      const events = await db().collection('member_link_events').find({}).toArray();
      expect(events).toHaveLength(1);
      expect(events[0].member_id.toHexString()).toBe(memberId);
      expect(events[0].account_id.toHexString()).toBe(account.accountId.toHexString());
      expect(events[0].verified_by.toHexString()).toBe(staff.accountId.toHexString());
      expect(events[0].verified_at).toBeInstanceOf(Date);
      expect(events[0].verification_method).toBe('IN_PERSON_DOCUMENT');
      expect(events[0].verification_note).toBe(note);
      expect(typeof events[0].request_key).toBe('string');
      expect(events[0].request_key.length).toBeGreaterThan(0);
    });

    it('US-09-TC08: liên kết dùng khóa quản trị US-07 (security_state.revision tăng)', async () => {
      const { staff, account, memberId } = await readyToLink();
      const before = await revision();

      await link(staff, memberId, linkBody(account.accountId)).expect(200);

      expect(await revision()).toBeGreaterThan(before);
    });

    it('US-09-TC08: liên kết không sửa document accounts (không đồng bộ tên/phone, không đổi auth_version)', async () => {
      const { staff, account, memberId } = await readyToLink();
      const before = await db().collection('accounts').findOne({ _id: account.accountId });

      await link(staff, memberId, linkBody(account.accountId)).expect(200);

      expect(await db().collection('accounts').findOne({ _id: account.accountId })).toEqual(before);
    });

    it('US-09-TC08: verification_note đúng biên 10 và 500 ký tự → 200', async () => {
      const staff = await login('STAFF');
      const first = await createAccount('MEMBER', '+84901111111');
      const second = await createAccount('MEMBER', '+84902222222');
      const memberA = await createMember(staff, '0901111111');
      const memberB = await createMember(staff, '0902222222');

      await link(staff, memberA.memberId, linkBody(first.accountId, { verificationNote: 'a'.repeat(10) })).expect(200);
      await link(staff, memberB.memberId, linkBody(second.accountId, { verificationNote: 'b'.repeat(500) })).expect(200);

      expect(await count('member_link_events')).toBe(2);
    });

    it('US-09-TC08: verified_by/verified_at lấy từ server; client gửi verifiedBy hoặc verifiedAt → 400, không liên kết', async () => {
      const { staff, account, memberId } = await readyToLink();
      const other = new ObjectId().toHexString();

      for (const extra of [{ verifiedBy: other }, { verifiedAt: '2026-01-01T00:00:00.000Z' }]) {
        const response = await link(staff, memberId, linkBody(account.accountId, extra));
        expect(response.status).toBe(400);
        expectErrorShape(response.body, 'VALIDATION_ERROR');
      }
      await expectNotLinked(memberId);
    });

    it('US-09-TC08: gửi lại cùng key và cùng payload → cùng kết quả gốc, chỉ một bản ghi audit', async () => {
      const { staff, account, memberId } = await readyToLink();
      const key = randomUUID();

      const first = await link(staff, memberId, linkBody(account.accountId), key).expect(200);
      const retry = await link(staff, memberId, linkBody(account.accountId), key);

      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      expect(await count('member_link_events')).toBe(1);
      expect((await memberDoc(memberId))!.version).toBe(1);
    });

    it('US-09-TC08: mất response → GET /api/operations/MEMBER_LINK/:key trả kết quả đã commit', async () => {
      const { staff, account, memberId } = await readyToLink();
      const key = randomUUID();
      await link(staff, memberId, linkBody(account.accountId), key).expect(200);

      const lookup = await http().get(`/api/operations/MEMBER_LINK/${key}`)
        .set('Origin', origin).set('Authorization', `Bearer ${staff.accessToken}`).expect(200);

      expect(lookup.body).toMatchObject({ status: 'COMMITTED', responseStatus: 200 });
      expect(lookup.body.responseBody.member.id).toBe(memberId);
    });

    it('US-09-TC08: cùng key nhưng đổi verificationNote → 409 IDEMPOTENCY_CONFLICT, không ghi thêm', async () => {
      const { staff, account, memberId } = await readyToLink();
      const key = randomUUID();
      await link(staff, memberId, linkBody(account.accountId), key).expect(200);

      const changed = await link(staff, memberId, linkBody(account.accountId, { verificationNote: 'Ghi nhận khác hẳn lần đầu' }), key);

      expect(changed.status).toBe(409);
      expectErrorShape(changed.body, 'IDEMPOTENCY_CONFLICT');
      expect(await count('member_link_events')).toBe(1);
    });

    it('US-09-TC08: đã liên kết, gửi lại bằng key khác → 409 MEMBER_ALREADY_LINKED, không ghi audit mới', async () => {
      const { staff, account, memberId } = await readyToLink();
      await link(staff, memberId, linkBody(account.accountId)).expect(200);

      const again = await link(staff, memberId, linkBody(account.accountId, { version: 1 }));

      expect(again.status).toBe(409);
      expectErrorShape(again.body, 'MEMBER_ALREADY_LINKED');
      expect(await count('member_link_events')).toBe(1);
      expect((await memberDoc(memberId))!.version).toBe(1);
    });

    it('US-09-TC08: member_link_events có index unique member_id và request_key', async () => {
      const { staff, account, memberId } = await readyToLink();
      await link(staff, memberId, linkBody(account.accountId)).expect(200);

      const indexes = (await db().collection('member_link_events').indexes()) as Array<{ key: Record<string, number>; unique?: boolean }>;
      const uniqueOn = (field: string) => indexes.find(index => JSON.stringify(index.key) === JSON.stringify({ [field]: 1 }))?.unique;
      expect(uniqueOn('member_id')).toBe(true);
      expect(uniqueOn('request_key')).toBe(true);
    });
  });

  // =====================================================================
  // TC09 – Không đủ điều kiện hoặc thiếu xác minh: 409/400, không liên kết
  // =====================================================================

  describe('US-09-TC09', () => {
    it('US-09-TC09: phone account khác phone hồ sơ → 409 IDENTITY_MISMATCH, không liên kết', async () => {
      const staff = await login('STAFF');
      const account = await createAccount('MEMBER', '+84901234567');
      const { memberId } = await createMember(staff, '0909999999');

      const response = await link(staff, memberId, linkBody(account.accountId));

      expect(response.status).toBe(409);
      expectErrorShape(response.body, 'IDENTITY_MISMATCH');
      await expectNotLinked(memberId);
    });

    it.each(['TRAINER', 'STAFF', 'ADMIN'] as const)('US-09-TC09: account role %s → 409 ACCOUNT_NOT_ELIGIBLE, không liên kết', async roleCode => {
      const staff = await login('STAFF');
      const account = await createAccount(roleCode, '+84901234567');
      const { memberId } = await createMember(staff, '0901234567');

      const response = await link(staff, memberId, linkBody(account.accountId));

      expect(response.status).toBe(409);
      expectErrorShape(response.body, 'ACCOUNT_NOT_ELIGIBLE');
      await expectNotLinked(memberId);
    });

    it('US-09-TC09: account MEMBER bị khóa (LOCKED) → 409 ACCOUNT_NOT_ELIGIBLE, không liên kết', async () => {
      const { staff, account, memberId } = await readyToLink();
      await db().collection('accounts').updateOne({ _id: account.accountId }, { $set: { status: 'LOCKED' } });

      const response = await link(staff, memberId, linkBody(account.accountId));

      expect(response.status).toBe(409);
      expectErrorShape(response.body, 'ACCOUNT_NOT_ELIGIBLE');
      await expectNotLinked(memberId);
    });

    it('US-09-TC09: account MEMBER đã có hồ sơ PT (trainers) → 409 ACCOUNT_NOT_ELIGIBLE, không liên kết', async () => {
      const { staff, account, memberId } = await readyToLink();
      const trainerId = new ObjectId();
      const now = new Date();
      await db().collection('trainers').insertOne({
        _id: trainerId, id: trainerId, account_id: account.accountId, specialty: 'Thể hình', status: 'ACTIVE', version: 0,
        created_at: now, updated_at: now,
      });

      const response = await link(staff, memberId, linkBody(account.accountId));

      expect(response.status).toBe(409);
      expectErrorShape(response.body, 'ACCOUNT_NOT_ELIGIBLE');
      await expectNotLinked(memberId);
    });

    it('US-09-TC09: account đã gắn với hồ sơ khác → 409 ACCOUNT_ALREADY_LINKED, hồ sơ thứ hai không liên kết', async () => {
      const staff = await login('STAFF');
      const account = await createAccount('MEMBER', '+84901234567');
      const first = await createMember(staff, '0901234567');
      await link(staff, first.memberId, linkBody(account.accountId)).expect(200);
      // Hồ sơ thứ hai: phone khác nên cần sửa phone account cho khớp để chỉ còn lý do "đã gắn hồ sơ khác".
      const second = await createMember(staff, '0902222222');
      await db().collection('accounts').updateOne({ _id: account.accountId }, { $set: { phone: '+84902222222' } });

      const response = await link(staff, second.memberId, linkBody(account.accountId));

      expect(response.status).toBe(409);
      expectErrorShape(response.body, 'ACCOUNT_ALREADY_LINKED');
      expect('account_id' in (await memberDoc(second.memberId))!).toBe(false);
      expect(await count('member_link_events')).toBe(1);
    });

    it('US-09-TC09: version hồ sơ đã cũ → 409 VERSION_CONFLICT, không liên kết', async () => {
      const { staff, account, memberId } = await readyToLink();

      const response = await link(staff, memberId, linkBody(account.accountId, { version: 3 }));

      expect(response.status).toBe(409);
      expectErrorShape(response.body, 'VERSION_CONFLICT');
      await expectNotLinked(memberId);
    });

    // Đối chứng cho các ca 404: route phải tồn tại (body sai vào hồ sơ có thật → 400, không phải 404).
    async function expectRouteExists(staff: Auth, memberId: string) {
      expect((await link(staff, memberId, { accountId: 'abc' })).status).toBe(400);
    }

    it('US-09-TC09: hồ sơ không tồn tại → 404', async () => {
      const { staff, account, memberId } = await readyToLink();
      await expectRouteExists(staff, memberId);

      const response = await link(staff, new ObjectId().toHexString(), linkBody(account.accountId));

      expect(response.status).toBe(404);
      expectErrorShape(response.body);
      expect(await count('member_link_events')).toBe(0);
    });

    it('US-09-TC09: account không tồn tại → 404 hoặc 409 ACCOUNT_NOT_ELIGIBLE, không liên kết', async () => {
      const { staff, memberId } = await readyToLink();
      await expectRouteExists(staff, memberId);

      const response = await link(staff, memberId, linkBody(new ObjectId()));

      expect([404, 409]).toContain(response.status);
      if (response.status === 409) expectErrorShape(response.body, 'ACCOUNT_NOT_ELIGIBLE');
      else expectErrorShape(response.body);
      await expectNotLinked(memberId);
    });

    const invalidBodies: Array<[string, Record<string, unknown>, string]> = [
      ['thiếu verificationMethod', { verificationMethod: undefined }, 'verificationMethod'],
      ['verificationMethod không thuộc enum (tự xác minh)', { verificationMethod: 'SELF' }, 'verificationMethod'],
      ['thiếu verificationNote', { verificationNote: undefined }, 'verificationNote'],
      ['verificationNote 9 ký tự', { verificationNote: 'a'.repeat(9) }, 'verificationNote'],
      ['verificationNote 501 ký tự', { verificationNote: 'a'.repeat(501) }, 'verificationNote'],
      ['thiếu accountId', { accountId: undefined }, 'accountId'],
      ['accountId không phải ObjectId', { accountId: 'abc' }, 'accountId'],
      ['thiếu version', { version: undefined }, 'version'],
      ['version âm', { version: -1 }, 'version'],
    ];

    it.each(invalidBodies)('US-09-TC09: %s → 400 VALIDATION_ERROR đúng field, không liên kết', async (_name, overrides, field) => {
      const { staff, account, memberId } = await readyToLink();

      const response = await link(staff, memberId, linkBody(account.accountId, overrides));

      expect(response.status).toBe(400);
      expectErrorShape(response.body, 'VALIDATION_ERROR');
      expect(JSON.stringify(response.body.error.details ?? [])).toContain(field);
      await expectNotLinked(memberId);
    });

    it('US-09-TC09: id hồ sơ trên URL không phải ObjectId → 400', async () => {
      const { staff, account } = await readyToLink();

      const response = await link(staff, 'khong-phai-id', linkBody(account.accountId));

      expect(response.status).toBe(400);
      expectErrorShape(response.body);
    });

    it('US-09-TC09: thiếu Idempotency-Key → 400, không liên kết', async () => {
      const { staff, account, memberId } = await readyToLink();

      const response = await link(staff, memberId, linkBody(account.accountId), null);

      expect(response.status).toBe(400);
      expectErrorShape(response.body);
      await expectNotLinked(memberId);
    });
  });

  // =====================================================================
  // TC13 – Sửa account sau liên kết không làm đổi hồ sơ nghiệp vụ hay mất liên kết
  // =====================================================================

  describe('US-09-TC13', () => {
    it('US-09-TC13: Admin sửa tên và phone account (US-06) sau liên kết → hồ sơ giữ nguyên tên/phone và account_id', async () => {
      const { staff, account, memberId } = await readyToLink();
      await link(staff, memberId, linkBody(account.accountId)).expect(200);
      const admin = await login('ADMIN');
      const accountVersion = (await db().collection('accounts').findOne({ _id: account.accountId }))!.version;

      await http().patch(`/api/users/${account.accountId.toHexString()}`).set('Origin', origin)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ version: accountVersion, fullName: 'Tên Mới Trên Tài Khoản', phone: '0908888888' }).expect(200);

      const member = await memberDoc(memberId);
      expect(member!.full_name).toBe('Hội viên tại quầy');
      expect(member!.phone).toBe('+84901234567');
      expect(member!.account_id.toHexString()).toBe(account.accountId.toHexString());
      expect(member!.version).toBe(1);
    });
  });
});
