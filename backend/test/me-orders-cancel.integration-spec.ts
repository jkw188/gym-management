// Tầng kiểm thử backend (Jest + Supertest + MongoDB replica set thật): US-42 bước 2 – Member tự hủy đơn qua Cancel Order Service dùng chung (US-45).
// Kiểm hủy trước bàn giao (chưa thu/đã thu/POS có member), COMPLETED 409, version/tranh chấp với prepare/thu/bàn giao, replay key, mất response, phiên thu hồi (TC09–TC11).
// Hợp đồng test đặt ra cho Builder (theo mục 1–2 của spec US-42 1.0.1 và Cancel Result của US-45):
//   POST /api/me/orders/:id/cancel (MEMBER chủ đơn, Idempotency-Key UUID v4, operation ORDER_CANCEL_OWN) {version, reason trim 10–500}
//     → 200 {id, code, status:"CANCELLED", version, reservationState:"RELEASED", cancelledAt, transactionStatus, refundState, refundAmount, refundId?, notificationState}.
//   Đơn của Member khác → 404; sai role → 403; COMPLETED → 409 ORDER_ALREADY_COMPLETED; version cũ → 409 VERSION_CONFLICT; không đổi items/giá.
//   Cùng key cùng payload → trả lại HTTP/body gốc (kiểm auth/owner trước, version sau); cùng key khác payload → 409 IDEMPOTENCY_CONFLICT.
//   GET /api/operations/ORDER_CANCEL_OWN/:key → 200 {status:"COMMITTED", responseStatus, responseBody}; không thấy → 404 OPERATION_UNKNOWN.
// Đơn/giao dịch/giữ tồn được ghi thẳng vào DB làm fixture như test US-45 (US-41 có writer thật và test riêng);
// catalog, nhập kho, prepare, thu tiền, bàn giao và hủy đều gọi API thật. Bước 3 (giao diện, TC12) chưa có trong file này.
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
import { COLLECTIONS, Rows, assertCommittedRows } from './helpers/en06-oracle';

const NOW = '2035-11-14T03:00:00.000Z';
const origin = 'http://localhost:5173';
const password = 'MậtKhẩuUS-42-cancel';
const PICKUP = 'Quầy lễ tân tầng 1 – kiểm thử US42 hủy';
const DAY = 24 * 3600 * 1000;
const REASON = 'Tôi đổi ý, không cần mua nữa';
// Số vòng lặp cho các ca tranh chấp (mỗi vòng một đơn mới).
const RACE_ROUNDS = 5;

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Actor = { accountId: string; token: string; phone: string };
type Fixture = { id: string; orderId: ObjectId; transactionId: ObjectId; items: { itemId: ObjectId; productId: ObjectId }[]; expires: Date };

