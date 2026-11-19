// Tầng kiểm thử backend (Jest + MongoDB replica set thật + Supertest): US-40 bước 2 – API giỏ hàng của Member.
// Kiểm tra GET/POST/PUT/DELETE /api/me/cart: đúng chủ, version, replay key, giá/tồn hiện tại, dòng bị chặn, không giữ tồn, rollback (TC01–TC13).
// Hợp đồng test đặt ra cho Builder (US-40 bước 2, theo mục 1–3 của spec):
//   GET /api/me/cart → 200, Cache-Control no-store:
//     { memberLinked, version, items, subtotal, totalsState, readyForOrder, canCheckout, asOf } (+ reason khi chưa liên kết).
//     canCheckout = readyForOrder từ US-41 bước 4 (S06); giỏ trống/bị chặn/chưa liên kết vẫn false.
//     Dòng: { productId, sku, name, imageUrl?, quantity, unitPrice, lineTotal, availableQuantity, productVersion, lineState, reasons[] }.
//     lineState: 'OK' (hợp lệ) | 'BLOCKED' (reasons có PRODUCT_UNAVAILABLE / INVENTORY_UNAVAILABLE / INSUFFICIENT_STOCK).
//     totalsState: 'OK' | 'UNAVAILABLE' | 'OVER_LIMIT'; subtotal là chuỗi VND, null khi không tính được.
//   POST /api/me/cart/items {version, productId, quantity} → 201 {version, productId, quantity} (quantity sau khi cộng).
//   PUT /api/me/cart/items/:productId {version, quantity} → 200 {version, productId, quantity}; dòng chưa có → 404 CART_ITEM_NOT_FOUND.
//   DELETE /api/me/cart/items/:productId?version= → 200 {version, removedProductId}.
//   Lỗi: {error:{code}}. 400 QUANTITY_INVALID / CART_LIMIT_EXCEEDED / AMOUNT_LIMIT_EXCEEDED; 409 CART_VERSION_CONFLICT,
//     PRODUCT_UNAVAILABLE, INSUFFICIENT_STOCK, INVENTORY_UNAVAILABLE, MEMBER_PROFILE_REQUIRED, IDEMPOTENCY_CONFLICT.
//   Dữ liệu mẫu: danh mục/sản phẩm tạo qua API Admin của US-34; tồn đặt thẳng vào inventory (on_hand − reserved = available).
//   Để bước sau: UI (bước 3); hai app, 20 request song song, GET đồng thời, fixture checkout S06 (bước 4: TC09, TC10, TC14, TC15).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Int32, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { ensureRetailCatalogIntegrity } from '../src/modules/catalog/retail-catalog.migration';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us40_cart_api';
const password = 'MậtKhẩuUS-40-123';
const MONEY_MAX = '999999999999';

type Role = 'MEMBER' | 'TRAINER' | 'STAFF' | 'ADMIN';
type Member = { accountId: string; memberId: ObjectId; token: string };
type CartBody = {
  memberLinked: boolean; version: number; subtotal: string | null; totalsState: string; readyForOrder: boolean; canCheckout: boolean;
  asOf: string; reason?: string;
  items: Array<{ productId: string; name: string | null; quantity: number; unitPrice: string | null; lineTotal: string | null;
    availableQuantity?: number; lineState: string; reasons: string[] }>;
};

