// Tầng kiểm thử backend (Jest + MongoDB replica set thật): US-41 bước 1 – Order Module, schema/enum/index đơn WEBSITE và migration đối chiếu reserved.
// Kiểm tra cấu trúc orders/order_items/order_events, index, operation/permission mới và preflight không tự sửa số dư (TC01, TC02, TC04–TC08, TC13).
// Hợp đồng test đặt ra cho Builder (US-41 bước 1, theo mục 3 "Schema đơn snapshot và chỉ mục" và S05-I01 của spec):
//   - OrdersModule nạp trong AppModule, cung cấp RetailQuoteService (retail-quote.service.ts) và RetailOrderFactory (retail-order.factory.ts);
//     RetailOrderFactory có thêm hàm createWebsite (luồng WEBSITE; logic khóa/giữ tồn làm ở bước 2).
//   - Model Mongoose gắn với collection orders, order_items, order_events (tìm theo tên collection, không phụ thuộc tên export).
//   - OPERATIONS có ORDER_CREATE_WEBSITE; ACCESS_POLICY có orders.createOwn chỉ cho MEMBER.
//   - ensureOrdersIntegrity(connection) (orders-migration.ts) tạo/kiểm index rồi đối chiếu: orphan và inventory.reserved ≠ tổng HELD
//     thì throw đúng mã (spec 1.0.1 mục 3): ORDERS_ORPHAN_RECONCILIATION_REQUIRED, ORDER_ITEMS_ORPHAN_RECONCILIATION_REQUIRED,
//     ORDERS_RESERVED_RECONCILIATION_REQUIRED; KHÔNG reset reserved, KHÔNG xóa chứng từ.
//   Để bước sau: preview/create, quote ký HS256, khóa S06-O01, InventoryWriter, xóa giỏ (bước 2); thu RETAIL/0 đồng (bước 3); UI (bước 4).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Int32, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';
import { createHash, randomBytes } from 'node:crypto';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { OPERATIONS } from '../src/modules/operations/schemas/operation-request.schema';
import { ensureOrdersIntegrity } from '../src/modules/orders/orders-migration';
import { RetailOrderFactory } from '../src/modules/orders/retail-order.factory';
import { RetailQuoteService } from '../src/modules/orders/retail-quote.service';
import { ACCESS_POLICY } from '../src/modules/users/access.policy';

const origin = 'http://localhost:5173';
type IndexInfo = { key: Record<string, unknown>; unique?: boolean; expireAfterSeconds?: number };

