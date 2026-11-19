// Tầng kiểm thử backend (Jest + Supertest + MongoDB replica set thật): US-42 bước 4 – rà các ca IDOR, POS linked/anonymous, tranh chấp và replay còn thiếu.
// Các ca chính của TC01–TC11 đã có ở me-orders-query (bước 1) và me-orders-cancel (bước 2); file này thêm những điều spec nêu mà chưa có test:
//   - Member khác dùng lại đúng Idempotency-Key của chủ đơn → 404, không nhận body gốc (spec mục 2: replay chỉ sau kiểm auth/owner).
//   - Hóa đơn/giao dịch GÓI TẬP của chính Member không mở được qua route order (spec: "Không mở các invoice gói không liên quan qua route order").
//   - Tìm q bằng mã đơn của Member khác → rỗng.
//   - Đơn POS linked không có SĐT người nhận (POS có thể không có SĐT) → recipientPhone null, vẫn đúng chủ.
//   - Hủy cạnh tranh trên HAI instance app dùng chung DB (cancel vs bàn giao, hai lệnh hủy khác key) → một thứ tự hợp lệ.
//   - Phiên bị thu hồi rồi đăng nhập lại cùng Member → gửi lại cùng key trả body gốc, vẫn một lần hủy.
// Fixture giống me-orders-cancel (đơn ghi thẳng DB như US-45; catalog/nhập kho/bàn giao/hủy gọi API thật).
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
const password = 'MậtKhẩuUS-42-hardening';
const PICKUP = 'Quầy lễ tân tầng 1 – kiểm thử US42 bước 4';
const DAY = 24 * 3600 * 1000;
const REASON = 'Tôi đổi ý, không cần mua nữa';
const RACE_ROUNDS = 5;

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Actor = { accountId: string; token: string; phone: string };
type Fixture = { id: string; orderId: ObjectId; transactionId: ObjectId; items: { itemId: ObjectId; productId: ObjectId }[] };

