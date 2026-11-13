// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-27 bước 2.
// Kiểm tra API lịch PT riêng của Member: chủ thể theo member_id từ principal, không phụ thuộc gói hiện tại, biên ngày VN (TC07, TC08, TC10, TC11).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { UsersRepository } from '../src/modules/users/users.repository';
// Hợp đồng test đặt ra cho Builder (US-27 bước 2, theo F05 và mục 2 của spec):
//   GET /api/me/pt-bookings?fromDate&toDate&status?&page?&limit?
//        -> MEMBER; 200 {memberLinked, items, page, limit, total, totalPages}; page mặc định 1, limit 20.
//        fromDate/toDate là ngày VN YYYY-MM-DD, bao gồm hai đầu, tối đa 31 ngày; sai -> 400.
//        Gồm BOOKED/COMPLETED/CANCELLED; status lọc tùy chọn. Chưa link -> 200 memberLinked=false, items=[].
//   GET /api/me/pt-bookings/:id
//        -> MEMBER owner; 200 đúng các field {id,membershipId,trainerId,trainerName,shiftId,startAt,endAt,location,status,version,cancelAllowed,asOf}.
//        Của người khác / không tồn tại / chưa link -> 404; id sai định dạng -> 400.
//   Chủ sở hữu = pt_bookings.member_id (US-28 bổ sung, bất biến), KHÔNG suy từ membership hiện tại.
//   trainerName/location lấy snapshot trainer_name_snapshot/location_snapshot của booking.
//   cancelAllowed là gợi ý theo luật US-29-F01: BOOKED và startAt − now ≥ 120 phút.
//   US-28 chưa có -> test ghi thẳng pt_bookings vào DB (khuôn mục 4.2.13 + phần US-28 bổ sung).

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us27_bookings';
const password = 'MậtKhẩuUS-27-123';
const base = '/api/me/pt-bookings';
const DETAIL_FIELDS = [
  'asOf', 'cancelAllowed', 'endAt', 'id', 'location', 'membershipId', 'shiftId', 'startAt', 'status', 'trainerId', 'trainerName', 'version',
];

type Auth = { accessToken: string };
type Owner = { memberId: ObjectId; membershipId: ObjectId };
type Item = Record<string, unknown> & { id: string; startAt: string; status: string };

