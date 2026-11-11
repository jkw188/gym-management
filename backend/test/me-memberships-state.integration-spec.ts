// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-17 bước 2.
// Kiểm tra kỳ gói của Member: timeState theo ngày Việt Nam, gói không cấp quyền, quota PT, snapshot lúc bán (TC05–TC08).
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
// Hợp đồng test đặt ra cho Builder (US-17 bước 2, theo F02, F03 và mục 2 của spec):
//   Mỗi kỳ gói (danh sách và chi tiết GET /api/me/memberships[/:id]) có:
//     storedStatus  = memberships.status giữ nguyên như DB (ACTIVE/SUPERSEDED/CANCELLED), GET không sửa DB.
//     timeState     = CURRENT nếu start_date <= hôm nay (giờ VN) <= end_date; SCHEDULED nếu chưa tới; EXPIRED nếu đã qua.
//     sessionsQuota = sessions_snapshot của sale; sessionsUsed = memberships.sessions_used (không cộng qua nhiều phiên bản gói);
//     sessionsReserved = số pt_bookings BOOKED của chính membership; sessionsAvailable = max(quota − used − reserved, 0).
//   "Cấp quyền hiện tại" kiểm qua bộ lọc của spec: storedStatus=ACTIVE&timeState=CURRENT.
//   Tên, quyền lợi, giá, kỳ, quota lấy từ snapshot của sale, không đọc lại plans hiện tại (test kiểm theo giá trị).
//   US-14/16/22 và US-28 chưa có → test ghi thẳng plans, transactions, service_sales, memberships, payments, invoices,
//   pt_bookings theo báo cáo mục 4.2.9–4.2.13, 4.2.23, 4.2.24.

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us17_state';
const password = 'MậtKhẩuUS-17-456';

// Chỉ giả Date; các timer khác chạy thật để MongoDB và Nest hoạt động bình thường.
const realTimers = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout'] as const;

// Ngày hôm nay theo giờ Việt Nam dạng YYYY-MM-DD, và cộng/trừ ngày lịch.
const vietnamDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
const todayVn = () => vietnamDate.format(new Date());
function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

type Auth = { accessToken: string };
type Kind = 'GYM' | 'PT';
type PurchaseOptions = {
  kind?: Kind;
  transactionStatus?: 'PENDING' | 'SETTLED' | 'CANCELLED';
  // null = chưa có membership (sale chưa thu tiền).
  membershipStatus?: 'ACTIVE' | 'SUPERSEDED' | 'CANCELLED' | null;
  startDate?: string;
  endDate?: string;
  amount?: number;
  sessions?: number;
  sessionsUsed?: number;
  operation?: 'REGISTER' | 'RENEW' | 'UPGRADE';
  previousSaleId?: ObjectId;
  planName?: string;
  benefits?: string;
};
type Purchase = { planId: ObjectId; transactionId: ObjectId; saleId: ObjectId; membershipId: ObjectId | null };

