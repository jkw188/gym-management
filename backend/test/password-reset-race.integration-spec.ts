// Tầng kiểm thử backend (Jest, MongoDB replica set + hộp thư SMTP sandbox): US-05 bước 4.
// Bước 4: đồng hồ giả để thử đúng mốc 60 giây / 10 phút, và race giữa HAI app instance dùng chung một DB.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { Account } from '../src/modules/users/schemas/account.schema';
import { UsersRepository } from '../src/modules/users/users.repository';
import { extractOtp, SmtpSandbox } from './helpers/smtp-sandbox';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us05_race';
const memberPhone = '0901234567';
const memberEmail = 'member.us05@example.com';
const oldPassword = 'MậtKhẩuCũUS-05-123';
const newPassword = 'MậtKhẩuMớiUS-05-456';

// Chỉ giả Date (đồng hồ), các bộ hẹn giờ khác vẫn chạy thật để HTTP, MongoDB và SMTP hoạt động bình thường.
const realTimers = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout'] as const;

describe('US-05 quên mật khẩu – bước 4: đồng hồ giả và race hai instance', () => {
  let mongo: MongoMemoryReplSet;
  let first: INestApplication;
  let second: INestApplication;
  let accounts: Model<Account>;
  const smtp = new SmtpSandbox();
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    await smtp.start();
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName } });
    Object.assign(process.env, {
      NODE_ENV: 'test',
      PORT: '3000',
      FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      ...smtp.env(),
    });
    const { AppModule } = await import('../src/app.module');
    // Hai instance cùng cấu hình và cùng DB, giống chạy hai máy chủ sau load balancer.
    first = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(first);
    await first.init();
    second = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(second);
    await second.init();
    accounts = first.get<Model<Account>>(getModelToken('Account'));
  }, 600000);

  beforeEach(async () => {
    smtp.clear();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const app of [first, second]) {
      const limiter = new LoginLimiter();
      jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    }
    const collections = await accounts.db.db!.collections();
    await Promise.all(collections.map(collection => collection.deleteMany({})));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await second?.close();
    await first?.close();
    await mongo?.stop();
    await smtp.stop();
    process.env = savedEnv;
  });

  // ---------- Hàm hỗ trợ ----------

  async function createAccount(phone = memberPhone, email = memberEmail) {
    const repository = first.get(UsersRepository);
    const role = await repository.ensureRole('MEMBER', 'MEMBER');
    const passwordHash = await first.get(PasswordService).hash(oldPassword);
    const account = await repository.createAccount({ roleId: role.id.toHexString(), phone, fullName: 'US05 Test', passwordHash, email });
    return account._id;
  }

  function requestReset(app: INestApplication, body: object) {
    return request(app.getHttpServer()).post('/api/auth/password-reset/request').set('Origin', origin).send(body);
  }

  function confirm(app: INestApplication, body: object) {
    return request(app.getHttpServer()).post('/api/auth/password-reset/confirm').set('Origin', origin).send(body);
  }

  function login(password: string, phone = memberPhone) {
    return request(first.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password });
  }

  async function openFlow(app: INestApplication, identifier = memberPhone, challenge?: string) {
    const before = smtp.messages.length;
    const response = await requestReset(app, challenge ? { identifier, challenge } : { identifier }).expect(202);
    const mails = await smtp.waitForMessages(before + 1);
    return { challenge: response.body.challenge as string, otp: extractOtp(mails[before])! };
  }

  function wrongOtp(otp: string) {
    return String((Number(otp) + 1) % 1_000_000).padStart(6, '0');
  }

  function unknownChallengeLike(sample: string) {
    return /^[0-9a-f]{64}$/.test(sample) ? randomBytes(32).toString('hex') : randomBytes(32).toString('base64url');
  }

  async function readReset(accountId: Types.ObjectId) {
    const resets = await accounts.db.collection('password_resets').find({ account_id: accountId }).sort({ created_at: -1 }).toArray();
    return resets[0] as Record<string, any>;
  }

  function expectResetInvalid(response: request.Response) {
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('RESET_INVALID');
  }

  // Bật đồng hồ giả, dừng ở thời điểm hiện tại. Sau đó jest.setSystemTime(...) để "nhảy" tới đúng mốc cần thử.
  function freezeClock(): number {
    const now = Date.now();
    jest.useFakeTimers({ doNotFake: [...realTimers], now });
    return now;
  }

  // ---------- Đồng hồ giả: đúng mốc 60 giây (TC03) và 10 phút (TC07) ----------

  // F05: chỉ cho tạo mới khi cách lần được chấp nhận ≥ 60 giây.
  it('US-05-TC03: hỏi lại sau đúng 59,999 giây vẫn bị chặn, không gửi thêm thư', async () => {
    await createAccount();
    const start = freezeClock();
    await openFlow(first);

    jest.setSystemTime(start + 59_999);
    await requestReset(first, { identifier: memberPhone }).expect(202);

    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(smtp.messages).toHaveLength(1);
  });

  it('US-05-TC03: hỏi lại sau đúng 60 giây thì được chấp nhận, gửi thư thứ hai', async () => {
    await createAccount();
    const start = freezeClock();
    await openFlow(first);

    jest.setSystemTime(start + 60_000);
    await requestReset(first, { identifier: memberPhone }).expect(202);

    await smtp.waitForMessages(2);
  });

  // F02: OTP hiệu lực 10 phút từ lúc tạo.
  it('US-05-TC07: OTP ở mốc 9 phút 59,999 giây vẫn dùng được', async () => {
    await createAccount();
    const start = freezeClock();
    const flow = await openFlow(first);

    jest.setSystemTime(start + 599_999);
    await confirm(first, { challenge: flow.challenge, otp: flow.otp, newPassword }).expect(200);
  });

  it('US-05-TC07: OTP ở mốc 10 phút 0,001 giây bị 400 RESET_INVALID', async () => {
    const id = await createAccount();
    const start = freezeClock();
    const flow = await openFlow(first);

    jest.setSystemTime(start + 600_001);
    const response = await confirm(first, { challenge: flow.challenge, otp: flow.otp, newPassword });

    expectResetInvalid(response);
    expect(await readReset(id)).toBeDefined(); // TTL chưa xóa record, nhưng mã vẫn bị từ chối.
    jest.useRealTimers();
    await login(oldPassword).expect(200);
  });

  // ---------- Race giữa hai instance ----------

  it('US-05-TC03: hỏi mã trên instance 1 rồi ngay lập tức trên instance 2 thì chỉ có 1 thư', async () => {
    await createAccount();

    await requestReset(first, { identifier: memberPhone }).expect(202);
    await requestReset(second, { identifier: memberEmail }).expect(202);

    await smtp.waitForMessages(1);
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(smtp.messages).toHaveLength(1);
  });

  it('US-05-TC03: hai request cùng lúc trên hai instance chỉ tạo một flow và một thư', async () => {
    const id = await createAccount();

    await Promise.all([requestReset(first, { identifier: memberPhone }), requestReset(second, { identifier: memberPhone })]);

    await smtp.waitForMessages(1);
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(smtp.messages).toHaveLength(1);
    expect(await accounts.db.collection('password_resets').countDocuments({ account_id: id })).toBe(1);
  });

  it('US-05-TC10: hai confirm đúng cùng lúc trên hai instance thì đúng một cái thành công', async () => {
    const id = await createAccount();
    const flow = await openFlow(first);
    const before = await accounts.collection.findOne({ _id: id });

    const results = await Promise.all([
      confirm(first, { challenge: flow.challenge, otp: flow.otp, newPassword: 'MậtKhẩuInstance1-US05' }),
      confirm(second, { challenge: flow.challenge, otp: flow.otp, newPassword: 'MậtKhẩuInstance2-US05' }),
    ]);

    expect(results.map(result => result.status).sort()).toEqual([200, 400]);
    expectResetInvalid(results.find(result => result.status === 400)!);
    expect((await accounts.collection.findOne({ _id: id }))!.auth_version).toBe(before!.auth_version + 1);
    const winner = results[0].status === 200 ? 'MậtKhẩuInstance1-US05' : 'MậtKhẩuInstance2-US05';
    await login(winner).expect(200);
  });

  it('US-05-TC06: sai 3 lần rồi 4 lần sai chia cho hai instance cùng lúc thì attempts dừng đúng 5', async () => {
    const id = await createAccount();
    const flow = await openFlow(first);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await confirm(attempt % 2 === 0 ? second : first, { challenge: flow.challenge, otp: wrongOtp(flow.otp), newPassword });
    }

    const results = await Promise.all([first, second, first, second].map(app =>
      confirm(app, { challenge: flow.challenge, otp: wrongOtp(flow.otp), newPassword })));

    for (const result of results) expectResetInvalid(result);
    const reset = await readReset(id);
    expect(reset.attempts).toBe(5);
    expect(reset.invalidated_at).toBeInstanceOf(Date);
    expectResetInvalid(await confirm(second, { challenge: flow.challenge, otp: flow.otp, newPassword }));
  });

  it('US-05-TC04: counter 20 confirm/IP dùng chung giữa hai instance', async () => {
    await createAccount();
    const flow = await openFlow(first);
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const app = attempt % 2 === 0 ? second : first;
      expectResetInvalid(await confirm(app, { challenge: unknownChallengeLike(flow.challenge), otp: flow.otp, newPassword }));
    }

    expect((await confirm(first, { challenge: flow.challenge, otp: flow.otp, newPassword })).status).toBe(429);
    expect((await confirm(second, { challenge: flow.challenge, otp: flow.otp, newPassword })).status).toBe(429);
    await login(oldPassword).expect(200);
  });

  it('US-05-TC13: confirm trên instance 2 chạy cùng lúc với đổi mật khẩu US-67 trên instance 1 thì chỉ một bên thắng', async () => {
    for (let round = 0; round < 5; round += 1) {
      const phone = `0970${String(round).padStart(6, '0')}`;
      await createAccount(phone, `race2.${round}@example.com`);
      await accounts.db.collection('auth_rate_limits').deleteMany({});
      const loginResponse = await login(oldPassword, phone).expect(200);
      const flow = await openFlow(second, phone);
      const resetPassword = `MậtKhẩuReset2-${round}-US05`;
      const changedPassword = `MậtKhẩuUS67-2-${round}-Đổi`;

      const [reset, change] = await Promise.all([
        confirm(second, { challenge: flow.challenge, otp: flow.otp, newPassword: resetPassword }),
        request(first.getHttpServer()).post('/api/auth/change-password').set('Origin', origin)
          .set('Authorization', `Bearer ${loginResponse.body.accessToken}`).send({ currentPassword: oldPassword, newPassword: changedPassword }),
      ]);

      if (reset.status === 200) expect(change.status).toBe(401);
      else {
        expectResetInvalid(reset);
        expect(change.status).toBe(200);
      }
      const finalPassword = reset.status === 200 ? resetPassword : changedPassword;
      for (const candidate of [oldPassword, resetPassword, changedPassword]) {
        await login(candidate, phone).expect(candidate === finalPassword ? 200 : 401);
      }
    }
  }, 120000);
});
