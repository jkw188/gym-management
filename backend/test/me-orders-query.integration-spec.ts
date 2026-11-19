// Tầng kiểm thử backend (Jest + Supertest + MongoDB replica set thật): US-42 bước 1 – Own Order Query Service.
// Member xem danh sách/chi tiết đơn của mình, hướng dẫn thanh toán và hóa đơn qua đơn; kiểm quyền sở hữu, dữ liệu an toàn, 3 lớp trạng thái (TC01–TC08).
// Hợp đồng test đặt ra cho Builder (theo mục 1 và 2 của spec US-42 1.0):
//   GET /api/me/orders?status&channel&fromDate&toDate&page&limit → 200 {memberLinked, items, page, limit, total, totalPages, asOf};
//     item: {id, code, channel, status, transactionStatus, total, reservationExpiresAt, refundState, ...}; sắp createdAt DESC rồi id DESC;
//     page 1, limit 20 (tối đa 100), ngày YYYY-MM-DD giờ Việt Nam, bao gồm 2 đầu, tối đa 366 ngày, mặc định 30 ngày gần nhất; query lạ → 400.
//   GET /api/me/orders/:id → 200 {id, code, channel, status, version, reservationState, reservationExpiresAt, expired, cancelAllowed,
//     paymentAllowed, transactionStatus, refundState, refundAmount, invoiceId?, items snapshot, recipient, quầy ...}.
//   GET /api/me/orders/:id/payment-instructions → 200 {transactionCode, amountDue, preferredPaymentMethod, pickupLocation, cashInstructions, transferOptions?}
//     chỉ khi đơn HELD chưa hết hạn và transaction PENDING, amountDue > 0; ngược lại không trả hướng dẫn (test chờ 409).
//   GET /api/me/orders/:id/invoice → 200 {invoiceNo, retailLines, thông tin thanh toán method/amount/paidAt}; chưa có invoice → 404.
//   Đơn của Member khác/không có → 404; sai role → 403; không token → 401; ID sai → 400. Tiền là chuỗi số nguyên VND.
// Dữ liệu đơn/giao dịch/thanh toán/hoàn được ghi thẳng vào DB làm fixture (US-41/45 đã có writer thật và test riêng);
// catalog dùng API admin thật. Bước 2 (hủy own: TC09–TC11) và bước 3 (giao diện: TC12) chưa có trong file này.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Int32, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { ensureFinancialIntegrity } from '../src/infrastructure/transaction/financial-integrity';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { ensureRetailCatalogIntegrity } from '../src/modules/catalog/retail-catalog.migration';
import { UsersRepository } from '../src/modules/users/users.repository';

// 03:00 UTC = 10:00 ngày 14/11/2035 giờ Việt Nam.
const NOW = '2035-11-14T03:00:00.000Z';
const origin = 'http://localhost:5173';
const password = 'MậtKhẩuUS-42-query';
const PICKUP = 'Quầy lễ tân tầng 1 – kiểm thử US42';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
// Tài khoản nhận chuyển khoản giả của môi trường test (không phải tài khoản thật).
const BANK_ACCOUNT_NUMBER = '9990001112';
const BANK_DETAILS = [{ code: 'GYM_MAIN', bankName: 'TEST ONLY Bank', accountNumber: BANK_ACCOUNT_NUMBER, accountName: 'TEST ONLY GYM' }];
// Dữ liệu nội bộ không được lộ ra API của Member (US-42-F03).
const SECRET_BANK_REFERENCE = 'SECRET_BANK_REF_US42';
const SECRET_EVIDENCE = 'Ghi chú đối soát nội bộ US42 không được lộ';
// Các collection mà một lệnh GET KHÔNG được phép thay đổi (US-42-F03, TC04, TC08).
const WATCHED = ['orders', 'order_items', 'order_events', 'transactions', 'payments', 'invoices', 'refunds', 'inventory', 'stock_movements',
  'members', 'notifications', 'notification_recipients', 'operation_requests', 'products'];

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Actor = { accountId: string; token: string; phone: string };
type SeedOptions = {
  memberId?: ObjectId | null;         // null = POS ẩn danh (không gắn member)
  channel?: 'WEBSITE' | 'POS';
  status?: 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
  transactionStatus?: 'PENDING' | 'SETTLED' | 'CANCELLED';
  free?: boolean;                     // tổng đơn 0 đồng
  createdAt?: Date;
  createdBy?: string;                 // account tạo đơn (Member hoặc Staff tại POS)
  refund?: 'PENDING' | 'FAILED' | 'SUCCEEDED';
  method?: 'CASH' | 'TRANSFER';
  productId?: ObjectId;
  orderId?: ObjectId;
};

