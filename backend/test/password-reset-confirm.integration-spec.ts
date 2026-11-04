// Tầng kiểm thử backend (Jest, MongoDB replica set trong bộ nhớ + hộp thư SMTP sandbox): US-05 bước 3.
// Bước 3 là POST /api/auth/password-reset/confirm: kiểm mã, đổi mật khẩu nguyên tử, thu hồi phiên.
// TC06–TC13, phần confirm của TC04, TC05, TC15. OTP lấy từ thư thật trong hộp thư sandbox như người dùng thật.
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
const databaseName = 'gym_management_test_us05_confirm';
const memberPhone = '0901234567';
const memberEmail = 'member.us05@example.com';
const oldPassword = 'MậtKhẩuCũUS-05-123';
const newPassword = 'MậtKhẩuMớiUS-05-456';
// Bảng API: câu thông báo khi đặt lại thành công.
const successMessage = 'Đã cập nhật mật khẩu, vui lòng đăng nhập lại';

interface Flow { challenge: string; otp: string }

describe('US-05 quên mật khẩu – bước 3: xác nhận OTP và đặt mật khẩu mới', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let accounts: Model<Account>;
  const smtp = new SmtpSandbox();
  const savedEnv = { ...process.env };
  let logs: string[] = [];

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
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    accounts = app.get<Model<Account>>(getModelToken('Account'));
  }, 600000);

  beforeEach(async () => {
    smtp.clear();
    logs = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    }
    // Giống test US-67: mỗi test dùng limiter đăng nhập mới để số lần login của test trước không ảnh hưởng test sau.
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    // Gỡ validator TC11 (nếu test trước lỗi giữa chừng) rồi xóa dữ liệu mọi collection.
    await removeValidators();
    const collections = await accounts.db.db!.collections();
    await Promise.all(collections.map(collection => collection.deleteMany({})));
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    await smtp.stop();
    process.env = savedEnv;
  });

  // ---------- Hàm hỗ trợ ----------

  async function createAccount(options: { phone?: string; email?: string } = {}) {
    const repository = app.get(UsersRepository);
    const role = await repository.ensureRole('MEMBER', 'MEMBER');
    const passwordHash = await app.get(PasswordService).hash(oldPassword);
    const account = await repository.createAccount({
      roleId: role.id.toHexString(), phone: options.phone ?? memberPhone, fullName: 'US05 Test', passwordHash,
      email: options.email ?? memberEmail,
    });
    return account._id;
  }

  function requestReset(body: object) {
    return request(app.getHttpServer()).post('/api/auth/password-reset/request').set('Origin', origin).send(body);
  }

  function confirm(body: object, cookie?: string) {
    const call = request(app.getHttpServer()).post('/api/auth/password-reset/confirm').set('Origin', origin);
    if (cookie) call.set('Cookie', cookie);
    return call.send(body);
  }

  // Mở flow (hoặc resend nếu truyền challenge) rồi đọc OTP trong thư mới nhất của hộp thư sandbox.
  async function openFlow(identifier = memberPhone, challenge?: string): Promise<Flow> {
    const before = smtp.messages.length;
    const response = await requestReset(challenge ? { identifier, challenge } : { identifier }).expect(202);
    const mails = await smtp.waitForMessages(before + 1);
    return { challenge: response.body.challenge, otp: extractOtp(mails[before])! };
  }

  // Một OTP chắc chắn sai: cộng 1 vào mã đúng, vẫn giữ đủ 6 chữ số.
  function wrongOtp(otp: string): string {
    return String((Number(otp) + 1) % 1_000_000).padStart(6, '0');
  }

  // Challenge ngẫu nhiên cùng dạng với challenge server trả (cùng độ dài, cùng kiểu mã hóa) nhưng không thuộc flow nào.
  function unknownChallengeLike(sample: string): string {
    return /^[0-9a-f]{64}$/.test(sample) ? randomBytes(32).toString('hex') : randomBytes(32).toString('base64url');
  }

  function login(password: string, phone = memberPhone) {
    return request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password });
  }

  async function loginDevice(password = oldPassword, phone = memberPhone) {
    const response = await login(password, phone).expect(200);
    return { token: response.body.accessToken as string, cookie: cookieOf(response) };
  }

  function cookieOf(response: request.Response) {
    return (response.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  }

  function refresh(cookie: string) {
    return request(app.getHttpServer()).post('/api/auth/refresh').set('Origin', origin).set('Cookie', cookie).send({});
  }

  function me(token: string) {
    return request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  }

  function changePassword(token: string, currentPassword: string, nextPassword: string) {
    return request(app.getHttpServer()).post('/api/auth/change-password').set('Origin', origin)
      .set('Authorization', `Bearer ${token}`).send({ currentPassword, newPassword: nextPassword });
  }

  function readAccount(id: Types.ObjectId) {
    return accounts.collection.findOne({ _id: id }) as Promise<Record<string, any>>;
  }

  // Record reset mới nhất của account.
  async function readReset(accountId: Types.ObjectId) {
    const resets = await accounts.db.collection('password_resets').find({ account_id: accountId }).sort({ created_at: -1 }).toArray();
    return resets[0] as Record<string, any>;
  }

  async function pretendSecondsPassed(seconds: number) {
    const fieldsByCollection: Record<string, string[]> = {
      accounts: ['recovery_requested_at'],
      password_resets: ['created_at', 'expires_at'],
      auth_rate_limits: ['window_start', 'expires_at'],
    };
    for (const [name, fields] of Object.entries(fieldsByCollection)) {
      const collection = accounts.db.collection(name);
      for (const document of await collection.find().toArray()) {
        const shifted: Record<string, Date> = {};
        for (const field of fields) {
          const value = document[field];
          if (value instanceof Date) shifted[field] = new Date(value.getTime() - seconds * 1000);
        }
        if (Object.keys(shifted).length > 0) await collection.updateOne({ _id: document._id }, { $set: shifted });
      }
    }
  }

  function expectResetInvalid(response: request.Response) {
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('RESET_INVALID');
  }

  // Mật khẩu chưa đổi: đăng nhập bằng mật khẩu cũ vẫn được.
  async function expectPasswordUnchanged(phone = memberPhone) {
    await login(oldPassword, phone).expect(200);
  }

  // TC11: validator của collection làm MongoDB từ chối một lần ghi, giống DB lỗi thật ngay trong transaction.
  async function setValidator(collection: string, validator: object) {
    await accounts.db.db!.command({ collMod: collection, validator, validationLevel: 'strict', validationAction: 'error' });
  }

  async function removeValidators() {
    const existing = (await accounts.db.db!.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name);
    for (const name of ['accounts', 'password_resets']) {
      if (existing.includes(name)) await accounts.db.db!.command({ collMod: name, validator: {}, validationLevel: 'off' });
    }
  }

  // ---------- US-05-TC12: đặt lại thành công, thu hồi phiên, không tự đăng nhập ----------

  it('US-05-TC12: OTP đúng trả 200 đúng message, không có token, header no-store', async () => {
    await createAccount();
    const flow = await openFlow();

    const response = await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: successMessage });
    expect(response.headers['cache-control']).toContain('no-store');
    // Không tự đăng nhập: không có cookie phiên mới nào khác rỗng.
    const cookies = (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    for (const cookie of cookies) expect(cookie).toMatch(/^gym_refresh=;/);
  });

  // F06: OTP đúng thì ghi used_at, attempts+1 và đổi password_hash, auth_version+1, version+1, recovery_revision+1, password_changed_at.
  it('US-05-TC12: thành công ghi đủ các field của account và record reset trong cùng một lần', async () => {
    const id = await createAccount();
    const flow = await openFlow();
    const accountBefore = await readAccount(id);
    const resetBefore = await readReset(id);

    await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword }).expect(200);

    const accountAfter = await readAccount(id);
    const resetAfter = await readReset(id);
    expect(accountAfter.password_hash).not.toBe(accountBefore.password_hash);
    expect(accountAfter.password_hash).toMatch(/^\$argon2id\$/);
    expect(accountAfter.auth_version).toBe(accountBefore.auth_version + 1);
    expect(accountAfter.version).toBe(accountBefore.version + 1);
    expect(accountAfter.recovery_revision).toBe(accountBefore.recovery_revision + 1);
    expect(accountAfter.password_changed_at).toBeInstanceOf(Date);
    expect(accountAfter.updated_at.getTime()).toBeGreaterThan(accountBefore.updated_at.getTime());
    expect(accountAfter.status).toBe('ACTIVE');
    expect(resetAfter.used_at).toBeInstanceOf(Date);
    expect(resetAfter.attempts).toBe(resetBefore.attempts + 1);
  });

  it('US-05-TC12: đăng nhập 2 thiết bị rồi reset thì access và refresh cũ đều 401', async () => {
    await createAccount();
    const deviceA = await loginDevice();
    const deviceB = await loginDevice();
    const flow = await openFlow();

    await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword }).expect(200);

    for (const device of [deviceA, deviceB]) {
      await me(device.token).expect(401);
      await refresh(device.cookie).expect(401);
    }
  });

  it('US-05-TC12: sau reset đăng nhập bằng mật khẩu mới được, mật khẩu cũ bị từ chối', async () => {
    await createAccount();
    const flow = await openFlow();

    await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword }).expect(200);

    const fresh = await login(newPassword).expect(200);
    await me(fresh.body.accessToken).expect(200);
    await login(oldPassword).expect(401);
  });

  // Bảng API dòng "Cookie và cache": thành công xóa gym_refresh theo đúng flags và path của US-02 (giống US-67).
  it('US-05-TC12: thành công xóa cookie gym_refresh của trình duyệt đúng flags và path', async () => {
    await createAccount();
    const device = await loginDevice();
    const flow = await openFlow();

    const response = await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword }, device.cookie).expect(200);

    const raw = (response.headers['set-cookie'] as unknown as string[])[0];
    expect(raw).toMatch(/^gym_refresh=;/);
    expect(raw).toMatch(/Path=\/api\/auth/);
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('US-05-TC12: OTP sai không xóa cookie gym_refresh', async () => {
    await createAccount();
    const device = await loginDevice();
    const flow = await openFlow();

    const response = await confirm({ challenge: flow.challenge, otp: wrongOtp(flow.otp), newPassword }, device.cookie);

    expectResetInvalid(response);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  // ---------- US-05-TC06: sai OTP 5 lần ----------

  // F06: OTP sai phải tăng attempts và commit TRƯỚC khi trả 400, không rollback counter.
  it('US-05-TC06: OTP sai trả 400 RESET_INVALID và attempts đã tăng trong DB ngay khi nhận phản hồi', async () => {
    const id = await createAccount();
    const flow = await openFlow();

    const response = await confirm({ challenge: flow.challenge, otp: wrongOtp(flow.otp), newPassword });

    expectResetInvalid(response);
    expect((await readReset(id)).attempts).toBe(1);
    await expectPasswordUnchanged();
  });

  it('US-05-TC06: sai 5 lần thì lần thứ 5 ghi invalidated_at, sau đó OTP đúng cũng bị từ chối', async () => {
    const id = await createAccount();
    const flow = await openFlow();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expectResetInvalid(await confirm({ challenge: flow.challenge, otp: wrongOtp(flow.otp), newPassword }));
      expect((await readReset(id)).attempts).toBe(attempt);
    }
    const reset = await readReset(id);
    expect(reset.invalidated_at).toBeInstanceOf(Date);

    expectResetInvalid(await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword }));
    await expectPasswordUnchanged();
  });

  // Ca đối chứng: attempts < 5 thì OTP đúng vẫn dùng được.
  it('US-05-TC06: sai 4 lần rồi nhập đúng vẫn đặt lại được', async () => {
    await createAccount();
    const flow = await openFlow();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expectResetInvalid(await confirm({ challenge: flow.challenge, otp: wrongOtp(flow.otp), newPassword }));
    }

    await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword }).expect(200);

    await login(newPassword).expect(200);
  });

  it('US-05-TC06: sai 3 lần rồi 4 lần sai chạy đồng thời thì attempts dừng đúng 5, challenge bị vô hiệu hóa', async () => {
    const id = await createAccount();
    const flow = await openFlow();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await confirm({ challenge: flow.challenge, otp: wrongOtp(flow.otp), newPassword });
    }

    const results = await Promise.all([1, 2, 3, 4].map(() => confirm({ challenge: flow.challenge, otp: wrongOtp(flow.otp), newPassword })));

    for (const result of results) expectResetInvalid(result);
    const reset = await readReset(id);
    expect(reset.attempts).toBe(5);
    expect(reset.invalidated_at).toBeInstanceOf(Date);
    expectResetInvalid(await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword }));
    await expectPasswordUnchanged();
  });

  // ---------- US-05-TC07: OTP hết 10 phút ----------

  it('US-05-TC07: OTP quá 10 phút (record còn trong DB vì TTL chưa xóa) trả 400 RESET_INVALID', async () => {
    const id = await createAccount();
    const flow = await openFlow();

    await pretendSecondsPassed(601);
    expect(await readReset(id)).toBeDefined();
    const response = await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword });

    expectResetInvalid(response);
    await expectPasswordUnchanged();
  });

  it('US-05-TC07: OTP mới qua 9 phút 50 giây vẫn còn hạn', async () => {
    await createAccount();
    const flow = await openFlow();

    await pretendSecondsPassed(590);
    await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword }).expect(200);
  });

  // ---------- US-05-TC08: OTP cũ sau resend, challenge cũ sau flow mới ----------

  it('US-05-TC08: resend cùng challenge thì OTP cũ bị từ chối, OTP mới dùng được', async () => {
    await createAccount();
    const first = await openFlow();
    await pretendSecondsPassed(61);
    const second = await openFlow(memberPhone, first.challenge);
    expect(second.challenge).toBe(first.challenge);

    expectResetInvalid(await confirm({ challenge: first.challenge, otp: first.otp, newPassword }));
    await confirm({ challenge: second.challenge, otp: second.otp, newPassword }).expect(200);
  });

  it('US-05-TC08: mở flow mới thì challenge cũ (kèm OTP cũ) bị vô hiệu hóa, flow mới dùng được', async () => {
    await createAccount();
    const first = await openFlow();
    await pretendSecondsPassed(61);
    const second = await openFlow();
    expect(second.challenge).not.toBe(first.challenge);

    expectResetInvalid(await confirm({ challenge: first.challenge, otp: first.otp, newPassword }));
    await confirm({ challenge: second.challenge, otp: second.otp, newPassword }).expect(200);
  });

  // ---------- US-05-TC09: account đổi sau khi yêu cầu mã ----------

  describe('US-05-TC09: account thay đổi sau khi yêu cầu mã thì OTP đúng cũng bị từ chối', () => {
    // Spec: password/identity/role/khóa thay đổi auth_version; F06 còn kiểm email và trạng thái ACTIVE riêng.
    const changes: { name: string; change: (id: Types.ObjectId) => Promise<unknown> }[] = [
      { name: 'đổi phone (auth_version tăng)', change: id => accounts.collection.updateOne({ _id: id }, { $set: { phone: '0907777777' }, $inc: { auth_version: 1 } }) },
      { name: 'đổi email (snapshot email không khớp)', change: id => accounts.collection.updateOne({ _id: id }, { $set: { email: 'email.moi@example.com' } }) },
      {
        name: 'đổi role (auth_version tăng)',
        change: async id => {
          const trainer = await app.get(UsersRepository).ensureRole('TRAINER', 'TRAINER');
          await accounts.collection.updateOne({ _id: id }, { $set: { role_id: trainer._id }, $inc: { auth_version: 1 } });
        },
      },
      { name: 'bị khóa LOCKED', change: id => accounts.collection.updateOne({ _id: id }, { $set: { status: 'LOCKED' } }) },
      { name: 'auth_version tăng vì lý do khác', change: id => accounts.collection.updateOne({ _id: id }, { $inc: { auth_version: 1 } }) },
    ];

    it.each(changes)('US-05-TC09: $name', async ({ change }) => {
      const id = await createAccount();
      const flow = await openFlow();
      await change(id);
      const before = await readAccount(id);

      const response = await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword });

      expectResetInvalid(response);
      const after = await readAccount(id);
      expect(after.password_hash).toBe(before.password_hash);
      expect(after.auth_version).toBe(before.auth_version);
    });
  });

  it('US-05-TC09: đổi mật khẩu bằng US-67 sau khi yêu cầu mã thì OTP đúng bị từ chối, mật khẩu US-67 giữ nguyên', async () => {
    await createAccount();
    const device = await loginDevice();
    const flow = await openFlow();
    const changedPassword = 'MậtKhẩuUS-67-Đổi-789';
    await changePassword(device.token, oldPassword, changedPassword).expect(200);

    expectResetInvalid(await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword }));

    await login(changedPassword).expect(200);
    await login(newPassword).expect(401);
  });

  // ---------- US-05-TC10: hai confirm đúng đồng thời ----------

  it('US-05-TC10: hai confirm đúng đồng thời thì đúng một cái thành công, cái còn lại 400, auth_version chỉ tăng 1', async () => {
    const id = await createAccount();
    const flow = await openFlow();
    const before = await readAccount(id);
    const passwordA = 'MậtKhẩuMớiA-US05-111';
    const passwordB = 'MậtKhẩuMớiB-US05-222';

    const [first, second] = await Promise.all([
      confirm({ challenge: flow.challenge, otp: flow.otp, newPassword: passwordA }),
      confirm({ challenge: flow.challenge, otp: flow.otp, newPassword: passwordB }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 400]);
    expectResetInvalid(first.status === 400 ? first : second);
    const after = await readAccount(id);
    expect(after.auth_version).toBe(before.auth_version + 1);
    expect((await readReset(id)).used_at).toBeInstanceOf(Date);
    const winner = first.status === 200 ? passwordA : passwordB;
    const loser = first.status === 200 ? passwordB : passwordA;
    await login(winner).expect(200);
    await login(loser).expect(401);
  });

  it('US-05-TC10: OTP đã dùng thành công thì dùng lại lần nữa bị 400 RESET_INVALID', async () => {
    await createAccount();
    const flow = await openFlow();
    await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword }).expect(200);

    expectResetInvalid(await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword: 'MậtKhẩuKhác-US05-333' }));

    await login(newPassword).expect(200);
  });

  // ---------- US-05-TC11: lỗi ghi trước commit thì rollback cả hai ----------

  it('US-05-TC11: lỗi ghi account trước commit thì trả 503, không đổi password, không ghi used_at; sau đó OTP vẫn dùng được', async () => {
    const id = await createAccount();
    const flow = await openFlow();
    const accountBefore = await readAccount(id);
    const resetBefore = await readReset(id);
    // MongoDB từ chối mọi lần ghi làm auth_version lớn hơn hiện tại (lần reset bắt buộc tăng auth_version).
    await setValidator('accounts', { $expr: { $lte: ['$auth_version', accountBefore.auth_version] } });

    const response = await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword });

    await removeValidators();
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(await readAccount(id)).toEqual(accountBefore);
    expect(await readReset(id)).toEqual(resetBefore);
    // Không có gì được commit nên mã vẫn còn dùng được.
    await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword }).expect(200);
  });

  it('US-05-TC11: lỗi ghi record reset trước commit thì trả 503, không đổi password, không ghi used_at', async () => {
    const id = await createAccount();
    const flow = await openFlow();
    const accountBefore = await readAccount(id);
    const resetBefore = await readReset(id);
    // MongoDB từ chối mọi lần ghi used_at vào password_resets.
    await setValidator('password_resets', { used_at: { $exists: false } });

    const response = await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword });

    await removeValidators();
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(await readAccount(id)).toEqual(accountBefore);
    expect(await readReset(id)).toEqual(resetBefore);
    await expectPasswordUnchanged();
  });

  // ---------- US-05-TC13: reset cạnh tranh với US-67 hoặc resend ----------

  // Race có thể ra nhiều thứ tự; chạy 5 lần, mỗi lần đều phải là MỘT thứ tự hợp lệ, không ghi đè bằng credential cũ.
  it('US-05-TC13: reset chạy cùng lúc với đổi mật khẩu US-67 thì không cả hai cùng thành công, mật khẩu cuối khớp bên thắng', async () => {
    for (let round = 0; round < 5; round += 1) {
      const phone = `0950${String(round).padStart(6, '0')}`;
      await createAccount({ phone, email: `race67.${round}@example.com` });
      await accounts.db.collection('auth_rate_limits').deleteMany({});
      const device = await loginDevice(oldPassword, phone);
      const flow = await openFlow(phone);
      const resetPassword = `MậtKhẩuReset-${round}-US05`;
      const changedPassword = `MậtKhẩuUS67-${round}-Đổi`;

      const [reset, change] = await Promise.all([
        confirm({ challenge: flow.challenge, otp: flow.otp, newPassword: resetPassword }),
        changePassword(device.token, oldPassword, changedPassword),
      ]);

      // Chỉ một thứ tự hợp lệ: reset trước thì phiên US-67 bị thu hồi (401); đổi US-67 trước thì reset bị 400 RESET_INVALID.
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

  it('US-05-TC13: resend chạy cùng lúc với confirm bằng OTP cũ thì chỉ một thứ tự hợp lệ', async () => {
    for (let round = 0; round < 3; round += 1) {
      const phone = `0960${String(round).padStart(6, '0')}`;
      await createAccount({ phone, email: `raceresend.${round}@example.com` });
      await accounts.db.collection('auth_rate_limits').deleteMany({});
      const first = await openFlow(phone);
      await pretendSecondsPassed(61);
      const mailsBefore = smtp.messages.length;
      const resetPassword = `MậtKhẩuResend-${round}-US05`;

      const [resend, reset] = await Promise.all([
        requestReset({ identifier: phone, challenge: first.challenge }),
        confirm({ challenge: first.challenge, otp: first.otp, newPassword: resetPassword }),
      ]);
      expect(resend.status).toBe(202);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const newMail = smtp.messages[mailsBefore];

      if (reset.status === 200) {
        // Confirm thắng: flow đã dùng, nếu resend vẫn gửi thư thì mã trong thư đó cũng không dùng được.
        if (newMail) expectResetInvalid(await confirm({ challenge: first.challenge, otp: extractOtp(newMail)!, newPassword: 'MậtKhẩuKhác-US05-999' }));
        await login(resetPassword, phone).expect(200);
      } else {
        // Resend thắng: OTP cũ bị thay, mật khẩu chưa đổi, mã mới trong thư dùng được.
        expectResetInvalid(reset);
        await login(oldPassword, phone).expect(200);
        expect(newMail).toBeDefined();
        await confirm({ challenge: first.challenge, otp: extractOtp(newMail)!, newPassword: resetPassword }).expect(200);
      }
    }
  }, 120000);

  // ---------- US-05-TC15: dữ liệu confirm sai ----------

  describe('US-05-TC15: body confirm sai trả 400 VALIDATION_ERROR, không tốn lượt thử, không đổi mật khẩu', () => {
    // Mỗi ca chỉ sai MỘT chỗ; các field còn lại là challenge và OTP đúng của flow vừa mở.
    const cases: { name: string; body: (flow: Flow) => object }[] = [
      { name: 'thiếu challenge', body: flow => ({ otp: flow.otp, newPassword }) },
      { name: 'challenge sai cú pháp', body: flow => ({ challenge: 'abc', otp: flow.otp, newPassword }) },
      { name: 'thiếu otp', body: flow => ({ challenge: flow.challenge, newPassword }) },
      { name: 'otp là số (không phải chuỗi)', body: flow => ({ challenge: flow.challenge, otp: Number(flow.otp), newPassword }) },
      { name: 'otp 5 chữ số', body: flow => ({ challenge: flow.challenge, otp: flow.otp.slice(0, 5), newPassword }) },
      { name: 'otp 7 chữ số', body: flow => ({ challenge: flow.challenge, otp: `${flow.otp}0`, newPassword }) },
      { name: 'otp có chữ cái', body: flow => ({ challenge: flow.challenge, otp: `${flow.otp.slice(0, 5)}a`, newPassword }) },
      { name: 'thiếu newPassword', body: flow => ({ challenge: flow.challenge, otp: flow.otp }) },
      { name: 'newPassword là số', body: flow => ({ challenge: flow.challenge, otp: flow.otp, newPassword: 123456789012 }) },
      // EN01-F06: 12–128 ký tự Unicode, đếm theo ký tự (giống test US-67).
      { name: 'newPassword 11 ký tự', body: flow => ({ challenge: flow.challenge, otp: flow.otp, newPassword: 'a'.repeat(11) }) },
      { name: 'newPassword 129 ký tự', body: flow => ({ challenge: flow.challenge, otp: flow.otp, newPassword: 'a'.repeat(129) }) },
      { name: 'newPassword 11 emoji', body: flow => ({ challenge: flow.challenge, otp: flow.otp, newPassword: '😀'.repeat(11) }) },
      { name: 'newPassword 6 emoji (12 đơn vị UTF-16 nhưng chỉ 6 ký tự)', body: flow => ({ challenge: flow.challenge, otp: flow.otp, newPassword: '😀'.repeat(6) }) },
      { name: 'field thừa accountId', body: flow => ({ challenge: flow.challenge, otp: flow.otp, newPassword, accountId: new Types.ObjectId().toHexString() }) },
      { name: 'field thừa role', body: flow => ({ challenge: flow.challenge, otp: flow.otp, newPassword, role: 'ADMIN' }) },
    ];

    it.each(cases)('US-05-TC15: $name', async ({ body }) => {
      const id = await createAccount();
      const flow = await openFlow();

      const response = await confirm(body(flow));

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect((await readReset(id)).attempts).toBe(0);
      await expectPasswordUnchanged();
    });
  });

  describe('US-05-TC15: newPassword hợp lệ ở biên vẫn đặt lại được', () => {
    const valid: [string, string][] = [
      ['12 ký tự', 'a'.repeat(12)],
      ['128 ký tự', 'a'.repeat(128)],
      ['12 emoji', '😀'.repeat(12)],
    ];

    it.each(valid)('US-05-TC15: newPassword %s', async (_label, password) => {
      await createAccount();
      const flow = await openFlow();

      await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword: password }).expect(200);

      await login(password).expect(200);
    });
  });

  // F06: newPassword "không trim" – khoảng trắng đầu/cuối là một phần của mật khẩu.
  it('US-05-TC15: newPassword không bị trim, phải đăng nhập bằng đúng chuỗi có khoảng trắng', async () => {
    await createAccount();
    const flow = await openFlow();
    const spaced = '  MậtKhẩuCóCách-US05  ';

    await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword: spaced }).expect(200);

    await login(spaced).expect(200);
    await login(spaced.trim()).expect(401);
  });

  // Bảng API dòng "Lỗi công khai": sai mã, hết hạn, bị thay, đã dùng, challenge lạ đều cùng một lỗi, không phân biệt.
  it('US-05-TC15: challenge lạ, OTP sai, mã đã dùng, mã hết hạn đều trả lỗi 400 giống hệt nhau', async () => {
    await createAccount();
    const used = await openFlow();
    await confirm({ challenge: used.challenge, otp: used.otp, newPassword }).expect(200);
    await pretendSecondsPassed(61);
    const active = await openFlow();

    const unknown = await confirm({ challenge: unknownChallengeLike(active.challenge), otp: active.otp, newPassword });
    const wrong = await confirm({ challenge: active.challenge, otp: wrongOtp(active.otp), newPassword });
    const reused = await confirm({ challenge: used.challenge, otp: used.otp, newPassword });
    await pretendSecondsPassed(601);
    const expired = await confirm({ challenge: active.challenge, otp: active.otp, newPassword });

    for (const response of [unknown, wrong, reused, expired]) expectResetInvalid(response);
    expect(wrong.body.error).toEqual(unknown.body.error);
    expect(reused.body.error).toEqual(unknown.body.error);
    expect(expired.body.error).toEqual(unknown.body.error);
  });

  // ---------- US-05-TC04 (phần confirm): giới hạn 20 lần reset/IP/10 phút ----------

  it('US-05-TC04: confirm thứ 21 từ cùng IP trong 10 phút bị 429 có Retry-After, kể cả OTP đúng; account không bị khóa', async () => {
    const id = await createAccount();
    const flow = await openFlow();
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      // Challenge lạ mỗi lần khác nhau để không chạm giới hạn 5 lần/challenge.
      expectResetInvalid(await confirm({ challenge: unknownChallengeLike(flow.challenge), otp: flow.otp, newPassword }));
    }

    const response = await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword });

    expect(response.status).toBe(429);
    const retryAfter = Number(response.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(10 * 60);
    expect((await readAccount(id)).status).toBe('ACTIVE');
    await expectPasswordUnchanged();
  });

  // ---------- US-05-TC05 (phần confirm): log không lộ bí mật ----------

  it('US-05-TC05: log khi confirm sai và đúng không chứa OTP, challenge hay mật khẩu mới', async () => {
    await createAccount();
    const flow = await openFlow();

    await confirm({ challenge: flow.challenge, otp: wrongOtp(flow.otp), newPassword });
    await confirm({ challenge: flow.challenge, otp: flow.otp, newPassword }).expect(200);

    const all = logs.join('\n');
    for (const secret of [flow.otp, wrongOtp(flow.otp), flow.challenge, newPassword]) expect(all).not.toContain(secret);
  });
});
