// Tầng kiểm thử backend (Jest, MongoDB replica set trong bộ nhớ + hộp thư SMTP sandbox thật): US-05 bước 2.
// Bước 2 gửi OTP qua SMTP SAU phản hồi 202, không gửi trong transaction: TC01 (phần thư), TC02/TC03 (không gửi thư), TC05, TC14.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Model, Types } from 'mongoose';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { Account } from '../src/modules/users/schemas/account.schema';
import { UsersRepository } from '../src/modules/users/users.repository';
import { extractOtp, SandboxMail, SmtpSandbox } from './helpers/smtp-sandbox';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us05_email';
const memberPhone = '0901234567';
const memberEmail = 'member.us05@example.com';
const pepper = randomBytes(32).toString('base64url');

describe('US-05 quên mật khẩu – bước 2: gửi OTP qua SMTP sau phản hồi', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let accounts: Model<Account>;
  const smtp = new SmtpSandbox();
  const savedEnv = { ...process.env };
  // Mọi dòng log trong lúc chạy test (console và stdout/stderr), để kiểm tra không lộ OTP/challenge.
  let logs: string[] = [];
  // Riêng log ghi qua console (cách cả dự án đang ghi log), dùng để kiểm tra "có log". Không đếm stdout vì Jest cũng ghi vào đó.
  let consoleLogs: string[] = [];

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
      RESET_OTP_PEPPER: pepper,
      ...smtp.env(),
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    accounts = app.get<Model<Account>>(getModelToken('Account'));
  }, 600000);

  beforeEach(async () => {
    if (!smtp.running) await smtp.start();
    smtp.clear();
    logs = [];
    consoleLogs = [];
    captureLogs();
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

  // Ghi lại mọi log (không in ra màn hình) để test đọc lại.
  function captureLogs() {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        const line = args.map(String).join(' ');
        logs.push(line);
        consoleLogs.push(line);
      });
    }
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        logs.push(String(chunk));
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
  }

  async function createAccount(options: { phone?: string; email?: string; status?: 'ACTIVE' | 'LOCKED' } = {}) {
    const repository = app.get(UsersRepository);
    const role = await repository.ensureRole('MEMBER', 'MEMBER');
    const passwordHash = await app.get(PasswordService).hash('MậtKhẩuUS-05-123');
    const account = await repository.createAccount({
      roleId: role.id.toHexString(), phone: options.phone ?? memberPhone, fullName: 'US05 Test', passwordHash, email: options.email,
    });
    if (options.status === 'LOCKED') await accounts.collection.updateOne({ _id: account._id }, { $set: { status: 'LOCKED' } });
    return account._id;
  }

  function requestReset(body: object) {
    return request(app.getHttpServer()).post('/api/auth/password-reset/request').set('Origin', origin).send(body);
  }

  function readResets() {
    return accounts.db.collection('password_resets').find().toArray() as Promise<Record<string, any>[]>;
  }

  // Giống file bước 1: lùi các mốc thời gian trong DB để giả lập đã qua `seconds` giây.
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

  function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Đọc OTP trong thư; test hỏng ngay nếu thư không có đúng một mã 6 chữ số.
  function otpOf(mail: SandboxMail): string {
    const otp = extractOtp(mail);
    expect(otp).toMatch(/^\d{6}$/);
    return otp!;
  }

  // Bảng "Lưu mã": token_hash = HMAC-SHA256(RESET_OTP_PEPPER, challenge|otp). Spec không nói kết quả mã hóa hex hay base64,
  // nên chấp nhận cả ba cách viết phổ biến của cùng một giá trị HMAC.
  function expectedTokenHashes(challenge: string, otp: string): string[] {
    const digest = createHmac('sha256', pepper).update(`${challenge}|${otp}`).digest();
    return [digest.toString('hex'), digest.toString('base64'), digest.toString('base64url')];
  }

  // Log không được chứa bí mật hay thông tin nhận diện account.
  function expectLogsSafe(secrets: string[]) {
    const all = logs.join('\n');
    for (const secret of [...secrets, pepper, smtp.pass]) expect(all).not.toContain(secret);
  }

  // ---------- US-05-TC01: thư gửi đúng email đã lưu ----------

  it('US-05-TC01: yêu cầu bằng phone gửi đúng 1 thư tới email đã lưu, từ SMTP_FROM, đăng nhập bằng SMTP_USER', async () => {
    await createAccount({ email: memberEmail });

    await requestReset({ identifier: memberPhone }).expect(202);

    const [mail] = await smtp.waitForMessages(1);
    await wait(500);
    expect(smtp.messages).toHaveLength(1);
    expect(mail.envelopeTo).toEqual([memberEmail]);
    expect(mail.headerTo).toEqual([memberEmail]);
    expect(mail.envelopeFrom).toBe(smtp.from);
    expect(mail.authUser).toBe(smtp.user);
  });

  it('US-05-TC01: yêu cầu bằng email gửi thư tới đúng email đã lưu', async () => {
    await createAccount({ email: memberEmail });

    await requestReset({ identifier: memberEmail }).expect(202);

    const [mail] = await smtp.waitForMessages(1);
    expect(mail.envelopeTo).toEqual([memberEmail]);
  });

  // Mục 2 spec: "Nội dung thư chỉ nêu mã, hạn 10 phút và hướng dẫn bỏ qua khi không yêu cầu".
  it('US-05-TC01: thư nêu mã 6 chữ số, hạn 10 phút, hướng dẫn bỏ qua; không chứa challenge, phone, accountId', async () => {
    const id = await createAccount({ email: memberEmail });

    const response = await requestReset({ identifier: memberPhone }).expect(202);

    const [mail] = await smtp.waitForMessages(1);
    otpOf(mail);
    expect(mail.text).toContain('10 phút');
    expect(mail.text.toLowerCase()).toContain('bỏ qua');
    for (const content of [mail.text, mail.subject, mail.raw]) {
      expect(content).not.toContain(response.body.challenge);
      expect(content).not.toContain(memberPhone);
      expect(content).not.toContain(id.toHexString());
    }
  });

  // ---------- US-05-TC02: account không đủ điều kiện thì không gửi thư ----------

  describe('US-05-TC02: account không đủ điều kiện không nhận thư nào', () => {
    const cases: { name: string; identifier: string; setup: () => Promise<unknown> }[] = [
      { name: 'phone không tồn tại', identifier: '0911111111', setup: async () => undefined },
      { name: 'email không tồn tại', identifier: 'khong.ton.tai@example.com', setup: async () => undefined },
      { name: 'account không có email', identifier: memberPhone, setup: () => createAccount() },
      { name: 'account LOCKED có email', identifier: memberPhone, setup: () => createAccount({ email: memberEmail, status: 'LOCKED' }) },
    ];

    it.each(cases)('US-05-TC02: $name trả 202 và không gửi thư', async ({ identifier, setup }) => {
      await setup();

      await requestReset({ identifier }).expect(202);

      await wait(1000);
      expect(smtp.messages).toHaveLength(0);
      expect(smtp.rejected).toHaveLength(0);
    });
  });

  // ---------- US-05-TC03: không gửi thêm khi bị cooldown hoặc vượt giới hạn ----------

  it('US-05-TC03: hỏi lại bằng cùng phone trước 60 giây không gửi thêm thư', async () => {
    await createAccount({ email: memberEmail });
    await requestReset({ identifier: memberPhone }).expect(202);
    await smtp.waitForMessages(1);

    await pretendSecondsPassed(30);
    await requestReset({ identifier: memberPhone }).expect(202);

    await wait(1000);
    expect(smtp.messages).toHaveLength(1);
  });

  it('US-05-TC03: đổi từ phone sang email trước 60 giây không gửi thêm thư', async () => {
    await createAccount({ email: memberEmail });
    await requestReset({ identifier: memberPhone }).expect(202);
    await smtp.waitForMessages(1);

    await pretendSecondsPassed(30);
    await requestReset({ identifier: memberEmail }).expect(202);

    await wait(1000);
    expect(smtp.messages).toHaveLength(1);
  });

  it('US-05-TC03: resend kèm challenge trước 60 giây không gửi thêm thư', async () => {
    await createAccount({ email: memberEmail });
    const first = await requestReset({ identifier: memberPhone }).expect(202);
    await smtp.waitForMessages(1);

    await pretendSecondsPassed(30);
    await requestReset({ identifier: memberPhone, challenge: first.body.challenge }).expect(202);

    await wait(1000);
    expect(smtp.messages).toHaveLength(1);
  });

  it('US-05-TC03: request thứ 4 cùng định danh trong 10 phút không gửi thêm thư', async () => {
    await createAccount({ email: memberEmail });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await requestReset({ identifier: memberPhone }).expect(202);
      await smtp.waitForMessages(attempt);
      await pretendSecondsPassed(61);
    }

    await requestReset({ identifier: memberPhone }).expect(202);

    await wait(1000);
    expect(smtp.messages).toHaveLength(3);
  });

  // F02: "Resend trong cùng flow giữ challenge, thay OTP sau tối thiểu 60 giây".
  it('US-05-TC03: resend kèm challenge sau hơn 60 giây gửi thư thứ hai với OTP mới khớp token_hash mới', async () => {
    await createAccount({ email: memberEmail });
    const first = await requestReset({ identifier: memberPhone }).expect(202);
    const firstOtp = otpOf((await smtp.waitForMessages(1))[0]);

    await pretendSecondsPassed(61);
    await requestReset({ identifier: memberPhone, challenge: first.body.challenge }).expect(202);

    const mails = await smtp.waitForMessages(2);
    const secondOtp = otpOf(mails[1]);
    expect(mails[1].envelopeTo).toEqual([memberEmail]);
    const [reset] = await readResets();
    expect(expectedTokenHashes(first.body.challenge, secondOtp)).toContain(reset.token_hash);
    expect(expectedTokenHashes(first.body.challenge, firstOtp)).not.toContain(reset.token_hash);
  });

  // ---------- US-05-TC05: không lưu/log OTP thô, HMAC có pepper, giữ số 0 đầu ----------

  it('US-05-TC05: token_hash là HMAC-SHA256(pepper, challenge|otp) của OTP trong thư', async () => {
    await createAccount({ email: memberEmail });

    const response = await requestReset({ identifier: memberPhone }).expect(202);

    const otp = otpOf((await smtp.waitForMessages(1))[0]);
    const [reset] = await readResets();
    expect(expectedTokenHashes(response.body.challenge, otp)).toContain(reset.token_hash);
  });

  it('US-05-TC05: DB không chứa OTP thô ở bất kỳ collection nào', async () => {
    await createAccount({ email: memberEmail });

    await requestReset({ identifier: memberPhone }).expect(202);

    const otp = otpOf((await smtp.waitForMessages(1))[0]);
    for (const collection of await accounts.db.db!.collections()) {
      const documents = await collection.find().toArray();
      expect(JSON.stringify(documents)).not.toContain(otp);
    }
  });

  it('US-05-TC05: log trong lúc yêu cầu và gửi thư không chứa OTP, challenge, email, pepper hay SMTP_PASS', async () => {
    await createAccount({ email: memberEmail });

    const response = await requestReset({ identifier: memberPhone }).expect(202);

    const otp = otpOf((await smtp.waitForMessages(1))[0]);
    await wait(300);
    expectLogsSafe([otp, response.body.challenge, memberEmail]);
  });

  // OTP là số ngẫu nhiên nên không chọn trước được mã có số 0 đầu. Test tạo nhiều account cho tới khi gặp một mã
  // bắt đầu bằng 0 (mỗi lần có 10% khả năng; 60 lần thì xác suất không gặp chỉ khoảng 0,2%).
  it('US-05-TC05: OTP có số 0 ở đầu vẫn đủ 6 ký tự trong thư và trong token_hash', async () => {
    let found: { otp: string; challenge: string; accountId: Types.ObjectId } | undefined;
    for (let attempt = 0; attempt < 60 && !found; attempt += 1) {
      const phone = `0940${String(attempt).padStart(6, '0')}`;
      const email = `zero.${attempt}@example.com`;
      const accountId = await createAccount({ phone, email });
      // Xóa counter giới hạn để 60 lần thử không bị chặn bởi giới hạn IP.
      await accounts.db.collection('auth_rate_limits').deleteMany({});
      const response = await requestReset({ identifier: phone }).expect(202);
      const mails = await smtp.waitForMessages(attempt + 1);
      const otp = otpOf(mails[attempt]);
      if (otp.startsWith('0')) found = { otp, challenge: response.body.challenge, accountId };
    }

    expect(found).toBeDefined();
    expect(found!.otp).toHaveLength(6);
    const reset = (await readResets()).find(item => item.account_id.equals(found!.accountId))!;
    expect(expectedTokenHashes(found!.challenge, found!.otp)).toContain(reset.token_hash);
  }, 180000);

  // Thứ tự triển khai bước 2: "env.example không có credential thật".
  it('US-05-TC05: .env.example có đủ biến SMTP và để trống mật khẩu, pepper', () => {
    const content = readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    const values = new Map(content.split(/\r?\n/)
      .filter(line => /^[A-Z_]+=/.test(line))
      .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]));

    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'RESET_OTP_PEPPER']) {
      expect(values.has(key)).toBe(true);
    }
    expect(values.get('SMTP_PASS')).toBe('');
    expect(values.get('RESET_OTP_PEPPER')).toBe('');
  });

  // ---------- US-05-TC14: SMTP chậm, lỗi hoặc không chạy ----------

  // F03 và bước 2: SMTP chạy sau phản hồi, không trong transaction, nên SMTP chậm không làm chậm 202.
  it('US-05-TC14: SMTP chậm 3 giây không làm chậm phản hồi 202; record đã lưu trước khi thư tới', async () => {
    await createAccount({ email: memberEmail });
    smtp.mode = 'slow';
    smtp.slowMs = 3000;

    const startedAt = Date.now();
    const response = await requestReset({ identifier: memberPhone });
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(202);
    expect(elapsed).toBeLessThan(1500);
    expect(await readResets()).toHaveLength(1);
    expect(smtp.messages).toHaveLength(0);
    // Chờ thư tới hẳn để không lẫn sang test sau.
    await smtp.waitForMessages(1, 10000);
  }, 30000);

  it('US-05-TC14: SMTP từ chối thư vẫn trả 202 như thường, có log nhưng log không lộ OTP, challenge, email', async () => {
    await createAccount({ email: memberEmail });
    smtp.mode = 'reject';

    const response = await requestReset({ identifier: memberPhone });

    expect(response.status).toBe(202);
    expect(Object.keys(response.body).sort()).toEqual(['challenge', 'message']);
    const [rejected] = await smtp.waitForRejected(1);
    const otp = otpOf(rejected);
    await wait(1000);
    expect(consoleLogs.length).toBeGreaterThan(0);
    expectLogsSafe([otp, response.body.challenge, memberEmail]);
  });

  it('US-05-TC14: SMTP không chạy vẫn trả 202, có log an toàn; sau cooldown yêu cầu lại thì nhận thư mới, không phát lại mã cũ', async () => {
    await createAccount({ email: memberEmail });
    await smtp.stop();

    const first = await requestReset({ identifier: memberPhone });

    expect(first.status).toBe(202);
    await wait(1500);
    expect(consoleLogs.length).toBeGreaterThan(0);
    expectLogsSafe([first.body.challenge, memberEmail]);

    // SMTP chạy lại; qua cooldown 60 giây thì người dùng mở flow mới.
    await smtp.start();
    await pretendSecondsPassed(61);
    const second = await requestReset({ identifier: memberPhone }).expect(202);

    const [mail] = await smtp.waitForMessages(1);
    await wait(500);
    expect(smtp.messages).toHaveLength(1);
    const otp = otpOf(mail);
    const newest = (await readResets()).sort((a, b) => b.created_at - a.created_at)[0];
    expect(expectedTokenHashes(second.body.challenge, otp)).toContain(newest.token_hash);
  }, 30000);
});
