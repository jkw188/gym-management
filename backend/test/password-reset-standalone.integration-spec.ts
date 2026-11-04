// Tầng kiểm thử backend (Jest, MongoDB thật chạy trong bộ nhớ dạng MÁY ĐƠN, không phải replica set): US-05 bước 1.
// MongoDB máy đơn không có transaction, nên quên mật khẩu không chạy được. Spec: 503 SERVICE_UNAVAILABLE khi DB/cấu hình
// không hoạt động, và không được phân biệt account có hay không (US-05-TC02). File riêng vì cần một DB khác file chính.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Model } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { Account } from '../src/modules/users/schemas/account.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us05_standalone';
const memberPhone = '0901234567';
const memberEmail = 'member.us05@example.com';

describe('US-05 quên mật khẩu – MongoDB máy đơn (không có transaction)', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication;
  let accounts: Model<Account>;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: '8.0.17' }, instance: { dbName: databaseName } });
    Object.assign(process.env, {
      NODE_ENV: 'test',
      PORT: '3000',
      FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    accounts = app.get<Model<Account>>(getModelToken('Account'));
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const collections = await accounts.db.db!.collections();
    await Promise.all(collections.map(collection => collection.deleteMany({})));
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  function requestReset(body: object) {
    return request(app.getHttpServer()).post('/api/auth/password-reset/request').set('Origin', origin).send(body);
  }

  async function createEligibleAccount() {
    const repository = app.get(UsersRepository);
    const role = await repository.ensureRole('MEMBER', 'MEMBER');
    const passwordHash = await app.get(PasswordService).hash('MậtKhẩuUS-05-123');
    await repository.createAccount({ roleId: role.id.toHexString(), phone: memberPhone, fullName: 'US05 Test', passwordHash, email: memberEmail });
  }

  it('US-05-TC02: account hợp lệ nhận 503 SERVICE_UNAVAILABLE, không tạo record', async () => {
    await createEligibleAccount();

    const response = await requestReset({ identifier: memberPhone });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(await accounts.db.collection('password_resets').countDocuments()).toBe(0);
  });

  it('US-05-TC02: account hợp lệ và phone không tồn tại nhận lỗi 503 giống hệt nhau', async () => {
    await createEligibleAccount();

    const eligible = await requestReset({ identifier: memberPhone });
    const missing = await requestReset({ identifier: '0911111111' });

    expect(eligible.status).toBe(503);
    expect(missing.status).toBe(503);
    expect(eligible.body.error).toEqual(missing.body.error);
  });

  it('US-05-TC02: tìm bằng email đã lưu và email không tồn tại cũng nhận lỗi 503 giống hệt nhau', async () => {
    await createEligibleAccount();

    const eligible = await requestReset({ identifier: memberEmail });
    const missing = await requestReset({ identifier: 'khong.ton.tai@example.com' });

    expect(eligible.status).toBe(503);
    expect(missing.status).toBe(503);
    expect(eligible.body.error).toEqual(missing.body.error);
  });
});
