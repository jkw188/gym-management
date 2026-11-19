// Tầng kiểm thử backend (Jest + Supertest + MongoDB replica set thật, HAI app instance): US-41 bước 3 – thu RETAIL cho đơn website và đơn 0 đồng.
// Kiểm tra preview/confirm US-21/22 mở cho RETAIL, chứng từ invoice, tổng 0 hoàn tất nội bộ, hủy/hết hạn cạnh tranh thu tiền, rollback khi lỗi (TC08, TC09–TC12, TC15, TC16).
// Hợp đồng test đặt ra cho Builder (US-41 bước 3, theo P01–P04, F04 và mục 4–5 của spec 1.0.2, hợp đồng US-21/US-22):
//   POST /api/transactions/:id/payment-preview (STAFF/ADMIN) → 200 {reviewState READY|BLOCKED, blockingCodes[], amountDue, ...} + ngữ cảnh đơn
//     (orderId, orderCode, hạn giữ). Không ghi DB, không đổi hạn.
//   POST /api/transactions/:id/confirm-payment (STAFF/ADMIN, key PAYMENT_CONFIRM) {method, amount, evidenceNote, receivingAccountCode?, bankReference?, receivedAt?}
//     → 200 {kind:'RETAIL', transactionId, status:'SETTLED', orderId, orderCode, paymentId, invoiceId, invoiceNo, notificationState}; KHÔNG có membershipId.
//     Chỉ khi order PENDING/CONFIRMED + HELD + chưa hết hạn, transaction PENDING, amount_due > 0.
//     Sau commit: payment SUCCEEDED, invoice, transaction SETTLED (version +1), order.version +1; order status/HELD/hạn giữ và tồn KHÔNG đổi.
//   Lỗi: 403 Member/PT; 409 AMOUNT_MISMATCH, PAYMENT_REFERENCE_USED, INVALID_ORDER_STATE, RESERVATION_EXPIRED, TRANSACTION_ALREADY_SETTLED.
//   GET /api/invoices/:id (STAFF/ADMIN) RETAIL → {id, invoiceNo, totalAmount, buyerSnapshot, transactionId, retailLines[]} lấy từ snapshot đơn.
//   Tổng 0: POST /api/me/orders trả transactionStatus SETTLED + invoiceId; invoice 0, không payment; order vẫn PENDING + HELD.
//   Hủy (US-45): POST /api/me/orders/:id/cancel, POST /api/orders/:id/cancel {version, reason}; tiền đến sau hủy: POST /api/orders/:id/late-receipts.
//   Để bước sau: own invoice của Member (US-42), UI (bước 4: TC18). TC17 hồi quy GYM/PT = các suite US-14/21/22 cũ phải vẫn xanh.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { ApplicationError } from '../src/common/errors/application-error';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { ensureFinancialIntegrity } from '../src/infrastructure/transaction/financial-integrity';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { ensureRetailCatalogIntegrity } from '../src/modules/catalog/retail-catalog.migration';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import { OperationRequestsRepository } from '../src/modules/operations/operation-requests.repository';
import { OrderExpiryWorker } from '../src/modules/orders/order-expiry.worker';
import { ensureOrdersIntegrity } from '../src/modules/orders/orders-migration';
import { UsersRepository } from '../src/modules/users/users.repository';
import { ACCOUNT_ADMINISTRATION } from '../src/modules/users/schemas/security-state.schema';

const NOW = '2035-11-14T03:00:00.000Z';
const origin = 'http://localhost:5173';
const password = 'MậtKhẩuUS-41-settle';
const HOUR = 3600 * 1000;
// Các collection mà thu tiền/hủy được phép ghi; dùng để chụp "trước/sau".
const WRITTEN = ['orders', 'order_items', 'order_events', 'transactions', 'invoices', 'payments', 'refunds', 'inventory', 'stock_movements',
  'operation_requests', 'notifications', 'notification_recipients', 'notification_outbox'];

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Actor = { accountId: string; token: string; phone: string };
type Member = Actor & { memberId: ObjectId };
type Created = { id: string; code: string; transactionId: string; transactionStatus: string; total: string; reservationExpiresAt: string;
  reservationState: string; invoiceId?: string };