describe('US-17 bước 2: trạng thái, quota và snapshot kỳ gói của Member', () => {
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
      SMTP_USER: 'us17-test', SMTP_PASS: 'us17-test', SMTP_FROM: 'no-reply@gym.test',
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

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());
  const money = (vnd: number) => Decimal128.fromString(String(vnd));

  // ---------- Chuẩn bị: account MEMBER thật, hồ sơ đã liên kết (đúng khuôn US-09) ----------
  let seq = 0;
  async function linkedMember() {
    const users = app.get(UsersRepository);
    const role = await users.ensureRole('MEMBER', 'MEMBER');
    seq += 1;
    const phone = `09117100${String(seq).padStart(2, '0')}`;
    const account = await users.createAccount({
      roleId: role.id.toHexString(), phone, fullName: `US17 Member ${seq}`, passwordHash: await app.get(PasswordService).hash(password),
    });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, account_id: account.id, member_code: `HV-${memberId.toHexString()}`,
      full_name: `Hội viên US17 ${seq}`, phone, version: 0, service_revision: 0n, created_by: staffId, updated_by: staffId,
    });
    return { accessToken: response.body.accessToken as string, memberId };
  }

  // Một lần bán gói (thay cho US-14/16/22). Mặc định: GYM, đã thu tiền, membership ACTIVE, kỳ đang hiệu lực.
  async function insertPurchase(memberId: ObjectId, options: PurchaseOptions = {}): Promise<Purchase> {
    seq += 1;
    const today = todayVn();
    const kind = options.kind ?? 'GYM';
    const transactionStatus = options.transactionStatus ?? 'SETTLED';
    const membershipStatus = options.membershipStatus === undefined ? 'ACTIVE' : options.membershipStatus;
    const amount = options.amount ?? 1500000;
    const sessions = options.sessions ?? (kind === 'PT' ? 10 : 0);
    const planName = options.planName ?? `Gói ${kind} ${seq}`;
    const benefits = options.benefits ?? `Quyền lợi gói ${kind} ${seq}`;
    const planId = new ObjectId();
    const transactionId = new ObjectId();
    const saleId = new ObjectId();
    const staffId = new ObjectId();
    const now = new Date();
    await db().collection('plans').insertOne({
      _id: planId, id: planId, code: `${kind}-US17-${seq}`, name: planName, kind, duration_days: 30,
      session_quota: sessions, price: money(amount), benefits, status: 'ACTIVE',
    });
    await db().collection('transactions').insertOne({
      _id: transactionId, id: transactionId, member_id: memberId, created_by: staffId, code: `GD-US17-${seq}`, kind,
      amount_due: money(amount), status: transactionStatus, request_key: `us17-state-${transactionId.toHexString()}`,
      created_at: now, guard_revision: 0n,
    });
    const sale: Record<string, unknown> = {
      _id: saleId, id: saleId, transaction_id: transactionId, member_id: memberId, plan_id: planId,
      operation: options.operation ?? 'REGISTER', start_date: options.startDate ?? addDays(today, -5),
      end_date: options.endDate ?? addDays(today, 24), plan_name_snapshot: planName, benefits_snapshot: benefits,
      list_price_snapshot: money(amount), credit_amount: money(0), sessions_snapshot: sessions,
      policy_snapshot: 'Giá niêm yết, 30 ngày', created_at: now,
    };
    if (options.previousSaleId) sale.previous_sale_id = options.previousSaleId;
    await db().collection('service_sales').insertOne(sale);
    if (transactionStatus === 'SETTLED') {
      const paymentId = new ObjectId();
      const invoiceId = new ObjectId();
      await db().collection('payments').insertOne({
        _id: paymentId, id: paymentId, transaction_id: transactionId, method: 'CASH', reference: `BN-US17-${seq}`,
        amount: money(amount), status: 'SUCCEEDED', verified_by: staffId, paid_at: now,
      });
      await db().collection('invoices').insertOne({
        _id: invoiceId, id: invoiceId, transaction_id: transactionId, invoice_no: `HD-US17-${seq}`, issued_at: now,
        total_amount: money(amount), buyer_snapshot: `Hội viên US17 - ${seq}`,
      });
    }
    let membershipId: ObjectId | null = null;
    if (membershipStatus) {
      membershipId = new ObjectId();
      await db().collection('memberships').insertOne({
        _id: membershipId, id: membershipId, service_sale_id: saleId, status: membershipStatus,
        sessions_used: options.sessionsUsed ?? 0,
      });
    }
    return { planId, transactionId, saleId, membershipId };
  }

  // Buổi PT mẫu (thay cho US-28) theo báo cáo mục 4.2.13; BOOKED đặt ở tương lai.
  async function insertBooking(membershipId: ObjectId, status: 'BOOKED' | 'COMPLETED' | 'CANCELLED', dayOffset: number) {
    const id = new ObjectId();
    const startAt = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
    const doc: Record<string, unknown> = {
      _id: id, id, membership_id: membershipId, trainer_id: new ObjectId(), shift_id: new ObjectId(),
      start_at: startAt, end_at: new Date(startAt.getTime() + 60 * 60 * 1000), status,
      request_key: `us17-booking-${id.toHexString()}`, created_at: new Date(),
    };
    if (status === 'COMPLETED') doc.completed_at = new Date(startAt.getTime() + 60 * 60 * 1000);
    await db().collection('pt_bookings').insertOne(doc);
  }

  function get(user: Auth, path: string, query: Record<string, string | number> = {}) {
    return http().get(path).query(query).set('Origin', origin).set('Authorization', `Bearer ${user.accessToken}`);
  }

  async function listMemberships(user: Auth, query: Record<string, string> = {}) {
    const response = await get(user, '/api/me/memberships', query).expect(200);
    return response.body.items as Array<Record<string, any>>;
  }

  const byId = (items: Array<Record<string, any>>, id: ObjectId | null) => items.find(item => item.id === id?.toHexString());

  // Ảnh chụp dữ liệu gói, để chứng minh GET không đổi trạng thái ngầm.
  async function snapshot() {
    const result: Record<string, unknown[]> = {};
    for (const name of ['transactions', 'service_sales', 'memberships', 'pt_bookings']) {
      result[name] = await db().collection(name).find({}).sort({ _id: 1 }).toArray();
    }
    return result;
  }

  // =====================================================================
  // AC02 – Trạng thái, ngày, quota, snapshot đúng (TC05–TC08)
  // =====================================================================

  describe('US-17-AC02', () => {
    // ---------- TC05: timeState theo ngày VN, storedStatus không đổi ngầm ----------

    it('US-17-TC05: gói bắt đầu đúng hôm nay (ngày đầu) → timeState CURRENT, storedStatus ACTIVE', async () => {
      const me = await linkedMember();
      const today = todayVn();
      const first = await insertPurchase(me.memberId, { startDate: today, endDate: addDays(today, 29) });

      const item = byId(await listMemberships(me), first.membershipId);
      expect(item).toMatchObject({ timeState: 'CURRENT', storedStatus: 'ACTIVE' });
      const detail = await get(me, `/api/me/memberships/${first.membershipId!.toHexString()}`).expect(200);
      expect(detail.body).toMatchObject({ timeState: 'CURRENT', storedStatus: 'ACTIVE' });
    });

    it('US-17-TC05: hôm nay là ngày cuối của kỳ → vẫn CURRENT (ngày cuối được tính là còn dùng)', async () => {
      const me = await linkedMember();
      const today = todayVn();
      const last = await insertPurchase(me.memberId, { startDate: addDays(today, -29), endDate: today });

      const item = byId(await listMemberships(me), last.membershipId);
      expect(item).toMatchObject({ timeState: 'CURRENT', storedStatus: 'ACTIVE' });
    });

    it('US-17-TC05: gói bắt đầu từ ngày mai → SCHEDULED; gói kết thúc hôm qua → EXPIRED; storedStatus vẫn ACTIVE', async () => {
      const me = await linkedMember();
      const today = todayVn();
      const future = await insertPurchase(me.memberId, { startDate: addDays(today, 1), endDate: addDays(today, 30) });
      const expired = await insertPurchase(me.memberId, { startDate: addDays(today, -30), endDate: addDays(today, -1) });

      const items = await listMemberships(me);
      expect(byId(items, future.membershipId)).toMatchObject({ timeState: 'SCHEDULED', storedStatus: 'ACTIVE' });
      expect(byId(items, expired.membershipId)).toMatchObject({ timeState: 'EXPIRED', storedStatus: 'ACTIVE' });
    });

    it('US-17-TC05: lọc timeState=CURRENT/SCHEDULED/EXPIRED trả đúng gói, total đúng', async () => {
      const me = await linkedMember();
      const today = todayVn();
      const current = await insertPurchase(me.memberId, { startDate: today, endDate: addDays(today, 29) });
      const lastDay = await insertPurchase(me.memberId, { startDate: addDays(today, -29), endDate: today });
      const future = await insertPurchase(me.memberId, { startDate: addDays(today, 1), endDate: addDays(today, 30) });
      const expired = await insertPurchase(me.memberId, { startDate: addDays(today, -30), endDate: addDays(today, -1) });

      const ids = (items: Array<Record<string, any>>) => items.map(item => item.id).sort();
      const hex = (...values: Array<ObjectId | null>) => values.map(value => value!.toHexString()).sort();

      const currentPage = await get(me, '/api/me/memberships', { timeState: 'CURRENT' }).expect(200);
      expect(ids(currentPage.body.items)).toEqual(hex(current.membershipId, lastDay.membershipId));
      expect(currentPage.body.total).toBe(2);
      expect(ids(await listMemberships(me, { timeState: 'SCHEDULED' }))).toEqual(hex(future.membershipId));
      expect(ids(await listMemberships(me, { timeState: 'EXPIRED' }))).toEqual(hex(expired.membershipId));
    });

    it('US-17-TC05: GET không tự đổi gói hết hạn thành trạng thái khác trong DB (storedStatus không đổi ngầm)', async () => {
      const me = await linkedMember();
      const today = todayVn();
      const expired = await insertPurchase(me.memberId, { startDate: addDays(today, -30), endDate: addDays(today, -1) });
      const before = await snapshot();

      await listMemberships(me);
      await get(me, `/api/me/memberships/${expired.membershipId!.toHexString()}`).expect(200);
      await listMemberships(me, { timeState: 'EXPIRED' });

      expect(await snapshot()).toEqual(before);
      expect((await db().collection('memberships').findOne({ _id: expired.membershipId! }))?.status).toBe('ACTIVE');
    });

    it('US-17-TC05: 00:30 ngày 05/11 giờ VN (UTC vẫn là 04/11) → gói bắt đầu 05/11 là CURRENT, gói kết thúc 04/11 là EXPIRED', async () => {
      // 2026-11-04T17:30:00Z = 00:30 ngày 05/11/2026 ở Việt Nam (UTC+7).
      jest.useFakeTimers({ doNotFake: [...realTimers], now: new Date('2026-11-04T17:30:00.000Z') });
      const me = await linkedMember();
      const startsToday = await insertPurchase(me.memberId, { startDate: '2026-11-05', endDate: '2026-12-04' });
      const endedYesterday = await insertPurchase(me.memberId, { startDate: '2026-10-06', endDate: '2026-11-04' });

      const items = await listMemberships(me);
      expect(byId(items, startsToday.membershipId)).toMatchObject({ timeState: 'CURRENT' });
      expect(byId(items, endedYesterday.membershipId)).toMatchObject({ timeState: 'EXPIRED' });
    });

    it('US-17-TC05: 23:59 ngày 05/11 giờ VN (UTC đã 16:59) → gói kết thúc 05/11 vẫn CURRENT, gói bắt đầu 06/11 vẫn SCHEDULED', async () => {
      // 2026-11-05T16:59:00Z = 23:59 ngày 05/11/2026 ở Việt Nam.
      jest.useFakeTimers({ doNotFake: [...realTimers], now: new Date('2026-11-05T16:59:00.000Z') });
      const me = await linkedMember();
      const endsToday = await insertPurchase(me.memberId, { startDate: '2026-10-07', endDate: '2026-11-05' });
      const startsTomorrow = await insertPurchase(me.memberId, { startDate: '2026-11-06', endDate: '2026-12-05' });

      const items = await listMemberships(me);
      expect(byId(items, endsToday.membershipId)).toMatchObject({ timeState: 'CURRENT' });
      expect(byId(items, startsTomorrow.membershipId)).toMatchObject({ timeState: 'SCHEDULED' });
    });

    // ---------- TC06: PENDING/CANCELLED và SUPERSEDED không cấp quyền hiện tại, lịch sử vẫn xem được ----------

    it('US-17-TC06: sale PENDING (chưa thu tiền) không thành gói đã có, nhưng vẫn xem được trong lịch sử mua', async () => {
      const me = await linkedMember();
      const pending = await insertPurchase(me.memberId, { transactionStatus: 'PENDING', membershipStatus: null });

      const memberships = await get(me, '/api/me/memberships').expect(200);
      expect(memberships.body).toMatchObject({ memberLinked: true, items: [], total: 0 });
      expect(await listMemberships(me, { storedStatus: 'ACTIVE', timeState: 'CURRENT' })).toEqual([]);

      const sales = await get(me, '/api/me/service-sales').expect(200);
      expect(sales.body.items.map((item: { id: string }) => item.id)).toEqual([pending.saleId.toHexString()]);
      expect(sales.body.items[0].status).toBe('PENDING');
      const detail = await get(me, `/api/me/service-sales/${pending.saleId.toHexString()}`).expect(200);
      expect(detail.body.status).toBe('PENDING');
      // Chưa thu thì giao dịch không có khoản thu "đã trả".
      const transaction = await get(me, `/api/me/transactions/${pending.transactionId.toHexString()}`).expect(200);
      expect(transaction.body.status).toBe('PENDING');
      expect(JSON.stringify(transaction.body)).not.toContain('paidAt');
    });

    it('US-17-TC06: sale CANCELLED có gói CANCELLED → không cấp quyền hiện tại, lịch sử mua vẫn hiện CANCELLED', async () => {
      const me = await linkedMember();
      const cancelled = await insertPurchase(me.memberId, { transactionStatus: 'CANCELLED', membershipStatus: 'CANCELLED' });

      expect(byId(await listMemberships(me, { storedStatus: 'ACTIVE', timeState: 'CURRENT' }), cancelled.membershipId)).toBeUndefined();

      const sales = await get(me, '/api/me/service-sales').expect(200);
      const sale = sales.body.items.find((item: { id: string }) => item.id === cancelled.saleId.toHexString());
      expect(sale?.status).toBe('CANCELLED');
      const detail = await get(me, `/api/me/service-sales/${cancelled.saleId.toHexString()}`).expect(200);
      expect(detail.body.status).toBe('CANCELLED');
    });

    it('US-17-TC06: gói SUPERSEDED sau nâng cấp vẫn trong kỳ → không cấp quyền hiện tại, chỉ gói mới ACTIVE; gói cũ vẫn xem được', async () => {
      const me = await linkedMember();
      const old = await insertPurchase(me.memberId, { membershipStatus: 'SUPERSEDED' });
      const upgraded = await insertPurchase(me.memberId, { operation: 'UPGRADE', previousSaleId: old.saleId });

      const all = await listMemberships(me);
      expect(byId(all, old.membershipId)).toMatchObject({ storedStatus: 'SUPERSEDED' });
      expect(byId(all, upgraded.membershipId)).toMatchObject({ storedStatus: 'ACTIVE' });

      const granting = await listMemberships(me, { storedStatus: 'ACTIVE', timeState: 'CURRENT' });
      expect(granting.map(item => item.id)).toEqual([upgraded.membershipId!.toHexString()]);

      const detail = await get(me, `/api/me/memberships/${old.membershipId!.toHexString()}`).expect(200);
      expect(detail.body).toMatchObject({ id: old.membershipId!.toHexString(), storedStatus: 'SUPERSEDED' });
      // Nhãn nguồn: gói mới trỏ về sale bị thay thế.
      const upgradedDetail = await get(me, `/api/me/memberships/${upgraded.membershipId!.toHexString()}`).expect(200);
      expect(JSON.stringify(upgradedDetail.body)).toContain(old.saleId.toHexString());
    });

    it('US-17-TC06: lọc storedStatus=SUPERSEDED và CANCELLED trả đúng gói lịch sử', async () => {
      const me = await linkedMember();
      const superseded = await insertPurchase(me.memberId, { membershipStatus: 'SUPERSEDED' });
      await insertPurchase(me.memberId, { transactionStatus: 'CANCELLED', membershipStatus: 'CANCELLED' });
      const active = await insertPurchase(me.memberId);

      expect((await listMemberships(me, { storedStatus: 'SUPERSEDED' })).map(item => item.id))
        .toEqual([superseded.membershipId!.toHexString()]);
      // Spec chưa nói gói CANCELLED có nằm trong danh sách kỳ gói hay chỉ trong lịch sử mua; test chỉ chắc chắn
      // bộ lọc CANCELLED không trả gói ở trạng thái khác.
      const cancelledItems = await listMemberships(me, { storedStatus: 'CANCELLED' });
      expect(cancelledItems.every(item => item.storedStatus === 'CANCELLED')).toBe(true);
      expect(byId(cancelledItems, superseded.membershipId)).toBeUndefined();
      expect(byId(cancelledItems, active.membershipId)).toBeUndefined();
    });

    // ---------- TC07: quota PT có phần mang sang và BOOKED ----------

    it('US-17-TC07: gói PT nâng cấp mang sang 3 buổi đã dùng, 2 BOOKED → used 4, reserved 2, available 14; không cộng trùng gói cũ', async () => {
      const me = await linkedMember();
      // Gói cũ 10 buổi đã dùng 3, bị thay thế; gói mới 20 buổi nhận used=3 mang sang rồi tập thêm 1 → used 4.
      const old = await insertPurchase(me.memberId, { kind: 'PT', sessions: 10, sessionsUsed: 3, membershipStatus: 'SUPERSEDED' });
      const upgraded = await insertPurchase(me.memberId, {
        kind: 'PT', sessions: 20, sessionsUsed: 4, operation: 'UPGRADE', previousSaleId: old.saleId,
      });
      // Buổi đã dạy ở gói cũ giữ ở gói cũ; gói mới có 2 BOOKED, 1 COMPLETED, 1 CANCELLED.
      await insertBooking(old.membershipId!, 'COMPLETED', -10);
      await insertBooking(upgraded.membershipId!, 'BOOKED', 2);
      await insertBooking(upgraded.membershipId!, 'BOOKED', 3);
      await insertBooking(upgraded.membershipId!, 'COMPLETED', -1);
      await insertBooking(upgraded.membershipId!, 'CANCELLED', 4);

      const detail = await get(me, `/api/me/memberships/${upgraded.membershipId!.toHexString()}`).expect(200);
      expect(detail.body).toMatchObject({ sessionsQuota: 20, sessionsUsed: 4, sessionsReserved: 2, sessionsAvailable: 14 });

      const items = await listMemberships(me, { kind: 'PT' });
      expect(byId(items, upgraded.membershipId)).toMatchObject({ sessionsQuota: 20, sessionsUsed: 4, sessionsReserved: 2, sessionsAvailable: 14 });
      // Gói cũ giữ đúng số đã dùng, không bị reset về 0 và không có BOOKED.
      expect(byId(items, old.membershipId)).toMatchObject({ sessionsQuota: 10, sessionsUsed: 3, sessionsReserved: 0 });
    });

    it('US-17-TC07: quota − used − reserved âm thì available = 0, không ra số âm', async () => {
      const me = await linkedMember();
      const pt = await insertPurchase(me.memberId, { kind: 'PT', sessions: 5, sessionsUsed: 4 });
      for (const day of [1, 2, 3]) await insertBooking(pt.membershipId!, 'BOOKED', day);

      const detail = await get(me, `/api/me/memberships/${pt.membershipId!.toHexString()}`).expect(200);
      expect(detail.body).toMatchObject({ sessionsQuota: 5, sessionsUsed: 4, sessionsReserved: 3, sessionsAvailable: 0 });
    });

    it('US-17-TC07: gói PT chưa có booking nào → reserved 0, available = quota − used', async () => {
      const me = await linkedMember();
      const pt = await insertPurchase(me.memberId, { kind: 'PT', sessions: 12, sessionsUsed: 2 });

      const detail = await get(me, `/api/me/memberships/${pt.membershipId!.toHexString()}`).expect(200);
      expect(detail.body).toMatchObject({ sessionsQuota: 12, sessionsUsed: 2, sessionsReserved: 0, sessionsAvailable: 10 });
    });

    it('US-17-TC07: BOOKED của gói PT người khác không bị tính vào reserved của mình', async () => {
      const me = await linkedMember();
      const other = await linkedMember();
      const mine = await insertPurchase(me.memberId, { kind: 'PT', sessions: 10, sessionsUsed: 1 });
      const theirs = await insertPurchase(other.memberId, { kind: 'PT', sessions: 10, sessionsUsed: 1 });
      await insertBooking(mine.membershipId!, 'BOOKED', 1);
      for (const day of [1, 2, 3]) await insertBooking(theirs.membershipId!, 'BOOKED', day);

      const detail = await get(me, `/api/me/memberships/${mine.membershipId!.toHexString()}`).expect(200);
      expect(detail.body).toMatchObject({ sessionsReserved: 1, sessionsAvailable: 8 });
    });

    // ---------- TC08: danh mục đổi sau khi mua → hiển thị theo snapshot của sale ----------

    it('US-17-TC08: đổi tên/quyền lợi/giá/thời hạn/số buổi của gói sau khi mua → gói của tôi vẫn hiện theo snapshot lúc bán', async () => {
      const me = await linkedMember();
      const today = todayVn();
      const bought = await insertPurchase(me.memberId, {
        kind: 'PT', sessions: 10, amount: 2400000, startDate: addDays(today, -3), endDate: addDays(today, 26),
        planName: 'PT 10 buổi bản bán ra', benefits: 'Quyền lợi lúc bán: 10 buổi PT',
      });
      // Admin sửa danh mục sau khi bán (US-12).
      await db().collection('plans').updateOne({ _id: bought.planId }, { $set: {
        name: 'PT 10 buổi ĐÃ ĐỔI TÊN', benefits: 'Quyền lợi MỚI sau khi sửa', price: money(3900000), duration_days: 90, session_quota: 30,
      } });

      const membership = await get(me, `/api/me/memberships/${bought.membershipId!.toHexString()}`).expect(200);
      const text = JSON.stringify(membership.body);
      expect(text).toContain('PT 10 buổi bản bán ra');
      expect(text).toContain('Quyền lợi lúc bán: 10 buổi PT');
      expect(text).toContain(addDays(today, 26));
      expect(membership.body.sessionsQuota).toBe(10);
      expect(text).not.toContain('ĐÃ ĐỔI TÊN');
      expect(text).not.toContain('Quyền lợi MỚI');
      expect(text).not.toContain('3900000');

      const sale = await get(me, `/api/me/service-sales/${bought.saleId.toHexString()}`).expect(200);
      const saleText = JSON.stringify(sale.body);
      expect(saleText).toContain('PT 10 buổi bản bán ra');
      expect(saleText).toContain('"2400000"');
      expect(saleText).not.toContain('3900000');
      expect(saleText).not.toContain('ĐÃ ĐỔI TÊN');
    });

    it('US-17-TC08: gói bị ngừng bán (plans INACTIVE) sau khi mua → vẫn xem được gói và lần mua của mình', async () => {
      const me = await linkedMember();
      const bought = await insertPurchase(me.memberId, { planName: 'Gói GYM đã ngừng bán sau này' });
      await db().collection('plans').updateOne({ _id: bought.planId }, { $set: { status: 'INACTIVE' } });

      const membership = await get(me, `/api/me/memberships/${bought.membershipId!.toHexString()}`).expect(200);
      expect(JSON.stringify(membership.body)).toContain('Gói GYM đã ngừng bán sau này');
      await get(me, `/api/me/service-sales/${bought.saleId.toHexString()}`).expect(200);
    });
  });
});
