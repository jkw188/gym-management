// Tầng kiểm thử backend (helper dùng chung cho test US-18 bước 2): dựng app NestJS trên MongoDB replica set thật,
// tạo account đăng nhập thật, hồ sơ hội viên đã/chưa liên kết và một gói GYM 300000đ. Không chứa luật nghiệp vụ.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../../src/common/http/configure-http';
import { PasswordService } from '../../src/common/security/password.service';
import { ServerClock } from '../../src/common/utils/business-date';
import { toVndDecimal } from '../../src/common/utils/vnd-money';
import { ensureFinancialIntegrity } from '../../src/infrastructure/transaction/financial-integrity';
import { TransactionRunner } from '../../src/infrastructure/transaction/transaction-runner';
import { LoginLimiter } from '../../src/modules/auth/login-limiter.service';
import { MembersRepository } from '../../src/modules/members/members.repository';
import { Plan } from '../../src/modules/plans/schemas/plan.schema';
import { UsersRepository } from '../../src/modules/users/users.repository';

export const origin = 'http://localhost:5173';
const password = 'US18 test password 123';

// Hai tài khoản nhận chuyển khoản mẫu cho test (chỉ dữ liệu công khai, không có mật khẩu/credential ngân hàng).
export const TEST_RECEIVING_ACCOUNTS = [
  { code: 'GYM_MAIN', bankName: 'Vietcombank', accountNumber: '0123456789', accountName: 'CONG TY GYM US18' },
  { code: 'GYM_SUB', bankName: 'Techcombank', accountNumber: '9876543210', accountName: 'CONG TY GYM US18' },
];

export type Us18World = {
  app: INestApplication;
  connection: Connection;
  // Token đăng nhập thật. member = account đã liên kết hồ sơ memberId; otherMember = account đã liên kết otherMemberId;
  // unlinked = account MEMBER chưa liên kết hồ sơ nào.
  tokens: { ADMIN: string; STAFF: string; TRAINER: string; member: string; otherMember: string; unlinked: string };
  memberAccountId: Types.ObjectId;
  staffId: Types.ObjectId;
  adminId: Types.ObjectId;
  memberId: string;
  otherMemberId: string;
  plan: Plan;
};

export type Us18App = {
  mongo: MongoMemoryReplSet;
  app: INestApplication;
  // Mọi instance ứng dụng (cùng một database); apps[0] === app.
  apps: INestApplication[];
  connection: Connection;
  savedEnv: NodeJS.ProcessEnv;
  setNow: (value: Date) => void;
};

// Khởi động app. extraEnv dùng để bật/tắt cấu hình tài khoản nhận chuyển khoản.
// instances > 1: dựng thêm instance dùng chung database để kiểm khóa thật giữa hai server (US-18 bước 4).
export async function startUs18App(databaseName: string, extraEnv: Record<string, string>, instances = 1): Promise<Us18App> {
  const savedEnv = { ...process.env };
  const mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
  Object.assign(process.env, {
    NODE_ENV: 'test', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(), MONGODB_DB: databaseName,
    JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
    // Ứng dụng bắt buộc có cấu hình SMTP/pepper khi khởi động (US-05); test này không gửi thư.
    RESET_OTP_PEPPER: randomBytes(32).toString('base64url'), SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525',
    SMTP_SECURE: 'false', SMTP_USER: 'us18', SMTP_PASS: 'us18', SMTP_FROM: 'no-reply@gym.test',
    ...extraEnv,
  });
  // Đồng hồ server cố định: hôm nay theo giờ Việt Nam là 2026-11-01.
  let now = new Date('2026-11-01T03:00:00Z');
  const clock = { now: () => now, today: () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now) };
  const { AppModule } = await import('../../src/app.module');
  const apps: INestApplication[] = [];
  for (let index = 0; index < instances; index++) {
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
    const instance = module.createNestApplication({ logger: false, bodyParser: false });
    configureHttp(instance);
    const instanceConnection = instance.get<Connection>(getConnectionToken());
    await ensureFinancialIntegrity(instanceConnection);
    await instance.init();
    await Promise.all(Object.values(instanceConnection.models).map(model => model.init()));
    apps.push(instance);
  }
  const app = apps[0];
  const connection = app.get<Connection>(getConnectionToken());
  return { mongo, app, apps, connection, savedEnv, setNow: value => { now = value; } };
}

export async function stopUs18App(started: Us18App | undefined) {
  if (!started) return;
  for (const app of started.apps) await app.close();
  await started.mongo.stop();
  process.env = started.savedEnv;
}