describe('US-41 bước 3: thu RETAIL cho đơn website và đơn 0 đồng', () => {
  const saved = { ...process.env };
  const clock = new ServerClock();
  let now = NOW;
  clock.now = () => new Date(now);
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let second: INestApplication;
  let connection: Connection;
  let admin: Actor;
  let staff: Actor;
  let sequence = 0;
  const db = () => connection.db!;
  const http = (instance: INestApplication = app) => request(instance.getHttpServer());

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
      NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: `gym_test_us41_settle_${randomBytes(4).toString('hex')}`, FRONTEND_ORIGIN: origin,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RETAIL_QUOTE_SECRET: randomBytes(32).toString('base64url'),
      PICKUP_LOCATION: 'Quầy kiểm thử US41 thu tiền', RECEIVING_ACCOUNTS: '["GYM_MAIN"]', RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
    });
    app = await createApp();
    second = await createApp();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    await ensureFinancialIntegrity(connection);
    await ensureOrdersIntegrity(connection);
  }, 600000);

  beforeEach(async () => {
    now = NOW;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const instance of [app, second]) {
      const limiter = new LoginLimiter();
      jest.spyOn(instance.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    }
    for (const collection of await db().collections()) {
      if (!['roles', 'security_state'].includes(collection.collectionName)) await collection.deleteMany({});
    }
    await db().collection<{ _id: string; revision: Long }>('security_state')
      .updateOne({ _id: ACCOUNT_ADMINISTRATION }, { $setOnInsert: { revision: Long.ZERO } }, { upsert: true });
    await ensureRetailCatalogIntegrity(connection);
    admin = await userOf('ADMIN');
    staff = await userOf('STAFF');
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await second?.close();
    await app?.close();
    await mongo?.stop();
    process.env = saved;
  });

  // ---------- Tài khoản, hồ sơ Member ----------
  async function account(role: Role) {
    const users = app.get(UsersRepository);
    const roleDoc = await users.ensureRole(role, role);
    const phone = `094104${String(++sequence).padStart(4, '0')}`;
    const created = await users.createAccount({ roleId: String(roleDoc.id), phone, fullName: `${role} US41 settle`,
      passwordHash: await app.get(PasswordService).hash(password) });
    return { accountId: String(created.id), phone };
  }
  async function loginAs(phone: string) {
    return (await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200)).body.accessToken as string;
  }
  async function userOf(role: Role): Promise<Actor> {
    const created = await account(role);
    return { ...created, token: await loginAs(created.phone) };
  }
  async function member(): Promise<Member> {
    const owner = await account('MEMBER');
    const memberId = new ObjectId(), staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: 'Hội viên US41 thu tiền', phone: owner.phone,
      account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { ...owner, memberId, token: await loginAs(owner.phone) };
  }

  // ---------- Sản phẩm, tồn, giỏ và tạo đơn website (API bước 2) ----------
  const send = (method: 'post' | 'patch', path: string, body: object, actor: Actor) => http()[method](`/api${path}`)
    .set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', randomUUID()).send(body);
  async function product(price = '25000', stock = 10) {
    const n = ++sequence;
    const categoryId = (await send('post', '/admin/categories', { name: `Danh mục thu ${n}`, status: 'ACTIVE' }, admin).expect(201)).body.id as string;
    const sku = `US41S_${n}`, name = `Sản phẩm thu ${n}`;
    const id = (await send('post', '/admin/products', { categoryId, sku, name, price, status: 'ACTIVE' }, admin).expect(201)).body.id as string;
    const receipt = await send('post', '/stock-receipts', { reason: 'Nhập hàng kiểm thử US41 thu tiền, không phải hàng thật',
      items: [{ productId: id, quantity: stock, unitCost: '1000' }] }, staff).expect(201);
    await send('post', `/stock-receipts/${receipt.body.id}/post`, { version: 0 }, staff).expect(200);
    return { id, sku, name };
  }
  async function cartVersion(me: Member) {
    return (await http().get('/api/me/cart').set('Authorization', `Bearer ${me.token}`).expect(200)).body.version as number;
  }
  // Member thêm giỏ → preview → tạo đơn website; trả body 201 của POST /api/me/orders.
  async function websiteOrder(me: Member, lines: Array<[string, number]>, recipientName = 'Nguyễn Văn Nhận'): Promise<Created> {
    let version = await cartVersion(me);
    for (const [productId, quantity] of lines) {
      version = (await http().post('/api/me/cart/items').set('Authorization', `Bearer ${me.token}`).set('Idempotency-Key', randomUUID())
        .send({ version, productId, quantity }).expect(201)).body.version as number;
    }
    const quote = (await http().post('/api/me/orders/preview').set('Authorization', `Bearer ${me.token}`).send({ cartVersion: version }).expect(200)).body;
    return (await http().post('/api/me/orders').set('Authorization', `Bearer ${me.token}`).set('Idempotency-Key', randomUUID())
      .send({ cartVersion: version, quoteToken: quote.quoteToken, recipientName, recipientPhone: '0901234567', preferredPaymentMethod: 'CASH' })
      .expect(201)).body as Created;
  }
  // Đơn 25 000 đồng (1 dòng) của một Member mới.
  async function paidOrder(price = '25000', quantity = 1) {
    const me = await member(), item = await product(price);
    return { me, item, order: await websiteOrder(me, [[item.id, quantity]]) };
  }

  // ---------- Thu tiền US-21/22, hủy và tiền đến sau US-45 ----------
  const cash = (amount = '25000') => ({ method: 'CASH', amount, evidenceNote: 'Đã đếm đủ tiền mặt thực nhận tại quầy' });
  const transfer = (amount = '25000', bankReference = `US41-${randomUUID()}`) => ({ method: 'TRANSFER', amount,
    evidenceNote: 'Đã kiểm tra báo có ngân hàng thực tế', receivingAccountCode: 'GYM_MAIN', bankReference, receivedAt: now });
  const confirm = (transactionId: string, body: object, actor: Actor = staff, key: string = randomUUID(), instance: INestApplication = app) =>
    http(instance).post(`/api/transactions/${transactionId}/confirm-payment`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send(body);
  const paymentPreview = (transactionId: string, body: object = cash(), actor: Actor = staff) =>
    http().post(`/api/transactions/${transactionId}/payment-preview`).set('Authorization', `Bearer ${actor.token}`).send(body);
  const cancel = (orderId: string, version: number, actor: Actor, own: boolean, instance: INestApplication = app) =>
    http(instance).post(`/api${own ? '/me' : ''}/orders/${orderId}/cancel`).set('Authorization', `Bearer ${actor.token}`)
      .set('Idempotency-Key', randomUUID()).send({ version, reason: 'Khách đổi ý, hủy đơn đã đặt' });
  const invoice = (invoiceId: string, actor: Actor = staff) => http().get(`/api/invoices/${invoiceId}`).set('Authorization', `Bearer ${actor.token}`);

  const findOrder = (id: string) => db().collection('orders').findOne({ _id: new ObjectId(id) });
  const findTransaction = (id: string) => db().collection('transactions').findOne({ _id: new ObjectId(id) });
  const count = (name: string, filter: object = {}) => db().collection(name).countDocuments(filter);
  async function snapshot() {
    const rows: Record<string, unknown[]> = {};
    for (const name of WRITTEN) rows[name] = await db().collection(name).find().sort({ _id: 1 }).toArray();
    return rows;
  }
  async function reserved(productId: string) {
    const row = await db().collection('inventory').findOne({ product_id: new ObjectId(productId) });
    return { onHand: Number(row!.on_hand), reserved: Number(row!.reserved) };
  }
  function expectError(response: request.Response, status: number, code?: string) {
    expect(response.status).toBe(status);
    if (code) expect(response.body.error?.code).toBe(code);
  }

  // =====================================================================
  // AC03 – Thu RETAIL và đơn 0 đồng (TC09–TC12)
  // =====================================================================
  describe('US-41-TC09: Staff xác nhận đủ tiền CASH/TRANSFER và đọc invoice', () => {
    it.each(['CASH', 'TRANSFER'])('US-41-TC09: %s đủ tiền → 200 kết quả RETAIL, không có membershipId', async method => {
      const { order } = await paidOrder();
      const body = method === 'CASH' ? cash() : transfer();

      const result = await confirm(order.transactionId, body).expect(200);

      expect(result.body).toMatchObject({ kind: 'RETAIL', transactionId: order.transactionId, status: 'SETTLED', orderId: order.id, orderCode: order.code });
      expect(typeof result.body.paymentId).toBe('string');
      expect(typeof result.body.invoiceId).toBe('string');
      expect(result.body.invoiceNo).toBe(`INV-${result.body.invoiceId}`);
      expect(typeof result.body.notificationState).toBe('string');
      expect(result.body.membershipId).toBeUndefined();
    });

    it.each(['CASH', 'TRANSFER'])('US-41-TC09: %s → payment SUCCEEDED đúng reference, invoice, transaction SETTLED; đơn vẫn PENDING/HELD, hạn và tồn giữ nguyên', async method => {
      const { item, order } = await paidOrder();
      const bankReference = `US41-${randomUUID()}`;
      const orderBefore = await findOrder(order.id), stockBefore = await reserved(item.id);
      const movementsBefore = await count('stock_movements');

      const result = (await confirm(order.transactionId, method === 'CASH' ? cash() : transfer('25000', bankReference)).expect(200)).body;

      const payment = await db().collection('payments').findOne({ _id: new ObjectId(result.paymentId as string) });
      expect(payment).toMatchObject({ status: 'SUCCEEDED' });
      expect(payment!.reference).toBe(method === 'CASH' ? `CASH:${result.paymentId}` : `TRF:GYM_MAIN:${bankReference}`);
      expect(String(payment!.amount)).toBe('25000');
      expect(await count('invoices', { transaction_id: new ObjectId(order.transactionId) })).toBe(1);
      const transaction = await findTransaction(order.transactionId);
      expect(transaction).toMatchObject({ status: 'SETTLED', version: 1 });
      const after = await findOrder(order.id);
      expect(after).toMatchObject({ status: 'PENDING', reservation_state: 'HELD', version: Number(orderBefore!.version) + 1 });
      expect(after!.reservation_expires_at).toEqual(orderBefore!.reservation_expires_at);
      expect(await reserved(item.id)).toEqual(stockBefore);
      expect(await count('stock_movements')).toBe(movementsBefore);
      expect(await count('order_events', { order_id: new ObjectId(order.id), action: 'PAYMENT_SETTLED' })).toBe(1);
      expect(await count('memberships')).toBe(0);
    });

    it('US-41-TC09: GET /api/invoices/:id trả chứng từ RETAIL: tổng = tổng đơn, dòng từ snapshot đơn, người mua là người nhận lúc tạo', async () => {
      const me = await member(), a = await product('25000'), b = await product('10000');
      const order = await websiteOrder(me, [[a.id, 2], [b.id, 1]], 'Trần Thị Người Nhận');
      const settled = (await confirm(order.transactionId, cash('60000')).expect(200)).body;

      const document = (await invoice(settled.invoiceId as string).expect(200)).body;

      expect(document).toMatchObject({ id: settled.invoiceId, invoiceNo: settled.invoiceNo, totalAmount: '60000', transactionId: order.transactionId });
      expect(document.retailLines).toHaveLength(2);
      const lines = JSON.stringify(document.retailLines);
      for (const text of [a.sku, a.name, b.sku, b.name, '25000', '10000']) expect(lines).toContain(text);
      expect(JSON.stringify(document.buyerSnapshot)).toContain('Trần Thị Người Nhận');
    });

    it('US-41-TC09: đổi tên/giá sản phẩm và tên hồ sơ sau khi thu → invoice đọc lại vẫn giữ snapshot cũ', async () => {
      const { me, item, order } = await paidOrder();
      const settled = (await confirm(order.transactionId, cash()).expect(200)).body;
      const first = (await invoice(settled.invoiceId as string).expect(200)).body;

      const version = Number((await db().collection('products').findOne({ _id: new ObjectId(item.id) }))!.version);
      await send('patch', `/admin/products/${item.id}`, { version, name: 'Tên sản phẩm mới', price: '99000' }, admin).expect(200);
      await db().collection('members').updateOne({ _id: me.memberId }, { $set: { full_name: 'Tên hồ sơ mới' } });

      expect((await invoice(settled.invoiceId as string).expect(200)).body).toEqual(first);
    });

    it('US-41-TC09: cùng key PAYMENT_CONFIRM gửi lại → 200 cùng body; key khác cho giao dịch đã SETTLED → 409 TRANSACTION_ALREADY_SETTLED', async () => {
      const { order } = await paidOrder();
      const key = randomUUID();
      const first = await confirm(order.transactionId, cash(), staff, key).expect(200);

      expect((await confirm(order.transactionId, cash(), staff, key).expect(200)).body).toEqual(first.body);
      expectError(await confirm(order.transactionId, cash()), 409, 'TRANSACTION_ALREADY_SETTLED');
      expect(await count('payments')).toBe(1);
      expect(await count('invoices')).toBe(1);
    });
  });

  describe('US-41-TC10: Member tự xác nhận, tiền thiếu/thừa, reference trùng', () => {
    it.each(['MEMBER', 'TRAINER'] as Role[])('US-41-TC10: %s gọi payment-preview/confirm-payment → 403, giao dịch vẫn PENDING', async role => {
      const { me, order } = await paidOrder();
      const actor = role === 'MEMBER' ? me : await userOf('TRAINER');
      const before = await snapshot();
      expectError(await paymentPreview(order.transactionId, cash(), actor), 403);
      expectError(await confirm(order.transactionId, cash(), actor), 403);
      expect(await snapshot()).toEqual(before);
    });

    it.each([['thiếu', '24999'], ['thừa', '25001']])('US-41-TC10: số tiền %s (%s) → 409 AMOUNT_MISMATCH, không payment', async (_case, amount) => {
      const { order } = await paidOrder();
      const before = await snapshot();
      expectError(await confirm(order.transactionId, cash(amount)), 409, 'AMOUNT_MISMATCH');
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC10: bankReference đã dùng cho giao dịch khác → 409 PAYMENT_REFERENCE_USED; thêm khoảng trắng đầu/cuối không lách được (server trim)', async () => {
      const first = await paidOrder(), other = await paidOrder();
      const reference = `US41-DUP-${randomUUID()}`;
      await confirm(first.order.transactionId, transfer('25000', reference)).expect(200);
      const before = await snapshot();

      expectError(await confirm(other.order.transactionId, transfer('25000', reference), admin), 409, 'PAYMENT_REFERENCE_USED');
      expectError(await confirm(other.order.transactionId, transfer('25000', `  ${reference}  `), admin), 409, 'PAYMENT_REFERENCE_USED');
      expect(await snapshot()).toEqual(before);
      expect((await findTransaction(other.order.transactionId))!.status).toBe('PENDING');
    });

    it.each([
      ['evidenceNote dưới 10 ký tự', { evidenceNote: 'ngắn' }], ['CASH kèm receivedAt', { receivedAt: NOW }],
      ['field lạ status', { status: 'SETTLED' }], ['field lạ memberId', { memberId: new ObjectId().toHexString() }],
    ])('US-41-TC10: confirm với %s → 400, không payment', async (_case, extra) => {
      const { order } = await paidOrder();
      expectError(await confirm(order.transactionId, { ...cash(), ...extra }), 400);
      expect(await count('payments')).toBe(0);
    });
  });

  describe('US-41-TC11: đơn tổng 0 đồng hợp lệ', () => {
    it('US-41-TC11: tạo đơn 0 đồng → 201 transactionStatus SETTLED + invoiceId; invoice 0, không payment; đơn vẫn PENDING + HELD, vẫn giữ tồn', async () => {
      const me = await member(), item = await product('0', 5);

      const order = await websiteOrder(me, [[item.id, 2]]);

      expect(order).toMatchObject({ total: '0', transactionStatus: 'SETTLED', reservationState: 'HELD' });
      expect(typeof order.invoiceId).toBe('string');
      expect(await findOrder(order.id)).toMatchObject({ status: 'PENDING', reservation_state: 'HELD' });
      expect(await findTransaction(order.transactionId)).toMatchObject({ status: 'SETTLED' });
      const zero = await db().collection('invoices').findOne({ _id: new ObjectId(order.invoiceId!) });
      expect(String(zero!.total_amount)).toBe('0');
      expect(await count('payments')).toBe(0);
      expect(await reserved(item.id)).toEqual({ onHand: 5, reserved: 2 });
    });

    it('US-41-TC11: confirm-payment cho giao dịch 0 đã hoàn tất → 409, không tạo payment 0', async () => {
      const me = await member(), item = await product('0', 5);
      const order = await websiteOrder(me, [[item.id, 1]]);
      const before = await snapshot();

      const response = await confirm(order.transactionId, cash('0'));

      expect([400, 409]).toContain(response.status);
      expect(await snapshot()).toEqual(before);
      expect(await count('payments')).toBe(0);
    });

    it('US-41-TC11: lỗi khi tạo invoice 0 → rollback cả lệnh tạo đơn: không đơn, không giữ tồn, giỏ còn', async () => {
      const me = await member(), item = await product('0', 5);
      let version = await cartVersion(me);
      version = (await http().post('/api/me/cart/items').set('Authorization', `Bearer ${me.token}`).set('Idempotency-Key', randomUUID())
        .send({ version, productId: item.id, quantity: 1 }).expect(201)).body.version as number;
      const quote = (await http().post('/api/me/orders/preview').set('Authorization', `Bearer ${me.token}`).send({ cartVersion: version }).expect(200)).body;
      jest.spyOn(connection.models.Invoice, 'create').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Lỗi giả khi tạo invoice 0'));
      const before = await snapshot();

      const failed = await http().post('/api/me/orders').set('Authorization', `Bearer ${me.token}`).set('Idempotency-Key', randomUUID())
        .send({ cartVersion: version, quoteToken: quote.quoteToken, recipientName: 'Người nhận', recipientPhone: '0901234567', preferredPaymentMethod: 'CASH' });

      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await snapshot()).toEqual(before);
      expect(await count('carts', { member_id: me.memberId })).toBe(1);
    });
  });

  describe('US-41-TC12: hủy/hết hạn cạnh tranh thu tiền và tiền đến sau hủy', () => {
    it('US-41-TC12: Member hủy trước → confirm 409 INVALID_ORDER_STATE, không hồi sinh đơn, không invoice bán', async () => {
      const { me, item, order } = await paidOrder();
      await cancel(order.id, 0, me, true).expect(200);
      const before = await snapshot();

      expectError(await confirm(order.transactionId, cash()), 409, 'INVALID_ORDER_STATE');

      expect(await snapshot()).toEqual(before);
      expect(await findOrder(order.id)).toMatchObject({ status: 'CANCELLED', reservation_state: 'RELEASED' });
      expect((await findTransaction(order.transactionId))!.status).toBe('CANCELLED');
      expect(await reserved(item.id)).toEqual({ onHand: 10, reserved: 0 });
    });

    it('US-41-TC12: thu tiền trước rồi Staff hủy → đơn CANCELLED, trả tồn, refund PENDING; transaction vẫn SETTLED, invoice giữ nguyên', async () => {
      const { item, order } = await paidOrder();
      const settled = (await confirm(order.transactionId, cash()).expect(200)).body;
      const invoiceBefore = (await invoice(settled.invoiceId as string).expect(200)).body;
      const version = Number((await findOrder(order.id))!.version);

      await cancel(order.id, version, staff, false).expect(200);

      expect(await findOrder(order.id)).toMatchObject({ status: 'CANCELLED', reservation_state: 'RELEASED' });
      expect((await findTransaction(order.transactionId))!.status).toBe('SETTLED');
      expect(await count('refunds', { status: 'PENDING' })).toBe(1);
      expect(await count('payments', { status: 'SUCCEEDED' })).toBe(1);
      expect(await reserved(item.id)).toEqual({ onHand: 10, reserved: 0 });
      // P04: phần chứng từ đã phát hành giữ nguyên (không sửa tổng về 0, không xóa payment);
      // trạng thái đơn/refund thì hiển thị theo nguồn hiện tại.
      const invoiceAfter = (await invoice(settled.invoiceId as string).expect(200)).body;
      for (const field of ['id', 'invoiceNo', 'issuedAt', 'totalAmount', 'buyerSnapshot', 'retailLines', 'payment']) {
        expect(invoiceAfter[field]).toEqual(invoiceBefore[field]);
      }
      expect(JSON.stringify(invoiceAfter)).toContain('CANCELLED');
      expect(JSON.stringify(invoiceAfter)).toContain('PENDING');
    });

    it('US-41-TC12: worker hết hạn hủy đơn chưa thu → confirm sau đó 409, transaction không thành SETTLED', async () => {
      const { order } = await paidOrder();
      now = new Date(Date.parse(NOW) + 24 * HOUR).toISOString();
      await app.get(OrderExpiryWorker).runOnce();
      expect(await findOrder(order.id)).toMatchObject({ status: 'CANCELLED', cancellation_source: 'EXPIRED' });

      const response = await confirm(order.transactionId, cash());

      expect(response.status).toBe(409);
      expect(['INVALID_ORDER_STATE', 'RESERVATION_EXPIRED']).toContain(response.body.error?.code);
      expect((await findTransaction(order.transactionId))!.status).not.toBe('SETTLED');
      expect(await count('payments')).toBe(0);
    });

    it('US-41-TC12: tiền thực nhận tới sau khi đơn đã hủy → đi route late-receipts (200), không SETTLED lại giao dịch đã CANCELLED', async () => {
      const { me, order } = await paidOrder();
      await cancel(order.id, 0, me, true).expect(200);
      const lateBody = { method: 'TRANSFER', amount: '25000', evidenceNote: 'Đối soát báo có ngân hàng đến sau khi hủy',
        receivingAccountCode: 'GYM_MAIN', bankReference: `US41-LATE-${randomUUID()}`, receivedAt: NOW };

      await http().post(`/api/orders/${order.id}/late-receipts`).set('Authorization', `Bearer ${staff.token}`).set('Idempotency-Key', randomUUID())
        .send(lateBody).expect(200);

      expect((await findTransaction(order.transactionId))!.status).toBe('CANCELLED');
      expect(await findOrder(order.id)).toMatchObject({ status: 'CANCELLED' });
      expect(await count('refunds')).toBe(1);
    });

    it('US-41-TC12: Member hủy và Staff thu tiền chạy đồng thời qua hai app (5 vòng) → luôn ra một kết quả hợp lệ, không hồi sinh đơn', async () => {
      for (let round = 0; round < 5; round++) {
        const { me, item, order } = await paidOrder();

        const [paid, cancelled] = await Promise.all([
          confirm(order.transactionId, cash(), staff, randomUUID(), app), cancel(order.id, 0, me, true, second),
        ]);

        const transaction = await findTransaction(order.transactionId), current = await findOrder(order.id);
        const refunds = await count('refunds', { transaction_id: new ObjectId(order.transactionId) });
        const payments = await count('payments', { transaction_id: new ObjectId(order.transactionId), status: 'SUCCEEDED' });
        if (transaction!.status === 'SETTLED') {
          // Thu tiền thắng: một payment; hoặc đơn vẫn giữ hàng (hủy bị từ chối), hoặc đơn hủy kèm refund PENDING.
          expect(paid.status).toBe(200);
          expect(payments).toBe(1);
          if (current!.status === 'CANCELLED') expect(refunds).toBe(1);
          else { expect(cancelled.status).toBe(409); expect(current).toMatchObject({ status: 'PENDING', reservation_state: 'HELD' }); }
        } else {
          // Hủy thắng: không payment, không invoice bán, giao dịch CANCELLED, trả tồn.
          expect(cancelled.status).toBe(200);
          expect(paid.status).toBe(409);
          expect(transaction!.status).toBe('CANCELLED');
          expect(payments).toBe(0);
          expect(await count('invoices', { transaction_id: new ObjectId(order.transactionId) })).toBe(0);
          expect(current).toMatchObject({ status: 'CANCELLED', reservation_state: 'RELEASED' });
          expect((await reserved(item.id)).reserved).toBe(0);
        }
      }
    });
  });

  describe('US-41-TC08: thu tiền trước hạn và đúng mốc 24 giờ', () => {
    it('US-41-TC08: thu lúc hạn − 1ms được; hạn giữ KHÔNG được gia hạn sau khi SETTLED', async () => {
      const { order } = await paidOrder();
      now = new Date(Date.parse(NOW) + 24 * HOUR - 1).toISOString();

      await confirm(order.transactionId, cash()).expect(200);

      expect((await findOrder(order.id))!.reservation_expires_at.toISOString()).toBe(order.reservationExpiresAt);
    });

    it('US-41-TC08: đúng mốc 24 giờ (worker chưa chạy) → confirm 409 RESERVATION_EXPIRED, không ghi gì', async () => {
      const { order } = await paidOrder();
      now = new Date(Date.parse(NOW) + 24 * HOUR).toISOString();
      const before = await snapshot();

      expectError(await confirm(order.transactionId, cash()), 409, 'RESERVATION_EXPIRED');
      expect(await snapshot()).toEqual(before);
    });
  });

  // =====================================================================
  // AC04 – Rollback khi lỗi và preview không thay quyền ghi (TC15, TC16)
  // =====================================================================
  describe('US-41-TC15: lỗi invoice/outbox/operation trong settlement', () => {
    it.each([
      ['insert invoice', () => jest.spyOn(connection.models.Invoice, 'create').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Invoice'))],
      ['insert outbox', () => jest.spyOn(app.get(NotificationsRepository), 'insertOutbox').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Outbox'))],
      ['ghi operation key', () => jest.spyOn(app.get(OperationRequestsRepository), 'insert').mockRejectedValue(new ApplicationError(503, 'TEST_FAILURE', 'Key'))],
    ])('US-41-TC15: lỗi %s → rollback toàn bộ: không payment/invoice, transaction PENDING, đơn không đổi; thử lại sau đó thành công', async (_case, fault) => {
      const { order } = await paidOrder();
      const before = await snapshot();
      fault();

      const failed = await confirm(order.transactionId, cash());

      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await snapshot()).toEqual(before);
      jest.restoreAllMocks();
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      await confirm(order.transactionId, cash()).expect(200);
    });
  });

  describe('US-41-TC16: preview READY rồi trạng thái/hạn thay đổi', () => {
    it('US-41-TC16: payment-preview RETAIL trả READY kèm ngữ cảnh đơn và KHÔNG ghi DB, không đổi hạn', async () => {
      const { order } = await paidOrder();
      const before = await snapshot();

      const preview = (await paymentPreview(order.transactionId).expect(200)).body;

      expect(preview).toMatchObject({ reviewState: 'READY', blockingCodes: [], amountDue: '25000' });
      const text = JSON.stringify(preview);
      for (const value of [order.id, order.code, order.reservationExpiresAt]) expect(text).toContain(value);
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC16: READY rồi Member hủy → preview mới BLOCKED; confirm vẫn kiểm lại và trả 409, không dùng preview cũ làm quyền ghi', async () => {
      const { me, order } = await paidOrder();
      expect((await paymentPreview(order.transactionId).expect(200)).body.reviewState).toBe('READY');
      await cancel(order.id, 0, me, true).expect(200);

      const blocked = (await paymentPreview(order.transactionId).expect(200)).body;
      expect(blocked.reviewState).toBe('BLOCKED');
      expect(blocked.blockingCodes.length).toBeGreaterThan(0);
      expectError(await confirm(order.transactionId, cash()), 409);
      expect(await count('payments')).toBe(0);
    });

    it('US-41-TC16: READY rồi tới đúng hạn → preview BLOCKED có RESERVATION_EXPIRED; confirm 409 RESERVATION_EXPIRED', async () => {
      const { order } = await paidOrder();
      expect((await paymentPreview(order.transactionId).expect(200)).body.reviewState).toBe('READY');
      now = new Date(Date.parse(NOW) + 24 * HOUR).toISOString();

      const blocked = (await paymentPreview(order.transactionId).expect(200)).body;
      expect(blocked).toMatchObject({ reviewState: 'BLOCKED' });
      expect(blocked.blockingCodes).toContain('RESERVATION_EXPIRED');
      expectError(await confirm(order.transactionId, cash()), 409, 'RESERVATION_EXPIRED');
    });
  });
});
