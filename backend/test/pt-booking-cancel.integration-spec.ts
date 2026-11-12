// Tầng kiểm thử backend (Jest + MongoDB replica set thật): US-29 bước 1.
// Kiểm tra CancelBookingService dùng chung hai policy OWN (Member tự hủy) và SUPPORT (Staff/Admin hủy hỗ trợ):
// kiểm lại giờ server, version, chủ booking ngay khi ghi; BOOKED → CANCELLED, quota giữ chỗ giảm 1, used không đổi (TC01–TC08).
// Hợp đồng test đặt ra cho Builder (US-29 bước 1, theo F01–F03 và mục 2 của spec):
//   File backend/src/modules/bookings/cancel-booking.service.ts, class CancelBookingService (provider của BookingsModule).
//   cancel(input: { policy: 'OWN' | 'SUPPORT'; actorId: string (account id người gọi); actorRole: 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
//                   bookingId: string; version: number; reason?: string; idempotencyKey: string (UUID, từ bước 2) }) → Promise<{ id, status: 'CANCELLED', version, cancelledAt }>.
//   Service tự mở transaction; trong transaction đọc booking mới nhất, kiểm owner/trạng thái/version/hạn bằng giờ server rồi ghi CAS.
//   Thành công: pt_bookings.status CANCELLED, cancelled_at, cancelled_by = actorId, cancellation_reason = reason đã trim (cùng tên với work_shifts US-25), updated_at, version+1.
//     Không xóa booking, không đổi member_id/membership_id, không sửa memberships/service_sales/transactions, không tạo refund.
//   Lỗi (ApplicationError status + code):
//     400 VALIDATION_ERROR  – reason thiếu hoặc sau trim ngoài 10–500 ký tự.
//     403                   – policy SUPPORT nhưng actorRole không phải STAFF/ADMIN.
//     404 NOT_FOUND         – booking không tồn tại, hoặc policy OWN mà booking không thuộc member của actor (không lộ dữ liệu).
//     409 CANCELLATION_WINDOW_CLOSED – policy OWN khi startAt − giờ server < 120 phút.
//     409 INVALID_BOOKING_STATE      – booking không còn BOOKED (CANCELLED, COMPLETED).
//     409 VERSION_CONFLICT           – version gửi lên khác version hiện tại.
//   Để bước sau: booking_events/thông báo/thứ tự khóa lịch (bước 2), API + Guard + UI (bước 3), fake clock "đúng 2 giờ" và race (bước 4).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { ApplicationError } from '../src/common/errors/application-error';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { CancelBookingService } from '../src/modules/bookings/cancel-booking.service';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us29_cancel';
const password = 'MậtKhẩuUS-29-123';
const REASON = 'Bận việc gia đình đột xuất';
const MINUTE = 60 * 1000;

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type CancelInput = { policy: 'OWN' | 'SUPPORT'; actorId: string; actorRole: Role; bookingId: string; version: number; reason?: string; idempotencyKey: string };