describe('US-42 bước 2: Member tự hủy đơn qua Cancel Order Service', () => {
  const saved = { ...process.env };
  const clock = new ServerClock();
  let now = NOW;
  clock.now = () => new Date(now);
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  let admin: Actor;
  let staff: Actor;
  let member: Actor;
  let memberId: ObjectId;
  let sequence = 0;
  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, {
      NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: `gym_test_us42_cancel_${randomBytes(4).toString('hex')}`, FRONTEND_ORIGIN: origin,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RETAIL_QUOTE_SECRET: randomBytes(32).toString('base64url'),
      PICKUP_LOCATION: PICKUP, RECEIVING_ACCOUNTS: '["GYM_MAIN"]', RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
    });
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    configureHttp(app);
    await app.init();
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
    member = await login('MEMBER');
    memberId = await memberProfile(member);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = saved;
  });

  // ---------- Tài khoản và hồ sơ ----------
  async function login(role: Role): Promise<Actor> {
    const users = app.get(UsersRepository);
    const roleDoc = await users.ensureRole(role, role);
    const phone = `094203${String(++sequence).padStart(4, '0')}`;
    const created = await users.createAccount({ roleId: String(roleDoc.id), phone, fullName: `${role} US42`,
      passwordHash: await app.get(PasswordService).hash(password) });
    const result = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return { accountId: String(created.id), token: result.body.accessToken as string, phone };
  }
  async function memberProfile(actor: Actor) {
    const id = new ObjectId(), at = new Date(NOW);
    await db().collection('members').insertOne({ _id: id, id, member_code: `HV-${id}`, full_name: 'Hội viên US42', phone: `+84${actor.phone.slice(1)}`,
      account_id: new ObjectId(actor.accountId), version: new Int32(0), service_revision: Long.ZERO,
      created_by: new ObjectId(admin.accountId), updated_by: new ObjectId(admin.accountId), created_at: at, updated_at: at });
    return id;
  }

  // ---------- Fixture: đơn 2 SKU x 25000, mỗi SKU nhập kho 3 và đang giữ 1 ----------
  async function create(path: string, body: object, actor = admin) {
    return (await http().post(`/api${path}`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', randomUUID()).send(body).expect(201)).body as { id: string };
  }
  async function fixture(options: { paid?: boolean; status?: 'PENDING' | 'CONFIRMED'; channel?: 'WEBSITE' | 'POS'; owner?: ObjectId } = {}): Promise<Fixture> {
    const orderId = new ObjectId(), transactionId = new ObjectId(), created = new Date(now), expires = new Date(created.getTime() + DAY);
    const owner = options.owner ?? memberId, paid = options.paid === true, status = options.status ?? 'CONFIRMED';
    // POS do Staff tạo nhưng gắn member; WEBSITE do chính Member tạo.
    const createdBy = new ObjectId(options.channel === 'POS' ? staff.accountId : member.accountId);
    await db().collection('transactions').insertOne({ _id: transactionId, id: transactionId, member_id: owner, created_by: createdBy, code: `TX-${transactionId}`,
      kind: 'RETAIL', status: paid ? 'SETTLED' : 'PENDING', amount_due: Decimal128.fromString('50000'),
      request_key: createHash('sha256').update(String(transactionId)).digest('hex'), created_at: created, guard_revision: Long.ZERO, version: new Int32(0),
      ...(paid ? { settled_at: created } : {}) });
    await db().collection('orders').insertOne({ _id: orderId, id: orderId, transaction_id: transactionId, member_id: owner, code: `ORD-${orderId}`,
      channel: options.channel ?? 'WEBSITE', status, reservation_state: 'HELD', reservation_expires_at: expires, preferred_payment_method: 'CASH',
      recipient_name: 'Người nhận snapshot', recipient_phone: '+84901234567', pickup_location_snapshot: PICKUP, created_by: createdBy,
      created_at: created, updated_at: created, version: new Int32(0), guard_revision: Long.ZERO,
      ...(status === 'CONFIRMED' ? { confirmed_at: created, confirmed_by: new ObjectId(staff.accountId) } : {}) });
    const category = await create('/admin/categories', { name: `US42 hủy ${++sequence}`, status: 'ACTIVE' });
    const items: { itemId: ObjectId; productId: ObjectId; sku: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const sku = `US42C_${++sequence}`;
      const product = await create('/admin/products', { categoryId: category.id, sku, name: 'Tên snapshot', price: '25000', status: 'ACTIVE' });
      items.push({ itemId: new ObjectId(), productId: new ObjectId(product.id), sku });
    }
    const receipt = await create('/stock-receipts', { reason: 'US42 FIXTURE nhập hàng kiểm thử, không hàng thật',
      items: items.map(item => ({ productId: String(item.productId), quantity: 3, unitCost: '1000' })) }, staff);
    await http().post(`/api/stock-receipts/${receipt.id}/post`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0 }).expect(200);
    for (const item of items) {
      await db().collection('order_items').insertOne({ _id: item.itemId, id: item.itemId, order_id: orderId, product_id: item.productId, sku_snapshot: item.sku,
        name_snapshot: 'Tên snapshot', product_version_snapshot: new Int32(0), unit_price: Decimal128.fromString('25000'), line_total: Decimal128.fromString('25000'), quantity: new Int32(1) });
      await db().collection('inventory').updateOne({ product_id: item.productId }, { $set: { reserved: new Int32(1), version: new Int32(2) } });
      await db().collection('stock_movements').insertOne({ product_id: item.productId, order_item_id: item.itemId, source_id: orderId, source_type: 'ORDER',
        source_code: `ORD-${orderId}`, event_key: `ORDER_RESERVE:${item.itemId}`, kind: 'ORDER_RESERVE', actor_id: createdBy, sequence: new Int32(2),
        on_hand_delta: new Int32(0), reserved_delta: new Int32(1), before_on_hand: new Int32(3), before_reserved: new Int32(0), after_on_hand: new Int32(3),
        after_reserved: new Int32(1), sku_snapshot: item.sku, name_snapshot: 'Tên snapshot', created_at: created });
    }
    if (paid) {
      const invoiceId = new ObjectId(), paymentId = new ObjectId();
      await db().collection('invoices').insertOne({ _id: invoiceId, id: invoiceId, transaction_id: transactionId, invoice_no: `INV-${orderId}`,
        total_amount: Decimal128.fromString('50000'), issued_at: created, buyer_snapshot: 'Người nhận snapshot' });
      await db().collection('payments').insertOne({ _id: paymentId, id: paymentId, transaction_id: transactionId, method: 'CASH', status: 'SUCCEEDED',
        amount: Decimal128.fromString('50000'), reference: `FIXTURE:${orderId}`, verified_by: new ObjectId(staff.accountId), paid_at: created,
        evidence_note: 'US42 fixture, không phải chứng từ thật' });
    }
    return { id: String(orderId), orderId, transactionId, items, expires };
  }

  // ---------- Gọi API ----------
  const cancel = (id: string, version: number, key: string = randomUUID(), actor: Actor = member, reason = REASON) =>
    http().post(`/api/me/orders/${id}/cancel`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send({ version, reason });
  const detail = (id: string, actor: Actor = member) => http().get(`/api/me/orders/${id}`).set('Authorization', `Bearer ${actor.token}`);
  const staffCommand = (path: string, body: object) =>
    http().post(`/api${path}`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID()).send(body);
  const prepare = (id: string, version: number) => staffCommand(`/orders/${id}/prepare`, { version });
  const fulfill = (id: string, version: number) => staffCommand(`/orders/${id}/fulfill`, { version });
  const confirmCash = (transactionId: ObjectId) => staffCommand(`/transactions/${transactionId}/confirm-payment`,
    { method: 'CASH', amount: '50000', evidenceNote: 'Đã đếm đủ tiền mặt thực nhận tại quầy' });
  const operation = (key: string, actor: Actor = member) =>
    http().get(`/api/operations/ORDER_CANCEL_OWN/${key}`).set('Authorization', `Bearer ${actor.token}`);

  // ---------- Đọc DB để so sánh ----------
  async function snapshot() {
    const rows: Record<string, unknown[]> = {};
    for (const name of [...COLLECTIONS, 'members']) rows[name] = await db().collection(name).find().sort({ _id: 1 }).toArray();
    return rows;
  }
  // Bất biến tài chính/kho dùng chung EN-06 (không tiền/kho dở dang, không CONSUMED+RELEASED…).
  async function oracle() {
    const rows = {} as Rows;
    for (const name of COLLECTIONS) rows[name] = await db().collection(name).find().toArray();
    assertCommittedRows(rows);
  }
  const order = (row: Fixture) => db().collection('orders').findOne({ _id: row.orderId });
  const refundsOf = (row: Fixture) => db().collection('refunds').find({ order_id: row.orderId }).toArray();
  const releases = (row: Fixture) => db().collection('stock_movements').countDocuments({ source_id: row.orderId, kind: 'ORDER_RELEASE' });
  const cancelEvents = (row: Fixture) => db().collection('order_events').countDocuments({ order_id: row.orderId, action: 'CANCELLED' });
  async function expectReleased(row: Fixture) {
    for (const item of row.items) {
      expect(await db().collection('inventory').findOne({ product_id: item.productId })).toMatchObject({ on_hand: 3, reserved: 0 });
    }
    expect(await releases(row)).toBe(row.items.length);
  }
  async function expectStillHeld(row: Fixture) {
    for (const item of row.items) {
      expect(await db().collection('inventory').findOne({ product_id: item.productId })).toMatchObject({ on_hand: 3, reserved: 1 });
    }
    expect(await releases(row)).toBe(0);
  }

  // ===================== US-42-TC09: hủy trước bàn giao, đã thu hoặc COMPLETED =====================

  it('US-42-TC09: Member hủy đơn PENDING chưa thu với version lấy từ GET → CANCELLED, giải phóng kho, giao dịch CANCELLED, không có khoản hoàn', async () => {
    const row = await fixture({ status: 'PENDING' });
    const before = (await detail(row.id).expect(200)).body;
    const result = await cancel(row.id, before.version).expect(200);
    expect(result.body).toMatchObject({ id: row.id, code: `ORD-${row.id}`, status: 'CANCELLED', version: before.version + 1, reservationState: 'RELEASED',
      cancelledAt: NOW, transactionStatus: 'CANCELLED', refundState: 'NONE', refundAmount: '0' });
    await expectReleased(row);
    expect(await refundsOf(row)).toEqual([]);
    // Không đổi items/giá; lý do hủy lưu đúng nội dung Member gửi.
    const after = (await detail(row.id).expect(200)).body;
    expect(after).toMatchObject({ status: 'CANCELLED', cancellationReason: REASON, total: '50000', items: before.items, cancelAllowed: false, paymentAllowed: false });
    await oracle();
  });

  it('US-42-TC09: Member hủy đơn CONFIRMED đã thu → giao dịch vẫn SETTLED, tạo khoản hoàn PENDING (chưa thực chi), payment/invoice giữ nguyên', async () => {
    const row = await fixture({ paid: true });
    const before = await snapshot();
    const result = await cancel(row.id, 0).expect(200);
    expect(result.body).toMatchObject({ status: 'CANCELLED', reservationState: 'RELEASED', transactionStatus: 'SETTLED', refundState: 'PENDING', refundAmount: '50000' });
    await expectReleased(row);
    const refunds = await refundsOf(row);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ status: 'PENDING', reason: 'CANCELLATION' });
    expect(refunds[0].refunded_at).toBeUndefined();
    const after = await snapshot();
    expect(after.payments).toEqual(before.payments);
    expect(after.invoices).toEqual(before.invoices);
    expect((await detail(row.id).expect(200)).body).toMatchObject({ status: 'CANCELLED', transactionStatus: 'SETTLED', refundState: 'PENDING', refundAmount: '50000' });
    await oracle();
  });

  it('US-42-TC09: Member hủy được đơn POS do Staff tạo nhưng gắn member của mình', async () => {
    const row = await fixture({ channel: 'POS' });
    expect((await cancel(row.id, 0).expect(200)).body).toMatchObject({ id: row.id, status: 'CANCELLED', reservationState: 'RELEASED' });
    await expectReleased(row);
    await oracle();
  });

  it('US-42-TC09: đơn đã COMPLETED (bàn giao thật qua API) → 409 ORDER_ALREADY_COMPLETED, không trả tồn giả, không tạo khoản hoàn', async () => {
    const row = await fixture({ paid: true });
    await fulfill(row.id, 0).expect(200);
    const completed = (await detail(row.id).expect(200)).body;
    expect(completed).toMatchObject({ status: 'COMPLETED', cancelAllowed: false });
    const before = await snapshot();
    expect((await cancel(row.id, completed.version).expect(409)).body.error.code).toBe('ORDER_ALREADY_COMPLETED');
    expect(await snapshot()).toEqual(before);
    expect(await releases(row)).toBe(0);
    expect(await refundsOf(row)).toEqual([]);
  });

  it('US-42-TC09: đúng mốc hết hạn (worker chưa chạy) Member vẫn gửi hủy được, đơn CANCELLED/RELEASED, không mở lại nhận hàng', async () => {
    const row = await fixture({ status: 'PENDING' });
    now = row.expires.toISOString();
    expect((await detail(row.id).expect(200)).body).toMatchObject({ expired: true, status: 'PENDING' });
    expect((await cancel(row.id, 0).expect(200)).body).toMatchObject({ status: 'CANCELLED', reservationState: 'RELEASED', transactionStatus: 'CANCELLED' });
    await expectReleased(row);
    expect((await fulfill(row.id, 1)).status).toBe(409);
    await oracle();
  });

  it('US-42-TC09: lý do ngắn hơn 10 ký tự sau trim, dài hơn 500 ký tự, thiếu version hoặc thiếu/sai Idempotency-Key → 400, DB không đổi', async () => {
    const row = await fixture();
    const before = await snapshot();
    await cancel(row.id, 0, randomUUID(), member, '   ngắn   ').expect(400);
    await cancel(row.id, 0, randomUUID(), member, 'a'.repeat(501)).expect(400);
    await http().post(`/api/me/orders/${row.id}/cancel`).set('Authorization', `Bearer ${member.token}`).set('Idempotency-Key', randomUUID()).send({ reason: REASON }).expect(400);
    await http().post(`/api/me/orders/${row.id}/cancel`).set('Authorization', `Bearer ${member.token}`).send({ version: 0, reason: REASON }).expect(400);
    await cancel(row.id, 0, 'khong-phai-uuid').expect(400);
    expect(await snapshot()).toEqual(before);
  });

  it('US-42-TC02: hủy đơn của Member khác → 404 không lộ dữ liệu; STAFF/ADMIN/TRAINER gọi route own → 403; DB không đổi', async () => {
    const row = await fixture({ paid: true });
    const intruder = await login('MEMBER');
    await memberProfile(intruder);
    const trainer = await login('TRAINER');
    const before = await snapshot();
    const response = await cancel(row.id, 0, randomUUID(), intruder).expect(404);
    expect(JSON.stringify(response.body)).not.toContain('Người nhận snapshot');
    expect(JSON.stringify(response.body)).not.toContain('50000');
    for (const actor of [staff, admin, trainer]) await cancel(row.id, 0, randomUUID(), actor).expect(403);
    expect(await snapshot()).toEqual(before);
  });

  // ===================== US-42-TC10: hủy cạnh tranh prepare/thu/bàn giao =====================

  it('US-42-TC10: Staff vừa prepare (version tăng) → Member gửi version cũ bị 409 VERSION_CONFLICT, tải lại version mới thì hủy được', async () => {
    const row = await fixture({ status: 'PENDING' });
    await prepare(row.id, 0).expect(200);
    const before = await snapshot();
    expect((await cancel(row.id, 0).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
    expect(await snapshot()).toEqual(before);
    const fresh = (await detail(row.id).expect(200)).body;
    expect(fresh).toMatchObject({ status: 'CONFIRMED', version: 1 });
    expect((await cancel(row.id, fresh.version).expect(200)).body).toMatchObject({ status: 'CANCELLED', transactionStatus: 'CANCELLED', refundState: 'NONE' });
    await oracle();
  });

  it('US-42-TC10: Staff vừa thu tiền (version tăng) → version cũ bị 409 VERSION_CONFLICT; tải lại rồi hủy thì tạo khoản hoàn PENDING', async () => {
    const row = await fixture();
    await confirmCash(row.transactionId).expect(200);
    const before = await snapshot();
    expect((await cancel(row.id, 0).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
    expect(await snapshot()).toEqual(before);
    const fresh = (await detail(row.id).expect(200)).body;
    expect(fresh).toMatchObject({ transactionStatus: 'SETTLED' });
    expect((await cancel(row.id, fresh.version).expect(200)).body).toMatchObject({ transactionStatus: 'SETTLED', refundState: 'PENDING', refundAmount: '50000' });
    await oracle();
  });

  it(`US-42-TC10: hủy và bàn giao gửi cùng lúc (${RACE_ROUNDS} vòng) → đúng một lệnh thắng, không vừa CONSUMED vừa RELEASED`, async () => {
    for (let round = 0; round < RACE_ROUNDS; round++) {
      const row = await fixture({ paid: true });
      const [cancelled, fulfilled] = await Promise.all([cancel(row.id, 0), fulfill(row.id, 0)]);
      expect([cancelled.status, fulfilled.status].sort()).toEqual([200, 409]);
      const saved = await order(row);
      if (cancelled.status === 200) {
        expect(saved).toMatchObject({ status: 'CANCELLED', reservation_state: 'RELEASED' });
        expect((await refundsOf(row)).map(refund => refund.status)).toEqual(['PENDING']);
        await expectReleased(row);
      } else {
        expect(saved).toMatchObject({ status: 'COMPLETED', reservation_state: 'CONSUMED' });
        expect(await refundsOf(row)).toEqual([]);
        expect(await releases(row)).toBe(0);
      }
      await oracle();
    }
  });

  it(`US-42-TC10: hủy và thu tiền gửi cùng lúc (${RACE_ROUNDS} vòng) → đúng một lệnh thắng; nếu đã thu mà đơn hủy thì phải có khoản hoàn PENDING`, async () => {
    for (let round = 0; round < RACE_ROUNDS; round++) {
      const row = await fixture({ status: 'PENDING' });
      const [cancelled, paid] = await Promise.all([cancel(row.id, 0), confirmCash(row.transactionId)]);
      expect([cancelled.status, paid.status].sort()).toEqual([200, 409]);
      const saved = await order(row);
      const transaction = await db().collection('transactions').findOne({ _id: row.transactionId });
      if (cancelled.status === 200) {
        // Hủy trước: giao dịch CANCELLED, không có payment.
        expect(saved).toMatchObject({ status: 'CANCELLED', reservation_state: 'RELEASED' });
        expect(transaction).toMatchObject({ status: 'CANCELLED' });
        expect(await db().collection('payments').countDocuments({ transaction_id: row.transactionId })).toBe(0);
      } else {
        // Thu trước: hủy với version cũ bị chặn, đơn vẫn giữ hàng.
        expect(saved).toMatchObject({ status: 'PENDING', reservation_state: 'HELD' });
        expect(transaction).toMatchObject({ status: 'SETTLED' });
        await expectStillHeld(row);
      }
      await oracle();
    }
  });

  // ===================== US-42-TC11: replay, mất response, phiên thu hồi =====================

  it('US-42-TC11: gửi lại cùng key cùng payload → trả đúng HTTP/body gốc, chỉ một lần hủy/giải phóng/khoản hoàn', async () => {
    const row = await fixture({ paid: true });
    const key = randomUUID();
    const first = await cancel(row.id, 0, key).expect(200);
    const after = await snapshot();
    const replay = await cancel(row.id, 0, key).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(await snapshot()).toEqual(after);
    expect(await cancelEvents(row)).toBe(1);
    expect(await refundsOf(row)).toHaveLength(1);
    expect(await releases(row)).toBe(row.items.length);
  });

  it('US-42-TC11: cùng key nhưng khác lý do → 409 IDEMPOTENCY_CONFLICT, lý do gốc giữ nguyên', async () => {
    const row = await fixture();
    const key = randomUUID();
    await cancel(row.id, 0, key).expect(200);
    const after = await snapshot();
    expect((await cancel(row.id, 0, key, member, 'Một lý do khác hẳn lý do ban đầu').expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await snapshot()).toEqual(after);
    expect((await order(row))!.cancellation_reason).toBe(REASON);
  });

  it('US-42-TC11: 10 request cùng key gửi đồng thời → chỉ một lần hủy, không khoản hoàn trùng', async () => {
    const row = await fixture({ paid: true });
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 10 }, () => cancel(row.id, 0, key)));
    const ok = responses.filter(response => response.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const response of responses) expect([200, 409]).toContain(response.status);
    for (const response of ok) expect(response.body).toEqual(ok[0].body);
    expect(await cancelEvents(row)).toBe(1);
    expect(await refundsOf(row)).toHaveLength(1);
    expect(await releases(row)).toBe(row.items.length);
    await oracle();
  });

  it('US-42-TC11: mất response → tra GET /api/operations/ORDER_CANCEL_OWN/:key thấy COMMITTED và body gốc; key lạ → 404 OPERATION_UNKNOWN; Member khác không tra được', async () => {
    const row = await fixture({ paid: true });
    const key = randomUUID();
    const lost = await cancel(row.id, 0, key).expect(200);
    const lookup = await operation(key).expect(200);
    expect(lookup.body).toMatchObject({ status: 'COMMITTED', responseStatus: 200, responseBody: lost.body });
    expect((await operation(randomUUID()).expect(404)).body.error.code).toBe('OPERATION_UNKNOWN');
    const other = await login('MEMBER');
    await memberProfile(other);
    await operation(key, other).expect(404);
  });

  it('US-42-TC11: phiên đã đăng xuất → gửi lại cùng key hoặc tra operation bằng token cũ đều 401, DB không đổi', async () => {
    const row = await fixture();
    const key = randomUUID();
    await cancel(row.id, 0, key).expect(200);
    await http().post('/api/auth/logout').set('Authorization', `Bearer ${member.token}`).set('Origin', origin).send({}).expect(204);
    const after = await snapshot();
    await cancel(row.id, 0, key).expect(401);
    await operation(key).expect(401);
    expect(await snapshot()).toEqual(after);
  });

  it('US-42-TC11: phiên thu hồi TRƯỚC khi hủy → 401, đơn vẫn giữ hàng', async () => {
    const row = await fixture();
    await http().post('/api/auth/logout').set('Authorization', `Bearer ${member.token}`).set('Origin', origin).send({}).expect(204);
    const before = await snapshot();
    await cancel(row.id, 0).expect(401);
    expect(await snapshot()).toEqual(before);
    await expectStillHeld(row);
  });
});