describe('US-42 bước 1: Member xem đơn của mình (Own Order Query Service)', () => {
  const saved = { ...process.env };
  const clock = new ServerClock();
  let now = NOW;
  clock.now = () => new Date(now);
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  // App phụ thiếu cấu hình ngân hàng (TC07): chỉ đóng ở afterAll để app chính không mất kết nối DB.
  let noBankApp: INestApplication | undefined;
  let connection: Connection;
  let admin: Actor;
  let staff: Actor;
  let sequence = 0;
  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());

  async function createApp() {
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
    const instance = module.createNestApplication({ logger: false, bodyParser: false });
    configureHttp(instance);
    await instance.init();
    return instance;
  }

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, {
      NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: `gym_test_us42_query_${randomBytes(4).toString('hex')}`, FRONTEND_ORIGIN: origin,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RETAIL_QUOTE_SECRET: randomBytes(32).toString('base64url'),
      PICKUP_LOCATION: PICKUP, RECEIVING_ACCOUNTS: '["GYM_MAIN"]', RECEIVING_ACCOUNT_DETAILS: JSON.stringify(BANK_DETAILS),
      RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
    });
    app = await createApp();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    await ensureFinancialIntegrity(connection);
  }, 600000);

  beforeEach(async () => {
    now = NOW;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Mỗi test dùng bộ đếm đăng nhập mới để không bị 429 vì đăng nhập nhiều tài khoản fixture.
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await db().collections()) {
      if (!['roles', 'security_state'].includes(collection.collectionName)) await collection.deleteMany({});
    }
    await ensureRetailCatalogIntegrity(connection);
    admin = await login('ADMIN');
    staff = await login('STAFF');
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await noBankApp?.close();
    await app?.close();
    await mongo?.stop();
    process.env = saved;
  });

  // ---------- Tài khoản và hồ sơ Member ----------
  async function login(role: Role, server: INestApplication = app): Promise<Actor> {
    const users = app.get(UsersRepository);
    const roleDoc = await users.ensureRole(role, role);
    const phone = `094202${String(++sequence).padStart(4, '0')}`;
    const created = await users.createAccount({ roleId: String(roleDoc.id), phone, fullName: `${role} US42`,
      passwordHash: await app.get(PasswordService).hash(password) });
    const result = await request(server.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { accountId: String(created.id), token: result.body.accessToken as string, phone };
  }

  // Tạo hồ sơ members; accountId undefined = hồ sơ chưa liên kết account nào.
  async function memberProfile(accountId: string | undefined, phone: string, fullName = 'Hội viên US42') {
    const id = new ObjectId(), at = new Date(NOW);
    await db().collection('members').insertOne({ _id: id, id, member_code: `HV-${id}`, full_name: fullName, phone: `+84${phone.slice(1)}`,
      ...(accountId ? { account_id: new ObjectId(accountId) } : {}), version: new Int32(0), service_revision: Long.ZERO,
      created_by: new ObjectId(admin.accountId), updated_by: new ObjectId(admin.accountId), created_at: at, updated_at: at });
    return id;
  }

  // Member đã đăng nhập và đã liên kết hồ sơ.
  async function linkedMember() {
    const actor = await login('MEMBER');
    const memberId = await memberProfile(actor.accountId, actor.phone);
    return { ...actor, memberId };
  }

  // ---------- Catalog thật qua API admin ----------
  async function product(): Promise<ObjectId> {
    const post = (path: string, body: object) => http().post(`/api${path}`).set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID()).send(body).expect(201);
    const category = await post('/admin/categories', { name: `US42 nhóm ${++sequence}`, status: 'ACTIVE' });
    const created = await post('/admin/products', { categoryId: category.body.id, sku: `US42_${++sequence}`, name: 'Tên snapshot', price: '25000', status: 'ACTIVE' });
    return new ObjectId(created.body.id as string);
  }

  // ---------- Fixture đơn RETAIL (1 dòng: 2 x 25000 = 50000) ----------
  async function seedOrder(options: SeedOptions = {}) {
    const orderId = options.orderId ?? new ObjectId(), transactionId = new ObjectId(), itemId = new ObjectId();
    const createdAt = options.createdAt ?? new Date(NOW), expiresAt = new Date(createdAt.getTime() + DAY);
    const status = options.status ?? 'CONFIRMED', transactionStatus = options.transactionStatus ?? 'PENDING';
    const unit = options.free ? '0' : '25000', total = options.free ? '0' : '50000';
    const settled = transactionStatus === 'SETTLED';
    const memberId = options.memberId === null ? undefined : options.memberId;
    const createdBy = new ObjectId(options.createdBy ?? staff.accountId);
    const reservationState = status === 'CANCELLED' ? 'RELEASED' : status === 'COMPLETED' ? 'CONSUMED' : 'HELD';
    await db().collection('transactions').insertOne({ _id: transactionId, id: transactionId, ...(memberId ? { member_id: memberId } : {}),
      created_by: createdBy, code: `TX-${transactionId}`, kind: 'RETAIL', status: transactionStatus, amount_due: Decimal128.fromString(total),
      request_key: createHash('sha256').update(String(transactionId)).digest('hex'), created_at: createdAt, guard_revision: Long.ZERO,
      version: new Int32(0), ...(settled ? { settled_at: createdAt } : {}) });
    await db().collection('orders').insertOne({ _id: orderId, id: orderId, transaction_id: transactionId, ...(memberId ? { member_id: memberId } : {}),
      code: `ORD-${orderId}`, channel: options.channel ?? 'WEBSITE', status, reservation_state: reservationState, reservation_expires_at: expiresAt,
      preferred_payment_method: options.method ?? 'CASH', recipient_name: 'Người nhận snapshot', recipient_phone: '+84901234567',
      pickup_location_snapshot: PICKUP, created_by: createdBy, created_at: createdAt, updated_at: createdAt, version: new Int32(3), guard_revision: Long.ZERO,
      ...(status !== 'PENDING' ? { confirmed_at: createdAt, confirmed_by: new ObjectId(staff.accountId) } : {}),
      ...(status === 'COMPLETED' ? { fulfilled_at: createdAt, fulfilled_by: new ObjectId(staff.accountId) } : {}),
      ...(status === 'CANCELLED' ? { cancelled_at: createdAt, cancelled_by: createdBy, cancellation_reason: 'Khách đổi ý không lấy hàng nữa', cancellation_source: 'USER' } : {}) });
    await db().collection('order_items').insertOne({ _id: itemId, id: itemId, order_id: orderId, product_id: options.productId ?? new ObjectId(),
      sku_snapshot: 'US42_SNAPSHOT', name_snapshot: 'Tên snapshot', product_version_snapshot: new Int32(0), quantity: new Int32(2),
      unit_price: Decimal128.fromString(unit), line_total: Decimal128.fromString(total) });
    let invoiceId: ObjectId | undefined, paymentId: ObjectId | undefined;
    if (settled) {
      invoiceId = new ObjectId();
      await db().collection('invoices').insertOne({ _id: invoiceId, id: invoiceId, transaction_id: transactionId, invoice_no: `INV-${orderId}`,
        total_amount: Decimal128.fromString(total), issued_at: createdAt, buyer_snapshot: 'Người nhận snapshot' });
      if (!options.free) {
        paymentId = new ObjectId();
        await db().collection('payments').insertOne({ _id: paymentId, id: paymentId, transaction_id: transactionId, method: 'CASH', status: 'SUCCEEDED',
          amount: Decimal128.fromString(total), reference: `FIXTURE:${orderId}`, verified_by: new ObjectId(staff.accountId), paid_at: createdAt,
          evidence_note: SECRET_EVIDENCE, bank_reference: SECRET_BANK_REFERENCE });
      }
    }
    if (options.refund && paymentId) {
      const refundId = new ObjectId();
      await db().collection('refunds').insertOne({ _id: refundId, id: refundId, order_id: orderId, payment_id: paymentId, reason: 'CANCELLATION',
        reference: `RF:${refundId}`, obligation_key: `CANCELLATION:${orderId}`, amount: Decimal128.fromString(total), status: options.refund,
        created_at: createdAt, actor_type: 'USER', version: new Int32(0),
        ...(options.refund === 'SUCCEEDED' ? { refunded_at: createdAt, method: 'CASH', payout_evidence: { evidenceNote: SECRET_EVIDENCE } } : {}) });
    }
    return { id: String(orderId), orderId, transactionId, invoiceId, expiresAt };
  }

  // Một thông báo chưa đọc của Member về đơn (để kiểm GET không đánh dấu đã đọc).
  async function unreadNotification(accountId: string, orderId: ObjectId) {
    const id = new ObjectId();
    await db().collection('notifications').insertOne({ _id: id, id, title: 'Đơn đã tạo', body: 'Đơn hàng của bạn đã được tạo',
      event_key: `ORDER_CREATED:${orderId}`, sequence: Long.fromNumber(1), created_at: new Date(NOW) });
    await db().collection('notification_recipients').insertOne({ notification_id: id, account_id: new ObjectId(accountId) });
  }

  async function snapshot() {
    const rows: Record<string, unknown[]> = {};
    for (const name of WATCHED) rows[name] = await db().collection(name).find().sort({ _id: 1 }).toArray();
    return rows;
  }

  // Gọi các route own của Member.
  const get = (actor: Actor | undefined, path: string, server: INestApplication = app) => {
    const call = request(server.getHttpServer()).get(`/api/me/orders${path}`);
    return actor ? call.set('Authorization', `Bearer ${actor.token}`) : call;
  };
  const list = (actor: Actor, query = '') => get(actor, query ? `?${query}` : '');
  const detail = (actor: Actor, id: string) => get(actor, `/${id}`);
  const instructions = (actor: Actor, id: string, server: INestApplication = app) => get(actor, `/${id}/payment-instructions`, server);
  const invoice = (actor: Actor, id: string) => get(actor, `/${id}/invoice`);
  const ids = (body: { items: { id: string }[] }) => body.items.map(item => item.id);

  // Liệt kê mọi tên field (kể cả lồng nhau) để kiểm không có field nội bộ.
  function keysOf(value: unknown, found: string[] = []): string[] {
    if (Array.isArray(value)) value.forEach(item => keysOf(item, found));
    else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { found.push(key); keysOf(inner, found); }
    return found;
  }
  function expectSafe(body: unknown) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRET_BANK_REFERENCE);
    expect(text).not.toContain(SECRET_EVIDENCE);
    expect(text).not.toContain('FIXTURE:');
    for (const key of keysOf(body)) expect(key).not.toMatch(/cost|bank_?reference|evidence|reference|note|verified|guard_?revision|request_?key|password|token/i);
  }

  // ===================== US-42-AC01: sở hữu và riêng tư =====================

  it('US-42-TC01: danh sách gồm đơn WEBSITE và POS có member_id của mình, không phụ thuộc người tạo', async () => {
    const me = await linkedMember(), other = await linkedMember();
    const website = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, createdAt: new Date(Date.parse(NOW) - 2 * MINUTE) });
    // Đơn POS do Staff tạo nhưng gắn đúng member của tôi.
    const pos = await seedOrder({ memberId: me.memberId, channel: 'POS', createdBy: staff.accountId, transactionStatus: 'SETTLED', createdAt: new Date(Date.parse(NOW) - MINUTE) });
    // Đơn của Member khác, kể cả do chính tôi (account) tạo hộ cũng không được hiện.
    await seedOrder({ memberId: other.memberId, createdBy: me.accountId });
    await seedOrder({ memberId: null, channel: 'POS', createdBy: staff.accountId });
    const response = await list(me).expect(200);
    expect(response.body).toMatchObject({ memberLinked: true, page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(typeof response.body.asOf).toBe('string');
    expect(ids(response.body)).toEqual([pos.id, website.id]);
    expect(response.body.items[0]).toMatchObject({ id: pos.id, code: `ORD-${pos.id}`, channel: 'POS', status: 'CONFIRMED', transactionStatus: 'SETTLED', total: '50000' });
    expect((await detail(me, pos.id).expect(200)).body).toMatchObject({ id: pos.id, channel: 'POS' });
  });

  it('US-42-TC02: đổi orderId sang đơn của Member khác ở detail/payment-instructions/invoice → 404, không lộ người nhận hoặc tiền', async () => {
    const owner = await linkedMember(), intruder = await linkedMember();
    const unpaid = await seedOrder({ memberId: owner.memberId, createdBy: owner.accountId });
    const paid = await seedOrder({ memberId: owner.memberId, createdBy: owner.accountId, transactionStatus: 'SETTLED' });
    const responses = [await detail(intruder, unpaid.id), await instructions(intruder, unpaid.id), await invoice(intruder, paid.id), await detail(intruder, paid.id)];
    for (const response of responses) {
      expect(response.status).toBe(404);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain('Người nhận snapshot');
      expect(text).not.toContain('50000');
      expect(text).not.toContain('+84901234567');
    }
    expect((await list(intruder).expect(200)).body.items).toEqual([]);
  });

  it('US-42-TC02: dùng transactionId/invoiceId của người khác thay orderId → 404; ID không tồn tại → 404; ID sai định dạng → 400', async () => {
    const owner = await linkedMember(), intruder = await linkedMember();
    const paid = await seedOrder({ memberId: owner.memberId, createdBy: owner.accountId, transactionStatus: 'SETTLED' });
    await detail(intruder, String(paid.transactionId)).expect(404);
    await invoice(intruder, String(paid.invoiceId)).expect(404);
    await detail(intruder, String(new ObjectId())).expect(404);
    await detail(intruder, 'not-an-id').expect(400);
  });

  it('US-42-TC02: không tin memberId/accountId do client gửi – query ngoài allowlist → 400', async () => {
    const owner = await linkedMember(), intruder = await linkedMember();
    await seedOrder({ memberId: owner.memberId, createdBy: owner.accountId });
    await list(intruder, `memberId=${owner.memberId}`).expect(400);
    await list(intruder, `accountId=${owner.accountId}`).expect(400);
  });

  it('US-42-TC03: account MEMBER chưa liên kết → 200 memberLinked=false, items rỗng; POS ẩn danh cùng phone không hiện, không tự liên kết', async () => {
    const unlinked = await login('MEMBER');
    // Hồ sơ cùng số điện thoại nhưng chưa gắn account, và đơn POS ẩn danh.
    const sameProfile = await memberProfile(undefined, unlinked.phone);
    const anonymous = await seedOrder({ memberId: null, channel: 'POS', createdBy: staff.accountId, transactionStatus: 'SETTLED' });
    const before = await snapshot();
    const response = await list(unlinked).expect(200);
    expect(response.body).toMatchObject({ memberLinked: false, items: [], total: 0, totalPages: 0 });
    await detail(unlinked, anonymous.id).expect(404);
    await invoice(unlinked, anonymous.id).expect(404);
    await instructions(unlinked, anonymous.id).expect(404);
    // Không autolink: hồ sơ cùng phone vẫn chưa có account_id, DB không đổi.
    expect((await db().collection('members').findOne({ _id: sameProfile }))!.account_id).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  it('US-42-TC03: Member đã liên kết cũng không thấy POS ẩn danh dù trùng số điện thoại', async () => {
    const me = await linkedMember();
    const anonymous = await seedOrder({ memberId: null, channel: 'POS', createdBy: staff.accountId });
    await db().collection('orders').updateOne({ _id: anonymous.orderId }, { $set: { recipient_phone: `+84${me.phone.slice(1)}` } });
    expect((await list(me).expect(200)).body.items).toEqual([]);
    await detail(me, anonymous.id).expect(404);
  });

  it('US-42-TC03: sai role (STAFF/ADMIN/TRAINER) → 403, không có token → 401 ở cả 4 route own', async () => {
    const owner = await linkedMember();
    const order = await seedOrder({ memberId: owner.memberId, createdBy: owner.accountId, transactionStatus: 'SETTLED' });
    const trainer = await login('TRAINER');
    const paths = ['', `/${order.id}`, `/${order.id}/payment-instructions`, `/${order.id}/invoice`];
    for (const path of paths) {
      for (const actor of [staff, admin, trainer]) await get(actor, path).expect(403);
      await get(undefined, path).expect(401);
    }
  });

  it('US-42-TC04: payload list/detail/invoice/payment-instructions không có giá vốn, bankReference, ghi chú đối soát hay dữ liệu audit nội bộ', async () => {
    const me = await linkedMember();
    const paid = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, transactionStatus: 'SETTLED', productId: await product() });
    const cancelled = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, status: 'CANCELLED', transactionStatus: 'SETTLED', refund: 'SUCCEEDED' });
    const unpaid = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, method: 'TRANSFER' });
    expectSafe((await list(me).expect(200)).body);
    for (const order of [paid, cancelled, unpaid]) expectSafe((await detail(me, order.id).expect(200)).body);
    expectSafe((await invoice(me, paid.id).expect(200)).body);
    expectSafe((await instructions(me, unpaid.id).expect(200)).body);
  });

  it('US-42-TC04: GET lặp lại không ghi DB, không đổi trạng thái và không đánh dấu thông báo đã đọc', async () => {
    const me = await linkedMember();
    const productId = await product();
    const paid = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, transactionStatus: 'SETTLED', productId });
    const unpaid = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, method: 'TRANSFER' });
    await unreadNotification(me.accountId, paid.orderId);
    const before = await snapshot();
    for (let round = 0; round < 2; round++) {
      await list(me).expect(200);
      await detail(me, paid.id).expect(200);
      await detail(me, unpaid.id).expect(200);
      await invoice(me, paid.id).expect(200);
      await instructions(me, unpaid.id).expect(200);
    }
    expect(await snapshot()).toEqual(before);
    expect((await db().collection('notification_recipients').findOne({ account_id: new ObjectId(me.accountId) }))!.read_at).toBeUndefined();
  });

  // ===================== US-42-AC02: trạng thái, snapshot, hướng dẫn =====================

  it('US-42-TC05: đơn CANCELLED đã SETTLED có refund PENDING → hiện chờ hoàn (refundState PENDING), không phải đã hoàn hay đã nhận hàng', async () => {
    const me = await linkedMember();
    const order = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, status: 'CANCELLED', transactionStatus: 'SETTLED', refund: 'PENDING' });
    const body = (await detail(me, order.id).expect(200)).body;
    expect(body).toMatchObject({ id: order.id, status: 'CANCELLED', transactionStatus: 'SETTLED', refundState: 'PENDING', refundAmount: '50000',
      reservationState: 'RELEASED', invoiceId: String(order.invoiceId) });
    // Có invoice nhưng chưa bàn giao: không có thời điểm nhận hàng.
    expect(body.fulfilledAt ?? null).toBeNull();
    expect(JSON.stringify(body)).not.toContain('SUCCEEDED');
    const item = (await list(me).expect(200)).body.items[0];
    expect(item).toMatchObject({ id: order.id, status: 'CANCELLED', transactionStatus: 'SETTLED', refundState: 'PENDING' });
  });

  it('US-42-TC05: refundState lấy từ nguồn thật – không có refund → NONE, FAILED → FAILED, SUCCEEDED → SUCCEEDED', async () => {
    const me = await linkedMember();
    const none = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, transactionStatus: 'SETTLED' });
    const failed = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, status: 'CANCELLED', transactionStatus: 'SETTLED', refund: 'FAILED' });
    const done = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, status: 'CANCELLED', transactionStatus: 'SETTLED', refund: 'SUCCEEDED' });
    expect((await detail(me, none.id).expect(200)).body).toMatchObject({ status: 'CONFIRMED', transactionStatus: 'SETTLED', refundState: 'NONE' });
    expect((await detail(me, failed.id).expect(200)).body).toMatchObject({ status: 'CANCELLED', refundState: 'FAILED', refundAmount: '50000' });
    expect((await detail(me, done.id).expect(200)).body).toMatchObject({ status: 'CANCELLED', refundState: 'SUCCEEDED', refundAmount: '50000' });
  });

  it('US-42-TC06: catalog và hồ sơ đổi sau khi đặt → detail và invoice vẫn giữ snapshot tên/giá/người nhận/quầy', async () => {
    const me = await linkedMember();
    const productId = await product();
    const order = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, transactionStatus: 'SETTLED', productId });
    await db().collection('products').updateOne({ _id: productId }, { $set: { name: 'Tên mới sau khi đặt', price: Decimal128.fromString('99000') } });
    await db().collection('members').updateOne({ _id: me.memberId }, { $set: { full_name: 'Tên hồ sơ mới', phone: '+84999999999' } });
    const body = (await detail(me, order.id).expect(200)).body;
    const text = JSON.stringify(body);
    expect(text).toContain('Tên snapshot');
    expect(text).toContain('25000');
    expect(text).toContain('Người nhận snapshot');
    expect(text).toContain(PICKUP);
    expect(text).not.toContain('Tên mới sau khi đặt');
    expect(text).not.toContain('99000');
    expect(text).not.toContain('Tên hồ sơ mới');
    const bill = (await invoice(me, order.id).expect(200)).body;
    expect(bill).toMatchObject({ invoiceNo: `INV-${order.id}` });
    expect(Array.isArray(bill.retailLines)).toBe(true);
    expect(JSON.stringify(bill.retailLines)).toContain('Tên snapshot');
    expect(JSON.stringify(bill)).not.toContain('Tên mới sau khi đặt');
    // Thông tin thanh toán: method/amount/paidAt.
    expect(JSON.stringify(bill)).toContain('"method":"CASH"');
    expect(JSON.stringify(bill)).toContain('paidAt');
  });

  it('US-42-TC06: chưa có invoice → 404 ở route invoice', async () => {
    const me = await linkedMember();
    const unpaid = await seedOrder({ memberId: me.memberId, createdBy: me.accountId });
    await invoice(me, unpaid.id).expect(404);
  });

  it('US-42-TC06: lọc ngày theo giờ Việt Nam, bao gồm hai đầu', async () => {
    const me = await linkedMember();
    // 13/11 16:30 UTC = 13/11 23:30 VN; 13/11 17:30 UTC = 14/11 00:30 VN.
    const late13 = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, createdAt: new Date('2035-11-13T16:30:00.000Z') });
    const early14 = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, createdAt: new Date('2035-11-13T17:30:00.000Z') });
    expect(ids((await list(me, 'fromDate=2035-11-14&toDate=2035-11-14').expect(200)).body)).toEqual([early14.id]);
    expect(ids((await list(me, 'fromDate=2035-11-13&toDate=2035-11-13').expect(200)).body)).toEqual([late13.id]);
    expect(ids((await list(me, 'fromDate=2035-11-13&toDate=2035-11-14').expect(200)).body)).toEqual([early14.id, late13.id]);
  });

  it('US-42-TC06: mặc định 30 ngày gần nhất; khoảng quá 366 ngày, ngày sai định dạng, limit > 100 → 400', async () => {
    const me = await linkedMember();
    const recent = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, createdAt: new Date(Date.parse(NOW) - 2 * DAY) });
    await seedOrder({ memberId: me.memberId, createdBy: me.accountId, createdAt: new Date(Date.parse(NOW) - 40 * DAY) });
    expect(ids((await list(me).expect(200)).body)).toEqual([recent.id]);
    await list(me, 'fromDate=2034-01-01&toDate=2035-11-14').expect(400);
    await list(me, 'fromDate=14-11-2035&toDate=2035-11-14').expect(400);
    await list(me, 'limit=101').expect(400);
    await list(me, 'page=0').expect(400);
  });

  it('US-42-TC06: phân trang và sắp xếp createdAt DESC rồi id DESC; trang rỗng totalPages 0', async () => {
    const me = await linkedMember();
    const same = new Date(Date.parse(NOW) - 5 * MINUTE);
    const lowId = new ObjectId('000000000000000000000001'), highId = new ObjectId('000000000000000000000002');
    const a = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, createdAt: same, orderId: lowId });
    const b = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, createdAt: same, orderId: highId });
    const newest = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, createdAt: new Date(Date.parse(NOW) - MINUTE) });
    const page1 = (await list(me, 'limit=2&page=1').expect(200)).body;
    expect(page1).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(ids(page1)).toEqual([newest.id, b.id]);
    const page2 = (await list(me, 'limit=2&page=2').expect(200)).body;
    expect(ids(page2)).toEqual([a.id]);
    const empty = (await list(me, 'status=COMPLETED').expect(200)).body;
    expect(empty).toMatchObject({ items: [], total: 0, totalPages: 0 });
  });

  it('US-42-TC06: lọc theo status và channel', async () => {
    const me = await linkedMember();
    const pos = await seedOrder({ memberId: me.memberId, channel: 'POS', createdBy: staff.accountId, status: 'COMPLETED', transactionStatus: 'SETTLED' });
    const web = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, status: 'PENDING' });
    expect(ids((await list(me, 'channel=POS').expect(200)).body)).toEqual([pos.id]);
    expect(ids((await list(me, 'status=PENDING').expect(200)).body)).toEqual([web.id]);
    await list(me, 'status=SHIPPED').expect(400);
  });

  it('US-42-TC07: đơn PENDING hợp lệ, transaction PENDING → hướng dẫn có mã giao dịch, số tiền, quầy, tiền mặt và tài khoản nhận cấu hình', async () => {
    const me = await linkedMember();
    const order = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, status: 'PENDING', method: 'TRANSFER' });
    const body = (await instructions(me, order.id).expect(200)).body;
    expect(body).toMatchObject({ transactionCode: `TX-${order.transactionId}`, amountDue: '50000', preferredPaymentMethod: 'TRANSFER', pickupLocation: PICKUP });
    expect(body.cashInstructions).toBeTruthy();
    expect(JSON.stringify(body.transferOptions)).toContain(BANK_ACCOUNT_NUMBER);
    expect((await detail(me, order.id).expect(200)).body).toMatchObject({ status: 'PENDING', transactionStatus: 'PENDING', paymentAllowed: true, expired: false });
  });

  it('US-42-TC07: đã SETTLED → không còn hướng dẫn thanh toán, detail paymentAllowed=false nhưng vẫn có quầy nhận', async () => {
    const me = await linkedMember();
    const order = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, transactionStatus: 'SETTLED' });
    await instructions(me, order.id).expect(409);
    const body = (await detail(me, order.id).expect(200)).body;
    expect(body).toMatchObject({ transactionStatus: 'SETTLED', paymentAllowed: false });
    expect(JSON.stringify(body)).toContain(PICKUP);
  });

  it('US-42-TC07: đơn tổng 0 đồng → không hướng dẫn thu 0 đồng', async () => {
    const me = await linkedMember();
    const order = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, status: 'PENDING', free: true });
    await instructions(me, order.id).expect(409);
    expect((await detail(me, order.id).expect(200)).body).toMatchObject({ paymentAllowed: false });
  });

  it('US-42-TC07: đơn hết hạn hoặc CANCELLED → chặn hướng dẫn thanh toán', async () => {
    const me = await linkedMember();
    const expired = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, status: 'PENDING', createdAt: new Date(Date.parse(NOW) - DAY - MINUTE) });
    const cancelled = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, status: 'CANCELLED', transactionStatus: 'CANCELLED' });
    await instructions(me, expired.id).expect(409);
    await instructions(me, cancelled.id).expect(409);
    expect((await detail(me, cancelled.id).expect(200)).body).toMatchObject({ status: 'CANCELLED', transactionStatus: 'CANCELLED', paymentAllowed: false, refundState: 'NONE' });
  });

  it('US-42-TC07: thiếu cấu hình tài khoản ngân hàng → vẫn 200 với hướng dẫn tiền mặt, không có số tài khoản giả', async () => {
    // App phụ: cùng DB nhưng không có RECEIVING_ACCOUNT_DETAILS.
    process.env.RECEIVING_ACCOUNT_DETAILS = '[]';
    noBankApp = noBankApp ?? await createApp();
    process.env.RECEIVING_ACCOUNT_DETAILS = JSON.stringify(BANK_DETAILS);
    const actor = await login('MEMBER', noBankApp);
    const memberId = await memberProfile(actor.accountId, actor.phone);
    const order = await seedOrder({ memberId, createdBy: actor.accountId, status: 'PENDING', method: 'TRANSFER' });
    const body = (await instructions(actor, order.id, noBankApp).expect(200)).body;
    expect(body).toMatchObject({ transactionCode: `TX-${order.transactionId}`, amountDue: '50000', pickupLocation: PICKUP });
    expect(body.cashInstructions).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(BANK_ACCOUNT_NUMBER);
    expect(keysOf(body)).not.toContain('accountNumber');
  });

  it('US-42-TC08: GET đúng mốc hết hạn khi worker chưa chạy → expired=true, paymentAllowed=false, không giải phóng kho hay đổi trạng thái', async () => {
    const me = await linkedMember();
    const productId = await product();
    const order = await seedOrder({ memberId: me.memberId, createdBy: me.accountId, status: 'PENDING', productId });
    await db().collection('inventory').updateOne({ product_id: productId }, { $set: { on_hand: new Int32(5), reserved: new Int32(2) } });
    // 1 ms trước hạn: chưa hết hạn.
    now = new Date(order.expiresAt.getTime() - 1).toISOString();
    expect((await detail(me, order.id).expect(200)).body).toMatchObject({ expired: false, paymentAllowed: true });
    // Đúng mốc expiresAt: đã hết hạn (S06-H01, bằng là hết hạn).
    now = order.expiresAt.toISOString();
    const before = await snapshot();
    const body = (await detail(me, order.id).expect(200)).body;
    expect(body).toMatchObject({ id: order.id, status: 'PENDING', reservationState: 'HELD', expired: true, paymentAllowed: false });
    expect((await list(me).expect(200)).body.items[0]).toMatchObject({ id: order.id, status: 'PENDING' });
    await instructions(me, order.id).expect(409);
    expect(await snapshot()).toEqual(before);
    expect(await db().collection('inventory').findOne({ product_id: productId })).toMatchObject({ on_hand: 5, reserved: 2 });
  });
});