describe('US-29 bước 1: CancelBookingService hai policy own/support', () => {
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
      NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(), MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'us29-test', SMTP_PASS: 'us29-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await db().collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    // Khóa lịch global (lệnh ensure-indexes tạo trong môi trường thật) – để Builder dùng được nếu lấy khóa lịch.
    await db().collection<{ _id: string; revision: Long }>('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO });
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());
  const cancel = (input: CancelInput) => app.get(CancelBookingService).cancel(input);

  // ---------- Thời gian tính theo giờ thật lúc chạy test ----------
  // Mốc tròn phút cách hiện tại ÍT NHẤT `minutes` phút (dùng cho các ca còn dư hạn rõ ràng).
  const minutesAhead = (minutes: number) => new Date(Math.ceil((Date.now() + minutes * MINUTE) / MINUTE) * MINUTE);
  // Mốc tròn phút đã qua ÍT NHẤT `minutes` phút.
  const minutesAgo = (minutes: number) => new Date(Math.floor((Date.now() - minutes * MINUTE) / MINUTE) * MINUTE);

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: Role, fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0913900${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    // accountId dạng chuỗi hex (giống id trong JWT) để truyền vào actorId.
    return { accountId: String(created.id), phone };
  }
  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }

  // PT mẫu (thay US-23): account TRAINER + hồ sơ trainers.
  async function trainer(fullName = 'PT Lê Văn Cường') {
    const owner = await account('TRAINER', fullName);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: new ObjectId(owner.accountId), specialty: 'Thể hình', status: 'ACTIVE', version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: owner.accountId };
  }

  // Member có tài khoản đã liên kết hồ sơ (khuôn US-09/US-28).
  async function linkedMember(name = 'Hội viên US29') {
    const owner = await account('MEMBER', name);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: name, phone: owner.phone,
      account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { accessToken: await loginAs(owner.phone), memberId, accountId: owner.accountId };
  }

  // Một gói PT (thay US-14/22): plan → transaction → sale → membership. used mặc định 2 để thấy rõ "used không đổi".
  let saleSeq = 0;
  async function insertPlan(memberId: ObjectId, options: { membershipStatus?: string; used?: number } = {}) {
    saleSeq += 1;
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const staffId = new ObjectId();
    const now = new Date();
    const money = Decimal128.fromString('3000000');
    const today = new Date(Date.now() + 7 * 60 * MINUTE);
    const vnDay = (days: number) => new Date(today.getTime() + days * 24 * 60 * MINUTE).toISOString().slice(0, 10);
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US29-${saleSeq}`, name: `Gói PT ${saleSeq}`, kind: 'PT', duration_days: 30,
      session_quota: 10, price: money, benefits: 'Quyền lợi', status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US29-${saleSeq}`, kind: 'PT', amount_due: money,
      status: 'SETTLED', request_key: randomBytes(32).toString('hex'), created_at: now, guard_revision: Long.ZERO,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: vnDay(-5), end_date: vnDay(30), plan_name_snapshot: `Gói PT ${saleSeq}`,
      benefits_snapshot: 'Quyền lợi', list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: 10,
      policy_snapshot: 'Giá niêm yết', created_at: now,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, id: membershipId, service_sale_id: saleId, status: options.membershipStatus ?? 'ACTIVE', sessions_used: options.used ?? 2,
    });
    return membershipId;
  }

  // Buổi PT có sẵn (đặt qua US-28 trước đó).
  async function insertBooking(memberId: ObjectId, membershipId: ObjectId, trainerId: ObjectId, start: Date, extra: Record<string, unknown> = {}) {
    const id = new ObjectId();
    await db().collection('pt_bookings').insertOne({
      _id: id, id, membership_id: membershipId, member_id: memberId, trainer_id: trainerId, shift_id: new ObjectId(),
      start_at: start, end_at: new Date(start.getTime() + 60 * MINUTE), status: 'BOOKED', request_key: randomBytes(32).toString('hex'),
      version: 0, trainer_name_snapshot: 'PT Lê Văn Cường', location_snapshot: 'Phòng PT 1', created_at: new Date(), updated_at: new Date(),
      ...extra,
    });
    return id;
  }

  // Bộ dữ liệu sẵn: Member có gói PT, một buổi BOOKED với PT bắt đầu lúc `start`.
  async function ready(start: Date, extra: Record<string, unknown> = {}) {
    const me = await linkedMember();
    const membershipId = await insertPlan(me.memberId);
    const pt = await trainer();
    const bookingId = await insertBooking(me.memberId, membershipId, pt.trainerId, start, extra);
    return { me, membershipId, pt, bookingId };
  }

  const ownInput = (me: { accountId: string }, bookingId: ObjectId, version = 0, reason: string | undefined = REASON): CancelInput => ({
    policy: 'OWN', actorId: me.accountId, actorRole: 'MEMBER', bookingId: bookingId.toHexString(), version, reason, idempotencyKey: randomUUID(),
  });
  const supportInput = (actor: { accountId: string }, role: Role, bookingId: ObjectId, version = 0, reason: string | undefined = REASON): CancelInput => ({
    policy: 'SUPPORT', actorId: actor.accountId, actorRole: role, bookingId: bookingId.toHexString(), version, reason, idempotencyKey: randomUUID(),
  });

  const bookingDoc = (id: ObjectId) => db().collection('pt_bookings').findOne({ _id: id });

  // Chờ service ném lỗi và kiểm status/code của ApplicationError.
  async function expectFail(work: Promise<unknown>, status: number, code?: string) {
    const error = await work.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationError);
    expect((error as ApplicationError).status).toBe(status);
    if (code) expect((error as ApplicationError).code).toBe(code);
    return error as ApplicationError;
  }

  // Lỗi thì booking phải giữ nguyên từng field như trước khi gọi.
  async function expectUnchanged(bookingId: ObjectId, work: () => Promise<unknown>) {
    const before = await bookingDoc(bookingId);
    await work();
    expect(await bookingDoc(bookingId)).toEqual(before);
  }

  async function quotaOf(user: { accessToken: string }, membershipId: ObjectId) {
    const response = await http().get(`/api/me/memberships/${membershipId.toHexString()}`).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`).expect(200);
    const { sessionsUsed, sessionsReserved, sessionsAvailable } = response.body as Record<string, number>;
    return { sessionsUsed, sessionsReserved, sessionsAvailable };
  }

  // Booking đã CANCELLED đúng hợp đồng bước 1.
  async function expectCancelled(bookingId: ObjectId, actorId: string, reason: string, version: number) {
    const saved = await bookingDoc(bookingId);
    expect(saved).not.toBeNull();
    expect(saved?.status).toBe('CANCELLED');
    expect(saved?.version).toBe(version);
    expect(saved?.cancelled_at).toBeInstanceOf(Date);
    expect(String(saved?.cancelled_by)).toBe(actorId);
    expect(saved?.cancellation_reason).toBe(reason);
    return saved!;
  }

  // =====================================================================
  // AC01 – Ownership và ranh giới 2 giờ (TC01–TC04)
  // =====================================================================

  describe('US-29-TC01: Member hủy BOOKED khi còn trên 2 giờ', () => {
    it('US-29-TC01: còn 3 giờ → trả {id, status CANCELLED, version+1, cancelledAt} theo giờ server', async () => {
      const { me, bookingId } = await ready(minutesAhead(180));
      const startedAt = Date.now();

      const result = await cancel(ownInput(me, bookingId));

      expect(result).toMatchObject({ id: bookingId.toHexString(), status: 'CANCELLED', version: 1 });
      const cancelledAt = new Date(result.cancelledAt).getTime();
      expect(cancelledAt).toBeGreaterThanOrEqual(startedAt - 1000);
      expect(cancelledAt).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('US-29-TC01: DB ghi cancelled_at/by, cancellation_reason (đã trim), updated_at mới, version+1; không DELETE, giữ member_id và membership_id', async () => {
      const { me, membershipId, bookingId } = await ready(minutesAhead(180));
      const before = await bookingDoc(bookingId);

      await cancel(ownInput(me, bookingId, 0, `   ${REASON}   `));

      const saved = await expectCancelled(bookingId, me.accountId, REASON, 1);
      expect(saved.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
      expect(String(saved.member_id)).toBe(me.memberId.toHexString());
      expect(String(saved.membership_id)).toBe(membershipId.toHexString());
      expect(await db().collection('pt_bookings').countDocuments()).toBe(1);
    });

    it('US-29-TC01: reserved giảm đúng 1, used không đổi; không sửa membership/sale/transaction, không tạo refund hay payment', async () => {
      const { me, membershipId, bookingId } = await ready(minutesAhead(180));
      const snapshot = async () => Promise.all(['memberships', 'service_sales', 'transactions', 'payments', 'refunds'].map(name => db().collection(name).find().toArray()));
      const quotaBefore = await quotaOf(me, membershipId);
      const dataBefore = await snapshot();

      await cancel(ownInput(me, bookingId));

      const quotaAfter = await quotaOf(me, membershipId);
      expect(quotaAfter.sessionsReserved).toBe(quotaBefore.sessionsReserved - 1);
      expect(quotaAfter.sessionsUsed).toBe(quotaBefore.sessionsUsed);
      expect(quotaAfter.sessionsAvailable).toBe(quotaBefore.sessionsAvailable + 1);
      expect(await snapshot()).toEqual(dataBefore);
    });
  });

  describe('US-29-TC02: còn dưới 2 giờ hoặc đã qua giờ → 409 theo giờ server', () => {
    it('US-29-TC02: còn 1 giờ 59 phút 59 giây → 409 CANCELLATION_WINDOW_CLOSED, booking giữ nguyên', async () => {
      const { me, bookingId } = await ready(new Date(Date.now() + 119 * MINUTE + 59 * 1000));

      await expectUnchanged(bookingId, () => expectFail(cancel(ownInput(me, bookingId)), 409, 'CANCELLATION_WINDOW_CLOSED'));
    });

    it('US-29-TC02: buổi đang diễn ra (bắt đầu 15 phút trước) → 409 CANCELLATION_WINDOW_CLOSED', async () => {
      const { me, bookingId } = await ready(minutesAgo(15));

      await expectUnchanged(bookingId, () => expectFail(cancel(ownInput(me, bookingId)), 409, 'CANCELLATION_WINDOW_CLOSED'));
    });

    it('US-29-TC02: start đã qua (hôm qua) → 409 CANCELLATION_WINDOW_CLOSED, reserved và used không đổi', async () => {
      const { me, membershipId, bookingId } = await ready(minutesAgo(24 * 60));
      const quotaBefore = await quotaOf(me, membershipId);

      await expectUnchanged(bookingId, () => expectFail(cancel(ownInput(me, bookingId)), 409, 'CANCELLATION_WINDOW_CLOSED'));

      expect(await quotaOf(me, membershipId)).toEqual(quotaBefore);
    });
  });

  describe('US-29-TC03: hủy booking người khác hoặc PT gọi own/support → 404/403, không lộ dữ liệu', () => {
    it('US-29-TC03: Member B hủy booking của Member A bằng policy OWN → 404 NOT_FOUND, lỗi không chứa id/tên của A', async () => {
      const { me, bookingId } = await ready(minutesAhead(180));
      const other = await linkedMember('Hội viên Khác');

      const error = await expectFail(cancel(ownInput(other, bookingId)), 404, 'NOT_FOUND');

      const text = JSON.stringify({ message: error.message, details: error.details });
      expect(text).not.toContain(me.memberId.toHexString());
      expect(text).not.toContain('Hội viên US29');
      expect(text).not.toContain('PT Lê Văn Cường');
      expect((await bookingDoc(bookingId))?.status).toBe('BOOKED');
    });

    it('US-29-TC03: booking không tồn tại → cùng 404 NOT_FOUND như booking của người khác', async () => {
      const me = await linkedMember();

      await expectFail(cancel(ownInput(me, new ObjectId())), 404, 'NOT_FOUND');
    });

    it('US-29-TC03: PT của buổi đó gọi policy OWN → bị chặn 404/403, booking giữ nguyên', async () => {
      const { pt, bookingId } = await ready(minutesAhead(180));
      const input: CancelInput = { ...ownInput(pt, bookingId), actorRole: 'TRAINER' };

      await expectUnchanged(bookingId, async () => {
        const error = await cancel(input).then(() => null, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(ApplicationError);
        expect([403, 404]).toContain((error as ApplicationError).status);
      });
    });

    it('US-29-TC03: PT gọi policy SUPPORT có lý do → 403, PT không được hủy thay học viên', async () => {
      const { pt, bookingId } = await ready(minutesAhead(180));

      await expectUnchanged(bookingId, () => expectFail(cancel(supportInput(pt, 'TRAINER', bookingId)), 403));
    });
  });

  describe('US-29-TC04: membership đã đổi sau nâng cấp, Member vẫn là owner', () => {
    // Mô phỏng US-16 (chưa có): booking chuyển sang gói mới, version tăng, gói cũ SUPERSEDED; member_id giữ nguyên.
    async function upgraded() {
      const data = await ready(minutesAhead(180));
      const newMembershipId = await insertPlan(data.me.memberId);
      await db().collection('memberships').updateOne({ _id: data.membershipId }, { $set: { status: 'SUPERSEDED' } });
      await db().collection('pt_bookings').updateOne({ _id: data.bookingId }, { $set: { membership_id: newMembershipId, version: 1 } });
      return { ...data, newMembershipId };
    }

    it('US-29-TC04: hủy với version hiện tại (1) → thành công, owner theo member_id không mất, membership_id giữ gói mới', async () => {
      const { me, bookingId, newMembershipId } = await upgraded();

      const result = await cancel(ownInput(me, bookingId, 1));

      expect(result).toMatchObject({ status: 'CANCELLED', version: 2 });
      const saved = await expectCancelled(bookingId, me.accountId, REASON, 2);
      expect(String(saved.member_id)).toBe(me.memberId.toHexString());
      expect(String(saved.membership_id)).toBe(newMembershipId.toHexString());
    });

    it('US-29-TC04: client giữ version cũ (0) → 409 VERSION_CONFLICT, booking giữ nguyên để tải lại', async () => {
      const { me, bookingId } = await upgraded();

      await expectUnchanged(bookingId, () => expectFail(cancel(ownInput(me, bookingId, 0)), 409, 'VERSION_CONFLICT'));
    });

    it('US-29-TC04: gói của booking không còn ACTIVE (SUPERSEDED) → vẫn được hủy lịch của mình', async () => {
      const { me, membershipId, bookingId } = await ready(minutesAhead(180));
      await db().collection('memberships').updateOne({ _id: membershipId }, { $set: { status: 'SUPERSEDED' } });

      await cancel(ownInput(me, bookingId));

      await expectCancelled(bookingId, me.accountId, REASON, 1);
    });
  });

  // =====================================================================
  // AC02 – Hỗ trợ và bảo toàn quota lịch sử (TC05–TC08)
  // =====================================================================

  describe('US-29-TC05: Staff/Admin hủy hỗ trợ sát giờ/đã qua giờ có lý do', () => {
    it('US-29-TC05: STAFF hủy buổi còn 30 phút → CANCELLED, cancelled_by là staff, lưu lý do', async () => {
      const { bookingId } = await ready(minutesAhead(30));
      const staff = await account('STAFF', 'Nhân viên Quầy');

      const result = await cancel(supportInput(staff, 'STAFF', bookingId));

      expect(result).toMatchObject({ id: bookingId.toHexString(), status: 'CANCELLED', version: 1 });
      await expectCancelled(bookingId, staff.accountId, REASON, 1);
    });

    it('US-29-TC05: ADMIN hủy buổi đang diễn ra (bắt đầu 15 phút trước) → CANCELLED', async () => {
      const { bookingId } = await ready(minutesAgo(15));
      const admin = await account('ADMIN', 'Quản trị viên');

      await cancel(supportInput(admin, 'ADMIN', bookingId));

      await expectCancelled(bookingId, admin.accountId, REASON, 1);
    });

    it('US-29-TC05: STAFF hủy buổi đã qua giờ (no show) → CANCELLED, không giả COMPLETED, used không tăng, reserved giảm 1', async () => {
      const { me, membershipId, bookingId } = await ready(minutesAgo(24 * 60));
      const staff = await account('STAFF', 'Nhân viên Quầy');
      const quotaBefore = await quotaOf(me, membershipId);

      await cancel(supportInput(staff, 'STAFF', bookingId));

      await expectCancelled(bookingId, staff.accountId, REASON, 1);
      const quotaAfter = await quotaOf(me, membershipId);
      expect(quotaAfter.sessionsUsed).toBe(quotaBefore.sessionsUsed);
      expect(quotaAfter.sessionsReserved).toBe(quotaBefore.sessionsReserved - 1);
    });
  });

  describe('US-29-TC06: support thiếu lý do/lý do sai độ dài hoặc thiếu quyền → 400/403, không vượt policy', () => {
    const cases: Array<[string, string | undefined]> = [
      ['không gửi reason', undefined],
      ['reason rỗng', ''],
      ['reason chỉ có khoảng trắng', '            '],
      ['reason 9 ký tự sau trim', '   123456789   '],
      ['reason 501 ký tự', 'a'.repeat(501)],
    ];
    it.each(cases)('US-29-TC06: %s → 400 VALIDATION_ERROR, booking giữ nguyên', async (_name, reason) => {
      const { bookingId } = await ready(minutesAhead(30));
      const staff = await account('STAFF', 'Nhân viên Quầy');
      // Ghi đè reason sau khi tạo input: truyền undefined vào tham số mặc định của supportInput sẽ bị thay bằng REASON hợp lệ.
      const input: CancelInput = { ...supportInput(staff, 'STAFF', bookingId), reason };

      await expectUnchanged(bookingId, () => expectFail(cancel(input), 400, 'VALIDATION_ERROR'));
    });

    it('US-29-TC06: biên hợp lệ – reason đúng 10 ký tự sau trim được nhận và lưu bản đã trim', async () => {
      const { bookingId } = await ready(minutesAhead(30));
      const staff = await account('STAFF', 'Nhân viên Quầy');

      await cancel(supportInput(staff, 'STAFF', bookingId, 0, '  1234567890  '));

      await expectCancelled(bookingId, staff.accountId, '1234567890', 1);
    });

    it('US-29-TC06: biên hợp lệ – reason đúng 500 ký tự được nhận', async () => {
      const { bookingId } = await ready(minutesAhead(30));
      const staff = await account('STAFF', 'Nhân viên Quầy');

      await cancel(supportInput(staff, 'STAFF', bookingId, 0, 'b'.repeat(500)));

      await expectCancelled(bookingId, staff.accountId, 'b'.repeat(500), 1);
    });

    it('US-29-TC06: MEMBER (kể cả chủ booking) gọi policy SUPPORT để vượt hạn 2 giờ → 403', async () => {
      const { me, bookingId } = await ready(minutesAhead(30));

      await expectUnchanged(bookingId, () => expectFail(cancel(supportInput(me, 'MEMBER', bookingId)), 403));
    });

    it('US-29-TC06: support gửi version cũ → 409 VERSION_CONFLICT, support không bỏ qua CAS', async () => {
      const { bookingId } = await ready(minutesAhead(30));
      await db().collection('pt_bookings').updateOne({ _id: bookingId }, { $set: { version: 3 } });
      const staff = await account('STAFF', 'Nhân viên Quầy');

      await expectUnchanged(bookingId, () => expectFail(cancel(supportInput(staff, 'STAFF', bookingId, 2)), 409, 'VERSION_CONFLICT'));
    });
  });

  describe('US-29-TC07: booking CANCELLED hoặc COMPLETED → 409, không đổi used/lịch sử', () => {
    it('US-29-TC07: booking đã CANCELLED, Member hủy lại → 409 INVALID_BOOKING_STATE, giữ cancelled_at/by và cancellation_reason lần đầu', async () => {
      const { me, bookingId } = await ready(minutesAhead(180));
      await cancel(ownInput(me, bookingId));

      await expectUnchanged(bookingId, () =>
        expectFail(cancel(ownInput(me, bookingId, 1, 'Hủy thêm lần nữa cho chắc')), 409, 'INVALID_BOOKING_STATE'));
    });

    it('US-29-TC07: booking COMPLETED, Staff hủy hỗ trợ → 409 INVALID_BOOKING_STATE, used và membership giữ nguyên', async () => {
      const me = await linkedMember();
      const membershipId = await insertPlan(me.memberId, { used: 3 });
      const pt = await trainer();
      const bookingId = await insertBooking(me.memberId, membershipId, pt.trainerId, minutesAgo(24 * 60), { status: 'COMPLETED', version: 2 });
      const staff = await account('STAFF', 'Nhân viên Quầy');
      const membershipBefore = await db().collection('memberships').findOne({ _id: membershipId });

      await expectUnchanged(bookingId, () => expectFail(cancel(supportInput(staff, 'STAFF', bookingId, 2)), 409, 'INVALID_BOOKING_STATE'));

      expect(await db().collection('memberships').findOne({ _id: membershipId })).toEqual(membershipBefore);
      expect(await db().collection('refunds').countDocuments()).toBe(0);
    });
  });

  describe('US-29-TC08: Member/PT bị khóa nhưng hỗ trợ của staff vẫn hợp lệ', () => {
    it('US-29-TC08: account Member LOCKED, account PT LOCKED, trainer INACTIVE → STAFF vẫn hủy hỗ trợ được', async () => {
      const { me, pt, bookingId } = await ready(minutesAhead(30));
      await db().collection('accounts').updateMany({ _id: { $in: [new ObjectId(me.accountId), new ObjectId(pt.accountId)] } }, { $set: { status: 'LOCKED' } });
      await db().collection('trainers').updateOne({ _id: pt.trainerId }, { $set: { status: 'INACTIVE' } });
      const staff = await account('STAFF', 'Nhân viên Quầy');

      const result = await cancel(supportInput(staff, 'STAFF', bookingId));

      expect(result).toMatchObject({ status: 'CANCELLED', version: 1 });
      await expectCancelled(bookingId, staff.accountId, REASON, 1);
    });
  });
});