describe('US-40 bước 2: API giỏ hàng của Member', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  let adminToken = '';
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName, args: ['--setParameter', 'enableTestCommands=1'] },
    });
    Object.assign(process.env, {
      NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(), MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'us40-test', SMTP_PASS: 'us40-test', SMTP_FROM: 'no-reply@gym.test',
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
    await ensureRetailCatalogIntegrity(connection);
    adminToken = (await userOf('ADMIN')).token;
  });

  afterEach(async () => {
    await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = () => request(app.getHttpServer());

  // ---------- Tài khoản và hồ sơ Member ----------
  let phoneSeq = 0;
  async function account(role: Role) {
    const users = app.get(UsersRepository);
    const roleDoc = await users.ensureRole(role, role);
    phoneSeq += 1;
    const phone = `0914401${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({
      roleId: String(roleDoc.id), phone, fullName: `${role} US40`, passwordHash: await app.get(PasswordService).hash(password),
    });
    return { accountId: String(created.id), phone };
  }
  async function loginAs(phone: string) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    return response.body.accessToken as string;
  }
  async function userOf(role: Role) {
    const created = await account(role);
    return { accountId: created.accountId, token: await loginAs(created.phone) };
  }
  // Hồ sơ hội viên mẫu (thay US-09). linked=false: tài khoản MEMBER chưa được liên kết hồ sơ nào.
  async function member(linked = true): Promise<Member> {
    const owner = await account('MEMBER');
    const memberId = new ObjectId();
    if (linked) {
      const staffId = new ObjectId();
      await db().collection('members').insertOne({
        _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: 'Hội viên US40', phone: owner.phone,
        account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
      });
    }
    return { accountId: owner.accountId, memberId, token: await loginAs(owner.phone) };
  }

  // ---------- Sản phẩm qua API Admin của US-34 ----------
  const adminSend = (method: 'post' | 'patch', path: string, body: object) => http()[method](`/api/admin/${path}`)
    .set('Authorization', `Bearer ${adminToken}`).set('Idempotency-Key', randomUUID()).send(body);
  let skuSeq = 0;
  async function category(status = 'ACTIVE') {
    skuSeq += 1;
    return (await adminSend('post', 'categories', { name: `Danh mục ${skuSeq}`, status }).expect(201)).body.id as string;
  }
  // Tạo sản phẩm ACTIVE, đặt tồn sẵn (mặc định còn 50).
  async function product(options: { price?: string; stock?: number; categoryId?: string } = {}) {
    skuSeq += 1;
    const categoryId = options.categoryId ?? await category();
    const id = (await adminSend('post', 'products', {
      categoryId, sku: `SKU_${skuSeq}`, name: `Sản phẩm ${skuSeq}`, price: options.price ?? '9000', status: 'ACTIVE',
    }).expect(201)).body.id as string;
    await setStock(id, options.stock ?? 50, 0);
    return { id, categoryId };
  }
  async function setStock(productId: string, onHand: number, reserved: number) {
    await db().collection('inventory').updateOne({ product_id: new ObjectId(productId) },
      { $set: { on_hand: new Int32(onHand), reserved: new Int32(reserved) } });
  }
  async function productVersion(productId: string) {
    return Number((await db().collection('products').findOne({ _id: new ObjectId(productId) }))?.version ?? 0);
  }
  async function patchProduct(productId: string, body: object) {
    await adminSend('patch', `products/${productId}`, { version: await productVersion(productId), ...body }).expect(200);
  }
  async function stopCategory(categoryId: string) {
    await adminSend('patch', `categories/${categoryId}`, { version: 0, status: 'INACTIVE' }).expect(200);
  }

  // ---------- Gọi API giỏ ----------
  const getCart = (token?: string) => {
    const call = http().get('/api/me/cart');
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };
  const add = (token: string, body: object, key: string = randomUUID()) =>
    http().post('/api/me/cart/items').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
  const setQty = (token: string, productId: string, body: object, key: string = randomUUID()) =>
    http().put(`/api/me/cart/items/${productId}`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
  const remove = (token: string, productId: string, version: number | string | undefined, key: string = randomUUID()) => {
    const query = version === undefined ? '' : `?version=${version}`;
    return http().delete(`/api/me/cart/items/${productId}${query}`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key);
  };
  async function cartOf(token: string): Promise<CartBody> {
    return (await getCart(token).expect(200)).body as CartBody;
  }
  function expectError(response: request.Response, status: number, code?: string) {
    expect(response.status).toBe(status);
    if (code) expect(response.body.error?.code).toBe(code);
  }
  const count = (name: string, filter: object = {}) => db().collection(name).countDocuments(filter);
  // Ảnh chụp giỏ trong DB để kiểm "giỏ trước giữ nguyên".
  async function cartRows(memberId: ObjectId) {
    const lines = await db().collection('carts').find({ member_id: memberId }, { projection: { _id: 0, product_id: 1, quantity: 1 } })
      .sort({ product_id: 1 }).toArray();
    const state = await db().collection('cart_states').findOne({ _id: memberId });
    return { lines: JSON.stringify(lines), version: state ? Number(state.version) : null };
  }

  // =====================================================================
  // AC01 – Owner dữ liệu và thao tác giỏ (TC01–TC04)
  // =====================================================================
  describe('US-40-TC01: thêm, thêm tiếp và đặt số tuyệt đối', () => {
    it('US-40-TC01: ADD 2 → ADD 3 → PUT 7: một dòng, quantity đúng, version tăng từng lệnh', async () => {
      const me = await member();
      const { id } = await product();

      const first = await add(me.token, { version: 0, productId: id, quantity: 2 }).expect(201);
      expect(first.body).toEqual({ version: 1, productId: id, quantity: 2 });
      const second = await add(me.token, { version: 1, productId: id, quantity: 3 }).expect(201);
      expect(second.body).toEqual({ version: 2, productId: id, quantity: 5 });
      const third = await setQty(me.token, id, { version: 2, quantity: 7 }).expect(200);
      expect(third.body).toEqual({ version: 3, productId: id, quantity: 7 });

      const cart = await cartOf(me.token);
      expect(cart.version).toBe(3);
      expect(cart.items).toHaveLength(1);
      expect(cart.items[0]).toMatchObject({ productId: id, quantity: 7, lineState: 'OK', reasons: [] });
      expect(await count('carts', { member_id: me.memberId })).toBe(1);
      expect(Number((await db().collection('cart_states').findOne({ _id: me.memberId }))?.version)).toBe(3);
    });

    // US-41 spec 1.0.2 bước 4 nối S06: canCheckout = readyForOrder (không còn cố định false của S05).
    it('US-40-TC01: GET trả đủ field, canCheckout bằng readyForOrder (giỏ hợp lệ → true), dòng xếp theo thứ tự thêm', async () => {
      const me = await member();
      const a = await product();
      const b = await product();
      await add(me.token, { version: 0, productId: b.id, quantity: 1 }).expect(201);
      await add(me.token, { version: 1, productId: a.id, quantity: 1 }).expect(201);

      const cart = await cartOf(me.token);
      expect(cart).toMatchObject({ memberLinked: true, version: 2, totalsState: 'OK', readyForOrder: true, canCheckout: true });
      expect(Number.isNaN(Date.parse(cart.asOf))).toBe(false);
      expect(cart.items.map(item => item.productId)).toEqual([b.id, a.id]);
    });

    it('US-40-TC01: PUT dòng chưa có trong giỏ → 404 CART_ITEM_NOT_FOUND (không upsert ngầm)', async () => {
      const me = await member();
      const { id } = await product();
      expectError(await setQty(me.token, id, { version: 0, quantity: 2 }), 404, 'CART_ITEM_NOT_FOUND');
      expect(await count('carts')).toBe(0);
      expect(await count('cart_states')).toBe(0);
    });

    it('US-40-TC01: POST ghi operation_requests với operation CART_ADD_ITEM, PUT là CART_SET_ITEM, DELETE là CART_REMOVE_ITEM', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 1 }).expect(201);
      await setQty(me.token, id, { version: 1, quantity: 2 }).expect(200);
      await remove(me.token, id, 2).expect(200);
      for (const operation of ['CART_ADD_ITEM', 'CART_SET_ITEM', 'CART_REMOVE_ITEM']) {
        expect(await count('operation_requests', { operation })).toBe(1);
      }
    });
  });

  describe('US-40-TC02: không thao tác giỏ người khác, đúng vai trò', () => {
    it('US-40-TC02: Member B không thấy, không sửa, không xóa được dòng của Member A', async () => {
      const a = await member();
      const b = await member();
      const { id } = await product();
      await add(a.token, { version: 0, productId: id, quantity: 2 }).expect(201);
      const before = await cartRows(a.memberId);

      expect((await cartOf(b.token)).items).toEqual([]);
      expectError(await setQty(b.token, id, { version: 0, quantity: 5 }), 404, 'CART_ITEM_NOT_FOUND');
      expectError(await remove(b.token, id, 0), 404, 'CART_ITEM_NOT_FOUND');
      expect(await cartRows(a.memberId)).toEqual(before);
    });

    it.each(['TRAINER', 'STAFF', 'ADMIN'] as const)('US-40-TC02: vai trò %s gọi API giỏ → 403', async role => {
      const other = await userOf(role);
      const { id } = await product();
      expectError(await getCart(other.token), 403);
      expectError(await add(other.token, { version: 0, productId: id, quantity: 1 }), 403);
      expect(await count('carts')).toBe(0);
    });

    it('US-40-TC02: Guest (không token) → 401', async () => {
      const { id } = await product();
      expectError(await getCart(), 401);
      expectError(await http().post('/api/me/cart/items').set('Idempotency-Key', randomUUID()).send({ version: 0, productId: id, quantity: 1 }), 401);
    });

    it.each([['memberId'], ['price'], ['accountId']])('US-40-TC02: body có %s → 400, không ghi gì', async field => {
      const me = await member();
      const other = await member();
      const { id } = await product();
      const value = field === 'price' ? '1' : field === 'memberId' ? other.memberId.toHexString() : other.accountId;
      expectError(await add(me.token, { version: 0, productId: id, quantity: 1, [field]: value }), 400);
      expect(await count('carts')).toBe(0);
      // Chỉ đếm operation của giỏ: fixture tạo sản phẩm qua API Admin cũng ghi CATEGORY_CREATE/PRODUCT_CREATE.
      expect(await count('operation_requests', { operation: /^CART_/ })).toBe(0);
    });

    it('US-40-TC02: tài khoản bị khóa dùng token cũ → 401, giỏ không đổi', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 1 }).expect(201);
      const before = await cartRows(me.memberId);
      await db().collection('accounts').updateOne({ _id: new ObjectId(me.accountId) }, { $set: { status: 'LOCKED' } });

      expectError(await getCart(me.token), 401);
      expectError(await add(me.token, { version: 1, productId: id, quantity: 1 }), 401);
      expect(await cartRows(me.memberId)).toEqual(before);
    });
  });

  describe('US-40-TC03: chưa liên kết hoặc giỏ chưa có state', () => {
    it('US-40-TC03: chưa liên kết → GET 200 rỗng có cờ MEMBER_PROFILE_REQUIRED, version 0', async () => {
      const me = await member(false);
      const response = await getCart(me.token).expect(200);
      expect(response.body).toMatchObject({
        memberLinked: false, version: 0, items: [], subtotal: '0', readyForOrder: false, canCheckout: false, reason: 'MEMBER_PROFILE_REQUIRED',
      });
    });

    it('US-40-TC03: chưa liên kết → POST 409 MEMBER_PROFILE_REQUIRED, không tạo hồ sơ/giỏ/state/operation', async () => {
      const me = await member(false);
      const { id } = await product();
      expectError(await add(me.token, { version: 0, productId: id, quantity: 1 }), 409, 'MEMBER_PROFILE_REQUIRED');
      expect(await count('members')).toBe(0);
      expect(await count('carts')).toBe(0);
      expect(await count('cart_states')).toBe(0);
      expect(await count('operation_requests', { operation: /^CART_/ })).toBe(0);
    });

    it('US-40-TC03: đã liên kết nhưng chưa có state → GET version 0, subtotal "0", không ghi DB, no-store', async () => {
      const me = await member();
      const response = await getCart(me.token).expect(200);
      expect(response.body).toMatchObject({ memberLinked: true, version: 0, items: [], subtotal: '0', readyForOrder: false, canCheckout: false });
      expect(response.headers['cache-control']).toContain('no-store');
      expect(await count('cart_states')).toBe(0);
      expect(await count('carts')).toBe(0);
    });

    it('US-40-TC03: DELETE trên giỏ chưa có state → 404, không tạo state rỗng giả', async () => {
      const me = await member();
      const { id } = await product();
      expectError(await remove(me.token, id, 0), 404, 'CART_ITEM_NOT_FOUND');
      expect(await count('cart_states')).toBe(0);
    });
  });

  describe('US-40-TC04: số lượng sai, tổng > 999, dòng thứ 101', () => {
    it('US-40-TC04: POST/PUT quantity 0 → 400, giỏ trước giữ nguyên (xóa dùng DELETE)', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 2 }).expect(201);
      const before = await cartRows(me.memberId);
      expectError(await add(me.token, { version: 1, productId: id, quantity: 0 }), 400);
      expectError(await setQty(me.token, id, { version: 1, quantity: 0 }), 400);
      expect(await cartRows(me.memberId)).toEqual(before);
    });

    it('US-40-TC04: dòng 998 cộng thêm 2 (tổng 1000 > 999) → 400 QUANTITY_INVALID, giỏ giữ nguyên', async () => {
      const me = await member();
      const { id } = await product({ stock: 2000 });
      await add(me.token, { version: 0, productId: id, quantity: 998 }).expect(201);
      const before = await cartRows(me.memberId);
      expectError(await add(me.token, { version: 1, productId: id, quantity: 2 }), 400, 'QUANTITY_INVALID');
      expect(await cartRows(me.memberId)).toEqual(before);
    });

    it('US-40-TC04: dòng 998 cộng thêm 1 (đúng 999) → 201', async () => {
      const me = await member();
      const { id } = await product({ stock: 2000 });
      await add(me.token, { version: 0, productId: id, quantity: 998 }).expect(201);
      expect((await add(me.token, { version: 1, productId: id, quantity: 1 }).expect(201)).body.quantity).toBe(999);
    });

    it('US-40-TC04: giỏ đã có 100 SKU, thêm SKU thứ 101 → 400 CART_LIMIT_EXCEEDED; cộng vào SKU đã có vẫn được', async () => {
      const me = await member();
      const categoryId = await category();
      const ids: string[] = [];
      for (let i = 0; i < 101; i += 1) ids.push((await product({ categoryId, price: '1000' })).id);
      // 100 dòng có sẵn (đặt thẳng vào DB cho nhanh), version 100.
      const now = Date.now();
      await db().collection('carts').insertMany(ids.slice(0, 100).map((id, index) => ({
        member_id: me.memberId, product_id: new ObjectId(id), quantity: new Int32(1),
        created_at: new Date(now + index), updated_at: new Date(now + index),
      })));
      await db().collection('cart_states').insertOne({ _id: me.memberId, version: new Int32(100), created_at: new Date(), updated_at: new Date() });

      expectError(await add(me.token, { version: 100, productId: ids[100], quantity: 1 }), 400, 'CART_LIMIT_EXCEEDED');
      expect(await count('carts', { member_id: me.memberId })).toBe(100);
      await add(me.token, { version: 100, productId: ids[0], quantity: 1 }).expect(201);
    });

    it('US-40-TC04: thiếu Idempotency-Key → 400, không ghi', async () => {
      const me = await member();
      const { id } = await product();
      const response = await http().post('/api/me/cart/items').set('Authorization', `Bearer ${me.token}`).send({ version: 0, productId: id, quantity: 1 });
      expectError(response, 400);
      expect(await count('carts')).toBe(0);
    });

    it('US-40-TC04: productId sai định dạng → 400; đúng định dạng nhưng không tồn tại → 404', async () => {
      const me = await member();
      expectError(await add(me.token, { version: 0, productId: 'khong-phai-id', quantity: 1 }), 400);
      expectError(await setQty(me.token, 'khong-phai-id', { version: 0, quantity: 1 }), 400);
      expectError(await add(me.token, { version: 0, productId: new ObjectId().toHexString(), quantity: 1 }), 404);
      expect(await count('carts')).toBe(0);
    });
  });

  // =====================================================================
  // AC02 – Giá, tồn và trạng thái lỗi minh bạch (TC05–TC08)
  // =====================================================================
  describe('US-40-TC05: chặn thêm/tăng khi ngừng bán hoặc vượt tồn, GET giữ dòng bị chặn', () => {
    it('US-40-TC05: sản phẩm INACTIVE → POST 409 PRODUCT_UNAVAILABLE', async () => {
      const me = await member();
      const { id } = await product();
      await patchProduct(id, { status: 'INACTIVE' });
      expectError(await add(me.token, { version: 0, productId: id, quantity: 1 }), 409, 'PRODUCT_UNAVAILABLE');
      expect(await count('carts')).toBe(0);
    });

    it('US-40-TC05: danh mục INACTIVE → POST 409 PRODUCT_UNAVAILABLE', async () => {
      const me = await member();
      const { id, categoryId } = await product();
      await stopCategory(categoryId);
      expectError(await add(me.token, { version: 0, productId: id, quantity: 1 }), 409, 'PRODUCT_UNAVAILABLE');
    });

    it('US-40-TC05: available = on_hand − reserved = 3: thêm 4 → 409 INSUFFICIENT_STOCK; thêm 3 được; tăng thêm 1 hoặc PUT 4 → 409', async () => {
      const me = await member();
      const { id } = await product();
      await setStock(id, 5, 2);
      expectError(await add(me.token, { version: 0, productId: id, quantity: 4 }), 409, 'INSUFFICIENT_STOCK');
      await add(me.token, { version: 0, productId: id, quantity: 3 }).expect(201);
      expectError(await add(me.token, { version: 1, productId: id, quantity: 1 }), 409, 'INSUFFICIENT_STOCK');
      expectError(await setQty(me.token, id, { version: 1, quantity: 4 }), 409, 'INSUFFICIENT_STOCK');
      expect((await cartOf(me.token)).items[0].quantity).toBe(3);
    });

    it('US-40-TC05: thiếu bản ghi inventory → POST 409 INVENTORY_UNAVAILABLE', async () => {
      const me = await member();
      const { id } = await product();
      await db().collection('inventory').deleteOne({ product_id: new ObjectId(id) });
      expectError(await add(me.token, { version: 0, productId: id, quantity: 1 }), 409, 'INVENTORY_UNAVAILABLE');
    });

    it('US-40-TC05: sản phẩm ngừng bán sau khi thêm → GET giữ dòng BLOCKED PRODUCT_UNAVAILABLE, không xóa/giảm', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 4 }).expect(201);
      await patchProduct(id, { status: 'INACTIVE' });

      const cart = await cartOf(me.token);
      expect(cart.items).toHaveLength(1);
      expect(cart.items[0]).toMatchObject({ productId: id, quantity: 4, lineState: 'BLOCKED' });
      expect(cart.items[0].reasons).toContain('PRODUCT_UNAVAILABLE');
      expect(cart.readyForOrder).toBe(false);
      expect(await count('carts', { member_id: me.memberId })).toBe(1);
    });

    it('US-40-TC05: tồn giảm sau khi thêm → GET BLOCKED INSUFFICIENT_STOCK, quantity giữ nguyên', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 4 }).expect(201);
      await setStock(id, 2, 0);

      const cart = await cartOf(me.token);
      expect(cart.items[0]).toMatchObject({ quantity: 4, lineState: 'BLOCKED', availableQuantity: 2 });
      expect(cart.items[0].reasons).toContain('INSUFFICIENT_STOCK');
      expect(cart.readyForOrder).toBe(false);
    });

    it('US-40-TC05: inventory mất sau khi thêm → GET BLOCKED INVENTORY_UNAVAILABLE', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 1 }).expect(201);
      await db().collection('inventory').deleteOne({ product_id: new ObjectId(id) });
      const cart = await cartOf(me.token);
      expect(cart.items[0].lineState).toBe('BLOCKED');
      expect(cart.items[0].reasons).toContain('INVENTORY_UNAVAILABLE');
    });

    it('US-40-TC05: PUT giữ nguyên số lượng trên dòng đã ngừng bán → 409 PRODUCT_UNAVAILABLE (chỉ cho giảm)', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 4 }).expect(201);
      await patchProduct(id, { status: 'INACTIVE' });
      expectError(await setQty(me.token, id, { version: 1, quantity: 4 }), 409, 'PRODUCT_UNAVAILABLE');
    });
  });

  describe('US-40-TC06: cho dọn giỏ trên dòng lỗi', () => {
    it('US-40-TC06: dòng đã ngừng bán: PUT giảm 4 → 2 được, vẫn BLOCKED; DELETE đúng version được', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 4 }).expect(201);
      await patchProduct(id, { status: 'INACTIVE' });

      expect((await setQty(me.token, id, { version: 1, quantity: 2 }).expect(200)).body).toEqual({ version: 2, productId: id, quantity: 2 });
      const blocked = await cartOf(me.token);
      expect(blocked.items[0]).toMatchObject({ quantity: 2, lineState: 'BLOCKED' });

      expect((await remove(me.token, id, 2).expect(200)).body).toEqual({ version: 3, removedProductId: id });
      expect((await cartOf(me.token)).items).toEqual([]);
      expect(await count('carts')).toBe(0);
    });

    it('US-40-TC06: tồn còn 1, dòng đang 5: PUT giảm xuống 3 được dù vẫn INSUFFICIENT_STOCK', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 5 }).expect(201);
      await setStock(id, 1, 0);
      await setQty(me.token, id, { version: 1, quantity: 3 }).expect(200);
      const cart = await cartOf(me.token);
      expect(cart.items[0]).toMatchObject({ quantity: 3, lineState: 'BLOCKED' });
      expect(cart.items[0].reasons).toContain('INSUFFICIENT_STOCK');
    });

    it('US-40-TC06: DELETE sai version → 409 CART_VERSION_CONFLICT, dòng còn nguyên', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 1 }).expect(201);
      expectError(await remove(me.token, id, 0), 409, 'CART_VERSION_CONFLICT');
      expect(await count('carts')).toBe(1);
    });

    it('US-40-TC06: DELETE thiếu version hoặc version sai định dạng → 400', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 1 }).expect(201);
      expectError(await remove(me.token, id, undefined), 400);
      expectError(await remove(me.token, id, '-1'), 400);
      expect(await count('carts')).toBe(1);
    });
  });

  describe('US-40-TC07: giá hiện tại, giá vốn không lộ, giá 0', () => {
    it('US-40-TC07: Admin đổi giá sau khi thêm → GET dùng giá mới; version giỏ không đổi vì giá thay bên ngoài', async () => {
      const me = await member();
      const { id } = await product({ price: '9000' });
      await add(me.token, { version: 0, productId: id, quantity: 2 }).expect(201);
      const before = await cartOf(me.token);
      expect(before.items[0]).toMatchObject({ unitPrice: '9000', lineTotal: '18000' });
      expect(before.subtotal).toBe('18000');

      await patchProduct(id, { price: '12000' });
      const after = await cartOf(me.token);
      expect(after.items[0]).toMatchObject({ unitPrice: '12000', lineTotal: '24000' });
      expect(after.subtotal).toBe('24000');
      expect(after.version).toBe(before.version);
    });

    it('US-40-TC07: tiền là chuỗi VND, subtotal = tổng các dòng', async () => {
      const me = await member();
      const a = await product({ price: '9000' });
      const b = await product({ price: '150000' });
      await add(me.token, { version: 0, productId: a.id, quantity: 3 }).expect(201);
      await add(me.token, { version: 1, productId: b.id, quantity: 2 }).expect(201);
      const cart = await cartOf(me.token);
      for (const item of cart.items) {
        expect(typeof item.unitPrice).toBe('string');
        expect(typeof item.lineTotal).toBe('string');
      }
      expect(cart.subtotal).toBe('327000');
    });

    it('US-40-TC07: giá vốn (unit_cost) khác giá bán → response không lộ unitCost', async () => {
      const me = await member();
      const { id } = await product({ price: '9000' });
      await db().collection('inventory').updateOne({ product_id: new ObjectId(id) }, { $set: { unit_cost: Decimal128.fromString('777777') } });
      await add(me.token, { version: 0, productId: id, quantity: 1 }).expect(201);
      const text = JSON.stringify((await getCart(me.token).expect(200)).body);
      expect(text).not.toMatch(/777777|unitCost|unit_cost|on_hand|reserved/);
    });

    it('US-40-TC07: sản phẩm giá 0 hợp lệ: unitPrice "0", subtotal tính bình thường, readyForOrder true', async () => {
      const me = await member();
      const free = await product({ price: '0' });
      const paid = await product({ price: '5000' });
      await add(me.token, { version: 0, productId: free.id, quantity: 2 }).expect(201);
      await add(me.token, { version: 1, productId: paid.id, quantity: 1 }).expect(201);
      const cart = await cartOf(me.token);
      expect(cart.items[0]).toMatchObject({ unitPrice: '0', lineTotal: '0', lineState: 'OK' });
      expect(cart).toMatchObject({ subtotal: '5000', totalsState: 'OK', readyForOrder: true });
    });
  });

  describe('US-40-TC08: dữ liệu thiếu hoặc tổng vượt trần', () => {
    it('US-40-TC08: product bị mất do dữ liệu bất thường → dòng còn productId/quantity, name/giá null, subtotal null UNAVAILABLE', async () => {
      const me = await member();
      const lost = await product({ price: '9000' });
      const ok = await product({ price: '5000' });
      await add(me.token, { version: 0, productId: lost.id, quantity: 2 }).expect(201);
      await add(me.token, { version: 1, productId: ok.id, quantity: 1 }).expect(201);
      await db().collection('products').deleteOne({ _id: new ObjectId(lost.id) });

      const cart = await cartOf(me.token);
      const line = cart.items.find(item => item.productId === lost.id)!;
      expect(line).toMatchObject({ quantity: 2, name: null, unitPrice: null, lineTotal: null, lineState: 'BLOCKED' });
      expect(line.reasons.length).toBeGreaterThan(0);
      // Không cộng tổng thiếu dòng: subtotal phải null chứ không phải "5000".
      expect(cart).toMatchObject({ subtotal: null, totalsState: 'UNAVAILABLE', readyForOrder: false });
      expect(await count('carts', { member_id: me.memberId })).toBe(2);
    });

    // Giá không tính được: sản phẩm vẫn còn nhưng price hỏng (dữ liệu bất thường). Sinh viên chốt dùng mã PRODUCT_UNAVAILABLE (18/11).
    it.each([['null', null], ['chuỗi không phải số', 'abc'], ['số lẻ', Decimal128.fromString('9000.5')]])(
      'US-40-TC08: giá %s sau khi thêm → dòng BLOCKED PRODUCT_UNAVAILABLE, giá null, subtotal null UNAVAILABLE', async (_label, badPrice) => {
        const me = await member();
        const { id } = await product({ price: '9000' });
        await add(me.token, { version: 0, productId: id, quantity: 2 }).expect(201);
        await db().collection('products').updateOne({ _id: new ObjectId(id) }, { $set: { price: badPrice } });

        const cart = await cartOf(me.token);
        expect(cart.items[0]).toMatchObject({ productId: id, quantity: 2, unitPrice: null, lineTotal: null, lineState: 'BLOCKED' });
        expect(cart.items[0].reasons).toContain('PRODUCT_UNAVAILABLE');
        expect(cart).toMatchObject({ subtotal: null, totalsState: 'UNAVAILABLE', readyForOrder: false });
      });

    it('US-40-TC08: sản phẩm có giá không tính được → POST thêm 409 PRODUCT_UNAVAILABLE, không ghi dòng', async () => {
      const me = await member();
      const { id } = await product({ price: '9000' });
      await db().collection('products').updateOne({ _id: new ObjectId(id) }, { $set: { price: 'abc' } });
      expectError(await add(me.token, { version: 0, productId: id, quantity: 1 }), 409, 'PRODUCT_UNAVAILABLE');
      expect(await count('carts')).toBe(0);
    });

    it('US-40-TC08: dòng có giá không tính được vẫn giảm/xóa được (dọn giỏ)', async () => {
      const me = await member();
      const { id } = await product({ price: '9000' });
      await add(me.token, { version: 0, productId: id, quantity: 3 }).expect(201);
      await db().collection('products').updateOne({ _id: new ObjectId(id) }, { $set: { price: null } });
      await setQty(me.token, id, { version: 1, quantity: 1 }).expect(200);
      await remove(me.token, id, 2).expect(200);
      expect(await count('carts')).toBe(0);
    });

    it('US-40-TC08: thêm làm tổng vượt 999999999999 → 400 AMOUNT_LIMIT_EXCEEDED, giỏ giữ nguyên', async () => {
      const me = await member();
      const { id } = await product({ price: MONEY_MAX });
      await add(me.token, { version: 0, productId: id, quantity: 1 }).expect(201);
      const before = await cartRows(me.memberId);
      expectError(await add(me.token, { version: 1, productId: id, quantity: 1 }), 400, 'AMOUNT_LIMIT_EXCEEDED');
      expect(await cartRows(me.memberId)).toEqual(before);
    });

    it('US-40-TC08: giá tăng sau khi thêm làm tổng vượt trần → GET subtotal null OVER_LIMIT; giảm vẫn được; thêm bị 400', async () => {
      const me = await member();
      const { id } = await product({ price: '400000000000' });
      await add(me.token, { version: 0, productId: id, quantity: 2 }).expect(201);
      await patchProduct(id, { price: '600000000000' });

      const over = await cartOf(me.token);
      expect(over).toMatchObject({ subtotal: null, totalsState: 'OVER_LIMIT', readyForOrder: false });
      expect(over.items[0].quantity).toBe(2);
      expectError(await add(me.token, { version: 1, productId: id, quantity: 1 }), 400, 'AMOUNT_LIMIT_EXCEEDED');
      // Giảm để dọn giỏ không bị chặn vì trần tiền (US-40-F02).
      await setQty(me.token, id, { version: 1, quantity: 1 }).expect(200);
      expect(await cartOf(me.token)).toMatchObject({ subtotal: '600000000000', totalsState: 'OK' });
    });
  });

  // =====================================================================
  // AC03 – Đồng thời, replay, rollback (TC09–TC13; phần hai app ở bước 4)
  // =====================================================================
  describe('US-40-TC09: hai tab cùng version (một app)', () => {
    it('US-40-TC09: hai lệnh tuần tự cùng version 0 → lệnh sau 409 CART_VERSION_CONFLICT, không lost update', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 2 }).expect(201);
      expectError(await add(me.token, { version: 0, productId: id, quantity: 3 }), 409, 'CART_VERSION_CONFLICT');
      expect(await cartRows(me.memberId)).toMatchObject({ version: 1 });
      expect((await cartOf(me.token)).items[0].quantity).toBe(2);
    });

    it('US-40-TC09: hai ADD song song cùng version 0, khác key → đúng một 201, một 409', async () => {
      const me = await member();
      const { id } = await product();
      const results = await Promise.all([
        add(me.token, { version: 0, productId: id, quantity: 2 }),
        add(me.token, { version: 0, productId: id, quantity: 3 }),
      ]);
      expect(results.map(result => result.status).sort()).toEqual([201, 409]);
      const winner = results.find(result => result.status === 201)!;
      const cart = await cartOf(me.token);
      expect(cart.version).toBe(1);
      expect(cart.items[0].quantity).toBe(winner.body.quantity);
    });
  });

  describe('US-40-TC10: replay cùng key', () => {
    it('US-40-TC10: POST cùng key/payload gửi lại 19 lần → cùng HTTP/body gốc, quantity chỉ cộng một lần', async () => {
      const me = await member();
      const { id } = await product();
      const key = randomUUID();
      const body = { version: 0, productId: id, quantity: 2 };
      const first = await add(me.token, body, key).expect(201);
      for (let i = 0; i < 19; i += 1) {
        const replay = await add(me.token, body, key);
        expect(replay.status).toBe(201);
        expect(replay.body).toEqual(first.body);
      }
      const cart = await cartOf(me.token);
      expect(cart).toMatchObject({ version: 1 });
      expect(cart.items[0].quantity).toBe(2);
      expect(await count('operation_requests', { operation: 'CART_ADD_ITEM' })).toBe(1);
    });

    it('US-40-TC10: replay được tìm trước khi kiểm version cũ: giỏ đã lên version 2, gửi lại key cũ (version 0) → 201 body gốc', async () => {
      const me = await member();
      const { id } = await product();
      const key = randomUUID();
      const body = { version: 0, productId: id, quantity: 2 };
      const first = await add(me.token, body, key).expect(201);
      await setQty(me.token, id, { version: 1, quantity: 5 }).expect(200);

      const replay = await add(me.token, body, key);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);
      expect((await cartOf(me.token)).items[0].quantity).toBe(5);
    });

    it('US-40-TC10: DELETE cùng key gửi lại → 200 body gốc; key mới trên dòng đã xóa → 404 CART_ITEM_NOT_FOUND', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 1 }).expect(201);
      const key = randomUUID();
      const first = await remove(me.token, id, 1, key).expect(200);
      const replay = await remove(me.token, id, 1, key);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expectError(await remove(me.token, id, 2), 404, 'CART_ITEM_NOT_FOUND');
      expect(await cartRows(me.memberId)).toMatchObject({ version: 2 });
    });
  });

  describe('US-40-TC11: key khác payload, replay khi bị khóa', () => {
    it('US-40-TC11: cùng key nhưng khác quantity → 409 IDEMPOTENCY_CONFLICT, giỏ không đổi', async () => {
      const me = await member();
      const { id } = await product();
      const key = randomUUID();
      await add(me.token, { version: 0, productId: id, quantity: 2 }, key).expect(201);
      const before = await cartRows(me.memberId);
      expectError(await add(me.token, { version: 0, productId: id, quantity: 3 }, key), 409, 'IDEMPOTENCY_CONFLICT');
      expect(await cartRows(me.memberId)).toEqual(before);
    });

    it('US-40-TC11: replay cùng key sau khi tài khoản bị khóa → 401, không trả dữ liệu giỏ', async () => {
      const me = await member();
      const { id } = await product();
      const key = randomUUID();
      const body = { version: 0, productId: id, quantity: 2 };
      await add(me.token, body, key).expect(201);
      await db().collection('accounts').updateOne({ _id: new ObjectId(me.accountId) }, { $set: { status: 'LOCKED' } });

      const replay = await add(me.token, body, key);
      expectError(replay, 401);
      expect(replay.body.productId).toBeUndefined();
      expect(replay.body.quantity).toBeUndefined();
    });
  });

  describe('US-40-TC12: giỏ không giữ tồn', () => {
    it('US-40-TC12: hai Member cùng thêm phần tồn cuối → đều được; inventory, đơn, giao dịch, phiếu kho không đổi', async () => {
      const a = await member();
      const b = await member();
      const { id } = await product();
      await setStock(id, 1, 0);
      const inventoryBefore = JSON.stringify(await db().collection('inventory').findOne({ product_id: new ObjectId(id) }));
      const countsBefore = await Promise.all(['orders', 'transactions', 'payments', 'stock_movements'].map(name => count(name)));

      await add(a.token, { version: 0, productId: id, quantity: 1 }).expect(201);
      await add(b.token, { version: 0, productId: id, quantity: 1 }).expect(201);

      expect(JSON.stringify(await db().collection('inventory').findOne({ product_id: new ObjectId(id) }))).toBe(inventoryBefore);
      expect(await Promise.all(['orders', 'transactions', 'payments', 'stock_movements'].map(name => count(name)))).toEqual(countsBefore);
    });

    it('US-40-TC12: tồn về 0 sau đó → GET của cả hai Member BLOCKED INSUFFICIENT_STOCK, quantity giữ 1', async () => {
      const a = await member();
      const b = await member();
      const { id } = await product();
      await setStock(id, 1, 0);
      await add(a.token, { version: 0, productId: id, quantity: 1 }).expect(201);
      await add(b.token, { version: 0, productId: id, quantity: 1 }).expect(201);
      await setStock(id, 1, 1);

      for (const who of [a, b]) {
        const line = (await cartOf(who.token)).items[0];
        expect(line).toMatchObject({ quantity: 1, lineState: 'BLOCKED' });
        expect(line.reasons).toContain('INSUFFICIENT_STOCK');
      }
    });
  });

  describe('US-40-TC13: lỗi trước commit thì rollback, gửi lại cùng key thành công', () => {
    // Bật lỗi giả lập cho các lệnh ghi vào một collection, chạy work, rồi tắt (giống US-65-TC11).
    async function failWritesOn(collection: string, work: () => Promise<void>) {
      await db().admin().command({
        configureFailPoint: 'failCommand', mode: 'alwaysOn',
        data: { failCommands: ['insert', 'update', 'findAndModify'], namespace: `${databaseName}.${collection}`, errorCode: 1, errmsg: 'Giả lập DB lỗi US-40-TC13' },
      });
      try {
        await work();
      } finally {
        await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
      }
    }

    it.each(['carts', 'cart_states', 'operation_requests'])('US-40-TC13: ghi %s lỗi khi ADD lần đầu → 5xx, không có giỏ một phần', async collection => {
      const me = await member();
      const { id } = await product();
      const key = randomUUID();
      const body = { version: 0, productId: id, quantity: 2 };
      await failWritesOn(collection, async () => {
        const response = await add(me.token, body, key);
        expect(response.status).toBeGreaterThanOrEqual(500);
        expect(JSON.stringify(response.body)).not.toMatch(/Giả lập DB lỗi|MongoServerError|stack/);
      });
      expect(await count('carts')).toBe(0);
      expect(await count('cart_states')).toBe(0);
      expect(await count('operation_requests', { operation: 'CART_ADD_ITEM' })).toBe(0);

      // Hết lỗi: gửi lại cùng key thì thành công đúng một lần.
      expect((await add(me.token, body, key).expect(201)).body).toEqual({ version: 1, productId: id, quantity: 2 });
      expect((await cartOf(me.token)).items[0].quantity).toBe(2);
    });

    it('US-40-TC13: ghi cart_states lỗi khi PUT trên giỏ đã có → dòng giữ số lượng cũ, version cũ', async () => {
      const me = await member();
      const { id } = await product();
      await add(me.token, { version: 0, productId: id, quantity: 2 }).expect(201);
      const before = await cartRows(me.memberId);
      await failWritesOn('cart_states', async () => {
        expect((await setQty(me.token, id, { version: 1, quantity: 5 })).status).toBeGreaterThanOrEqual(500);
      });
      expect(await cartRows(me.memberId)).toEqual(before);
    });
  });
});
