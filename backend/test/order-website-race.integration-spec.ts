// Tầng kiểm thử backend (Jest + Supertest + MongoDB replica set thật, HAI app instance): US-41 bước 2 – tạo đơn website khi chạy đồng thời.
// Kiểm tra tranh tồn cuối, hai checkout cùng cartVersion, key mới trên giỏ đã dùng và 20 request cùng key qua hai app (TC07, TC13).
// Hợp đồng test đặt ra cho Builder (US-41 bước 2, theo F03, S06-O01, S05-I01 và mục 5 của spec 1.0.2):
//   Khóa catalog → member → cart_state → inventory trước khi ghi; đọc lại điều kiện sau khóa; không mutex trong bộ nhớ (hai app khác bộ nhớ).
//   TC07: hai Member tranh đơn vị tồn cuối → đúng một 201, còn lại 409 INSUFFICIENT_STOCK; reserved không vượt on_hand.
//         Hai checkout cùng cartVersion (khác key) → đúng một đơn; lệnh thua 409 (CART_VERSION_CONFLICT hoặc CART_EMPTY: giỏ đã dùng).
//   TC13: 20 request cùng key + cùng payload qua hai app → mọi phản hồi thành công là 201 cùng body (hoặc 409 khi lệnh gốc đang chạy);
//         đúng một order, một lần giữ tồn mỗi dòng, một lần xóa giỏ (cartVersion +1 một lần), một event CREATED, một operation_requests.
//   API và body như order-website-create.integration-spec.ts.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { ensureFinancialIntegrity } from '../src/infrastructure/transaction/financial-integrity';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { ensureRetailCatalogIntegrity } from '../src/modules/catalog/retail-catalog.migration';
import { ensureOrdersIntegrity } from '../src/modules/orders/orders-migration';
import { UsersRepository } from '../src/modules/users/users.repository';
import { ACCOUNT_ADMINISTRATION } from '../src/modules/users/schemas/security-state.schema';

const NOW = '2035-11-14T03:00:00.000Z';
const origin = 'http://localhost:5173';
const password = 'MậtKhẩuUS-41-race';
const ROUNDS = 5;

type Actor = { accountId: string; token: string; phone: string };
type Member = Actor & { memberId: ObjectId };

