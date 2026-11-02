// Tầng kiểm thử backend (Jest, MongoDB thật chạy trong bộ nhớ): gọi API đổi mật khẩu của US-67.
// File này chứa các TC của bước 1 (TC02, TC03, TC04): kiểm tra chủ thể, mật khẩu hiện tại và policy.
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

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us67';
const memberPhone = '0901234567';
const otherPhone = '0907654321';
const currentPassword = 'Mật khẩu US-67 123';
const validNewPassword = 'Mật khẩu mới US-67 456';

describe('US-67 đổi mật khẩu - bước 1', () => {
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

  it('US-67-TC03: mật khẩu hiện tại có khoảng trắng gửi đúng nguyên văn thì được chấp nhận', async () => {
    const spaced = '  Mật khẩu có khoảng trắng  ';
    const { token } = await createAndLogin('MEMBER', spaced);

    // Dùng lại chính mật khẩu đó: PASSWORD_UNCHANGED chứng tỏ current đã verify đúng mà chưa cần ghi DB.
    const response = await changePassword(token, { currentPassword: spaced, newPassword: spaced });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('PASSWORD_UNCHANGED');
  });

  it.each([
    ['chỉ thêm khoảng trắng hai đầu', currentPassword, `  ${currentPassword}  `],
    ['chỉ khác dạng chuẩn hóa Unicode', currentPassword.normalize('NFC'), currentPassword.normalize('NFD')],
  ])('US-67-TC03: mật khẩu mới %s là mật khẩu khác, không bị PASSWORD_UNCHANGED', async (_label, oldPassword, newPassword) => {
    const { token } = await createAndLogin('MEMBER', oldPassword);

    const response = await changePassword(token, { currentPassword: oldPassword, newPassword });

    expect(response.status).not.toBe(404); // Endpoint phải tồn tại thì kết quả bên dưới mới có ý nghĩa.
    expect(response.body.error?.code).not.toBe('PASSWORD_UNCHANGED');
    expect(response.body.error?.code).not.toBe('VALIDATION_ERROR');
  });

  // Spec 1.1, F02: mật khẩu mới chỉ gồm khoảng trắng bị từ chối.
  it.each([
    ['12 dấu cách', ' '.repeat(12)],
    ['dấu cách, tab và xuống dòng', ' \t\n'.repeat(4)],
    ['12 khoảng trắng Unicode', '　'.repeat(12)],
  ])('US-67-TC03: mật khẩu mới chỉ gồm %s bị 400 VALIDATION_ERROR', async (_label, newPassword) => {
    const { id, token } = await createAndLogin('MEMBER');
    const before = await readAccount(id);

    const response = await changePassword(token, { currentPassword, newPassword });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await readAccount(id)).toEqual(before);
  });

  // Spec 1.1, F02: khoảng trắng nằm cùng ký tự khác vẫn hợp lệ. Current sai để biết đã qua kiểm tra định dạng.
  it('US-67-TC03: mật khẩu mới có khoảng trắng xen ký tự khác không bị VALIDATION_ERROR', async () => {
    const { token } = await createAndLogin('MEMBER');

    const response = await changePassword(token, { currentPassword: 'Sai mật khẩu hiện tại', newPassword: '   ab   cd   ef' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CURRENT_PASSWORD_INVALID');
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
});