describe('US-41 bước 1: Order Module, schema đơn WEBSITE và migration', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  const saved = { ...process.env };
  let sequence = 0;
  const db = () => connection.db!;

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, {
      NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: `gym_test_us41_${randomBytes(4).toString('hex')}`, FRONTEND_ORIGIN: origin,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RETAIL_QUOTE_SECRET: randomBytes(32).toString('base64url'),
      PICKUP_LOCATION: 'Quầy kiểm thử US41', RECEIVING_ACCOUNTS: '["GYM_MAIN"]',
      RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
    });
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    await ensureOrdersIntegrity(connection);
  }, 600000);

  beforeEach(async () => {
    for (const name of ['members', 'orders', 'order_items', 'order_events', 'transactions', 'inventory', 'stock_movements']) {
      await db().collection(name).deleteMany({});
    }
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = saved;
  });

  // Tìm model Mongoose theo tên collection để không phụ thuộc tên export của schema.
  function modelOf(collection: string): mongoose.Model<any> {
    const model = Object.values(connection.models).find(m => m.collection.collectionName === collection);
    if (!model) throw new Error(`Không có model cho collection ${collection}`);
    return model;
  }

  const errorPaths = (doc: mongoose.Document) => Object.keys(doc.validateSync()?.errors ?? {});
  const indexesOf = async (collection: string) => (await db().collection(collection).indexes()) as IndexInfo[];
  const findIndex = (list: IndexInfo[], key: Record<string, unknown>) => list.find(index => JSON.stringify(index.key) === JSON.stringify(key));

  // Một đơn WEBSITE hợp lệ theo bảng "orders gốc" + "orders bổ sung" của spec.
  // code luôn là ORD-<_id> của chính đơn (kể cả khi test truyền _id riêng), vì preflight kiểm code khớp _id.
  function websiteOrder(overrides: Record<string, unknown> = {}) {
    const id = (overrides._id as ObjectId | undefined) ?? new ObjectId(), created = new Date('2035-11-15T03:00:00.000Z');
    return {
      _id: id, transaction_id: new ObjectId(), member_id: new ObjectId(), code: `ORD-${id.toHexString()}`, channel: 'WEBSITE', status: 'PENDING',
      reservation_state: 'HELD', reservation_expires_at: new Date(created.getTime() + 24 * 3600 * 1000), preferred_payment_method: 'CASH',
      recipient_name: 'Nguyễn Văn Nhận', recipient_phone: '+84901234567', pickup_location_snapshot: 'Quầy kiểm thử US41',
      created_by: new ObjectId(), created_at: created, updated_at: created, version: 0, ...overrides,
    };
  }

  function orderItem(overrides: Record<string, unknown> = {}) {
    return {
      _id: new ObjectId(), order_id: new ObjectId(), product_id: new ObjectId(), sku_snapshot: 'SKU-01', name_snapshot: 'Whey 1kg',
      product_version_snapshot: 3, unit_price: '25000', quantity: 2, line_total: '50000', ...overrides,
    };
  }

  // Tạo account MEMBER thật (người tạo đơn WEBSITE là account của chính Member).
  async function memberAccount(): Promise<ObjectId> {
    const users = app.get(UsersRepository), role = await users.ensureRole('MEMBER', 'MEMBER');
    const account = await users.createAccount({ roleId: String(role.id), fullName: 'US41 member', phone: `094100${String(++sequence).padStart(4, '0')}`,
      passwordHash: await app.get(PasswordService).hash('US41 fixture password 123') });
    return new ObjectId(String(account._id));
  }

  // Ghi thẳng dữ liệu đã commit (fixture) để kiểm migration: transaction + order + item + inventory.
  // Đơn RELEASED là đơn đã hủy chưa thu: order CANCELLED, transaction CANCELLED (bảng trạng thái mục 2 của spec).
  async function persistedOrder(options: { released?: boolean; quantity?: number; reserved?: number; withTransaction?: boolean } = {}) {
    const orderId = new ObjectId(), transactionId = new ObjectId(), productId = new ObjectId(), itemId = new ObjectId(), memberId = new ObjectId();
    const accountId = await memberAccount();
    const quantity = options.quantity ?? 1, created = new Date('2035-11-15T03:00:00.000Z');
    await db().collection('members').insertOne({ _id: memberId, id: memberId, member_code: `HV-${memberId}`, phone: `+8494${String(++sequence).padStart(7, '0')}`,
      service_revision: Long.ZERO, account_id: accountId });
    if (options.withTransaction !== false) {
      await db().collection('transactions').insertOne({
        _id: transactionId, id: transactionId, member_id: memberId, created_by: accountId, code: `TX-${transactionId}`, kind: 'RETAIL',
        status: options.released ? 'CANCELLED' : 'PENDING',
        amount_due: Decimal128.fromString(String(25000 * quantity)), request_key: createHash('sha256').update(String(transactionId)).digest('hex'),
        created_at: created, guard_revision: Long.ZERO, version: 0,
      });
    }
    const cancelled = options.released
      ? { status: 'CANCELLED', reservation_state: 'RELEASED', cancelled_at: created, cancelled_by: new ObjectId(), cancellation_reason: 'Khách đổi ý', cancellation_source: 'USER' }
      : {};
    await db().collection('orders').insertOne({ ...websiteOrder({ _id: orderId, transaction_id: transactionId, member_id: memberId, created_by: accountId, ...cancelled }),
      id: orderId, version: new Int32(0), guard_revision: Long.ZERO });
    await db().collection('order_items').insertOne({ ...orderItem({ _id: itemId, order_id: orderId, product_id: productId, quantity: new Int32(quantity),
      product_version_snapshot: new Int32(0), unit_price: Decimal128.fromString('25000'), line_total: Decimal128.fromString(String(25000 * quantity)) }), id: itemId });
    await db().collection('inventory').insertOne({ product_id: productId, on_hand: new Int32(5), reserved: new Int32(options.reserved ?? quantity), version: new Int32(1), guard_revision: Long.ZERO });
    return { orderId, transactionId, productId };
  }

  async function snapshot() {
    const rows: Record<string, unknown> = {};
    for (const name of ['orders', 'order_items', 'transactions', 'inventory', 'stock_movements']) rows[name] = await db().collection(name).find().sort({ _id: 1 }).toArray();
    return rows;
  }

  describe('Order Module, operation và quyền', () => {
    it('US-41-TC01: OrdersModule cung cấp RetailQuoteService và RetailOrderFactory có hàm createWebsite', () => {
      expect(app.get(RetailQuoteService)).toBeDefined();
      const factory = app.get(RetailOrderFactory) as unknown as Record<string, unknown>;
      expect(typeof factory.createWebsite).toBe('function');
    });

    it('US-41-TC13: OPERATIONS có ORDER_CREATE_WEBSITE (key tạo đơn website), vẫn giữ ORDER_CREATE_POS', () => {
      expect(OPERATIONS).toContain('ORDER_CREATE_WEBSITE');
      expect(OPERATIONS).toContain('ORDER_CREATE_POS');
    });

    it('US-41-TC02: quyền orders.createOwn chỉ cấp cho MEMBER (Staff/Admin/PT không dùng route Member)', () => {
      const policy = ACCESS_POLICY as unknown as Record<string, { roles: readonly string[] }>;
      expect(policy['orders.createOwn']).toBeDefined();
      expect([...policy['orders.createOwn'].roles]).toEqual(['MEMBER']);
    });
  });

  describe('orders: enum và index', () => {
    it('US-41-TC01: đơn WEBSITE PENDING, HELD, hạn giữ, người nhận và quầy snapshot → hợp lệ', () => {
      const Order = modelOf('orders');
      expect(errorPaths(new Order(websiteOrder()))).toEqual([]);
      expect(errorPaths(new Order(websiteOrder({ preferred_payment_method: 'TRANSFER' })))).toEqual([]);
    });

    it('US-41-TC01: channel/status/reservation_state/preferred_payment_method/cancellation_source ngoài enum → lỗi đúng field', () => {
      const Order = modelOf('orders');
      const cases: Array<[string, unknown]> = [
        ['channel', 'ONLINE'], ['status', 'SHIPPED'], ['reservation_state', 'EXPIRED'], ['preferred_payment_method', 'CARD'], ['cancellation_source', 'ADMIN'],
      ];
      for (const [field, value] of cases) {
        expect(errorPaths(new Order(websiteOrder({ [field]: value })))).toContain(field);
      }
    });

    it('US-41-TC01: đủ các giá trị enum spec cho phép (status 4 giá trị, reservation_state 3 giá trị, cancellation_source USER/EXPIRED)', () => {
      const Order = modelOf('orders');
      for (const status of ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED']) expect(errorPaths(new Order(websiteOrder({ status })))).not.toContain('status');
      for (const state of ['HELD', 'CONSUMED', 'RELEASED']) expect(errorPaths(new Order(websiteOrder({ reservation_state: state })))).not.toContain('reservation_state');
      for (const source of ['USER', 'EXPIRED']) expect(errorPaths(new Order(websiteOrder({ cancellation_source: source })))).not.toContain('cancellation_source');
      expect(errorPaths(new Order(websiteOrder({ channel: 'POS' })))).not.toContain('channel');
    });

    it('US-41-TC01: version âm → lỗi ở version', () => {
      const Order = modelOf('orders');
      expect(errorPaths(new Order(websiteOrder({ version: -1 })))).toContain('version');
    });

    it('US-41-TC06: orders không có field vận chuyển trong S06 (chỉ nhận tại quầy)', () => {
      const paths = Object.keys(modelOf('orders').schema.paths);
      expect(paths.filter(path => /ship|deliver|address/i.test(path))).toEqual([]);
    });

    it('US-41-TC01: MongoDB có index unique code và unique transaction_id (mỗi transaction một đơn)', async () => {
      const list = await indexesOf('orders');
      expect(findIndex(list, { code: 1 })?.unique).toBe(true);
      expect(findIndex(list, { transaction_id: 1 })?.unique).toBe(true);
    });

    it('US-41-TC01: có index (member_id, created_at, _id) và (channel, status, created_at, _id)', async () => {
      const list = await indexesOf('orders');
      expect(findIndex(list, { member_id: 1, created_at: 1, _id: 1 })).toBeDefined();
      expect(findIndex(list, { channel: 1, status: 1, created_at: 1, _id: 1 })).toBeDefined();
    });

    it('US-41-TC08: có index (reservation_state, reservation_expires_at) cho worker hết hạn và KHÔNG có TTL xóa order', async () => {
      const list = await indexesOf('orders');
      expect(findIndex(list, { reservation_state: 1, reservation_expires_at: 1 })).toBeDefined();
      expect(list.filter(index => index.expireAfterSeconds !== undefined)).toEqual([]);
    });
  });

  describe('order_items: snapshot và tiền Decimal128', () => {
    it('US-41-TC06: dòng snapshot đầy đủ → hợp lệ; unit_price và line_total lưu Decimal128 (không float)', () => {
      const Item = modelOf('order_items');
      const doc = new Item(orderItem());
      expect(errorPaths(doc)).toEqual([]);
      expect(doc.get('unit_price')).toBeInstanceOf(mongoose.Types.Decimal128);
      expect(doc.get('line_total')).toBeInstanceOf(mongoose.Types.Decimal128);
    });

    it('US-41-TC06: thiếu sku_snapshot/name_snapshot/product_version_snapshot/unit_price/line_total → lỗi đúng field', () => {
      const Item = modelOf('order_items');
      for (const field of ['sku_snapshot', 'name_snapshot', 'product_version_snapshot', 'unit_price', 'line_total']) {
        expect(errorPaths(new Item(orderItem({ [field]: undefined })))).toContain(field);
      }
    });

    it('US-41-TC04: quantity 1 và 999 hợp lệ; 0, âm, số lẻ, 1000 → lỗi ở quantity', () => {
      const Item = modelOf('order_items');
      for (const quantity of [1, 999]) expect(errorPaths(new Item(orderItem({ quantity })))).not.toContain('quantity');
      for (const quantity of [0, -1, 1.5, 1000]) expect(errorPaths(new Item(orderItem({ quantity })))).toContain('quantity');
    });

    it('US-41-TC06: MongoDB có index unique (order_id, product_id) và index tra theo product_id', async () => {
      const list = await indexesOf('order_items');
      expect(findIndex(list, { order_id: 1, product_id: 1 })?.unique).toBe(true);
      expect(list.some(index => Object.keys(index.key)[0] === 'product_id')).toBe(true);
    });

    it('US-41-TC06: cùng order thêm cùng product hai lần ở tầng DB → lỗi trùng (mỗi product một dòng)', async () => {
      const orderId = new ObjectId(), productId = new ObjectId();
      const raw = () => ({ _id: new ObjectId(), order_id: orderId, product_id: productId, sku_snapshot: 'SKU', name_snapshot: 'Tên', product_version_snapshot: 0,
        unit_price: Decimal128.fromString('1000'), quantity: 1, line_total: Decimal128.fromString('1000') });
      await db().collection('order_items').insertOne(raw());
      await expect(db().collection('order_items').insertOne(raw())).rejects.toMatchObject({ code: 11000 });
    });
  });

  describe('order_events', () => {
    it('US-41-TC05: action đủ 6 giá trị spec, actor_type USER/SYSTEM; giá trị lạ → lỗi đúng field', () => {
      const Event = modelOf('order_events');
      const event = (overrides: Record<string, unknown>) => new Event({ order_id: new ObjectId(), action: 'CREATED', actor_type: 'USER', actor_id: new ObjectId(),
        occurred_at: new Date(), before: null, after: { status: 'PENDING', version: 0 }, event_key: `ORDER_CREATED:${new ObjectId()}`, ...overrides });
      for (const action of ['CREATED', 'PREPARED', 'PAYMENT_SETTLED', 'FULFILLED', 'CANCELLED', 'LATE_RECEIPT']) expect(errorPaths(event({ action }))).not.toContain('action');
      for (const actorType of ['USER', 'SYSTEM']) expect(errorPaths(event({ actor_type: actorType }))).not.toContain('actor_type');
      expect(errorPaths(event({ action: 'SHIPPED' }))).toContain('action');
      expect(errorPaths(event({ actor_type: 'GUEST' }))).toContain('actor_type');
    });

    it('US-41-TC13: event_key unique trong MongoDB (replay không tạo CREATED thứ hai)', async () => {
      expect(findIndex(await indexesOf('order_events'), { event_key: 1 })?.unique).toBe(true);
    });
  });

  describe('migration ensureOrdersIntegrity: đối chiếu, không tự sửa', () => {
    it('US-41-TC05: dữ liệu khớp (reserved = tổng HELD) → qua preflight, không đổi bất kỳ dòng nào', async () => {
      await persistedOrder({ quantity: 2, reserved: 2 });
      const before = await snapshot();
      await ensureOrdersIntegrity(connection);
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC07: inventory.reserved lớn hơn tổng HELD → báo lỗi, KHÔNG reset reserved', async () => {
      await persistedOrder({ quantity: 1, reserved: 3 });
      const before = await snapshot();
      await expect(ensureOrdersIntegrity(connection)).rejects.toThrow('ORDERS_RESERVED_RECONCILIATION_REQUIRED');
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC07: inventory.reserved nhỏ hơn tổng HELD (nguy cơ oversell) → báo lỗi, không tự sửa', async () => {
      await persistedOrder({ quantity: 2, reserved: 1 });
      const before = await snapshot();
      await expect(ensureOrdersIntegrity(connection)).rejects.toThrow('ORDERS_RESERVED_RECONCILIATION_REQUIRED');
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC07: đơn đã hủy (RELEASED) không tính vào reserved → reserved 0 vẫn qua preflight', async () => {
      await persistedOrder({ released: true, quantity: 2, reserved: 0 });
      await expect(ensureOrdersIntegrity(connection)).resolves.not.toThrow();
    });

    it('US-41-TC05: order trỏ tới transaction không tồn tại (orphan) → báo lỗi, không xóa order/items', async () => {
      await persistedOrder({ withTransaction: false });
      const before = await snapshot();
      await expect(ensureOrdersIntegrity(connection)).rejects.toThrow('ORDERS_ORPHAN_RECONCILIATION_REQUIRED');
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC05: order_items không có order (orphan) → báo lỗi, không xóa item', async () => {
      const row = await persistedOrder();
      await db().collection('orders').deleteOne({ _id: row.orderId });
      await db().collection('inventory').updateOne({ product_id: row.productId }, { $set: { reserved: new Int32(0) } });
      const before = await snapshot();
      await expect(ensureOrdersIntegrity(connection)).rejects.toThrow('ORDER_ITEMS_ORPHAN_RECONCILIATION_REQUIRED');
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC01: CSDL đã chạy còn 2 index cũ chiều giảm dần → migration xóa index cũ, có index tăng dần theo spec, dữ liệu không đổi, chạy lại vẫn qua', async () => {
      const orders = db().collection('orders');
      await orders.createIndex({ member_id: 1, created_at: -1, _id: -1 }, { name: 'orders_member_created_id' });
      await orders.createIndex({ channel: 1, status: 1, created_at: -1, _id: -1 }, { name: 'orders_channel_status_created_id' });
      await persistedOrder({ quantity: 2, reserved: 2 });
      const before = await snapshot();

      await ensureOrdersIntegrity(connection);

      const names = (await orders.indexes()).map(index => index.name);
      expect(names).not.toContain('orders_member_created_id');
      expect(names).not.toContain('orders_channel_status_created_id');
      const list = await indexesOf('orders');
      expect(findIndex(list, { member_id: 1, created_at: 1, _id: 1 })).toBeDefined();
      expect(findIndex(list, { channel: 1, status: 1, created_at: 1, _id: 1 })).toBeDefined();
      expect(await snapshot()).toEqual(before);

      // Chạy lần hai: index cũ đã không còn, migration vẫn không lỗi và không đổi dữ liệu.
      await expect(ensureOrdersIntegrity(connection)).resolves.not.toThrow();
      expect(await snapshot()).toEqual(before);
    });

    it('US-41-TC01: tạo index mới thất bại → migration báo lỗi và 2 index cũ VẪN CÒN (tạo mới thành công rồi mới xóa cũ)', async () => {
      const orders = db().collection('orders');
      // Chiếm tên index mới bằng khóa khác spec để createIndexes chắc chắn lỗi (trùng tên, khác khóa).
      await orders.dropIndex('orders_member_created_at_id').catch(() => undefined);
      await orders.createIndex({ member_id: 1 }, { name: 'orders_member_created_at_id' });
      await orders.createIndex({ member_id: 1, created_at: -1, _id: -1 }, { name: 'orders_member_created_id' });
      await orders.createIndex({ channel: 1, status: 1, created_at: -1, _id: -1 }, { name: 'orders_channel_status_created_id' });
      try {
        await expect(ensureOrdersIntegrity(connection)).rejects.toThrow();

        const names = (await orders.indexes()).map(index => index.name);
        expect(names).toContain('orders_member_created_id');
        expect(names).toContain('orders_channel_status_created_id');
      } finally {
        // Trả CSDL test về đúng index spec để không ảnh hưởng test khác.
        await orders.dropIndex('orders_member_created_at_id').catch(() => undefined);
        await ensureOrdersIntegrity(connection);
      }
    });
  });
});