describe('US-42 bước 4: IDOR, POS linked/anonymous, tranh chấp hai instance và replay', () => {
  const saved = { ...process.env };
  const clock = new ServerClock();
  clock.now = () => new Date(NOW);
  let mongo: MongoMemoryReplSet;
  // Hai instance app dùng chung một DB, mô phỏng hai server chạy song song.
  let app: INestApplication;
  let second: INestApplication;
  let connection: Connection;
  let admin: Actor;
  let staff: Actor;
  let member: Actor;
  let memberId: ObjectId;
  let sequence = 0;
  const db = () => connection.db!;
  const http = (server: INestApplication = app) => request(server.getHttpServer());

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
      NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: `gym_test_us42_hard_${randomBytes(4).toString('hex')}`, FRONTEND_ORIGIN: origin,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RETAIL_QUOTE_SECRET: randomBytes(32).toString('base64url'),
      PICKUP_LOCATION: PICKUP, RECEIVING_ACCOUNTS: '["GYM_MAIN"]', RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
    });
    app = await createApp();
    second = await createApp();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    await ensureFinancialIntegrity(connection);
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Mỗi test dùng bộ đếm đăng nhập mới (cả hai instance) để không bị 429.
    for (const instance of [app, second]) {
      const limiter = new LoginLimiter();
      jest.spyOn(instance.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    }
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
    await second?.close();
    await app?.close();
    await mongo?.stop();
    process.env = saved;
  });

  // ---------- Tài khoản và hồ sơ ----------
  async function account(role: Role) {
    const users = app.get(UsersRepository);
    const roleDoc = await users.ensureRole(role, role);
    const phone = `094204${String(++sequence).padStart(4, '0')}`;
    const created = await users.createAccount({ roleId: String(roleDoc.id), phone, fullName: `${role} US42`,
      passwordHash: await app.get(PasswordService).hash(password) });
    return { accountId: String(created.id), phone };
  }
  async function loginPhone(phone: string) {
    return (await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200)).body.accessToken as string;
  }
  async function login(role: Role): Promise<Actor> {
    const created = await account(role);
    return { ...created, token: await loginPhone(created.phone) };
  }
  async function memberProfile(actor: Actor) {
    const id = new ObjectId(), at = new Date(NOW);
    await db().collection('members').insertOne({ _id: id, id, member_code: `HV-${id}`, full_name: 'Hội viên US42', phone: `+84${actor.phone.slice(1)}`,
      account_id: new ObjectId(actor.accountId), version: new Int32(0), service_revision: Long.ZERO,
      created_by: new ObjectId(admin.accountId), updated_by: new ObjectId(admin.accountId), created_at: at, updated_at: at });
    return id;
  }

  // ---------- Fixture đơn RETAIL 2 SKU x 25000, mỗi SKU nhập 3 và đang giữ 1 ----------
  async function create(path: string, body: object, actor = admin) {
    return (await http().post(`/api${path}`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', randomUUID()).send(body).expect(201)).body as { id: string };
  }
  async function fixture(options: { paid?: boolean; channel?: 'WEBSITE' | 'POS'; owner?: ObjectId; noPhone?: boolean } = {}): Promise<Fixture> {
    const orderId = new ObjectId(), transactionId = new ObjectId(), created = new Date(NOW), expires = new Date(created.getTime() + DAY);
    const owner = options.owner ?? memberId, paid = options.paid === true;
    const createdBy = new ObjectId(options.channel === 'POS' ? staff.accountId : member.accountId);
    await db().collection('transactions').insertOne({ _id: transactionId, id: transactionId, member_id: owner, created_by: createdBy, code: `TX-${transactionId}`,
      kind: 'RETAIL', status: paid ? 'SETTLED' : 'PENDING', amount_due: Decimal128.fromString('50000'),
      request_key: createHash('sha256').update(String(transactionId)).digest('hex'), created_at: created, guard_revision: Long.ZERO, version: new Int32(0),
      ...(paid ? { settled_at: created } : {}) });
    await db().collection('orders').insertOne({ _id: orderId, id: orderId, transaction_id: transactionId, member_id: owner, code: `ORD-${orderId}`,
      channel: options.channel ?? 'WEBSITE', status: 'CONFIRMED', reservation_state: 'HELD', reservation_expires_at: expires, preferred_payment_method: 'CASH',
      recipient_name: 'Người nhận snapshot', ...(options.noPhone ? {} : { recipient_phone: '+84901234567' }), pickup_location_snapshot: PICKUP,
      created_by: createdBy, created_at: created, updated_at: created, version: new Int32(0), guard_revision: Long.ZERO,
      confirmed_at: created, confirmed_by: new ObjectId(staff.accountId) });
    const category = await create('/admin/categories', { name: `US42 b4 ${++sequence}`, status: 'ACTIVE' });
    const items: { itemId: ObjectId; productId: ObjectId; sku: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const sku = `US42H_${++sequence}`;
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
    return { id: String(orderId), orderId, transactionId, items };
  }

  // ---------- Gọi API ----------
  const cancel = (id: string, version: number, key: string = randomUUID(), actor: Actor = member, server: INestApplication = app, reason = REASON) =>
    http(server).post(`/api/me/orders/${id}/cancel`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send({ version, reason });
  const get = (path: string, actor: Actor = member) => http().get(`/api/me/orders${path}`).set('Authorization', `Bearer ${actor.token}`);
  const fulfill = (id: string, version: number, server: INestApplication = app) =>
    http(server).post(`/api/orders/${id}/fulfill`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID()).send({ version });

  // ---------- Đọc DB ----------
  async function snapshot() {
    const rows: Record<string, unknown[]> = {};
    for (const name of [...COLLECTIONS, 'members']) rows[name] = await db().collection(name).find().sort({ _id: 1 }).toArray();
    return rows;
  }
  async function oracle() {
    const rows = {} as Rows;
    for (const name of COLLECTIONS) rows[name] = await db().collection(name).find().toArray();
    assertCommittedRows(rows);
  }
  const refundsOf = (row: Fixture) => db().collection('refunds').find({ order_id: row.orderId }).toArray();
  const releases = (row: Fixture) => db().collection('stock_movements').countDocuments({ source_id: row.orderId, kind: 'ORDER_RELEASE' });
  const cancelEvents = (row: Fixture) => db().collection('order_events').countDocuments({ order_id: row.orderId, action: 'CANCELLED' });

  // ===================== IDOR =====================

  it('US-42-TC11: Member khác gửi hủy đơn của tôi bằng ĐÚNG Idempotency-Key tôi đã dùng → 404, không nhận lại body gốc, không tác động thêm', async () => {
    const row = await fixture({ paid: true });
    const key = randomUUID();
    const mine = await cancel(row.id, 0, key).expect(200);
    const intruder = await login('MEMBER');
    await memberProfile(intruder);
    const after = await snapshot();
    const response = await cancel(row.id, 0, key, intruder).expect(404);
    expect(response.body).not.toEqual(mine.body);
    expect(JSON.stringify(response.body)).not.toContain('50000');
    expect(JSON.stringify(response.body)).not.toContain(row.id);
    expect(await snapshot()).toEqual(after);
  });

  it('US-42-TC02: hóa đơn/giao dịch gói tập của CHÍNH Member không mở được qua route order → 404', async () => {
    // Giao dịch gói tập (không phải RETAIL) của chính Member, đã có hóa đơn.
    const transactionId = new ObjectId(), invoiceId = new ObjectId(), at = new Date(NOW);
    await db().collection('transactions').insertOne({ _id: transactionId, id: transactionId, member_id: memberId, created_by: new ObjectId(staff.accountId),
      code: `TX-${transactionId}`, kind: 'GYM', status: 'SETTLED', amount_due: Decimal128.fromString('300000'),
      request_key: createHash('sha256').update(String(transactionId)).digest('hex'), created_at: at, settled_at: at, guard_revision: Long.ZERO, version: new Int32(1) });
    await db().collection('invoices').insertOne({ _id: invoiceId, id: invoiceId, transaction_id: transactionId, invoice_no: `INV-GYM-${transactionId}`,
      total_amount: Decimal128.fromString('300000'), issued_at: at, buyer_snapshot: 'Hội viên US42' });
    for (const id of [transactionId, invoiceId]) {
      for (const path of [`/${id}`, `/${id}/invoice`, `/${id}/payment-instructions`]) {
        const response = await get(path).expect(404);
        expect(JSON.stringify(response.body)).not.toContain('300000');
      }
    }
    expect((await get('').expect(200)).body.items).toEqual([]);
  });

  it('US-42-TC02: tìm q bằng mã đơn của Member khác → danh sách rỗng, không lộ đơn', async () => {
    const other = await login('MEMBER');
    const otherMember = await memberProfile(other);
    const foreign = await fixture({ owner: otherMember });
    const response = await get(`?q=${encodeURIComponent(`ORD-${foreign.id}`)}`).expect(200);
    expect(response.body).toMatchObject({ memberLinked: true, items: [], total: 0 });
    expect(JSON.stringify(response.body)).not.toContain(foreign.id);
    // Chủ đơn tìm đúng mã thì thấy.
    expect((await get(`?q=${encodeURIComponent(foreign.id.slice(-6))}`, other).expect(200)).body.items.map((item: { id: string }) => item.id)).toEqual([foreign.id]);
  });

  it('US-42-TC01: đơn POS linked do Staff tạo, không có SĐT người nhận → Member thấy trong danh sách, detail recipientPhone null', async () => {
    const row = await fixture({ channel: 'POS', noPhone: true });
    expect((await get('').expect(200)).body.items.map((item: { id: string }) => item.id)).toEqual([row.id]);
    expect((await get(`/${row.id}`).expect(200)).body).toMatchObject({ id: row.id, channel: 'POS', recipientName: 'Người nhận snapshot', recipientPhone: null });
  });

  // ===================== Tranh chấp trên hai instance =====================

  it(`US-42-TC10: hủy (instance 1) và bàn giao (instance 2) cùng lúc, ${RACE_ROUNDS} vòng → đúng một lệnh thắng, không vừa CONSUMED vừa RELEASED`, async () => {
    for (let round = 0; round < RACE_ROUNDS; round++) {
      const row = await fixture({ paid: true });
      const [cancelled, fulfilled] = await Promise.all([cancel(row.id, 0, randomUUID(), member, app), fulfill(row.id, 0, second)]);
      expect([cancelled.status, fulfilled.status].sort()).toEqual([200, 409]);
      const order = await db().collection('orders').findOne({ _id: row.orderId });
      if (cancelled.status === 200) {
        expect(order).toMatchObject({ status: 'CANCELLED', reservation_state: 'RELEASED' });
        expect((await refundsOf(row)).map(refund => refund.status)).toEqual(['PENDING']);
        expect(await releases(row)).toBe(row.items.length);
      } else {
        expect(order).toMatchObject({ status: 'COMPLETED', reservation_state: 'CONSUMED' });
        expect(await refundsOf(row)).toEqual([]);
        expect(await releases(row)).toBe(0);
      }
      await oracle();
    }
  });

  it(`US-42-TC10: hai lệnh hủy khác key gửi cùng lúc trên hai instance, ${RACE_ROUNDS} vòng → chỉ một lần hủy/giải phóng/khoản hoàn`, async () => {
    for (let round = 0; round < RACE_ROUNDS; round++) {
      const row = await fixture({ paid: true });
      const responses = await Promise.all([cancel(row.id, 0, randomUUID(), member, app), cancel(row.id, 0, randomUUID(), member, second)]);
      // Một lệnh hủy thật; lệnh còn lại nhận kết quả đã hủy (200, US-45) hoặc 409 do version/state đã đổi.
      expect(responses.some(response => response.status === 200)).toBe(true);
      for (const response of responses) expect([200, 409]).toContain(response.status);
      expect(await cancelEvents(row)).toBe(1);
      expect(await refundsOf(row)).toHaveLength(1);
      expect(await releases(row)).toBe(row.items.length);
      await oracle();
    }
  });

  // ===================== Replay sau khi đăng nhập lại =====================

  it('US-42-TC11: phiên bị thu hồi rồi đăng nhập lại cùng Member → gửi lại cùng key trả body gốc, vẫn chỉ một lần hủy', async () => {
    const row = await fixture({ paid: true });
    const key = randomUUID();
    const first = await cancel(row.id, 0, key).expect(200);
    await http().post('/api/auth/logout').set('Authorization', `Bearer ${member.token}`).set('Origin', origin).send({}).expect(204);
    await cancel(row.id, 0, key).expect(401);
    const fresh: Actor = { ...member, token: await loginPhone(member.phone) };
    const replay = await cancel(row.id, 0, key, fresh).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(await cancelEvents(row)).toBe(1);
    expect(await refundsOf(row)).toHaveLength(1);
    expect(await releases(row)).toBe(row.items.length);
  });
});