// Xóa sạch dữ liệu rồi tạo lại account, hồ sơ và gói cho một test.
export async function seedUs18World(app: INestApplication, connection: Connection): Promise<Us18World> {
  // Bộ giới hạn đăng nhập lưu trong bộ nhớ: mỗi test dùng bộ mới để không bị 429.
  const limiter = new LoginLimiter();
  jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
  for (const collection of await connection.db!.collections()) await collection.deleteMany({});

  const users = app.get(UsersRepository);
  const hash = await app.get(PasswordService).hash(password);
  let phoneSeq = 0;
  async function account(code: 'ADMIN' | 'STAFF' | 'TRAINER' | 'MEMBER', label: string) {
    const role = await users.ensureRole(code, code);
    phoneSeq += 1;
    const created = await users.createAccount({ roleId: role.id.toHexString(), fullName: `US18 ${label}`,
      phone: `+8491234570${phoneSeq}`, passwordHash: hash });
    const response = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin)
      .send({ phone: created.phone, password }).expect(200);
    return { id: created._id, token: response.body.accessToken as string };
  }
  const admin = await account('ADMIN', 'ADMIN');
  const staff = await account('STAFF', 'STAFF');
  const trainer = await account('TRAINER', 'TRAINER');
  const member = await account('MEMBER', 'MEMBER');
  const otherMember = await account('MEMBER', 'MEMBER khác');
  const unlinked = await account('MEMBER', 'MEMBER chưa liên kết');

  // Hồ sơ hội viên tạo đúng như quầy (US-09), rồi gắn account_id.
  const members = app.get(MembersRepository);
  const runner = app.get(TransactionRunner);
  const mine = await runner.run(session => members.insert({ fullName: 'Hội viên US18', phone: '+84908888881' }, staff.id, session));
  const other = await runner.run(session => members.insert({ fullName: 'Hội viên khác US18', phone: '+84908888882' }, staff.id, session));
  await connection.collection('members').updateOne({ _id: mine._id }, { $set: { account_id: member.id } });
  await connection.collection('members').updateOne({ _id: other._id }, { $set: { account_id: otherMember.id } });

  const plan = (await app.get<Model<Plan>>(getModelToken('Plan')).create({ code: 'GYM30', name: 'Gym 30 ngày', kind: 'GYM',
    duration_days: 30, session_quota: 0, price: toVndDecimal('300000'), benefits: 'Tập Gym trong giờ mở cửa', status: 'ACTIVE',
    created_by: admin.id, updated_by: admin.id })).toObject();

  return {
    app, connection,
    tokens: { ADMIN: admin.token, STAFF: staff.token, TRAINER: trainer.token, member: member.token,
      otherMember: otherMember.token, unlinked: unlinked.token },
    memberAccountId: member.id, staffId: staff.id, adminId: admin.id,
    memberId: mine._id.toHexString(), otherMemberId: other._id.toHexString(), plan,
  };
}

// Các lời gọi HTTP hay dùng trong test US-18.
export function us18Api(world: () => Us18World) {
  const server = () => world().app.getHttpServer();
  const selfInput = (extra: Record<string, unknown> = {}) => ({ planId: world().plan._id.toHexString(), planVersion: 0,
    startDate: '2026-11-01', preferredPaymentMethod: 'CASH', ...extra });
  const counterInput = (extra: Record<string, unknown> = {}) => ({ memberId: world().memberId, planId: world().plan._id.toHexString(),
    planVersion: 0, startDate: '2026-11-01', ...extra });
  return {
    selfInput,
    counterInput,
    // Member tự đăng ký (bước 1 đã có).
    register: (body: Record<string, unknown> = selfInput(), token = world().tokens.member, key: string = randomUUID()) =>
      request(server()).post('/api/me/service-registrations').set('Origin', origin)
        .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body),
    preview: (body: Record<string, unknown> = selfInput(), token = world().tokens.member) =>
      request(server()).post('/api/me/service-registrations/preview').set('Origin', origin)
        .set('Authorization', `Bearer ${token}`).send(body),
    // Quầy bán gói (US-14).
    counterSale: (body: Record<string, unknown> = counterInput(), key: string = randomUUID()) =>
      request(server()).post('/api/service-sales').set('Origin', origin)
        .set('Authorization', `Bearer ${world().tokens.STAFF}`).set('Idempotency-Key', key).send(body),
    // Member tự hủy yêu cầu SELF_SERVICE đang chờ (bước 2).
    cancel: (saleId: string, body: Record<string, unknown>, token = world().tokens.member, key: string = randomUUID()) =>
      request(server()).post(`/api/me/service-sales/${saleId}/cancel`).set('Origin', origin)
        .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body),
    // Hướng dẫn thanh toán của giao dịch của mình (bước 2).
    instructions: (transactionId: string, token = world().tokens.member) =>
      request(server()).get(`/api/me/transactions/${transactionId}/payment-instructions`).set('Authorization', `Bearer ${token}`),
    // Xác nhận thu của US-22 (chỉ STAFF/ADMIN).
    confirmCash: (transactionId: string, token = world().tokens.STAFF, key: string = randomUUID()) =>
      request(server()).post(`/api/transactions/${transactionId}/confirm-payment`).set('Origin', origin)
        .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key)
        .send({ method: 'CASH', amount: '300000', evidenceNote: 'Đã đếm đủ tiền mặt thực nhận' }),
    count: (collection: string) => world().connection.collection(collection).countDocuments(),
    findById: (collection: string, id: string) => world().connection.collection(collection).findOne({ _id: new Types.ObjectId(id) }),
    setPlanPrice: (price: string) => world().connection.collection('plans')
      .updateOne({ _id: world().plan._id }, { $set: { price: toVndDecimal(price) } }),
  };
}