describe('US-27 bước 2: lịch PT riêng của Member', () => {
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
      NODE_ENV: 'test',
      PORT: '3000',
      FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      // Ứng dụng bắt buộc có cấu hình SMTP/pepper khi khởi động (US-05); test này không gửi thư.
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'us27-test', SMTP_PASS: 'us27-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http');
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Bộ giới hạn đăng nhập (US-02) lưu trong bộ nhớ: mỗi test dùng bộ mới để không bị 429.
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await connection.db!.collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());

  // ---------- Thời gian theo lịch Việt Nam ----------
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  // Ngày VN (YYYY-MM-DD) cách hôm nay `days` ngày (âm = quá khứ).
  const vnDay = (days: number) => new Date(Date.now() + VN_OFFSET_MS + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const at = (onDay: string, hhmm: string) => new Date(`${onDay}T${hhmm}:00+07:00`);
  const future = vnDay(10);
  const past = vnDay(-3);

  // ---------- Tài khoản ----------
  let phoneSeq = 0;
  async function account(roleCode: 'MEMBER' | 'TRAINER', fullName: string) {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole(roleCode, roleCode);
    const passwordHash = await app.get(PasswordService).hash(password);
    phoneSeq += 1;
    const phone = `0912800${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({ roleId: role.id.toHexString(), phone, fullName, passwordHash });
    return { accountId: created.id, phone };
  }

  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }

  // PT mẫu (thay US-23).
  async function trainer(name = 'PT Trần Văn Bình') {
    const owner = await account('TRAINER', name);
    const trainerId = new ObjectId();
    const now = new Date();
    await db().collection('trainers').insertOne({
      _id: trainerId, id: trainerId, account_id: owner.accountId, specialty: 'Thể hình', status: 'ACTIVE',
      version: 0, created_at: now, updated_at: now,
    });
    return { trainerId, accountId: owner.accountId };
  }

  // Hồ sơ hội viên mẫu (khuôn US-09). accountId = null: hội viên ngoại tuyến chưa liên kết.
  let memberSeq = 0;
  async function insertMember(accountId: ObjectId | null, phone: string) {
    memberSeq += 1;
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    const doc: Record<string, unknown> = {
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: `Hội viên US27 ${memberSeq}`,
      phone, version: 0, service_revision: 0n, created_by: staffId, updated_by: staffId,
    };
    if (accountId) doc.account_id = accountId;
    await db().collection('members').insertOne(doc);
    return memberId;
  }

  // Một gói PT đã thu tiền (thay US-14/22): plan → transaction SETTLED → sale → membership.
  let saleSeq = 0;
  async function insertPtMembership(memberId: ObjectId, status: 'ACTIVE' | 'SUPERSEDED' = 'ACTIVE', quota = 10, used = 0) {
    saleSeq += 1;
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const membershipId = new ObjectId();
    const staffId = new ObjectId();
    const now = new Date();
    const money = Decimal128.fromString('3000000');
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `PT-US27B2-${saleSeq}`, name: `Gói PT ${quota} buổi`, kind: 'PT', duration_days: 60,
      session_quota: quota, price: money, benefits: `${quota} buổi PT`, status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US27B2-${saleSeq}`, kind: 'PT',
      amount_due: money, status: 'SETTLED', request_key: `us27b2-key-${transactionId.toHexString()}`, created_at: now,
    });
    await db().collection('service_sales').insertOne({
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId, operation: 'REGISTER',
      start_date: vnDay(-30), end_date: vnDay(30), plan_name_snapshot: `Gói PT ${quota} buổi`, benefits_snapshot: `${quota} buổi PT`,
      list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), sessions_snapshot: quota,
      policy_snapshot: 'Giá niêm yết, 60 ngày', created_at: now,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, id: membershipId, service_sale_id: saleId, status, sessions_used: used,
    });
    return membershipId;
  }

  // Member có tài khoản đã liên kết và một gói PT ACTIVE.
  async function linkedMember() {
    const owner = await account('MEMBER', `Hội viên US27 B2 ${phoneSeq + 1}`);
    const memberId = await insertMember(owner.accountId, owner.phone);
    const membershipId = await insertPtMembership(memberId);
    return { accessToken: await loginAs(owner.phone), memberId, membershipId, phone: owner.phone };
  }

  // Buổi PT mẫu (thay US-28): khuôn mục 4.2.13 + phần US-28 bổ sung (member_id, snapshot, version).
  async function insertBooking(owner: Owner, trainerId: ObjectId, start: Date, options: {
    status?: 'BOOKED' | 'COMPLETED' | 'CANCELLED'; trainerName?: string; location?: string; version?: number; shiftId?: ObjectId;
  } = {}) {
    const id = new ObjectId();
    const status = options.status ?? 'BOOKED';
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const doc: Record<string, unknown> = {
      _id: id, id, membership_id: owner.membershipId, member_id: owner.memberId, trainer_id: trainerId,
      shift_id: options.shiftId ?? new ObjectId(), start_at: start, end_at: end, status,
      request_key: `us27b2-booking-${id.toHexString()}`, version: options.version ?? 0,
      trainer_name_snapshot: options.trainerName ?? 'PT Trần Văn Bình', location_snapshot: options.location ?? 'Phòng PT 1',
      created_by: new ObjectId(), created_at: new Date(), updated_at: new Date(),
    };
    if (status === 'COMPLETED') doc.completed_at = end;
    if (status === 'CANCELLED') Object.assign(doc, { cancelled_at: new Date(), cancelled_by: new ObjectId(), cancelled_reason: 'Học viên bận việc gia đình' });
    await db().collection('pt_bookings').insertOne(doc);
    return id.toHexString();
  }

  function list(user: Auth, query: Record<string, string | number>) {
    return http().get(base).query(query).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }
  function detail(user: Auth, id: string) {
    return http().get(`${base}/${id}`).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }
  const ids = (body: { items: Item[] }) => body.items.map(item => item.id);

  function expectError(response: request.Response, status: number) {
    expect(response.status).toBe(status);
    expect(typeof response.body.error?.code).toBe('string');
    expect(typeof response.body.error?.message).toBe('string');
    expect(typeof response.body.requestId).toBe('string');
  }

  // =====================================================================
  // AC02 – Membership và quyền riêng tư (TC07, TC08)
  // =====================================================================

  describe('US-27-TC07: Member chưa link; booking của người khác', () => {
    it('US-27-TC07: Member chưa link xem lịch riêng → 200 memberLinked=false, items rỗng', async () => {
      const owner = await account('MEMBER', 'Chưa liên kết');
      const me = { accessToken: await loginAs(owner.phone) };
      const response = await list(me, { fromDate: future, toDate: future }).expect(200);
      expect(response.body).toMatchObject({ memberLinked: false, items: [], total: 0, totalPages: 0 });
    });

    it('US-27-TC07: chưa link dù phone khớp hội viên ngoại tuyến có lịch → vẫn rỗng, không tự nối hồ sơ', async () => {
      const owner = await account('MEMBER', 'Trùng phone');
      const offlineId = await insertMember(null, owner.phone);
      const offlineMembership = await insertPtMembership(offlineId);
      const pt = await trainer();
      await insertBooking({ memberId: offlineId, membershipId: offlineMembership }, pt.trainerId, at(future, '08:00'));
      const me = { accessToken: await loginAs(owner.phone) };

      const response = await list(me, { fromDate: future, toDate: future }).expect(200);

      expect(response.body.memberLinked).toBe(false);
      expect(response.body.items).toEqual([]);
      const offline = await db().collection('members').findOne({ _id: offlineId });
      expect(offline?.account_id).toBeUndefined();
    });

    it('US-27-TC07: Member chưa link xem chi tiết một booking bất kỳ → 404', async () => {
      const other = await linkedMember();
      const pt = await trainer();
      const bookingId = await insertBooking(other, pt.trainerId, at(future, '08:00'));
      const owner = await account('MEMBER', 'Chưa liên kết');
      const me = { accessToken: await loginAs(owner.phone) };
      expectError(await detail(me, bookingId), 404);
    });

    it('US-27-TC07: list của Member không chứa booking của Member khác cùng ngày, cùng PT', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const pt = await trainer();
      const mine = await insertBooking(me, pt.trainerId, at(future, '08:00'));
      const theirs = await insertBooking(other, pt.trainerId, at(future, '10:00'));

      const response = await list(me, { fromDate: future, toDate: future }).expect(200);

      expect(response.body.memberLinked).toBe(true);
      expect(ids(response.body)).toEqual([mine]);
      expect(JSON.stringify(response.body)).not.toContain(theirs);
      expect(JSON.stringify(response.body)).not.toContain(other.memberId.toHexString());
    });

    it('US-27-TC07: chi tiết booking của Member khác → 404 giống không tồn tại, không lộ dữ liệu', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const pt = await trainer();
      const theirs = await insertBooking(other, pt.trainerId, at(future, '08:00'), { trainerName: 'PT Bí Mật' });

      const foreign = await detail(me, theirs);
      const missing = await detail(me, new ObjectId().toHexString());

      expectError(foreign, 404);
      expectError(missing, 404);
      expect(foreign.body.error.code).toBe(missing.body.error.code);
      expect(JSON.stringify(foreign.body)).not.toContain('PT Bí Mật');
    });

    it('US-27-TC07: id booking sai định dạng → 400, không phải 500', async () => {
      const me = await linkedMember();
      expectError(await detail(me, 'khong-phai-objectid'), 400);
    });
  });

  describe('US-27-TC08: gói đã SUPERSEDED nhưng xem booking lịch sử', () => {
    it('US-27-TC08: booking gắn gói cũ SUPERSEDED vẫn có trong list và chi tiết của đúng owner', async () => {
      const me = await linkedMember();
      const oldMembership = await insertPtMembership(me.memberId, 'SUPERSEDED');
      const pt = await trainer();
      const bookingId = await insertBooking({ memberId: me.memberId, membershipId: oldMembership }, pt.trainerId, at(past, '08:00'),
        { status: 'COMPLETED' });

      const listed = await list(me, { fromDate: past, toDate: past }).expect(200);
      expect(ids(listed.body)).toEqual([bookingId]);

      const response = await detail(me, bookingId).expect(200);
      expect(response.body).toMatchObject({ id: bookingId, membershipId: oldMembership.toHexString(), status: 'COMPLETED' });
    });

    it('US-27-TC08: Member không còn gói nào hiệu lực (mọi gói SUPERSEDED) vẫn xem được lịch cũ', async () => {
      const owner = await account('MEMBER', 'Hết gói');
      const memberId = await insertMember(owner.accountId, owner.phone);
      const oldMembership = await insertPtMembership(memberId, 'SUPERSEDED');
      const pt = await trainer();
      const bookingId = await insertBooking({ memberId, membershipId: oldMembership }, pt.trainerId, at(past, '09:00'), { status: 'COMPLETED' });
      const me = { accessToken: await loginAs(owner.phone) };

      const response = await list(me, { fromDate: past, toDate: past }).expect(200);

      expect(response.body.memberLinked).toBe(true);
      expect(ids(response.body)).toEqual([bookingId]);
    });

    it('US-27-TC08: quyền theo member_id của booking, không theo membership (booking của người khác trỏ gói của mình vẫn 404)', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const pt = await trainer();
      // Dữ liệu lệch: member_id là người khác nhưng membership_id là gói của mình.
      const odd = await insertBooking({ memberId: other.memberId, membershipId: me.membershipId }, pt.trainerId, at(future, '08:00'));

      const response = await list(me, { fromDate: future, toDate: future }).expect(200);
      expect(ids(response.body)).not.toContain(odd);
      expectError(await detail(me, odd), 404);
    });

    it('US-27-TC08: chi tiết đúng các field hợp đồng, PT và địa điểm theo snapshot dù tên PT trên account đã đổi', async () => {
      const me = await linkedMember();
      const pt = await trainer('PT Tên Cũ');
      const shiftId = new ObjectId();
      const start = at(future, '08:00');
      const bookingId = await insertBooking(me, pt.trainerId, start, { trainerName: 'PT Tên Cũ', location: 'Phòng PT 3', version: 2, shiftId });
      await db().collection('accounts').updateOne({ _id: pt.accountId }, { $set: { full_name: 'PT Tên Mới' } });

      const response = await detail(me, bookingId).expect(200);

      expect(Object.keys(response.body).sort()).toEqual(DETAIL_FIELDS);
      expect(response.body).toMatchObject({
        id: bookingId, membershipId: me.membershipId.toHexString(), trainerId: pt.trainerId.toHexString(), trainerName: 'PT Tên Cũ',
        shiftId: shiftId.toHexString(), location: 'Phòng PT 3', status: 'BOOKED', version: 2,
      });
      expect(new Date(response.body.startAt).toISOString()).toBe(start.toISOString());
      expect(new Date(response.body.endAt).toISOString()).toBe(new Date(start.getTime() + 3600000).toISOString());
      expect(response.body.startAt).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
      expect(Number.isNaN(Date.parse(response.body.asOf))).toBe(false);
    });
  });

  // =====================================================================
  // AC03 – Dữ liệu stale (TC10, TC11)
  // =====================================================================

  describe('US-27-TC10: BOOKED đã qua giờ và booking CANCELLED', () => {
    it('US-27-TC10: BOOKED đã qua giờ vẫn là BOOKED trong list/chi tiết, cancelAllowed=false, DB không bị đổi', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      const bookingId = await insertBooking(me, pt.trainerId, at(past, '08:00'));

      const listed = await list(me, { fromDate: past, toDate: past }).expect(200);
      expect(listed.body.items.map((item: Item) => item.status)).toEqual(['BOOKED']);

      const response = await detail(me, bookingId).expect(200);
      expect(response.body).toMatchObject({ status: 'BOOKED', cancelAllowed: false });
      const stored = await db().collection('pt_bookings').findOne({ _id: new ObjectId(bookingId) });
      expect(stored?.status).toBe('BOOKED');
    });

    it('US-27-TC10: BOOKED còn xa giờ (hơn 2 giờ) có cancelAllowed=true; CANCELLED có cancelAllowed=false', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      const booked = await insertBooking(me, pt.trainerId, at(future, '08:00'));
      const cancelled = await insertBooking(me, pt.trainerId, at(future, '10:00'), { status: 'CANCELLED' });

      expect((await detail(me, booked).expect(200)).body.cancelAllowed).toBe(true);
      expect((await detail(me, cancelled).expect(200)).body.cancelAllowed).toBe(false);
    });

    it('US-27-TC10: BOOKED đã qua giờ vẫn giữ quota của gói (reserved đếm cả buổi quá giờ, CANCELLED không đếm)', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      await insertBooking(me, pt.trainerId, at(past, '08:00'));
      await insertBooking(me, pt.trainerId, at(past, '10:00'), { status: 'CANCELLED' });

      const response = await http().get(`/api/me/memberships/${me.membershipId.toHexString()}`).set('Origin', origin)
        .set('Authorization', `Bearer ${me.accessToken}`).expect(200);

      expect(response.body).toMatchObject({ sessionsQuota: 10, sessionsUsed: 0, sessionsReserved: 1, sessionsAvailable: 9 });
    });

    it('US-27-TC10: lịch riêng gồm cả BOOKED, COMPLETED, CANCELLED; lọc status=CANCELLED chỉ còn buổi đã hủy', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      const booked = await insertBooking(me, pt.trainerId, at(past, '08:00'));
      const completed = await insertBooking(me, pt.trainerId, at(past, '10:00'), { status: 'COMPLETED' });
      const cancelled = await insertBooking(me, pt.trainerId, at(past, '14:00'), { status: 'CANCELLED' });

      const all = await list(me, { fromDate: past, toDate: past }).expect(200);
      expect(ids(all.body)).toEqual([booked, completed, cancelled]);

      const onlyCancelled = await list(me, { fromDate: past, toDate: past, status: 'CANCELLED' }).expect(200);
      expect(ids(onlyCancelled.body)).toEqual([cancelled]);
    });

    it('US-27-TC10: booking CANCELLED không chặn slot mới cùng giờ của PT', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const pt = await trainer();
      const shiftId = new ObjectId();
      const now = new Date();
      await db().collection('work_shifts').insertOne({
        _id: shiftId, id: shiftId, trainer_id: pt.trainerId, start_at: at(future, '08:00'), end_at: at(future, '09:00'),
        location: 'Phòng PT 1', status: 'CONFIRMED', version: 1, created_by: new ObjectId(), updated_by: new ObjectId(),
        created_at: now, updated_at: now,
      });
      await insertBooking(other, pt.trainerId, at(future, '08:00'), { status: 'CANCELLED', shiftId });

      const response = await http().get(`/api/me/pt-trainers/${pt.trainerId.toHexString()}/availability`)
        .query({ fromDate: future, toDate: future }).set('Origin', origin).set('Authorization', `Bearer ${me.accessToken}`).expect(200);

      expect(response.body.slots.map((slot: { startAt: string }) => new Date(slot.startAt).toISOString()))
        .toEqual([at(future, '08:00').toISOString()]);
    });
  });

  describe('US-27-TC11: biên ngày VN và query quá 31 ngày', () => {
    it('US-27-TC11: buổi 00:00 giờ VN thuộc đúng ngày đó, không thuộc ngày hôm trước (dù UTC là 17:00 hôm trước)', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      const day = vnDay(5);
      const dayBefore = vnDay(4);
      const midnight = await insertBooking(me, pt.trainerId, at(day, '00:00'));

      expect(ids((await list(me, { fromDate: day, toDate: day }).expect(200)).body)).toEqual([midnight]);
      expect(ids((await list(me, { fromDate: dayBefore, toDate: dayBefore }).expect(200)).body)).toEqual([]);
    });

    it('US-27-TC11: buổi 23:00 giờ VN thuộc đúng ngày đó, không thuộc ngày hôm sau', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      const day = vnDay(5);
      const dayAfter = vnDay(6);
      const late = await insertBooking(me, pt.trainerId, at(day, '23:00'));

      expect(ids((await list(me, { fromDate: day, toDate: day }).expect(200)).body)).toEqual([late]);
      expect(ids((await list(me, { fromDate: dayAfter, toDate: dayAfter }).expect(200)).body)).toEqual([]);
    });

    it('US-27-TC11: fromDate và toDate đều được tính (bao gồm hai ngày đầu/cuối)', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      const first = await insertBooking(me, pt.trainerId, at(vnDay(5), '08:00'));
      const last = await insertBooking(me, pt.trainerId, at(vnDay(7), '20:00'));

      const response = await list(me, { fromDate: vnDay(5), toDate: vnDay(7) }).expect(200);
      expect(ids(response.body)).toEqual([first, last]);
    });

    it('US-27-TC11: khoảng đúng 31 ngày → 200; 32 ngày → 400', async () => {
      const me = await linkedMember();
      await list(me, { fromDate: vnDay(1), toDate: vnDay(31) }).expect(200);
      expectError(await list(me, { fromDate: vnDay(1), toDate: vnDay(32) }), 400);
    });

    it('US-27-TC11: ngày không có thật, sai định dạng hoặc toDate trước fromDate → 400', async () => {
      const me = await linkedMember();
      expectError(await list(me, { fromDate: '2027-02-30', toDate: '2027-03-01' }), 400);
      expectError(await list(me, { fromDate: '01/03/2027', toDate: '2027-03-02' }), 400);
      expectError(await list(me, { fromDate: vnDay(5), toDate: vnDay(4) }), 400);
    });

    it('US-27-TC11: query gửi memberId của người khác → 400, không trả lịch của họ', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const pt = await trainer();
      const theirs = await insertBooking(other, pt.trainerId, at(future, '08:00'));

      const response = await list(me, { fromDate: future, toDate: future, memberId: other.memberId.toHexString() });

      expectError(response, 400);
      expect(JSON.stringify(response.body)).not.toContain(theirs);
    });

    it('US-27-TC11: slot trống cũng giới hạn 31 ngày: availability 32 ngày → 400', async () => {
      const me = await linkedMember();
      const pt = await trainer();
      const response = await http().get(`/api/me/pt-trainers/${pt.trainerId.toHexString()}/availability`)
        .query({ fromDate: vnDay(1), toDate: vnDay(32) }).set('Origin', origin).set('Authorization', `Bearer ${me.accessToken}`);
      expectError(response, 400);
    });
  });
});