describe('US-41 bước 2: tạo đơn website khi chạy đồng thời qua hai app', () => {
  const saved = { ...process.env };
  const clock = new ServerClock();
  clock.now = () => new Date(NOW);
  let mongo: MongoMemoryReplSet;
  let first: INestApplication;
  let second: INestApplication;
  let connection: Connection;
  let admin: Actor;
  let staff: Actor;
  let sequence = 0;
  const db = () => connection.db!;
  // Request thứ chẵn đi app 1, thứ lẻ đi app 2.
  const instanceAt = (index: number) => (index % 2 === 0 ? first : second);
  const http = (instance: INestApplication = first) => request(instance.getHttpServer());

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
      NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: `gym_test_us41_race_${randomBytes(4).toString('hex')}`, FRONTEND_ORIGIN: origin,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RETAIL_QUOTE_SECRET: randomBytes(32).toString('base64url'),
      PICKUP_LOCATION: 'Quầy kiểm thử US41 race', RECEIVING_ACCOUNTS: '["GYM_MAIN"]', RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
    });
    first = await createApp();
    second = await createApp();
    connection = first.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
    await ensureFinancialIntegrity(connection);
    await ensureOrdersIntegrity(connection);
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const instance of [first, second]) {
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
    await first?.close();
    await mongo?.stop();
    process.env = saved;
  });

  // ---------- Tài khoản, hồ sơ, sản phẩm, giỏ (giống file create) ----------
  async function account(role: 'MEMBER' | 'STAFF' | 'ADMIN') {
    const users = first.get(UsersRepository);
    const roleDoc = await users.ensureRole(role, role);
    const phone = `094103${String(++sequence).padStart(4, '0')}`;
    const created = await users.createAccount({ roleId: String(roleDoc.id), phone, fullName: `${role} US41 race`,
      passwordHash: await first.get(PasswordService).hash(password) });
    return { accountId: String(created.id), phone };
  }
  async function loginAs(phone: string) {
    return (await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200)).body.accessToken as string;
  }
  async function userOf(role: 'STAFF' | 'ADMIN'): Promise<Actor> {
    const created = await account(role);
    return { ...created, token: await loginAs(created.phone) };
  }
  async function member(): Promise<Member> {
    const owner = await account('MEMBER');
    const memberId = new ObjectId(), staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: 'Hội viên US41 race', phone: owner.phone,
      account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { ...owner, memberId, token: await loginAs(owner.phone) };
  }
  const send = (path: string, body: object, actor: Actor) => http().post(`/api${path}`)
    .set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', randomUUID()).send(body);
  async function product(stock: number, price = '25000') {
    const n = ++sequence;
    const categoryId = (await send('/admin/categories', { name: `Danh mục race ${n}`, status: 'ACTIVE' }, admin).expect(201)).body.id as string;
    const id = (await send('/admin/products', { categoryId, sku: `US41R_${n}`, name: `Sản phẩm race ${n}`, price, status: 'ACTIVE' }, admin)
      .expect(201)).body.id as string;
    const receipt = await send('/stock-receipts', { reason: 'Nhập hàng kiểm thử US41 race, không phải hàng thật',
      items: [{ productId: id, quantity: stock, unitCost: '1000' }] }, staff).expect(201);
    await send(`/stock-receipts/${receipt.body.id}/post`, { version: 0 }, staff).expect(200);
    return id;
  }
  async function cartVersion(me: Member) {
    return (await http().get('/api/me/cart').set('Authorization', `Bearer ${me.token}`).expect(200)).body.version as number;
  }
  async function readyCart(me: Member, lines: Array<[string, number]>) {
    let version = await cartVersion(me);
    for (const [productId, quantity] of lines) {
      version = (await http().post('/api/me/cart/items').set('Authorization', `Bearer ${me.token}`).set('Idempotency-Key', randomUUID())
        .send({ version, productId, quantity }).expect(201)).body.version as number;
    }
    const quote = (await http().post('/api/me/orders/preview').set('Authorization', `Bearer ${me.token}`).send({ cartVersion: version }).expect(200)).body;
    return { version, body: { cartVersion: version, quoteToken: quote.quoteToken as string, recipientName: 'Người nhận race',
      recipientPhone: '0901234567', preferredPaymentMethod: 'CASH' } };
  }
  const create = (instance: INestApplication, me: Member, body: object, key: string = randomUUID()) =>
    http(instance).post('/api/me/orders').set('Authorization', `Bearer ${me.token}`).set('Idempotency-Key', key).send(body);
  async function cartRows(memberId: ObjectId) {
    const lines = await db().collection('carts').find({ member_id: memberId }).toArray();
    const state = await db().collection('cart_states').findOne({ _id: memberId });
    return { lines: lines.length, version: state ? Number(state.version) : null };
  }
  async function balance(productId: string) {
    const row = await db().collection('inventory').findOne({ product_id: new ObjectId(productId) });
    return { onHand: Number(row!.on_hand), reserved: Number(row!.reserved) };
  }
  const count = (name: string, filter: object = {}) => db().collection(name).countDocuments(filter);

  describe('US-41-TC07: không oversell, giỏ chỉ dùng được một lần', () => {
    it(`US-41-TC07: hai Member tranh đơn vị tồn cuối qua hai app (${ROUNDS} vòng) → đúng một đơn, lệnh thua 409 INSUFFICIENT_STOCK, giỏ người thua còn`, async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const productId = await product(1);
        const a = await member(), b = await member();
        const cartA = await readyCart(a, [[productId, 1]]), cartB = await readyCart(b, [[productId, 1]]);

        const results = await Promise.all([create(first, a, cartA.body), create(second, b, cartB.body)]);

        const statuses = results.map(result => result.status).sort();
        expect(statuses).toEqual([201, 409]);
        const loser = results.find(result => result.status === 409)!;
        expect(loser.body.error?.code).toBe('INSUFFICIENT_STOCK');
        expect(await balance(productId)).toEqual({ onHand: 1, reserved: 1 });
        expect(await count('orders', { channel: 'WEBSITE' })).toBe(round + 1);
        const loserMember = results[0].status === 409 ? a : b, loserCart = results[0].status === 409 ? cartA : cartB;
        expect(await cartRows(loserMember.memberId)).toEqual({ lines: 1, version: loserCart.version });
      }
    });

    it(`US-41-TC07: cùng Member gửi hai checkout cùng cartVersion, khác key, qua hai app (${ROUNDS} vòng) → đúng một đơn`, async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const productId = await product(10);
        const me = await member();
        const { version, body } = await readyCart(me, [[productId, 2]]);

        const results = await Promise.all([create(first, me, body), create(second, me, body)]);

        expect(results.map(result => result.status).sort()).toEqual([201, 409]);
        const loser = results.find(result => result.status === 409)!;
        expect(['CART_VERSION_CONFLICT', 'CART_EMPTY']).toContain(loser.body.error?.code);
        expect(await count('orders', { member_id: me.memberId })).toBe(1);
        expect(await balance(productId)).toEqual({ onHand: 10, reserved: 2 });
        expect(await cartRows(me.memberId)).toEqual({ lines: 0, version: version + 1 });
      }
    });

    it('US-41-TC07: sau khi đặt thành công, key MỚI trên cartVersion cũ → 409, không có đơn thứ hai, không giữ tồn thêm', async () => {
      const productId = await product(10);
      const me = await member();
      const { body } = await readyCart(me, [[productId, 1]]);
      await create(first, me, body).expect(201);

      const again = await create(second, me, body);

      expect(again.status).toBe(409);
      expect(['CART_VERSION_CONFLICT', 'CART_EMPTY']).toContain(again.body.error?.code);
      expect(await count('orders')).toBe(1);
      expect(await balance(productId)).toEqual({ onHand: 10, reserved: 1 });
    });
  });

  describe('US-41-TC13: 20 create cùng key/payload qua hai app', () => {
    it('US-41-TC13: một order/giữ tồn/xóa giỏ/event/key; mọi phản hồi thành công là 201 cùng body; replay sau đó 201 cùng IDs', async () => {
      const a = await product(50), b = await product(50, '10000');
      const me = await member();
      const { version, body } = await readyCart(me, [[a, 2], [b, 3]]);
      const key = randomUUID();

      const results = await Promise.all(Array.from({ length: 20 }, (_, index) => create(instanceAt(index), me, body, key)));

      const succeeded = results.filter(result => result.status === 201);
      expect(succeeded.length).toBeGreaterThanOrEqual(1);
      for (const result of results) expect([201, 409]).toContain(result.status);
      for (const result of succeeded) expect(result.body).toEqual(succeeded[0].body);
      const orderId = new ObjectId(succeeded[0].body.id as string);

      expect(await count('orders')).toBe(1);
      expect(await count('order_items', { order_id: orderId })).toBe(2);
      expect(await count('transactions', { kind: 'RETAIL' })).toBe(1);
      expect(await count('stock_movements', { kind: 'ORDER_RESERVE' })).toBe(2);
      expect(await balance(a)).toEqual({ onHand: 50, reserved: 2 });
      expect(await balance(b)).toEqual({ onHand: 50, reserved: 3 });
      expect(await cartRows(me.memberId)).toEqual({ lines: 0, version: version + 1 });
      expect(await count('order_events', { order_id: orderId, action: 'CREATED' })).toBe(1);
      expect(await count('operation_requests', { operation: 'ORDER_CREATE_WEBSITE' })).toBe(1);

      for (const instance of [first, second]) {
        const replay = await create(instance, me, body, key).expect(201);
        expect(replay.body).toEqual(succeeded[0].body);
      }
      expect(await count('orders')).toBe(1);
    });
  });
});
