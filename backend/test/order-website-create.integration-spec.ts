// Tầng kiểm thử backend (Jest + Supertest + MongoDB replica set thật): US-41 bước 2 – Member preview và tạo đơn website từ giỏ.
// Kiểm tra quote ký riêng, quyền, chặn hàng/tồn/trần, tạo nguyên tử (đơn + giữ tồn + xóa giỏ + key), snapshot, hạn 24 giờ, replay key (TC01–TC06, TC08, TC14).
// Hợp đồng test đặt ra cho Builder (US-41 bước 2, theo mục 1, 2, 3 và 5 của spec 1.0.2):
//   POST /api/me/orders/preview {cartVersion} → 200 {items, total, quoteToken, quoteExpiresAt, pickupLocation, asOf}; không ghi DB.
//   POST /api/me/orders (Idempotency-Key, operation ORDER_CREATE_WEBSITE)
//     {cartVersion, quoteToken, recipientName, recipientPhone, preferredPaymentMethod}
//     → 201 {id, code, status, transactionId, transactionStatus, total, reservationExpiresAt, reservationState, cartVersion, invoiceId?, notificationState}.
//   quoteToken: JWT HS256 ký bằng RETAIL_QUOTE_SECRET (dùng nguyên chuỗi làm khóa), aud retail-order-quote, purpose RETAIL_QUOTE_V1,
//     exp = quoteExpiresAt = giờ server + 10 phút; payload actorId, memberId, channel, cartVersion, items[{productId, quantity, productVersion, unitPrice}], total.
//   Lỗi {error:{code}}: 400 DTO/quote giả; 401; 403; 409 CART_EMPTY, CART_VERSION_CONFLICT, QUOTE_STALE, QUOTE_EXPIRED, PRODUCT_UNAVAILABLE,
//     INSUFFICIENT_STOCK, MEMBER_PROFILE_REQUIRED, CART_LIMIT_EXCEEDED, AMOUNT_LIMIT_EXCEEDED, IDEMPOTENCY_CONFLICT; 503 thiếu PICKUP_LOCATION.
//   Giữ tồn: inventory.reserved +q, on_hand giữ nguyên, movement kind ORDER_RESERVE event_key ORDER_RESERVE:<orderItemId>, inventory.version +1.
//   Để bước sau: thu RETAIL / đơn 0 đồng / invoice (bước 3: TC09–TC12, TC15–TC17); canCheckout S06 và UI (bước 4: TC18).
//   Tranh chấp hai app (TC07, TC13) nằm ở order-website-race.integration-spec.ts.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { ApplicationError } from '../src/common/errors/application-error';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { ensureFinancialIntegrity } from '../src/infrastructure/transaction/financial-integrity';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { ensureRetailCatalogIntegrity } from '../src/modules/catalog/retail-catalog.migration';
import { InventoryWriter } from '../src/modules/inventory/inventory-writer';
import { ensureOrdersIntegrity } from '../src/modules/orders/orders-migration';
import { UsersRepository } from '../src/modules/users/users.repository';
import { ACCOUNT_ADMINISTRATION } from '../src/modules/users/schemas/security-state.schema';

const NOW = '2035-11-14T03:00:00.000Z';
const origin = 'http://localhost:5173';
const password = 'MậtKhẩuUS-41-create';
const PICKUP = 'Quầy lễ tân tầng 1 – kiểm thử US41';
const HOUR = 3600 * 1000;
// Các collection mà một lệnh tạo đơn được phép ghi; dùng để chụp "trước/sau" khi lệnh bị chặn hoặc rollback.
const WRITTEN = ['orders', 'order_items', 'order_events', 'transactions', 'invoices', 'payments', 'inventory', 'stock_movements',
  'carts', 'cart_states', 'operation_requests', 'notifications', 'notification_recipients', 'notification_outbox'];

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Actor = { accountId: string; token: string; phone: string };
type Member = Actor & { memberId: ObjectId };
type Product = { id: string; categoryId: string; sku: string; name: string };

