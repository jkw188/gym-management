// Tầng kiểm thử backend (Jest, MongoDB thật chạy trong bộ nhớ): gọi API đổi mật khẩu của US-67.
// File này chứa các TC của bước 1 (TC02, TC03, TC04): kiểm tra chủ thể, mật khẩu hiện tại và policy.
// Bước 2 thêm TC01, TC06, TC09 và phần lỗi khi ghi của TC11. TC11 chưa phủ mất response, phần đó thuộc giao diện ở bước 3.
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
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { Account } from '../src/modules/users/schemas/account.schema';
import { Role, RoleCode } from '../src/modules/users/schemas/role.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

// Dùng require để lấy đúng object module, nhờ đó jest.spyOn giả lập được lỗi của argon2.
const argon2 = require('argon2');

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us67';
const memberPhone = '0901234567';
const otherPhone = '0907654321';
// Spec 1.2: mật khẩu mới không được chứa khoảng trắng, nên hai hằng số dùng làm mật khẩu mới đều viết liền.
const currentPassword = 'MậtKhẩuUS-67-123';
const validNewPassword = 'MậtKhẩuMớiUS-67-456';

describe('US-67 đổi mật khẩu', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication;
  let accounts: Model<Account>;
  let roles: Model<Role>;
  let repository: UsersRepository;
  let passwords: PasswordService;
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
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    accounts = app.get<Model<Account>>(getModelToken('Account'));
    roles = app.get<Model<Role>>(getModelToken('Role'));
    repository = app.get(UsersRepository);
    passwords = app.get(PasswordService);
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Mỗi test dùng limiter đăng nhập mới để số lần login của test trước không ảnh hưởng test sau.
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    await Promise.all([accounts.deleteMany({}), roles.deleteMany({})]);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  // Tạo tài khoản trong DB rồi đăng nhập thật, trả về id và access token.
  async function createAndLogin(code: RoleCode, password = currentPassword, phone = memberPhone) {
    const role = await repository.ensureRole(code, code);
    const passwordHash = await passwords.hash(password);
    const account = await repository.createAccount({ roleId: role.id.toHexString(), phone, fullName: 'US67 Test', passwordHash });
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ phone, password })
      .expect(200);
    return { id: account.id.toHexString(), token: login.body.accessToken as string };
  }

  function changePassword(token: string, body: object) {
    return request(app.getHttpServer())
      .post('/api/auth/change-password')
      .set('Origin', origin)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function login(password: string, phone = memberPhone) {
    return request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password });
  }

  function changePasswordWithQuery(token: string, body: object, query: Record<string, string>) {
    return changePassword(token, body).query(query);
  }

  function changePasswordWithoutToken(body: object) {
    return request(app.getHttpServer()).post('/api/auth/change-password').set('Origin', origin).send(body);
  }

  function me(token: string) {
    return request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  }

  // Đọc toàn bộ document, gồm cả password_hash, để so sánh trước và sau khi gọi API.
  function readAccount(id: string) {
    return accounts.findById(id).select('+password_hash').orFail().lean();
  }

  // US-67-TC02: current sai hoặc new bằng cũ thì trả 400, password và phiên giữ nguyên.
  describe.each<RoleCode>(['MEMBER', 'TRAINER'])('vai trò %s', code => {
    it('US-67-TC02: mật khẩu hiện tại sai trả 400 CURRENT_PASSWORD_INVALID, password và phiên giữ nguyên', async () => {
      const { id, token } = await createAndLogin(code);
      const before = await readAccount(id);

      const response = await changePassword(token, { currentPassword: 'Sai mật khẩu hiện tại', newPassword: validNewPassword });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('CURRENT_PASSWORD_INVALID');
      expect(await readAccount(id)).toEqual(before);
      await me(token).expect(200);
    });

    it('US-67-TC02: mật khẩu mới bằng mật khẩu cũ trả 400 PASSWORD_UNCHANGED, password và phiên giữ nguyên', async () => {
      const { id, token } = await createAndLogin(code);
      const before = await readAccount(id);

      const response = await changePassword(token, { currentPassword, newPassword: currentPassword });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('PASSWORD_UNCHANGED');
      expect(await readAccount(id)).toEqual(before);
      await me(token).expect(200);
    });
  });

  // US-67-TC03: policy EN-01 là 12–128 ký tự Unicode, tính theo ký tự chứ không theo byte.
  it.each([
    ['11 ký tự', 'a'.repeat(11)],
    ['129 ký tự', 'a'.repeat(129)],
    ['11 emoji', '😀'.repeat(11)],
    ['6 emoji (dài 12 đơn vị UTF-16 nhưng chỉ 6 ký tự)', '😀'.repeat(6)],
    ['129 emoji', '😀'.repeat(129)],
  ])('US-67-TC03: mật khẩu mới %s bị từ chối với VALIDATION_ERROR', async (_label, newPassword) => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readAccount(id);

    const response = await changePassword(token, { currentPassword, newPassword });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await readAccount(id)).toEqual(before);
  });

  // Gửi kèm current sai: nhận CURRENT_PASSWORD_INVALID nghĩa là newPassword đã qua kiểm tra định dạng.
  it.each([
    ['12 ký tự', 'a'.repeat(12)],
    ['128 ký tự', 'a'.repeat(128)],
    ['12 emoji', '😀'.repeat(12)],
    ['128 emoji', '😀'.repeat(128)],
  ])('US-67-TC03: mật khẩu mới %s đúng biên policy nên không bị VALIDATION_ERROR', async (_label, newPassword) => {
    const { token } = await createAndLogin('MEMBER');

    const response = await changePassword(token, { currentPassword: 'Sai mật khẩu hiện tại', newPassword });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CURRENT_PASSWORD_INVALID');
  });

  it('US-67-TC03: mật khẩu hiện tại bị cắt khoảng trắng không còn đúng', async () => {
    const spaced = '  Mật khẩu có khoảng trắng  ';
    const { token } = await createAndLogin('MEMBER', spaced);

    const response = await changePassword(token, { currentPassword: spaced.trim(), newPassword: validNewPassword });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CURRENT_PASSWORD_INVALID');
  });

  // Spec 1.2, F02: tài khoản cũ có mật khẩu chứa khoảng trắng vẫn đổi được, current không áp luật khoảng trắng.
  it('US-67-TC03: mật khẩu hiện tại có khoảng trắng gửi đúng nguyên văn thì được chấp nhận', async () => {
    const spaced = '  Mật khẩu có khoảng trắng  ';
    const { token } = await createAndLogin('MEMBER', spaced);

    const response = await changePassword(token, { currentPassword: spaced, newPassword: validNewPassword });

    expect(response.status).toBe(200);
    await login(validNewPassword).expect(200);
  });

  // Spec 1.2, F02: current sai vì mọi lý do đều trả CURRENT_PASSWORD_INVALID, kể cả sai độ dài policy.
  it.each([
    ['ngắn hơn 12 ký tự', 'a'.repeat(11)],
    ['dài hơn 128 ký tự', 'a'.repeat(129)],
  ])('US-67-TC03: mật khẩu hiện tại %s trả CURRENT_PASSWORD_INVALID', async (_label, wrongCurrent) => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readAccount(id);

    const response = await changePassword(token, { currentPassword: wrongCurrent, newPassword: validNewPassword });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CURRENT_PASSWORD_INVALID');
    expect(await readAccount(id)).toEqual(before);
  });

  it.each([
    ['chỉ bớt khoảng trắng hai đầu so với mật khẩu cũ', `  ${currentPassword}  `, currentPassword],
    ['chỉ khác dạng chuẩn hóa Unicode', currentPassword.normalize('NFC'), currentPassword.normalize('NFD')],
  ])('US-67-TC03: mật khẩu mới %s là mật khẩu khác, không bị PASSWORD_UNCHANGED', async (_label, oldPassword, newPassword) => {
    const { token } = await createAndLogin('MEMBER', oldPassword);

    const response = await changePassword(token, { currentPassword: oldPassword, newPassword });

    expect(response.status).toBe(200);
    await login(newPassword).expect(200);
  });

  // Spec 1.2, F02: mật khẩu mới chứa khoảng trắng ở bất kỳ vị trí nào đều bị từ chối, kể cả khi toàn khoảng trắng.
  it.each([
    ['khoảng trắng ở đầu', ` ${validNewPassword}`],
    ['khoảng trắng ở cuối', `${validNewPassword} `],
    ['khoảng trắng ở giữa', 'MậtKhẩu Mới-US-67'],
    ['tab ở giữa', 'MậtKhẩu\tMới-US-67'],
    ['xuống dòng ở giữa', 'MậtKhẩu\nMới-US-67'],
    ['khoảng trắng Unicode ở giữa', 'MậtKhẩu　Mới-US-67'],
    ['12 dấu cách', ' '.repeat(12)],
    ['dấu cách, tab và xuống dòng', ' \t\n'.repeat(4)],
    ['12 khoảng trắng Unicode', '　'.repeat(12)],
  ])('US-67-TC03: mật khẩu mới có %s bị 400 VALIDATION_ERROR', async (_label, newPassword) => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readAccount(id);

    const response = await changePassword(token, { currentPassword, newPassword });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await readAccount(id)).toEqual(before);
  });

  // Spec 1.1: thiếu field hoặc sai kiểu trả 400 VALIDATION_ERROR.
  it.each<[string, object]>([
    ['thiếu currentPassword', { newPassword: validNewPassword }],
    ['thiếu newPassword', { currentPassword }],
    ['body rỗng', {}],
    ['currentPassword là số', { currentPassword: 123456789012, newPassword: validNewPassword }],
    ['newPassword là số', { currentPassword, newPassword: 123456789012 }],
    ['newPassword là null', { currentPassword, newPassword: null }],
    ['newPassword là mảng', { currentPassword, newPassword: [validNewPassword] }],
  ])('US-67-TC03: %s bị 400 VALIDATION_ERROR', async (_label, body) => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readAccount(id);

    const response = await changePassword(token, body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await readAccount(id)).toEqual(before);
  });

  // US-67-TC04: Staff/Admin không có quyền dùng endpoint này.
  it.each<RoleCode>(['STAFF', 'ADMIN'])('US-67-TC04: %s bị 403 và mật khẩu không đổi', async code => {
    const { id, token } = await createAndLogin(code);
    const before = await readAccount(id);

    const response = await changePassword(token, { currentPassword, newPassword: validNewPassword });

    expect(response.status).toBe(403);
    expect(await readAccount(id)).toEqual(before);
  });

  // Spec 1.1, F01: gửi accountId/userId trên query cũng trả 400, kể cả khi current đúng.
  it.each(['accountId', 'userId'])('US-67-TC04: gửi %s của tài khoản khác trên query bị 400, không đổi hộ', async field => {
    const member = await createAndLogin('MEMBER');
    const other = await createAndLogin('MEMBER', currentPassword, otherPhone);
    const memberBefore = await readAccount(member.id);
    const otherBefore = await readAccount(other.id);

    const response = await changePasswordWithQuery(member.token, { currentPassword, newPassword: validNewPassword }, { [field]: other.id });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await readAccount(member.id)).toEqual(memberBefore);
    expect(await readAccount(other.id)).toEqual(otherBefore);
  });

  // Spec 1.2: accountId trên đường dẫn trả 404, không có route đổi mật khẩu theo id.
  it('US-67-TC04: gửi accountId của tài khoản khác trên đường dẫn bị 404, không đổi hộ', async () => {
    const member = await createAndLogin('MEMBER');
    const other = await createAndLogin('MEMBER', currentPassword, otherPhone);
    const memberBefore = await readAccount(member.id);
    const otherBefore = await readAccount(other.id);

    const response = await request(app.getHttpServer())
      .post(`/api/auth/change-password/${other.id}`)
      .set('Origin', origin)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ currentPassword, newPassword: validNewPassword });

    expect(response.status).toBe(404);
    expect(await readAccount(member.id)).toEqual(memberBefore);
    expect(await readAccount(other.id)).toEqual(otherBefore);
  });

  // Spec 1.1, F01: chỉ session hợp lệ của account ACTIVE mới được gọi.
  it('US-67-TC04: thiếu token bị 401', async () => {
    const response = await changePasswordWithoutToken({ currentPassword, newPassword: validNewPassword });

    expect(response.status).toBe(401);
  });

  it('US-67-TC04: tài khoản LOCKED bị 401 và mật khẩu không đổi', async () => {
    const { id, token } = await createAndLogin('MEMBER');
    await accounts.updateOne({ id: (await readAccount(id)).id }, { status: 'LOCKED' });
    const before = await readAccount(id);

    const response = await changePassword(token, { currentPassword, newPassword: validNewPassword });

    expect(response.status).toBe(401);
    expect(await readAccount(id)).toEqual(before);
  });

  // US-67-TC04: chủ thể chỉ lấy từ phiên đăng nhập, gửi field thừa trên body thì bị từ chối.
  it.each(['accountId', 'userId'])('US-67-TC04: gửi %s của tài khoản khác bị 400, không đổi hộ', async field => {
    const member = await createAndLogin('MEMBER');
    const other = await createAndLogin('MEMBER', currentPassword, otherPhone);
    const memberBefore = await readAccount(member.id);
    const otherBefore = await readAccount(other.id);

    const response = await changePassword(member.token, { currentPassword, newPassword: validNewPassword, [field]: other.id });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await readAccount(member.id)).toEqual(memberBefore);
    expect(await readAccount(other.id)).toEqual(otherBefore);
  });

  it.each([
    ['role', 'ADMIN'],
    ['confirmPassword', validNewPassword],
  ])('US-67-TC04: gửi field thừa %s bị 400 VALIDATION_ERROR', async (field, value) => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readAccount(id);

    const response = await changePassword(token, { currentPassword, newPassword: validNewPassword, [field]: value });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await readAccount(id)).toEqual(before);
  });

  // US-67-TC11 và bảng API dòng 503: DB hoặc bộ băm hỏng thì trả 503 SERVICE_UNAVAILABLE, không báo sai mật khẩu.
  function databaseError() {
    return Object.assign(new Error('private detail'), { name: 'MongoNetworkError' });
  }

  function expectServiceUnavailable(response: request.Response) {
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toMatch(/private detail|mongodb/i);
  }

  it('US-67-TC11: DB lỗi khi đọc mật khẩu trả 503 SERVICE_UNAVAILABLE, mật khẩu và phiên giữ nguyên', async () => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readAccount(id);
    jest.spyOn(repository, 'findCredentialsById').mockRejectedValueOnce(databaseError());

    const response = await changePassword(token, { currentPassword, newPassword: validNewPassword });

    expectServiceUnavailable(response);
    expect(await readAccount(id)).toEqual(before);
    await me(token).expect(200);
  });

  it('US-67-TC11: DB lỗi ngay trong Guard cũng trả 503 SERVICE_UNAVAILABLE', async () => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readAccount(id);
    jest.spyOn(repository, 'findAccountById').mockRejectedValueOnce(databaseError());

    const response = await changePassword(token, { currentPassword, newPassword: validNewPassword });

    expectServiceUnavailable(response);
    expect(await readAccount(id)).toEqual(before);
  });

  it('US-67-TC11: argon2 lỗi khi kiểm tra mật khẩu hiện tại trả 503, không báo sai mật khẩu', async () => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readAccount(id);
    jest.spyOn(argon2, 'verify').mockRejectedValueOnce(new Error('private detail'));

    const response = await changePassword(token, { currentPassword, newPassword: validNewPassword });

    expectServiceUnavailable(response);
    expect(await readAccount(id)).toEqual(before);
    await me(token).expect(200);
  });

  // Mật khẩu mới trùng cũ, lần verify thứ hai hỏng: không được coi là "không trùng" rồi đi tiếp để ghi DB.
  it('US-67-TC11: argon2 lỗi khi so mật khẩu mới với cũ trả 503 và mật khẩu không đổi', async () => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readAccount(id);
    const realVerify = argon2.verify;
    let verifyCount = 0;
    jest.spyOn(argon2, 'verify').mockImplementation(async (...args: unknown[]) => {
      verifyCount += 1;
      if (verifyCount === 2) throw new Error('private detail');
      return realVerify(...args);
    });

    const response = await changePassword(token, { currentPassword, newPassword: currentPassword });

    expectServiceUnavailable(response);
    expect(verifyCount).toBe(2);
    expect(await readAccount(id)).toEqual(before);
  });

  // Spec 1.3: password_hash bị mất hoặc hỏng là lỗi hệ thống, không phải người dùng gõ sai.
  // Dùng accounts.collection để ghi thẳng dữ liệu hỏng vào MongoDB, bỏ qua kiểm tra của schema.
  it.each<[string, object]>([
    ['bị mất', { $unset: { password_hash: '' } }],
    ['đúng tiền tố nhưng nội dung hỏng', { $set: { password_hash: '$argon2id$hong' } }],
    ['không phải Argon2id', { $set: { password_hash: 'khong-phai-argon2id' } }],
  ])('US-67-TC11: password_hash %s trả 503 SERVICE_UNAVAILABLE, không báo sai mật khẩu', async (_label, damage) => {
    const { id, token } = await createAndLogin('MEMBER');
    const { _id } = await readAccount(id);
    await accounts.collection.updateOne({ _id }, damage);
    const before = await readAccount(id);

    const response = await changePassword(token, { currentPassword, newPassword: validNewPassword });

    expectServiceUnavailable(response);
    expect(await readAccount(id)).toEqual(before);
    await me(token).expect(200);
  });

  // --- Bước 2: lệnh ghi CAS ---

  // Đọc document thô vì password_changed_at và recovery_revision do bước 2 thêm vào schema.
  async function readRawAccount(id: string) {
    return (await readAccount(id)) as unknown as Record<string, any>;
  }

  // Giả lập việc khác xảy ra đúng lúc service đã đọc account và đang tạo hash mới, trước khi ghi (F03).
  function runDuringHashing(change: () => Promise<unknown>) {
    const realHash = passwords.hash.bind(passwords);
    jest.spyOn(passwords, 'hash').mockImplementationOnce(async password => {
      await change();
      return realHash(password);
    });
  }

  // US-67-TC01: đổi thành công trả 200, hash mới, version/auth_version tăng 1 và thời gian do server đặt.
  it.each<RoleCode>(['MEMBER', 'TRAINER'])('US-67-TC01: %s đổi mật khẩu thành công', async code => {
    const { id, token } = await createAndLogin(code);
    const before = await readRawAccount(id);
    const startedAt = Date.now();

    const response = await changePassword(token, { currentPassword, newPassword: validNewPassword });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: 'Đã đổi mật khẩu, vui lòng đăng nhập lại', reauthenticationRequired: true });
    expect(response.headers['cache-control']).toBe('no-store');

    const after = await readRawAccount(id);
    expect(after.password_hash).not.toBe(before.password_hash);
    expect(await passwords.verify(after.password_hash, validNewPassword)).toBe(true);
    expect(await passwords.verify(after.password_hash, currentPassword)).toBe(false);
    expect(after.version).toBe(before.version + 1);
    expect(after.auth_version).toBe(before.auth_version + 1);
    expect(after.password_changed_at.getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(after.password_changed_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(startedAt);
  });

  it('US-67-TC01: đăng nhập được bằng mật khẩu mới, không còn đăng nhập được bằng mật khẩu cũ', async () => {
    const { token } = await createAndLogin('MEMBER');

    await changePassword(token, { currentPassword, newPassword: validNewPassword }).expect(200);

    await login(validNewPassword).expect(200);
    await login(currentPassword).expect(401);
  });

  it('US-67-TC01: chỉ đổi thông tin xác thực, không đổi tên, số điện thoại, vai trò và trạng thái', async () => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readRawAccount(id);

    await changePassword(token, { currentPassword, newPassword: validNewPassword }).expect(200);

    const after = await readRawAccount(id);
    expect(after.full_name).toBe(before.full_name);
    expect(after.phone).toBe(before.phone);
    expect(after.role_id).toEqual(before.role_id);
    expect(after.status).toBe(before.status);
  });

  // F03: recovery_revision tăng bằng $inc để mã reset cũ hết hiệu lực; record cũ thiếu field vẫn đổi được.
  it('US-67-TC01: recovery_revision đang có thì tăng thêm 1', async () => {
    const { id, token } = await createAndLogin('MEMBER');
    const { _id } = await readRawAccount(id);
    await accounts.collection.updateOne({ _id }, { $set: { recovery_revision: 7 } });

    await changePassword(token, { currentPassword, newPassword: validNewPassword }).expect(200);

    expect((await readRawAccount(id)).recovery_revision).toBe(8);
  });

  it('US-67-TC01: record cũ thiếu password_changed_at và recovery_revision vẫn đổi được', async () => {
    const { id, token } = await createAndLogin('MEMBER');
    const { _id } = await readRawAccount(id);
    await accounts.collection.updateOne({ _id }, { $unset: { password_changed_at: '', recovery_revision: '' } });

    await changePassword(token, { currentPassword, newPassword: validNewPassword }).expect(200);

    const after = await readRawAccount(id);
    expect(after.recovery_revision).toBe(1);
    expect(after.password_changed_at).toBeInstanceOf(Date);
  });

  // US-67-TC06: hai yêu cầu cùng lúc thì chỉ một yêu cầu được ghi, yêu cầu còn lại không ghi đè.
  it('US-67-TC06: hai yêu cầu đổi mật khẩu đồng thời chỉ có một yêu cầu thành công', async () => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readRawAccount(id);
    const newPasswords = ['MậtKhẩuThứNhất-111', 'MậtKhẩuThứHai-22222'];

    const responses = await Promise.all(newPasswords.map(newPassword => changePassword(token, { currentPassword, newPassword })));

    const statuses = responses.map(response => response.status);
    expect(statuses.filter(status => status === 200)).toHaveLength(1);
    const winner = newPasswords[statuses.indexOf(200)];
    const after = await readRawAccount(id);
    expect(await passwords.verify(after.password_hash, winner)).toBe(true);
    expect(after.auth_version).toBe(before.auth_version + 1);
    expect(after.version).toBe(before.version + 1);
  });

  // Ca chắc chắn xảy ra: yêu cầu kia đã thắng ngay sau khi yêu cầu này đọc account.
  it('US-67-TC06: yêu cầu thua CAS bị 401 và không ghi đè mật khẩu của yêu cầu thắng', async () => {
    const { id, token } = await createAndLogin('MEMBER');
    const { _id } = await readRawAccount(id);
    const winnerHash = await passwords.hash('MậtKhẩuNgườiThắng-1');
    runDuringHashing(() => accounts.collection.updateOne({ _id }, { $set: { password_hash: winnerHash }, $inc: { auth_version: 1, version: 1 } }));

    const response = await changePassword(token, { currentPassword, newPassword: validNewPassword });

    expect(response.status).toBe(401);
    expect((await readRawAccount(id)).password_hash).toBe(winnerHash);
  });

  // US-67-TC09: sửa tên đồng thời không phải thay đổi bảo mật nên không được làm đổi mật khẩu thất bại.
  it('US-67-TC09: sửa tên đồng thời không làm đổi mật khẩu thất bại và tên mới được giữ', async () => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readRawAccount(id);
    runDuringHashing(() => accounts.collection.updateOne({ _id: before._id }, { $set: { full_name: 'Tên Mới' }, $inc: { version: 1 } }));

    const response = await changePassword(token, { currentPassword, newPassword: validNewPassword });

    expect(response.status).toBe(200);
    const after = await readRawAccount(id);
    expect(after.full_name).toBe('Tên Mới');
    expect(after.version).toBe(before.version + 2);
    expect(await passwords.verify(after.password_hash, validNewPassword)).toBe(true);
  });

  // US-67-TC09: khóa tài khoản, đổi role hoặc đổi định danh trước CAS thì lệnh đổi phải thất bại.
  it.each<[string, object]>([
    ['khóa tài khoản', { $set: { status: 'LOCKED' } }],
    ['đổi role hoặc định danh làm auth_version tăng', { $inc: { auth_version: 1 } }],
  ])('US-67-TC09: %s trước CAS khiến đổi mật khẩu bị 401, mật khẩu không đổi', async (_label, securityChange) => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readRawAccount(id);
    runDuringHashing(() => accounts.collection.updateOne({ _id: before._id }, securityChange));

    const response = await changePassword(token, { currentPassword, newPassword: validNewPassword });

    expect(response.status).toBe(401);
    expect((await readRawAccount(id)).password_hash).toBe(before.password_hash);
  });

  // US-67-TC11: lỗi khi tạo hash mới hoặc khi ghi thì trả 503, không báo thành công và không đổi account.
  it('US-67-TC11: argon2 lỗi khi tạo hash mới trả 503, mật khẩu và phiên giữ nguyên', async () => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readAccount(id);
    const hashSpy = jest.spyOn(argon2, 'hash').mockRejectedValueOnce(new Error('private detail'));

    const response = await changePassword(token, { currentPassword, newPassword: validNewPassword });

    expectServiceUnavailable(response);
    expect(hashSpy).toHaveBeenCalledTimes(1); // Bảo đảm 503 này đúng là do lỗi tạo hash, không phải lý do khác.
    expect(await readAccount(id)).toEqual(before);
    await me(token).expect(200);
  });

  // Chặn ở tầng driver MongoDB để test không phụ thuộc tên hàm ghi mà Builder đặt trong repository.
  it('US-67-TC11: DB lỗi khi ghi trả 503 SERVICE_UNAVAILABLE, mật khẩu và phiên giữ nguyên', async () => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readAccount(id);
    const databaseFailure = () => Promise.reject(databaseError());
    const writeSpies = [
      jest.spyOn(accounts.collection, 'findOneAndUpdate').mockImplementation(databaseFailure as never),
      jest.spyOn(accounts.collection, 'updateOne').mockImplementation(databaseFailure as never),
    ];

    const response = await changePassword(token, { currentPassword, newPassword: validNewPassword });

    expectServiceUnavailable(response);
    expect(writeSpies.some(spy => spy.mock.calls.length > 0)).toBe(true);
    writeSpies.forEach(spy => spy.mockRestore());
    expect(await readAccount(id)).toEqual(before);
    await me(token).expect(200);
  });
});
