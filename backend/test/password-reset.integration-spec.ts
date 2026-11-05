// Tầng kiểm thử backend (Jest, MongoDB thật chạy trong bộ nhớ dạng replica set): gọi API quên mật khẩu của US-05.
// Bước 1 chỉ có POST /api/auth/password-reset/request (chưa gửi SMTP): TC01 (phần 202), TC02, TC03, TC04, TC15 (phần request).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Model, Types } from 'mongoose';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { Account } from '../src/modules/users/schemas/account.schema';
import { RoleCode } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';
import { SmtpSandbox } from './helpers/smtp-sandbox';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us05';
const requestUrl = '/api/auth/password-reset/request';
// Bảng API: câu thông báo chung, giống nhau cho mọi trường hợp.
const publicMessage = 'Nếu tài khoản đủ điều kiện, mã xác thực sẽ được gửi đến email đã lưu';
const memberPhone = '0901234567';
const memberEmail = 'member.us05@example.com';
const password = 'MậtKhẩuUS-05-123';

// Chạy một lệnh node con (dùng cho build và lệnh ensure-indexes), trả về mã thoát và toàn bộ output.
function runProcess(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), env: { ...process.env, ...env }, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Lệnh con không kết thúc')); }, 120000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}

describe('US-05 quên mật khẩu – bước 1: yêu cầu mã', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let secondApp: INestApplication | undefined;
  let accounts: Model<Account>;
  let repository: UsersRepository;
  let passwords: PasswordService;
  // Bước 2: bật quên mật khẩu thì phải có cấu hình SMTP, nên file này cũng dùng hộp thư sandbox (chỉ để nhận thư, không kiểm tra thư).
  const smtp = new SmtpSandbox();
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    await smtp.start();
    // F05 và F06 dùng transaction, mà MongoDB chỉ cho transaction khi chạy replica set, nên test dựng replica set 1 node.
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName } });
    Object.assign(process.env, {
      NODE_ENV: 'test',
      PORT: '3000',
      FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      // Bảng "Lưu mã": pepper ngẫu nhiên ≥ 32 byte qua env, khác JWT secret.
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      ...smtp.env(),
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    accounts = app.get<Model<Account>>(getModelToken('Account'));
    repository = app.get(UsersRepository);
    passwords = app.get(PasswordService);
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Xóa dữ liệu mọi collection (gồm counter giới hạn) để các test không ảnh hưởng nhau. Index vẫn giữ.
    const collections = await accounts.db.db!.collections();
    await Promise.all(collections.map(collection => collection.deleteMany({})));
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await secondApp?.close();
    await app?.close();
    await mongo?.stop();
    await smtp.stop();
    process.env = savedEnv;
  });

  // ---------- Hàm hỗ trợ ----------

  // Tạo tài khoản trong DB. email để trống nghĩa là tài khoản không có email.
  async function createAccount(options: { code?: RoleCode; phone?: string; email?: string; status?: 'ACTIVE' | 'LOCKED' } = {}) {
    const code = options.code ?? 'MEMBER';
    const role = await repository.ensureRole(code, code);
    const passwordHash = await passwords.hash(password);
    const account = await repository.createAccount({
      roleId: role.id.toHexString(), phone: options.phone ?? memberPhone, fullName: 'US05 Test', passwordHash, email: options.email,
    });
    if (options.status === 'LOCKED') await accounts.collection.updateOne({ _id: account._id }, { $set: { status: 'LOCKED' } });
    return account._id;
  }

  function requestReset(body: object, target: INestApplication = app) {
    return request(target.getHttpServer()).post(requestUrl).set('Origin', origin).send(body);
  }

  // Đọc thẳng document trong MongoDB (không qua Mongoose) để thấy đúng dữ liệu đã lưu.
  function readAccount(id: Types.ObjectId) {
    return accounts.collection.findOne({ _id: id }) as Promise<Record<string, any>>;
  }

  function readResets() {
    return accounts.db.collection('password_resets').find().toArray() as Promise<Record<string, any>[]>;
  }

  function readRateLimits() {
    return accounts.db.collection('auth_rate_limits').find().toArray() as Promise<Record<string, any>[]>;
  }

  // Giả lập thời gian trôi qua: lùi mọi mốc thời gian liên quan trong DB đi `seconds` giây.
  // Bước 1 chưa có fake clock (bước 4 mới có), nên đây là cách test cooldown 60 giây mà không phải chờ thật.
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

  // Bảng API: body 202 chỉ có đúng 2 field message và challenge, không email/accountId/trạng thái gửi.
  function expectPublicAccepted(response: request.Response) {
    expect(response.status).toBe(202);
    expect(Object.keys(response.body).sort()).toEqual(['challenge', 'message']);
    expect(response.body.message).toBe(publicMessage);
    expectChallengeShape(response.body.challenge);
    // F03: không tự đăng nhập, không trả token hoặc cookie.
    expect(response.headers['set-cookie']).toBeUndefined();
  }

  // F02: challenge là 32 byte ngẫu nhiên do server tạo. Spec không nói cách mã hóa, nên chỉ kiểm tra là chuỗi
  // đủ dài cho 32 byte (base64url là 43 ký tự, hex là 64 ký tự) và chỉ gồm ký tự an toàn.
  function expectChallengeShape(challenge: unknown) {
    expect(typeof challenge).toBe('string');
    expect((challenge as string).length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_\-+/=]+$/);
  }

  function expectRateLimited(response: request.Response) {
    expect(response.status).toBe(429);
    const retryAfter = Number(response.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(10 * 60);
  }

  // Lấy một challenge đúng cú pháp nhưng không thuộc flow nào: hỏi mã cho số điện thoại không tồn tại.
  async function unknownButValidChallenge() {
    const response = await requestReset({ identifier: '0999999999' });
    expectPublicAccepted(response);
    return response.body.challenge as string;
  }

  // ---------- US-05-TC01: account ACTIVE có email ----------

  describe.each<RoleCode>(['ADMIN', 'STAFF', 'TRAINER', 'MEMBER'])('vai trò %s', code => {
    it('US-05-TC01: yêu cầu bằng phone trả 202 chung và tạo một flow reset cho account', async () => {
      const id = await createAccount({ code, email: memberEmail });

      const response = await requestReset({ identifier: memberPhone });

      expectPublicAccepted(response);
      const resets = await readResets();
      expect(resets).toHaveLength(1);
      expect(resets[0].account_id.equals(id)).toBe(true);
    });
  });

  it('US-05-TC01: yêu cầu bằng email đã lưu cũng trả 202 chung và tạo flow reset', async () => {
    const id = await createAccount({ email: memberEmail });

    const response = await requestReset({ identifier: memberEmail });

    expectPublicAccepted(response);
    const resets = await readResets();
    expect(resets).toHaveLength(1);
    expect(resets[0].account_id.equals(id)).toBe(true);
  });

  it('US-05-TC01: header Cache-Control là no-store', async () => {
    await createAccount({ email: memberEmail });

    const response = await requestReset({ identifier: memberPhone });

    expect(response.headers['cache-control']).toContain('no-store');
  });

  // Bảng "Lưu mã": các field của password_resets sau khi tạo flow mới.
  it('US-05-TC01: record password_resets lưu hash, snapshot, hạn 10 phút và không lưu challenge thô', async () => {
    const id = await createAccount({ email: memberEmail });
    const before = await readAccount(id);

    const response = await requestReset({ identifier: memberPhone });

    expectPublicAccepted(response);
    const [reset] = await readResets();
    const after = await readAccount(id);
    expect(reset.id.equals(reset._id)).toBe(true);
    expect(reset.attempts).toBe(0);
    expect(reset.used_at).toBeUndefined();
    expect(reset.invalidated_at).toBeUndefined();
    expect(typeof reset.token_hash).toBe('string');
    expect(reset.token_hash.length).toBeLessThanOrEqual(255);
    expect(reset.challenge_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(reset.email_snapshot).toBe(memberEmail);
    expect(reset.auth_version_snapshot).toBe(before.auth_version);
    expect(reset.recovery_revision_snapshot).toBe(after.recovery_revision);
    // F02: hạn 10 phút tính từ lúc tạo.
    expect(reset.expires_at.getTime() - reset.created_at.getTime()).toBe(10 * 60 * 1000);
    // Challenge thô chỉ trả cho trình duyệt, không được nằm trong DB.
    expect(JSON.stringify(reset)).not.toContain(response.body.challenge);
  });

  // Bảng "accounts bổ sung": request tăng recovery_revision, ghi recovery_requested_at, không đụng auth_version/password.
  it('US-05-TC01: tạo flow tăng recovery_revision và ghi recovery_requested_at, không đổi auth_version, password', async () => {
    const id = await createAccount({ email: memberEmail });
    const before = await readAccount(id);

    await requestReset({ identifier: memberPhone }).expect(202);

    const after = await readAccount(id);
    expect(after.recovery_revision).toBe((before.recovery_revision ?? 0) + 1);
    expect(after.recovery_requested_at).toBeInstanceOf(Date);
    expect(after.auth_version).toBe(before.auth_version);
    expect(after.version).toBe(before.version);
    expect(after.password_hash).toBe(before.password_hash);
    expect(after.status).toBe('ACTIVE');
  });

  it('US-05-TC01: mỗi flow mới có challenge ngẫu nhiên khác nhau', async () => {
    await createAccount({ email: memberEmail });

    const first = await requestReset({ identifier: memberPhone });
    await pretendSecondsPassed(61);
    const second = await requestReset({ identifier: memberPhone });

    expectPublicAccepted(first);
    expectPublicAccepted(second);
    expect(second.body.challenge).not.toBe(first.body.challenge);
  });

  // Đầu ra bước 1: index của password_resets (bảng "Lưu mã").
  it('US-05-TC01: password_resets có index unique token_hash, challenge_hash, index account_id+created_at và TTL expires_at', async () => {
    await createAccount({ email: memberEmail });
    await requestReset({ identifier: memberPhone }).expect(202);

    const indexes = await accounts.db.collection('password_resets').indexes();
    const find = (key: object) => indexes.find(index => JSON.stringify(index.key) === JSON.stringify(key));
    expect(find({ token_hash: 1 })?.unique).toBe(true);
    expect(find({ challenge_hash: 1 })?.unique).toBe(true);
    expect(find({ account_id: 1, created_at: 1 })).toBeDefined();
    expect(find({ expires_at: 1 })?.expireAfterSeconds).toEqual(expect.any(Number));
  });

  // Mục 4.2.6 báo cáo: id bắt buộc, unique và bằng _id (bổ sung theo review bước 1).
  it('US-05-TC01: password_resets có index unique cho id', async () => {
    await createAccount({ email: memberEmail });
    await requestReset({ identifier: memberPhone }).expect(202);

    const indexes = await accounts.db.collection('password_resets').indexes();
    const idIndex = indexes.find(index => JSON.stringify(index.key) === JSON.stringify({ id: 1 }));
    expect(idIndex?.unique).toBe(true);
  });

  // Đầu ra bước 1: "thêm revision, index và rate counter bằng migration có thể chạy lại".
  // Lệnh migration dùng lệnh ensure-indexes đã có của repo; lệnh này đọc code trong dist nên test build trước.
  it('US-05-TC01: migration ensure-indexes chạy 2 lần đều thành công, account cũ có recovery_revision = 0', async () => {
    const build = await runProcess([require.resolve('@nestjs/cli/bin/nest.js'), 'build'], {});
    expect(build).toMatchObject({ code: 0 });
    const id = await createAccount({ email: memberEmail });
    // Giả lập account tạo trước US-05: chưa có field recovery_revision.
    await accounts.collection.updateOne({ _id: id }, { $unset: { recovery_revision: '' } });

    const first = await runProcess(['scripts/admin.cjs', 'ensure-indexes'], {});
    const second = await runProcess(['scripts/admin.cjs', 'ensure-indexes'], {});

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect((await readAccount(id)).recovery_revision).toBe(0);
    const resetIndexes = await accounts.db.collection('password_resets').indexes();
    expect(resetIndexes.some(index => JSON.stringify(index.key) === JSON.stringify({ challenge_hash: 1 }))).toBe(true);
  }, 240000);

  // ---------- US-05-TC02: account không có / email trống / LOCKED ----------

  describe('US-05-TC02: account không đủ điều kiện vẫn nhận phản hồi giống hệt', () => {
    const cases: { name: string; identifier: string; setup: () => Promise<Types.ObjectId | undefined> }[] = [
      { name: 'phone không tồn tại', identifier: '0911111111', setup: async () => undefined },
      { name: 'email không tồn tại', identifier: 'khong.ton.tai@example.com', setup: async () => undefined },
      { name: 'account không có email', identifier: memberPhone, setup: () => createAccount() },
      {
        name: 'account có email là chuỗi rỗng', identifier: memberPhone,
        setup: async () => {
          const id = await createAccount();
          await accounts.collection.updateOne({ _id: id }, { $set: { email: '' } });
          return id;
        },
      },
      { name: 'account LOCKED có email', identifier: memberPhone, setup: () => createAccount({ email: memberEmail, status: 'LOCKED' }) },
    ];

    it.each(cases)('US-05-TC02: $name trả 202, cùng message và cùng dạng challenge, không tạo record', async ({ identifier, setup }) => {
      const id = await setup();
      const before = id ? await readAccount(id) : undefined;
      // Account đủ điều kiện để so sánh dạng phản hồi.
      await createAccount({ phone: '0902222222', email: 'eligible.us05@example.com' });
      const eligible = await requestReset({ identifier: '0902222222' });
      await accounts.db.collection('password_resets').deleteMany({});

      const response = await requestReset({ identifier });

      expectPublicAccepted(response);
      expect(Object.keys(response.body).sort()).toEqual(Object.keys(eligible.body).sort());
      expect(response.body.message).toBe(eligible.body.message);
      expect(response.body.challenge.length).toBe(eligible.body.challenge.length);
      expect(response.body.challenge).not.toBe(eligible.body.challenge);
      expect(await readResets()).toHaveLength(0);
      if (id) {
        const after = await readAccount(id);
        expect(after.recovery_revision).toBe(before!.recovery_revision);
        expect(after.status).toBe(before!.status);
      }
    });
  });

  // Spec 1.1, F03: mọi phản hồi 202 mất tối thiểu 200 ms tính từ lúc nhận request, để thời gian không lộ account.
  // Test đo từ lúc gửi tới lúc nhận nên luôn ≥ thời gian server xử lý; chỉ kiểm tra cận dưới để không chập chờn.
  describe('US-05-TC02: thời gian phản hồi 202 tối thiểu 200 ms', () => {
    const timingCases: { name: string; identifier: string; setup: () => Promise<unknown> }[] = [
      { name: 'account hợp lệ (chạy transaction)', identifier: memberPhone, setup: () => createAccount({ email: memberEmail }) },
      { name: 'phone không tồn tại', identifier: '0911111111', setup: async () => undefined },
      { name: 'account LOCKED', identifier: memberPhone, setup: () => createAccount({ email: memberEmail, status: 'LOCKED' }) },
      { name: 'account không có email', identifier: memberPhone, setup: () => createAccount() },
    ];

    it.each(timingCases)('US-05-TC02: $name trả 202 sau ít nhất 200 ms', async ({ identifier, setup }) => {
      await setup();

      const startedAt = Date.now();
      const response = await requestReset({ identifier });
      const elapsed = Date.now() - startedAt;

      expectPublicAccepted(response);
      expect(elapsed).toBeGreaterThanOrEqual(200);
    });
  });

  it('US-05-TC02: hai lần hỏi cho account không tồn tại trả hai challenge ngẫu nhiên khác nhau', async () => {
    const first = await requestReset({ identifier: '0911111111' });
    const second = await requestReset({ identifier: '0911111112' });

    expectPublicAccepted(first);
    expectPublicAccepted(second);
    expect(second.body.challenge).not.toBe(first.body.challenge);
  });

  // ---------- US-05-TC03: resend trước 60 giây, đổi phone/email, vượt 3/định danh/10 phút ----------

  it('US-05-TC03: hỏi lại bằng cùng phone trước 60 giây trả 202 chung, không tạo mã mới', async () => {
    const id = await createAccount({ email: memberEmail });
    await requestReset({ identifier: memberPhone }).expect(202);
    const [firstReset] = await readResets();
    const before = await readAccount(id);

    await pretendSecondsPassed(30);
    const response = await requestReset({ identifier: memberPhone });

    expectPublicAccepted(response);
    const resets = await readResets();
    expect(resets).toHaveLength(1);
    expect(resets[0].token_hash).toBe(firstReset.token_hash);
    expect(resets[0].invalidated_at).toBeUndefined();
    expect((await readAccount(id)).recovery_revision).toBe(before.recovery_revision);
  });

  it('US-05-TC03: resend kèm challenge trước 60 giây trả 202, echo đúng challenge và giữ mã đang có hiệu lực', async () => {
    const id = await createAccount({ email: memberEmail });
    const first = await requestReset({ identifier: memberPhone });
    const [firstReset] = await readResets();
    const before = await readAccount(id);

    await pretendSecondsPassed(30);
    const response = await requestReset({ identifier: memberPhone, challenge: first.body.challenge });

    expectPublicAccepted(response);
    expect(response.body.challenge).toBe(first.body.challenge);
    const resets = await readResets();
    expect(resets).toHaveLength(1);
    expect(resets[0].token_hash).toBe(firstReset.token_hash);
    expect(resets[0].expires_at.getTime()).toBe(firstReset.expires_at.getTime() - 30 * 1000);
    expect((await readAccount(id)).recovery_revision).toBe(before.recovery_revision);
  });

  it('US-05-TC03: đổi từ phone sang email trước 60 giây vẫn bị chặn, không tạo mã mới', async () => {
    const id = await createAccount({ email: memberEmail });
    await requestReset({ identifier: memberPhone }).expect(202);
    const [firstReset] = await readResets();
    const before = await readAccount(id);

    await pretendSecondsPassed(30);
    const response = await requestReset({ identifier: memberEmail });

    expectPublicAccepted(response);
    const resets = await readResets();
    expect(resets).toHaveLength(1);
    expect(resets[0].token_hash).toBe(firstReset.token_hash);
    expect((await readAccount(id)).recovery_revision).toBe(before.recovery_revision);
  });

  it('US-05-TC03: đổi từ email sang phone trước 60 giây vẫn bị chặn, không tạo mã mới', async () => {
    const id = await createAccount({ email: memberEmail });
    await requestReset({ identifier: memberEmail }).expect(202);
    const before = await readAccount(id);

    await pretendSecondsPassed(30);
    const response = await requestReset({ identifier: memberPhone });

    expectPublicAccepted(response);
    expect(await readResets()).toHaveLength(1);
    expect((await readAccount(id)).recovery_revision).toBe(before.recovery_revision);
  });

  // Ca đối chứng của cooldown: sau đủ 60 giây thì flow mới được chấp nhận và tăng revision.
  it('US-05-TC03: sau hơn 60 giây, flow mới được tạo với challenge mới và recovery_revision tăng', async () => {
    const id = await createAccount({ email: memberEmail });
    const first = await requestReset({ identifier: memberPhone });

    await pretendSecondsPassed(61);
    const second = await requestReset({ identifier: memberPhone });

    expectPublicAccepted(second);
    expect(second.body.challenge).not.toBe(first.body.challenge);
    const account = await readAccount(id);
    expect(account.recovery_revision).toBe(2);
    const newest = (await readResets()).sort((a, b) => b.created_at - a.created_at)[0];
    expect(newest.recovery_revision_snapshot).toBe(2);
  });

  it('US-05-TC03: resend kèm challenge sau hơn 60 giây giữ challenge và record, thay mã, reset attempts, tăng revision', async () => {
    const id = await createAccount({ email: memberEmail });
    const first = await requestReset({ identifier: memberPhone });
    const [firstReset] = await readResets();
    await accounts.db.collection('password_resets').updateOne({ _id: firstReset._id }, { $set: { attempts: 2 } });

    await pretendSecondsPassed(61);
    const response = await requestReset({ identifier: memberPhone, challenge: first.body.challenge });

    expectPublicAccepted(response);
    expect(response.body.challenge).toBe(first.body.challenge);
    const resets = await readResets();
    expect(resets).toHaveLength(1);
    expect(resets[0]._id.equals(firstReset._id)).toBe(true);
    expect(resets[0].challenge_hash).toBe(firstReset.challenge_hash);
    expect(resets[0].token_hash).not.toBe(firstReset.token_hash);
    expect(resets[0].attempts).toBe(0);
    expect(resets[0].expires_at.getTime()).toBeGreaterThan(firstReset.expires_at.getTime());
    const account = await readAccount(id);
    expect(account.recovery_revision).toBe(2);
    expect(resets[0].recovery_revision_snapshot).toBe(2);
  });

  it('US-05-TC03: resend với challenge đúng cú pháp nhưng không có flow trả 202, echo challenge, không đổi dữ liệu', async () => {
    const id = await createAccount({ email: memberEmail });
    const fakeChallenge = await unknownButValidChallenge();
    await pretendSecondsPassed(61);
    const before = await readAccount(id);

    const response = await requestReset({ identifier: memberPhone, challenge: fakeChallenge });

    expectPublicAccepted(response);
    expect(response.body.challenge).toBe(fakeChallenge);
    expect(await readResets()).toHaveLength(0);
    expect((await readAccount(id)).recovery_revision).toBe(before.recovery_revision);
  });

  it('US-05-TC03: resend với challenge của flow đã dùng trả 202, echo challenge, không thay mã', async () => {
    const id = await createAccount({ email: memberEmail });
    const first = await requestReset({ identifier: memberPhone });
    const [firstReset] = await readResets();
    await accounts.db.collection('password_resets').updateOne({ _id: firstReset._id }, { $set: { used_at: new Date() } });
    await pretendSecondsPassed(61);
    const before = await readAccount(id);

    const response = await requestReset({ identifier: memberPhone, challenge: first.body.challenge });

    expectPublicAccepted(response);
    expect(response.body.challenge).toBe(first.body.challenge);
    const resets = await readResets();
    expect(resets).toHaveLength(1);
    expect(resets[0].token_hash).toBe(firstReset.token_hash);
    expect((await readAccount(id)).recovery_revision).toBe(before.recovery_revision);
  });

  it('US-05-TC03: resend với challenge của flow đã bị vô hiệu hóa trả 202, echo challenge, không thay mã', async () => {
    const id = await createAccount({ email: memberEmail });
    const first = await requestReset({ identifier: memberPhone });
    const [firstReset] = await readResets();
    await accounts.db.collection('password_resets').updateOne({ _id: firstReset._id }, { $set: { invalidated_at: new Date() } });
    await pretendSecondsPassed(61);
    const before = await readAccount(id);

    const response = await requestReset({ identifier: memberPhone, challenge: first.body.challenge });

    expectPublicAccepted(response);
    expect(response.body.challenge).toBe(first.body.challenge);
    expect((await readResets())[0].token_hash).toBe(firstReset.token_hash);
    expect((await readAccount(id)).recovery_revision).toBe(before.recovery_revision);
  });

  // F04: tối đa 3 request/định danh/10 phút. Lần 4 (đã qua cooldown 60 giây) vẫn 202 chung nhưng không tạo mã.
  it('US-05-TC03: request thứ 4 cùng định danh trong 10 phút trả 202 chung, không tạo mã mới', async () => {
    const id = await createAccount({ email: memberEmail });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expectPublicAccepted(await requestReset({ identifier: memberPhone }));
      await pretendSecondsPassed(61);
    }
    const resetsBefore = await readResets();
    const before = await readAccount(id);
    expect(before.recovery_revision).toBe(3);

    const response = await requestReset({ identifier: memberPhone });

    expectPublicAccepted(response);
    const resetsAfter = await readResets();
    expect(resetsAfter).toHaveLength(resetsBefore.length);
    expect(resetsAfter.map(reset => reset.token_hash).sort()).toEqual(resetsBefore.map(reset => reset.token_hash).sort());
    expect((await readAccount(id)).recovery_revision).toBe(3);
  });

  // ---------- US-05-TC04: vượt ngưỡng IP và nhiều instance ----------

  // F04: tối đa 10 request/IP/10 phút; vượt thì 429 kèm Retry-After. Mỗi request dùng định danh khác để không chạm giới hạn định danh.
  it('US-05-TC04: request thứ 11 từ cùng IP trong 10 phút bị 429 có Retry-After, account không bị khóa', async () => {
    const id = await createAccount({ email: memberEmail });
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expectPublicAccepted(await requestReset({ identifier: `09100000${String(attempt).padStart(2, '0')}` }));
    }

    expectRateLimited(await requestReset({ identifier: memberPhone }));

    const account = await readAccount(id);
    expect(account.status).toBe('ACTIVE');
    expect(await readResets()).toHaveLength(0);
  });

  it('US-05-TC04: counter IP dùng chung giữa hai app instance', async () => {
    const { AppModule } = await import('../src/app.module');
    // Instance thứ hai đóng ở afterAll: đóng sớm sẽ làm mất kết nối DB của app chính trong cùng tiến trình test.
    secondApp = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(secondApp);
    await secondApp.init();

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const target = attempt % 2 === 0 ? secondApp : app;
      expectPublicAccepted(await requestReset({ identifier: `09200000${String(attempt).padStart(2, '0')}` }, target));
    }

    expectRateLimited(await requestReset({ identifier: '0920000011' }, secondApp));
    expectRateLimited(await requestReset({ identifier: '0920000012' }, app));
  });

  // Bảng "auth_rate_limits mới": counter lưu trong MongoDB, key là HMAC nên không chứa phone/email/IP thô.
  it('US-05-TC04: counter lưu trong auth_rate_limits và không chứa phone, email hoặc IP thô', async () => {
    await createAccount({ email: memberEmail });
    await requestReset({ identifier: memberPhone }).expect(202);
    await requestReset({ identifier: memberEmail }).expect(202);

    const limits = await readRateLimits();
    expect(limits.length).toBeGreaterThan(0);
    const stored = JSON.stringify(limits);
    expect(stored).not.toContain(memberPhone);
    expect(stored).not.toContain(memberEmail);
    expect(stored).not.toContain('127.0.0.1');
    for (const limit of limits) {
      expect(typeof limit.key).toBe('string');
      expect(Number.isInteger(limit.count)).toBe(true);
      expect(limit.expires_at).toBeInstanceOf(Date);
    }
  });

  it('US-05-TC04: auth_rate_limits có index unique theo key và TTL theo expires_at', async () => {
    await requestReset({ identifier: memberPhone }).expect(202);

    const indexes = await accounts.db.collection('auth_rate_limits').indexes();
    expect(indexes.some(index => index.unique === true && Object.keys(index.key).includes('key'))).toBe(true);
    expect(indexes.some(index => JSON.stringify(index.key) === JSON.stringify({ expires_at: 1 }) && typeof index.expireAfterSeconds === 'number')).toBe(true);
  });

  // ---------- US-05-TC15: dữ liệu gửi lên sai (phần request) ----------

  describe('US-05-TC15: body sai cú pháp trả 400 VALIDATION_ERROR, không tạo record', () => {
    const invalidBodies: { name: string; body: object }[] = [
      { name: 'thiếu identifier', body: {} },
      { name: 'identifier là số', body: { identifier: 901234567 } },
      { name: 'identifier là mảng', body: { identifier: [memberPhone] } },
      { name: 'identifier rỗng', body: { identifier: '' } },
      { name: 'identifier không phải phone hay email', body: { identifier: 'khong phai phone hay email' } },
      { name: 'challenge là số', body: { identifier: memberPhone, challenge: 12345 } },
      { name: 'challenge sai cú pháp', body: { identifier: memberPhone, challenge: 'abc' } },
      { name: 'field thừa accountId', body: { identifier: memberPhone, accountId: new Types.ObjectId().toHexString() } },
      { name: 'field thừa role', body: { identifier: memberPhone, role: 'ADMIN' } },
      // F01: không gửi tới email mới do request cung cấp.
      { name: 'field thừa email', body: { identifier: memberPhone, email: 'ke.gian@example.com' } },
    ];

    it.each(invalidBodies)('US-05-TC15: $name', async ({ body }) => {
      const id = await createAccount({ email: memberEmail });
      const before = await readAccount(id);

      const response = await requestReset(body);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(await readResets()).toHaveLength(0);
      expect((await readAccount(id)).recovery_revision).toBe(before.recovery_revision);
    });
  });

  // F03: "Cú pháp đầu vào sai vẫn 400 như nhau" – lỗi giống hệt dù account có tồn tại hay không.
  it('US-05-TC15: lỗi 400 giống hệt nhau giữa account tồn tại và không tồn tại', async () => {
    await createAccount({ email: memberEmail });

    const existing = await requestReset({ identifier: memberPhone, accountId: 'x' });
    const missing = await requestReset({ identifier: '0933333333', accountId: 'x' });

    expect(existing.status).toBe(400);
    expect(missing.status).toBe(400);
    expect(existing.body.error).toEqual(missing.body.error);
  });
});