describe('US-41 bước 2: Member preview và tạo đơn website', () => {
  const saved = { ...process.env };
  const clock = new ServerClock();
  let now = NOW;
  clock.now = () => new Date(now);
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  // App phụ (ví dụ thiếu PICKUP_LOCATION): chỉ đóng ở afterAll, vì đóng giữa chừng làm app chính mất kết nối DB.
  const extraApps: INestApplication[] = [];
  let connection: Connection;
  let admin: Actor;
  let staff: Actor;
  let sequence = 0;
  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());

  // Dựng một app Nest dùng chung DB và đồng hồ giả (dùng cả cho app phụ thiếu PICKUP_LOCATION).
  async function createApp() {
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
    const instance = module.createNestApplication({ logger: false, bodyParser: false });
    configureHttp(instance);
    await instance.init();
    return instance;
  }

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      replSet: { count: 1, storageEngine: 'wiredTiger', args: ['--setParameter', 'enableTestCommands=1'] },
    });
    Object.assign(process.env, {
      NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: `gym_test_us41_create_${randomBytes(4).toString('hex')}`, FRONTEND_ORIGIN: origin,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RETAIL_QUOTE_SECRET: randomBytes(32).toString('base64url'),
      PICKUP_LOCATION: PICKUP, RECEIVING_ACCOUNTS: '["GYM_MAIN"]', RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
    });
    app = await createApp();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    await ensureFinancialIntegrity(connection);
    await ensureOrdersIntegrity(connection);
  }, 600000);

  beforeEach(async () => {
    now = NOW;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await db().collections()) {
      if (!['roles', 'security_state'].includes(collection.collectionName)) await collection.deleteMany({});
    }
    await db().collection<{ _id: string; revision: Long }>('security_state')
      .updateOne({ _id: ACCOUNT_ADMINISTRATION }, { $setOnInsert: { revision: Long.ZERO } }, { upsert: true });
    await ensureRetailCatalogIntegrity(connection);
    admin = await userOf('ADMIN');
    staff = await userOf('STAFF');
  });

  afterEach(async () => {
    await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    for (const extra of extraApps) await extra.close();
    await app?.close();
    await mongo?.stop();
    process.env = saved;
  });

  // ---------- Tài khoản, hồ sơ Member ----------
  async function account(role: Role) {
    const users = app.get(UsersRepository);
    const roleDoc = await users.ensureRole(role, role);
    const phone = `094102${String(++sequence).padStart(4, '0')}`;
    const created = await users.createAccount({ roleId: String(roleDoc.id), phone, fullName: `${role} US41`,
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
  // Hồ sơ hội viên đã liên kết với account MEMBER (linked=false: account MEMBER chưa có hồ sơ).
  async function member(linked = true): Promise<Member> {
    const owner = await account('MEMBER');
    const memberId = new ObjectId();
    if (linked) {
      const staffId = new ObjectId();
      await db().collection('members').insertOne({
        _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: 'Hội viên US41', phone: owner.phone,
        account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
      });
    }
    return { ...owner, memberId, token: await loginAs(owner.phone) };
  }

  // ---------- Sản phẩm (API Admin US-34) và tồn (phiếu nhập US-37) ----------
  const send = (method: 'post' | 'patch', path: string, body: object, actor: Actor) => http()[method](`/api${path}`)
    .set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', randomUUID()).send(body);
  async function product(options: { price?: string; stock?: number; categoryId?: string } = {}): Promise<Product> {
    const n = ++sequence;
    const categoryId = options.categoryId
      ?? (await send('post', '/admin/categories', { name: `Danh mục US41 ${n}`, status: 'ACTIVE' }, admin).expect(201)).body.id as string;
    const sku = `US41_${n}`, name = `Sản phẩm US41 ${n}`;
    const id = (await send('post', '/admin/products', { categoryId, sku, name, price: options.price ?? '25000', status: 'ACTIVE' }, admin)
      .expect(201)).body.id as string;
    const stock = options.stock ?? 10;
    if (stock > 0) {
      const receipt = await send('post', '/stock-receipts', { reason: 'Nhập hàng kiểm thử US41, không phải hàng thật',
        items: [{ productId: id, quantity: stock, unitCost: '1000' }] }, staff).expect(201);
      await send('post', `/stock-receipts/${receipt.body.id}/post`, { version: 0 }, staff).expect(200);
    }
    return { id, categoryId, sku, name };
  }
  async function productVersion(productId: string) {
    return Number((await db().collection('products').findOne({ _id: new ObjectId(productId) }))?.version ?? 0);
  }
  async function patchProduct(productId: string, body: object) {
    await send('patch', `/admin/products/${productId}`, { version: await productVersion(productId), ...body }, admin).expect(200);
  }

  // ---------- Giỏ (API US-40) ----------
  async function cartVersion(me: Member) {
    return (await http().get('/api/me/cart').set('Authorization', `Bearer ${me.token}`).expect(200)).body.version as number;
  }
  async function addToCart(me: Member, productId: string, quantity: number) {
    const version = await cartVersion(me);
    return (await http().post('/api/me/cart/items').set('Authorization', `Bearer ${me.token}`).set('Idempotency-Key', randomUUID())
      .send({ version, productId, quantity }).expect(201)).body.version as number;
  }
  async function cartRows(memberId: ObjectId) {
    const lines = await db().collection('carts').find({ member_id: memberId }, { projection: { _id: 0, product_id: 1, quantity: 1 } })
      .sort({ product_id: 1 }).toArray();
    const state = await db().collection('cart_states').findOne({ _id: memberId });
    return { lines: lines.map(line => `${line.product_id}:${line.quantity}`), version: state ? Number(state.version) : null };
  }

  // ---------- Gọi API đặt đơn ----------
  const previewCall = (actor: Actor | null, body: object) => {
    const call = http().post('/api/me/orders/preview');
    return (actor ? call.set('Authorization', `Bearer ${actor.token}`) : call).send(body);
  };
  const createCall = (actor: Actor | null, body: object, key: string | null = randomUUID()) => {
    let call = http().post('/api/me/orders');
    if (actor) call = call.set('Authorization', `Bearer ${actor.token}`);
    if (key !== null) call = call.set('Idempotency-Key', key);
    return call.send(body);
  };
  async function preview(me: Member, version?: number) {
    return (await previewCall(me, { cartVersion: version ?? await cartVersion(me) }).expect(200)).body as {
      items: unknown[]; total: string; quoteToken: string; quoteExpiresAt: string; pickupLocation: unknown; asOf: string;
    };
  }
  // Body tạo đơn hợp lệ từ một lần preview.
  function orderBody(version: number, quoteToken: string, overrides: Record<string, unknown> = {}) {
    return { cartVersion: version, quoteToken, recipientName: 'Nguyễn Văn Nhận', recipientPhone: '0901234567', preferredPaymentMethod: 'CASH', ...overrides };
  }
  // Giỏ có sẵn các dòng và một quote hợp lệ.
  async function readyCart(me: Member, lines: Array<[Product, number]>) {
    let version = await cartVersion(me);
    for (const [item, quantity] of lines) version = await addToCart(me, item.id, quantity);
    const quote = await preview(me, version);
    return { version, quote, body: orderBody(version, quote.quoteToken) };
  }

  async function snapshot() {
    const rows: Record<string, unknown[]> = {};
    for (const name of WRITTEN) rows[name] = await db().collection(name).find().sort({ _id: 1 }).toArray();
    return rows;
  }
  function expectError(response: request.Response, status: number, code?: string) {
    expect(response.status).toBe(status);
    if (code) expect(response.body.error?.code).toBe(code);
  }
  const count = (name: string, filter: object = {}) => db().collection(name).countDocuments(filter);

  // ---------- JWT tự ký để giả quote (chỉ dùng crypto của Node) ----------
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  function decode(token: string) {
    const [header, payload] = token.split('.');
    return { header: JSON.parse(Buffer.from(header, 'base64url').toString()), payload: JSON.parse(Buffer.from(payload, 'base64url').toString()) };
  }
  function sign(header: object, payload: object, secret: string) {
    const head = `${b64(header)}.${b64(payload)}`;
    return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
  }

  // Bật lỗi giả của MongoDB cho đúng một collection, và tự kiểm lỗi giả đã có hiệu lực (tránh test xanh oan).
  async function failOn(collection: string, command: 'insert' | 'delete') {
    await db().admin().command({ configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: [command], errorCode: 8, namespace: `${db().databaseName}.${collection}` } });
    const probe = command === 'insert'
      ? db().collection(collection).insertOne({ probe: true })
      : db().collection(collection).deleteMany({ probe: true });
    await expect(probe).rejects.toMatchObject({ code: 8 });
    // Đối chứng: collection khác vẫn ghi/xóa bình thường, tức lỗi giả chỉ nhắm đúng collection cần thử.
    const control = db().collection('zz_failpoint_control');
    await expect(control.insertOne({ probe: true })).resolves.toBeDefined();
    await expect(control.deleteMany({ probe: true })).resolves.toBeDefined();
  }

  // =====================================================================
  // AC01 – Owner, quote giá và dữ liệu đầu vào (TC01–TC04)
  // =====================================================================
  describe('US-41-TC01: Member đã liên kết preview rồi tạo đơn từ giỏ hợp lệ', () => {
    it('US-41-TC01: preview trả giá server, quầy nhận, quote hạn 10 phút và KHÔNG ghi gì vào DB', async () => {
      const me = await member();
      const a = await product({ price: '25000' }), b = await product({ price: '10000' });
      await addToCart(me, a.id, 2);
      const version = await addToCart(me, b.id, 1);
      const before = await snapshot();

      const quote = await preview(me, version);

      expect(quote.items).toHaveLength(2);
      expect(quote.total).toBe('60000');
      expect(typeof quote.quoteToken).toBe('string');
      expect(quote.quoteExpiresAt).toBe(new Date(Date.parse(NOW) + 10 * 60 * 1000).toISOString());
      expect(JSON.stringify(quote.pickupLocation)).toContain(PICKUP);
      expect(typeof quote.asOf).toBe('string');
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC01: create trả 201 đúng hợp đồng: đơn WEBSITE PENDING, HELD, đúng tổng, hạn 24 giờ, cartVersion +1', async () => {
      const me = await member();
      const a = await product({ price: '25000' }), b = await product({ price: '10000' });
      const { version, body } = await readyCart(me, [[a, 2], [b, 1]]);

      const response = await createCall(me, body).expect(201);

      expect(response.body).toMatchObject({
        status: 'PENDING', transactionStatus: 'PENDING', total: '60000', reservationState: 'HELD',
        reservationExpiresAt: new Date(Date.parse(NOW) + 24 * HOUR).toISOString(), cartVersion: version + 1,
      });
      expect(response.body.code).toBe(`ORD-${response.body.id}`);
      expect(typeof response.body.transactionId).toBe('string');
      expect(typeof response.body.notificationState).toBe('string');
      expect(response.body.invoiceId).toBeUndefined();
    });

    it('US-41-TC01: DB sau create: order, transaction RETAIL PENDING chưa invoice/payment, giữ tồn, giỏ trống, event và key', async () => {
      const me = await member();
      const a = await product({ price: '25000', stock: 10 }), b = await product({ price: '10000', stock: 10 });
      const { version, body } = await readyCart(me, [[a, 2], [b, 1]]);
      const inventoryBefore = await db().collection('inventory').find().toArray();

      const created = (await createCall(me, body).expect(201)).body;
      const orderId = new ObjectId(created.id as string);

      const order = await db().collection('orders').findOne({ _id: orderId });
      expect(order).toMatchObject({ channel: 'WEBSITE', status: 'PENDING', reservation_state: 'HELD', preferred_payment_method: 'CASH' });
      expect(String(order!.member_id)).toBe(String(me.memberId));
      expect(String(order!.created_by)).toBe(me.accountId);
      const transaction = await db().collection('transactions').findOne({ _id: new ObjectId(created.transactionId as string) });
      expect(transaction).toMatchObject({ kind: 'RETAIL', status: 'PENDING' });
      expect(String(transaction!.amount_due)).toBe('60000');
      expect(await count('invoices')).toBe(0);
      expect(await count('payments')).toBe(0);
      expect(await count('order_items', { order_id: orderId })).toBe(2);

      for (const [item, quantity] of [[a, 2], [b, 1]] as Array<[Product, number]>) {
        const old = inventoryBefore.find(row => String(row.product_id) === item.id)!;
        const balance = await db().collection('inventory').findOne({ product_id: new ObjectId(item.id) });
        expect(Number(balance!.on_hand)).toBe(Number(old.on_hand));
        expect(Number(balance!.reserved)).toBe(Number(old.reserved) + quantity);
        expect(Number(balance!.version)).toBe(Number(old.version) + 1);
        const line = await db().collection('order_items').findOne({ order_id: orderId, product_id: new ObjectId(item.id) });
        const movements = await db().collection('stock_movements').find({ kind: 'ORDER_RESERVE', product_id: new ObjectId(item.id) }).toArray();
        expect(movements).toHaveLength(1);
        expect(movements[0].event_key).toBe(`ORDER_RESERVE:${line!._id}`);
      }

      expect(await cartRows(me.memberId)).toEqual({ lines: [], version: version + 1 });
      expect(await count('order_events', { order_id: orderId, action: 'CREATED', event_key: `ORDER_CREATED:${orderId}` })).toBe(1);
      expect(await count('operation_requests', { operation: 'ORDER_CREATE_WEBSITE' })).toBe(1);
    });
  });

  describe('US-41-TC02: Guest, sai vai trò, chưa liên kết, dữ liệu giả', () => {
    it('US-41-TC02: Guest gọi preview/create → 401', async () => {
      expectError(await previewCall(null, { cartVersion: 0 }), 401);
      expectError(await createCall(null, orderBody(0, 'x')), 401);
    });

    it.each(['STAFF', 'ADMIN', 'TRAINER'] as Role[])('US-41-TC02: %s gọi route Member → 403, không có đơn', async role => {
      const actor = await userOf(role);
      expectError(await previewCall(actor, { cartVersion: 0 }), 403);
      expectError(await createCall(actor, orderBody(0, 'x')), 403);
      expect(await count('orders')).toBe(0);
    });

    it('US-41-TC02: account MEMBER chưa liên kết hồ sơ → preview 409 MEMBER_PROFILE_REQUIRED', async () => {
      const me = await member(false);
      expectError(await previewCall(me, { cartVersion: 0 }), 409, 'MEMBER_PROFILE_REQUIRED');
    });

    it('US-41-TC02: giỏ trống → preview 409 CART_EMPTY', async () => {
      const me = await member();
      expectError(await previewCall(me, { cartVersion: await cartVersion(me) }), 409, 'CART_EMPTY');
    });

    it.each([
      ['memberId', { memberId: new ObjectId().toHexString() }], ['unitPrice', { unitPrice: '1' }], ['total', { total: '1' }],
      ['status', { status: 'SETTLED' }], ['items', { items: [] }], ['accountId', { accountId: new ObjectId().toHexString() }],
    ])('US-41-TC02: create gửi kèm field ngoài allowlist (%s) → 400, không có đơn, giỏ giữ nguyên', async (_field, extra) => {
      const me = await member();
      const { body } = await readyCart(me, [[await product(), 1]]);
      const cart = await cartRows(me.memberId);
      expectError(await createCall(me, { ...body, ...extra }), 400);
      expect(await count('orders')).toBe(0);
      expect(await cartRows(me.memberId)).toEqual(cart);
    });

    it('US-41-TC02: preview gửi kèm memberId → 400', async () => {
      const me = await member();
      await addToCart(me, (await product()).id, 1);
      expectError(await previewCall(me, { cartVersion: await cartVersion(me), memberId: new ObjectId().toHexString() }), 400);
    });

    it.each([
      ['recipientName 1 ký tự sau trim', { recipientName: '  A  ' }], ['recipientName 121 ký tự', { recipientName: 'A'.repeat(121) }],
      ['thiếu recipientName', { recipientName: undefined }], ['recipientPhone sai định dạng', { recipientPhone: 'abc' }],
      ['recipientPhone quá ngắn', { recipientPhone: '123' }], ['preferredPaymentMethod CARD', { preferredPaymentMethod: 'CARD' }],
      ['thiếu preferredPaymentMethod', { preferredPaymentMethod: undefined }], ['cartVersion là chuỗi', { cartVersion: '1' }],
      ['thiếu quoteToken', { quoteToken: undefined }],
    ])('US-41-TC02: create với %s → 400, không có đơn', async (_case, override) => {
      const me = await member();
      const { body } = await readyCart(me, [[await product(), 1]]);
      expectError(await createCall(me, { ...body, ...override }), 400);
      expect(await count('orders')).toBe(0);
    });

    it('US-41-TC02: thiếu Idempotency-Key hoặc key không phải UUID v4 → 400', async () => {
      const me = await member();
      const { body } = await readyCart(me, [[await product(), 1]]);
      expectError(await createCall(me, body, null), 400);
      expectError(await createCall(me, body, 'khong-phai-uuid'), 400);
      expect(await count('orders')).toBe(0);
    });

    it('US-41-TC02: recipientName 2 ký tự sau trim và 120 ký tự là hợp lệ; lưu bản đã trim, không sửa hồ sơ Member', async () => {
      const me = await member();
      const first = await readyCart(me, [[await product(), 1]]);
      const short = (await createCall(me, { ...first.body, recipientName: '  An  ' }).expect(201)).body;
      const second = await readyCart(me, [[await product(), 1]]);
      const long = (await createCall(me, { ...second.body, recipientName: 'B'.repeat(120) }).expect(201)).body;

      expect((await db().collection('orders').findOne({ _id: new ObjectId(short.id as string) }))?.recipient_name).toBe('An');
      expect((await db().collection('orders').findOne({ _id: new ObjectId(long.id as string) }))?.recipient_name).toBe('B'.repeat(120));
      expect((await db().collection('members').findOne({ _id: me.memberId }))?.full_name).toBe('Hội viên US41');
    });
  });

  describe('US-41-TC03: quote giả, sai actor, hết hạn, giỏ/sản phẩm đổi', () => {
    it('US-41-TC03: quoteToken là JWT HS256 ký bằng RETAIL_QUOTE_SECRET, đúng aud/purpose/exp và payload, không chứa tên/SĐT', async () => {
      const me = await member();
      const a = await product({ price: '25000' });
      const { version, quote } = await readyCart(me, [[a, 2]]);
      const [head, payload, signature] = quote.quoteToken.split('.');
      const { header, payload: claims } = decode(quote.quoteToken);

      expect(header.alg).toBe('HS256');
      expect(createHmac('sha256', process.env.RETAIL_QUOTE_SECRET!).update(`${head}.${payload}`).digest('base64url')).toBe(signature);
      expect(createHmac('sha256', process.env.JWT_ACCESS_SECRET!).update(`${head}.${payload}`).digest('base64url')).not.toBe(signature);
      expect([claims.aud].flat()).toContain('retail-order-quote');
      expect(claims.purpose).toBe('RETAIL_QUOTE_V1');
      expect(claims.exp * 1000).toBe(Date.parse(quote.quoteExpiresAt));
      expect(claims).toMatchObject({ actorId: me.accountId, memberId: String(me.memberId), channel: 'WEBSITE', cartVersion: version, total: '50000' });
      expect(claims.items).toEqual([{ productId: a.id, quantity: 2, productVersion: await productVersion(a.id), unitPrice: '25000' }]);
      const text = JSON.stringify(claims);
      expect(text).not.toContain(me.phone);
      expect(text).not.toContain('Hội viên US41');
    });

    it('US-41-TC03: quoteToken không dùng được làm access token → 401', async () => {
      const me = await member();
      const { quote } = await readyCart(me, [[await product(), 1]]);
      await http().get('/api/me/cart').set('Authorization', `Bearer ${quote.quoteToken}`).expect(401);
    });

    it('US-41-TC03: quote giả, ký bằng secret khác, sai purpose hoặc alg none → 400; DB không đổi', async () => {
      const me = await member();
      const { body, quote } = await readyCart(me, [[await product(), 1]]);
      const { header, payload } = decode(quote.quoteToken);
      const before = await snapshot();
      const forged = [
        'forged',
        sign(header, payload, process.env.JWT_ACCESS_SECRET!),
        sign(header, payload, randomBytes(32).toString('base64url')),
        sign(header, { ...payload, purpose: 'ACCESS' }, process.env.RETAIL_QUOTE_SECRET!),
        sign(header, { ...payload, aud: 'gym-access' }, process.env.RETAIL_QUOTE_SECRET!),
        `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`,
      ];
      for (const quoteToken of forged) expectError(await createCall(me, { ...body, quoteToken }), 400);
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC03: Member khác dùng quote của người khác → 403; DB không đổi', async () => {
      const owner = await member(), other = await member();
      const item = await product();
      const { quote } = await readyCart(owner, [[item, 1]]);
      const otherVersion = await addToCart(other, item.id, 1);
      const before = await snapshot();
      expectError(await createCall(other, orderBody(otherVersion, quote.quoteToken)), 403);
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC03: quá 10 phút kể từ preview → 409 QUOTE_EXPIRED; không giữ chỗ', async () => {
      const me = await member();
      const { body } = await readyCart(me, [[await product(), 1]]);
      const before = await snapshot();
      now = new Date(Date.parse(NOW) + 10 * 60 * 1000).toISOString();
      expectError(await createCall(me, body), 409, 'QUOTE_EXPIRED');
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC03: giá sản phẩm đổi sau preview → 409 QUOTE_STALE, không tự thu theo giá mới', async () => {
      const me = await member();
      const item = await product({ price: '25000' });
      const { body } = await readyCart(me, [[item, 1]]);
      await patchProduct(item.id, { price: '26000' });
      const before = await snapshot();
      expectError(await createCall(me, body), 409, 'QUOTE_STALE');
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC03: productVersion đổi (đổi tên, giá giữ nguyên) sau preview → 409 QUOTE_STALE', async () => {
      const me = await member();
      const item = await product();
      const { body } = await readyCart(me, [[item, 1]]);
      await patchProduct(item.id, { name: 'Tên mới sau preview' });
      expectError(await createCall(me, body), 409, 'QUOTE_STALE');
      expect(await count('orders')).toBe(0);
    });

    it('US-41-TC03: giỏ đổi sau preview, gửi cartVersion cũ → 409 CART_VERSION_CONFLICT; giỏ mới giữ nguyên', async () => {
      const me = await member();
      const { body } = await readyCart(me, [[await product(), 1]]);
      await addToCart(me, (await product()).id, 1);
      const cart = await cartRows(me.memberId);
      expectError(await createCall(me, body), 409, 'CART_VERSION_CONFLICT');
      expect(await cartRows(me.memberId)).toEqual(cart);
      expect(await count('orders')).toBe(0);
    });

    it('US-41-TC03: giỏ đổi sau preview, gửi cartVersion mới nhưng quote cũ → 409 QUOTE_STALE', async () => {
      const me = await member();
      const { body } = await readyCart(me, [[await product(), 1]]);
      const newVersion = await addToCart(me, (await product()).id, 1);
      expectError(await createCall(me, { ...body, cartVersion: newVersion }), 409, 'QUOTE_STALE');
      expect(await count('orders')).toBe(0);
    });
  });

  describe('US-41-TC04: hàng ngừng bán, thiếu tồn, vượt trần, thiếu PICKUP_LOCATION', () => {
    it('US-41-TC04: sản phẩm ngừng bán → preview 409 PRODUCT_UNAVAILABLE', async () => {
      const me = await member();
      const item = await product();
      await addToCart(me, item.id, 1);
      await patchProduct(item.id, { status: 'INACTIVE' });
      expectError(await previewCall(me, { cartVersion: await cartVersion(me) }), 409, 'PRODUCT_UNAVAILABLE');
    });

    it('US-41-TC04: danh mục ngừng sau preview → create 409 PRODUCT_UNAVAILABLE, không đơn, không giữ tồn, giỏ còn', async () => {
      const me = await member();
      const item = await product();
      const { body } = await readyCart(me, [[item, 1]]);
      await send('patch', `/admin/categories/${item.categoryId}`, { version: 0, status: 'INACTIVE' }, admin).expect(200);
      const before = await snapshot();
      expectError(await createCall(me, body), 409, 'PRODUCT_UNAVAILABLE');
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC04: tồn khả dụng giảm sau preview (Member khác đặt trước) → create và preview 409 INSUFFICIENT_STOCK', async () => {
      const me = await member(), other = await member();
      const item = await product({ stock: 2 });
      const mine = await readyCart(me, [[item, 2]]);
      const theirs = await readyCart(other, [[item, 1]]);
      await createCall(other, theirs.body).expect(201);
      const before = await snapshot();

      expectError(await createCall(me, mine.body), 409, 'INSUFFICIENT_STOCK');
      expect(await snapshot()).toEqual(before);
      expectError(await previewCall(me, { cartVersion: mine.version }), 409, 'INSUFFICIENT_STOCK');
    });

    it('US-41-TC04: dòng giỏ đã lưu có quantity 1000 → preview 409 CART_LIMIT_EXCEEDED, không cấp quote', async () => {
      const me = await member();
      const item = await product({ stock: 2000 });
      const version = await addToCart(me, item.id, 1);
      await db().collection('carts').updateOne({ member_id: me.memberId, product_id: new ObjectId(item.id) }, { $set: { quantity: 1000 } });
      const response = await previewCall(me, { cartVersion: version });
      expectError(response, 409, 'CART_LIMIT_EXCEEDED');
      expect(response.body.quoteToken).toBeUndefined();
    });

    it('US-41-TC04: tổng giỏ vượt 999999999999 sau khi giá tăng → preview 409 AMOUNT_LIMIT_EXCEEDED', async () => {
      const me = await member();
      const expensive = await product({ price: '1' }), cheap = await product({ price: '1' });
      await addToCart(me, expensive.id, 1);
      const version = await addToCart(me, cheap.id, 1);
      await patchProduct(expensive.id, { price: '999999999999' });
      expectError(await previewCall(me, { cartVersion: version }), 409, 'AMOUNT_LIMIT_EXCEEDED');
    });

    it('US-41-TC04: thiếu cấu hình PICKUP_LOCATION → preview 503, không điền địa chỉ giả, không ghi DB', async () => {
      const me = await member();
      const version = await addToCart(me, (await product()).id, 1);
      const before = await snapshot();
      delete process.env.PICKUP_LOCATION;
      const noPickup = await createApp();
      extraApps.push(noPickup);
      try {
        const response = await request(noPickup.getHttpServer()).post('/api/me/orders/preview')
          .set('Authorization', `Bearer ${me.token}`).send({ cartVersion: version });
        expectError(response, 503);
        expect(response.body.quoteToken).toBeUndefined();
      } finally {
        process.env.PICKUP_LOCATION = PICKUP;
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  // =====================================================================
  // AC02 – Đơn/giỏ/tồn/snapshot nguyên tử và hạn giữ (TC05, TC06, TC08)
  // =====================================================================
  describe('US-41-TC05: cùng commit hoặc rollback cả giỏ/đơn/tồn/key', () => {
    it('US-41-TC05: lỗi ở dòng 2 khi giữ tồn → rollback toàn bộ; thử lại CÙNG key sau đó tạo được đơn (key cũng đã rollback)', async () => {
      const me = await member();
      const { body } = await readyCart(me, [[await product(), 1], [await product(), 1]]);
      const writer = app.get(InventoryWriter);
      const original = writer.apply.bind(writer);
      let calls = 0;
      jest.spyOn(writer, 'apply').mockImplementation(async (...args: Parameters<InventoryWriter['apply']>) => {
        const result = await original(...args);
        if (++calls === 2) throw new ApplicationError(503, 'TEST_FAILURE', 'Lỗi giả ở dòng 2');
        return result;
      });
      const before = await snapshot(), key = randomUUID();

      const failed = await createCall(me, body, key);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(await snapshot()).toEqual(before);

      jest.mocked(writer.apply).mockRestore();
      await createCall(me, body, key).expect(201);
      expect(await count('orders')).toBe(1);
    });

    it('US-41-TC05: ghi movement thất bại → rollback toàn bộ, giỏ còn nguyên', async () => {
      const me = await member();
      const { body } = await readyCart(me, [[await product(), 2]]);
      const cart = await cartRows(me.memberId);
      await failOn('stock_movements', 'insert');
      const before = await snapshot();

      const failed = await createCall(me, body);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await snapshot()).toEqual(before);
      expect(await cartRows(me.memberId)).toEqual(cart);
    });

    it('US-41-TC05: xóa giỏ thất bại → rollback toàn bộ: không đơn, không giữ tồn, không movement, không key', async () => {
      const me = await member();
      const { body } = await readyCart(me, [[await product(), 1]]);
      await failOn('carts', 'delete');
      const before = await snapshot();

      const failed = await createCall(me, body);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await snapshot()).toEqual(before);
      expect(await count('operation_requests', { operation: 'ORDER_CREATE_WEBSITE' })).toBe(0);
    });
  });

  describe('US-41-TC06: snapshot giữ nguyên khi catalog/hồ sơ đổi sau tạo', () => {
    it('US-41-TC06: order_items chụp SKU, tên, productVersion, đơn giá, tổng dòng; order chụp người nhận và quầy nhận', async () => {
      const me = await member();
      const item = await product({ price: '25000' });
      const version = await productVersion(item.id);
      const { body } = await readyCart(me, [[item, 3]]);
      const created = (await createCall(me, { ...body, recipientName: '  Trần Thị Nhận  ' }).expect(201)).body;
      const orderId = new ObjectId(created.id as string);

      const line = await db().collection('order_items').findOne({ order_id: orderId });
      expect(line).toMatchObject({ sku_snapshot: item.sku, name_snapshot: item.name, quantity: 3, product_version_snapshot: version });
      expect(line!.unit_price).toBeInstanceOf(Decimal128);
      expect(String(line!.unit_price)).toBe('25000');
      expect(String(line!.line_total)).toBe('75000');
      const order = await db().collection('orders').findOne({ _id: orderId });
      expect(order!.recipient_name).toBe('Trần Thị Nhận');
      expect(typeof order!.recipient_phone).toBe('string');
      expect(JSON.stringify(order!.pickup_location_snapshot)).toContain(PICKUP);
    });

    it('US-41-TC06: đổi giá, tên sản phẩm và tên/SĐT hồ sơ sau khi tạo → đơn, dòng và nghĩa vụ tiền không đổi', async () => {
      const me = await member();
      const item = await product({ price: '25000' });
      const { body } = await readyCart(me, [[item, 1]]);
      const created = (await createCall(me, body).expect(201)).body;
      const orderId = new ObjectId(created.id as string);
      const orderBefore = await db().collection('orders').findOne({ _id: orderId });
      const linesBefore = await db().collection('order_items').find({ order_id: orderId }).toArray();
      const transactionBefore = await db().collection('transactions').findOne({ _id: new ObjectId(created.transactionId as string) });

      await patchProduct(item.id, { price: '99000', name: 'Tên đã đổi' });
      await db().collection('members').updateOne({ _id: me.memberId }, { $set: { full_name: 'Tên hồ sơ mới', phone: '0999999999' } });

      expect(await db().collection('orders').findOne({ _id: orderId })).toEqual(orderBefore);
      expect(await db().collection('order_items').find({ order_id: orderId }).toArray()).toEqual(linesBefore);
      expect(await db().collection('transactions').findOne({ _id: new ObjectId(created.transactionId as string) })).toEqual(transactionBefore);
    });
  });

  describe('US-41-TC08: hạn giữ 24 giờ cố định theo giờ server lúc tạo', () => {
    it('US-41-TC08: tạo lúc T → hạn T + 24 giờ; tạo lúc T + 5 giờ → hạn T + 29 giờ (không tính từ lúc preview)', async () => {
      const me = await member();
      const first = await readyCart(me, [[await product(), 1]]);
      const early = (await createCall(me, first.body).expect(201)).body;
      now = new Date(Date.parse(NOW) + 5 * HOUR).toISOString();
      const second = await readyCart(me, [[await product(), 1]]);
      const late = (await createCall(me, second.body).expect(201)).body;

      expect(early.reservationExpiresAt).toBe(new Date(Date.parse(NOW) + 24 * HOUR).toISOString());
      expect(late.reservationExpiresAt).toBe(new Date(Date.parse(NOW) + 29 * HOUR).toISOString());
      const order = await db().collection('orders').findOne({ _id: new ObjectId(late.id as string) });
      expect(order!.reservation_expires_at.getTime() - order!.created_at.getTime()).toBe(24 * HOUR);
    });

    it('US-41-TC08: Staff chuẩn bị lúc hạn − 1ms được; đúng mốc 24 giờ bị chặn 409 RESERVATION_EXPIRED, không gia hạn', async () => {
      const me = await member();
      const first = await readyCart(me, [[await product(), 1]]);
      const before = (await createCall(me, first.body).expect(201)).body;
      const second = await readyCart(me, [[await product(), 1]]);
      const atDeadline = (await createCall(me, second.body).expect(201)).body;
      const prepare = (id: string) => http().post(`/api/orders/${id}/prepare`).set('Authorization', `Bearer ${staff.token}`)
        .set('Idempotency-Key', randomUUID()).send({ version: 0 });

      now = new Date(Date.parse(NOW) + 24 * HOUR - 1).toISOString();
      await prepare(before.id as string).expect(200);
      now = new Date(Date.parse(NOW) + 24 * HOUR).toISOString();
      expectError(await prepare(atDeadline.id as string), 409, 'RESERVATION_EXPIRED');

      const prepared = await db().collection('orders').findOne({ _id: new ObjectId(before.id as string) });
      expect(prepared!.reservation_expires_at.toISOString()).toBe(new Date(Date.parse(NOW) + 24 * HOUR).toISOString());
    });
  });

  // =====================================================================
  // AC04 – Replay, mất response, phiên bị thu hồi (TC14)
  // =====================================================================
  describe('US-41-TC14: cùng key payload khác, mất response, phiên bị thu hồi', () => {
    it('US-41-TC14: cùng key nhưng payload khác → 409 IDEMPOTENCY_CONFLICT, không có đơn thứ hai', async () => {
      const me = await member();
      const { body } = await readyCart(me, [[await product(), 1]]);
      const key = randomUUID();
      await createCall(me, body, key).expect(201);
      expectError(await createCall(me, { ...body, recipientName: 'Người nhận khác' }, key), 409, 'IDEMPOTENCY_CONFLICT');
      expect(await count('orders')).toBe(1);
    });

    it('US-41-TC14: mất response → tra GET /api/operations/ORDER_CREATE_WEBSITE/:key thấy kết quả gốc; replay trả 201 cùng body dù giỏ đã trống', async () => {
      const me = await member();
      const { body } = await readyCart(me, [[await product(), 1]]);
      const key = randomUUID();
      const lost = await createCall(me, body, key).expect(201);

      const lookup = await http().get(`/api/operations/ORDER_CREATE_WEBSITE/${key}`).set('Authorization', `Bearer ${me.token}`).expect(200);
      expect(lookup.body).toMatchObject({ status: 'COMMITTED', responseStatus: 201, responseBody: lost.body });
      const replay = await createCall(me, body, key).expect(201);
      expect(replay.body).toEqual(lost.body);
      expect(await count('orders')).toBe(1);
    });

    it('US-41-TC14: key chưa từng gửi → 404 OPERATION_UNKNOWN; Member khác tra key của mình → 404', async () => {
      const me = await member(), other = await member();
      const { body } = await readyCart(me, [[await product(), 1]]);
      const key = randomUUID();
      await createCall(me, body, key).expect(201);

      const unknown = await http().get(`/api/operations/ORDER_CREATE_WEBSITE/${randomUUID()}`).set('Authorization', `Bearer ${me.token}`);
      expectError(unknown, 404, 'OPERATION_UNKNOWN');
      expectError(await http().get(`/api/operations/ORDER_CREATE_WEBSITE/${key}`).set('Authorization', `Bearer ${other.token}`), 404);
    });

    it('US-41-TC14: phiên đã đăng xuất → replay và tra cứu key đều 401, không tạo đơn ngầm', async () => {
      const me = await member();
      const { body } = await readyCart(me, [[await product(), 1]]);
      const key = randomUUID();
      await createCall(me, body, key).expect(201);
      await http().post('/api/auth/logout').set('Authorization', `Bearer ${me.token}`).set('Origin', origin).send({}).expect(204);

      expectError(await createCall(me, body, key), 401);
      expectError(await http().get(`/api/operations/ORDER_CREATE_WEBSITE/${key}`).set('Authorization', `Bearer ${me.token}`), 401);
      expect(await count('orders')).toBe(1);
    });
  });
});
