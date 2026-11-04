// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ): EN-02 bước 3.
// Kiểm tra IdempotencyService (TC04, TC06, TC07, TC16) và API GET /api/operations/:operation/:key (TC07, TC08, TC15).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ClientSession } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Model } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { ApplicationError } from '../src/common/errors/application-error';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { Account } from '../src/modules/users/schemas/account.schema';
import { RoleCode } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng test đặt ra cho Builder: IdempotencyService.execute(command, work) trong module operations.
import { IdempotencyService } from '../src/modules/operations/idempotency.service';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_en02_idem';
const password = 'MậtKhẩuEN-02-123';

// Kết quả giả của một lệnh nghiệp vụ: ghi một payment trong cùng session rồi trả về status/body.
type WorkResult = { status: number; body: Record<string, unknown>; resultIds: Record<string, unknown> };

describe('EN-02 bước 3: IdempotencyService và API lookup', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let idempotency: IdempotencyService;
  let accounts: Model<Account>;
  let repository: UsersRepository;
  let passwords: PasswordService;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName } });
    Object.assign(process.env, {
      NODE_ENV: 'test',
      PORT: '3000',
      FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    idempotency = app.get(IdempotencyService);
    accounts = app.get<Model<Account>>(getModelToken('Account'));
    repository = app.get(UsersRepository);
    passwords = app.get(PasswordService);
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    // Chỉ xóa dữ liệu, giữ index (unique index operation_requests phải còn để test có ý nghĩa).
    const collections = await accounts.db.db!.collections();
    for (const collection of collections) await collection.deleteMany({});
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  // Tạo tài khoản trong DB rồi đăng nhập thật; trả về id và access token.
  async function createAndLogin(code: RoleCode, phone: string) {
    const role = await repository.ensureRole(code, code);
    const passwordHash = await passwords.hash(password);
    const account = await repository.createAccount({ roleId: role.id.toHexString(), phone, fullName: `EN02 ${code}`, passwordHash });
    const login = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { id: account.id.toHexString(), token: login.body.accessToken as string };
  }

  function lookup(token: string | undefined, operation: string, key: string) {
    const call = request(app.getHttpServer()).get(`/api/operations/${operation}/${key}`).set('Origin', origin);
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  }

  // work giả: ghi một payment trong session của transaction, đếm số lần được gọi.
  function paymentWork(counter: { calls: number }) {
    return async (session: ClientSession): Promise<WorkResult> => {
      counter.calls += 1;
      const inserted = await accounts.db.collection('payments').insertOne({ amount: '150000' }, { session });
      const paymentId = inserted.insertedId.toHexString();
      return { status: 201, body: { paymentId, amount: '150000' }, resultIds: { paymentId } };
    };
  }

  function command(actorId: string, clientKey: string, payload: Record<string, unknown>, targetId = 'tx-001') {
    return { actorId, operation: 'PAYMENT_CONFIRM' as const, clientKey, payload, targetId };
  }

  const countPayments = () => accounts.db.collection('payments').countDocuments();
  const countRecords = () => accounts.db.collection('operation_requests').countDocuments();

  // ---------- EN-02-TC04: cùng actor/operation/key/payload gửi hai lần ----------
  it('EN-02-TC04: gửi hai lần cùng key và payload trả cùng status/body gốc, chỉ ghi một kết quả', async () => {
    const staff = await createAndLogin('STAFF', '0901000001');
    const key = randomUUID();
    const counter = { calls: 0 };

    const first = await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000' }), paymentWork(counter));
    const second = await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000' }), paymentWork(counter));

    expect(first.status).toBe(201);
    expect(second).toEqual(first);
    expect(counter.calls).toBe(1);
    expect(await countPayments()).toBe(1);
    expect(await countRecords()).toBe(1);
  });

  it('EN-02-TC04: payload chỉ đổi thứ tự field vẫn là cùng payload sau chuẩn hóa, trả lại kết quả gốc', async () => {
    const staff = await createAndLogin('STAFF', '0901000001');
    const key = randomUUID();
    const counter = { calls: 0 };

    const first = await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000' }), paymentWork(counter));
    const second = await idempotency.execute(command(staff.id, key, { amount: '150000', method: 'CASH' }), paymentWork(counter));

    expect(second).toEqual(first);
    expect(counter.calls).toBe(1);
    expect(await countPayments()).toBe(1);
  });

  // ---------- EN-02-TC06: cùng key nhưng đổi amount/target ----------
  it('EN-02-TC06: cùng key đổi amount trả 409 IDEMPOTENCY_CONFLICT, không ghi thêm', async () => {
    const staff = await createAndLogin('STAFF', '0901000001');
    const key = randomUUID();
    const counter = { calls: 0 };
    await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000' }), paymentWork(counter));

    const failure = await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '200000' }), paymentWork(counter))
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationError);
    expect((failure as ApplicationError).status).toBe(409);
    expect((failure as ApplicationError).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(counter.calls).toBe(1);
    expect(await countPayments()).toBe(1);
    expect(await countRecords()).toBe(1);
  });

  it('EN-02-TC06: cùng key và payload nhưng đổi target trả 409 IDEMPOTENCY_CONFLICT, không ghi thêm', async () => {
    const staff = await createAndLogin('STAFF', '0901000001');
    const key = randomUUID();
    const counter = { calls: 0 };
    await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000' }, 'tx-001'), paymentWork(counter));

    const failure = await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000' }, 'tx-002'), paymentWork(counter))
      .then(() => undefined, (error: unknown) => error);

    expect((failure as ApplicationError).status).toBe(409);
    expect((failure as ApplicationError).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(counter.calls).toBe(1);
    expect(await countPayments()).toBe(1);
  });

  // ---------- EN-02-TC07: mất response sau commit rồi lookup / gửi lại ----------
  it('EN-02-TC07: mất response sau commit thì lookup trả 200 COMMITTED kèm status/body gốc', async () => {
    const staff = await createAndLogin('STAFF', '0901000001');
    const key = randomUUID();
    // Coi như client không nhận được kết quả này.
    const lost = await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000' }), paymentWork({ calls: 0 }));

    const response = await lookup(staff.token, 'PAYMENT_CONFIRM', key);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'COMMITTED', responseStatus: lost.status, responseBody: lost.body });
  });

  it('EN-02-TC07: mất response sau commit rồi gửi lại cùng key thì khôi phục kết quả cũ, không thu tiền lần hai', async () => {
    const staff = await createAndLogin('STAFF', '0901000001');
    const key = randomUUID();
    const counter = { calls: 0 };
    const lost = await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000' }), paymentWork(counter));

    const resent = await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000' }), paymentWork(counter));

    expect(resent).toEqual(lost);
    expect(counter.calls).toBe(1);
    expect(await countPayments()).toBe(1);
  });

  it('EN-02-TC07: lệnh gốc lỗi và rollback thì không có record, gửi lại cùng key được chạy lại', async () => {
    const staff = await createAndLogin('STAFF', '0901000001');
    const key = randomUUID();
    const failing = async (session: ClientSession): Promise<WorkResult> => {
      await accounts.db.collection('payments').insertOne({ amount: '150000' }, { session });
      throw new Error('lỗi giữa chừng');
    };
    await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000' }), failing).catch(() => undefined);
    expect(await countRecords()).toBe(0);
    expect(await countPayments()).toBe(0);

    const counter = { calls: 0 };
    const retried = await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000' }), paymentWork(counter));

    expect(retried.status).toBe(201);
    expect(counter.calls).toBe(1);
    expect(await countPayments()).toBe(1);
  });

  // ---------- EN-02-TC08: lookup khi request gốc đang chạy ----------
  it('EN-02-TC08: lookup key chưa thấy khi request gốc đang chạy trả 404 OPERATION_UNKNOWN, commit xong thì thấy', async () => {
    const staff = await createAndLogin('STAFF', '0901000001');
    const key = randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const workStarted = new Promise<void>((resolve) => { started = resolve; });

    const running = idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000' }), async (session) => {
      const inserted = await accounts.db.collection('payments').insertOne({ amount: '150000' }, { session });
      started();
      await gate;
      return { status: 201, body: { paymentId: inserted.insertedId.toHexString() }, resultIds: {} };
    });
    await workStarted;

    const during = await lookup(staff.token, 'PAYMENT_CONFIRM', key);
    expect(during.status).toBe(404);
    expect(during.body.error.code).toBe('OPERATION_UNKNOWN');

    release();
    await running;
    const after = await lookup(staff.token, 'PAYMENT_CONFIRM', key);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('COMMITTED');
  });

  it('EN-02-TC08: key chưa từng gửi trả 404 OPERATION_UNKNOWN', async () => {
    const staff = await createAndLogin('STAFF', '0901000001');

    const response = await lookup(staff.token, 'PAYMENT_CONFIRM', randomUUID());

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('OPERATION_UNKNOWN');
  });

  // ---------- EN-02-TC15: non-owner, mất quyền, role giả ----------
  describe('EN-02-TC15: lookup an toàn', () => {
    let owner: { id: string; token: string };
    let key: string;

    beforeEach(async () => {
      owner = await createAndLogin('STAFF', '0901000001');
      key = randomUUID();
      await idempotency.execute(command(owner.id, key, { method: 'CASH', amount: '150000' }), paymentWork({ calls: 0 }));
    });

    it('EN-02-TC15: không có token trả 401', async () => {
      const response = await lookup(undefined, 'PAYMENT_CONFIRM', key);

      expect(response.status).toBe(401);
      expect(response.body.responseBody).toBeUndefined();
    });

    it('EN-02-TC15: token tự ký giả role ADMIN trả 401, không lộ kết quả', async () => {
      const forged = new JwtService({ secret: randomBytes(32).toString('base64url') })
        .sign({ sub: owner.id, role: 'ADMIN' }, { issuer: 'gym-api', audience: 'gym-web', expiresIn: 900 });

      const response = await lookup(forged, 'PAYMENT_CONFIRM', key);

      expect(response.status).toBe(401);
      expect(response.body.responseBody).toBeUndefined();
    });

    it('EN-02-TC15: STAFF khác (non-owner) lookup key của người khác trả 404, không lộ kết quả', async () => {
      const other = await createAndLogin('STAFF', '0901000002');

      const response = await lookup(other.token, 'PAYMENT_CONFIRM', key);

      expect(response.status).toBe(404);
      expect(response.body.responseBody).toBeUndefined();
    });

    it('EN-02-TC15: non-owner thêm query actorId của chủ sở hữu vẫn trả 404', async () => {
      const other = await createAndLogin('STAFF', '0901000002');

      const response = await lookup(other.token, 'PAYMENT_CONFIRM', key).query({ actorId: owner.id });

      expect(response.status).toBe(404);
      expect(response.body.responseBody).toBeUndefined();
    });

    it('EN-02-TC15: role MEMBER không được thực hiện PAYMENT_CONFIRM nên lookup trả 403', async () => {
      const member = await createAndLogin('MEMBER', '0901000003');

      const response = await lookup(member.token, 'PAYMENT_CONFIRM', key);

      expect(response.status).toBe(403);
      expect(response.body.responseBody).toBeUndefined();
    });

    it('EN-02-TC15: chủ sở hữu bị đổi role sang MEMBER (mất quyền) thì lookup bị từ chối 401/403', async () => {
      const memberRole = await repository.ensureRole('MEMBER', 'MEMBER');
      await accounts.updateOne({ _id: owner.id }, { $set: { role_id: memberRole.id } });

      const response = await lookup(owner.token, 'PAYMENT_CONFIRM', key);

      expect([401, 403]).toContain(response.status);
      expect(response.body.responseBody).toBeUndefined();
    });
  });

  // ---------- EN-02-TC16: không lưu secret, replay giữ nguyên kết quả nghiệp vụ ----------
  it('EN-02-TC16: record operation_requests không chứa dữ liệu nhạy cảm của payload, chỉ có các field theo spec', async () => {
    const staff = await createAndLogin('STAFF', '0901000001');
    const key = randomUUID();
    const secret = 'MậtKhẩuBíMật-EN02-999';

    await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000', password: secret }), paymentWork({ calls: 0 }));

    const record = await accounts.db.collection('operation_requests').findOne({});
    expect(record).not.toBeNull();
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(Object.keys(record!).sort()).toEqual(
      ['_id', 'actor_id', 'client_key', 'committed_at', 'operation', 'request_hash', 'response_body', 'response_status', 'result_ids'].sort());
    expect(record!.request_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('EN-02-TC16: lookup qua API trả lại đúng kết quả nghiệp vụ gốc, không kèm secret', async () => {
    const staff = await createAndLogin('STAFF', '0901000001');
    const key = randomUUID();
    const secret = 'MậtKhẩuBíMật-EN02-999';
    const original = await idempotency.execute(command(staff.id, key, { method: 'CASH', amount: '150000', password: secret }), paymentWork({ calls: 0 }));

    const response = await lookup(staff.token, 'PAYMENT_CONFIRM', key);

    expect(response.body.responseBody).toEqual(original.body);
    expect(JSON.stringify(response.body)).not.toContain(secret);
  });
});
