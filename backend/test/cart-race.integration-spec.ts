// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật, HAI app instance): US-40 bước 4 – giỏ hàng khi chạy đồng thời.
// Kiểm tra hai app cùng version, 20 request cùng key, GET song song với sửa giỏ/đổi giá, và adapter checkout S06 (TC09, TC10, TC14, TC15).
// Hợp đồng test đặt ra cho Builder (US-40 bước 4, theo US-40-C01 và mục 3 của spec; dùng API đã có từ bước 2):
//   TC09: nhiều lệnh cùng version qua hai instance → đúng một thành công, còn lại 409 CART_VERSION_CONFLICT; không lost update, không vượt 999.
//   TC10: 20 request cùng key + cùng payload qua hai instance → mọi phản hồi thành công có cùng body gốc (hoặc 409 khi lệnh gốc đang chạy);
//         giỏ chỉ đổi một lần, version +1 một lần, một operation_requests.
//   TC14: mỗi GET là MỘT snapshot: quantity khớp version, lineTotal = unitPrice × quantity, subtotal = tổng lineTotal, có asOf, canCheckout false.
//   TC15: adapter checkout (chỉ trong test, KHÔNG phải US-41) chạy transaction: khóa catalog_state → members (DataGuardsService của EN-02),
//         rồi đọc cart_states.version và carts trong CÙNG session. Chạy song song với sửa giỏ → luôn thấy dòng khớp version, không lỗi.
//   Mẹo kiểm "nửa cũ nửa mới": chuỗi PUT luôn đặt quantity = version mới, nên ở mọi ảnh chụp đúng phải có quantity === version.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Int32, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { DataGuardsService } from '../src/infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { ensureRetailCatalogIntegrity } from '../src/modules/catalog/retail-catalog.migration';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us40_cart_race';
const password = 'MậtKhẩuUS-40-race';

type Member = { accountId: string; memberId: ObjectId; token: string };
type CartLine = { productId: string; quantity: number; unitPrice: string | null; lineTotal: string | null };
type CartBody = { version: number; items: CartLine[]; subtotal: string | null; asOf: string; canCheckout: boolean };

describe('US-40 bước 4: giỏ hàng khi chạy đồng thời trên hai app', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let second: INestApplication;
  let connection: Connection;
  let adminToken = '';
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName } });
    Object.assign(process.env, {
      NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: origin, MONGODB_URI: mongo.getUri(), MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'us40-test', SMTP_PASS: 'us40-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    const { configureHttp } = await import('../src/common/http/configure-http');
    // Hai instance cùng một DB và cùng JWT secret: token đăng nhập ở app này dùng được ở app kia (giống chạy hai server sau load balancer).
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    second = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(second);
    await second.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const instance of [app, second]) {
      const limiter = new LoginLimiter();
      jest.spyOn(instance.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    }
    for (const collection of await db().collections()) {
      if (collection.collectionName !== 'roles') await collection.deleteMany({});
    }
    await ensureRetailCatalogIntegrity(connection);
    adminToken = (await login(await account('ADMIN'))).token;
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await second?.close();
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const http = (instance: INestApplication = app) => request(instance.getHttpServer());

  // ---------- Tài khoản, hồ sơ, sản phẩm (khuôn giống cart-api.integration-spec.ts) ----------
  let phoneSeq = 0;
  async function account(role: 'MEMBER' | 'ADMIN') {
    const users = app.get(UsersRepository);
    const roleDoc = await users.ensureRole(role, role);
    phoneSeq += 1;
    const phone = `0914402${String(phoneSeq).padStart(3, '0')}`;
    const created = await users.createAccount({
      roleId: String(roleDoc.id), phone, fullName: `${role} US40 race`, passwordHash: await app.get(PasswordService).hash(password),
    });
    return { accountId: String(created.id), phone };
  }
  async function login(owner: { accountId: string; phone: string }) {
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone: owner.phone, password }).expect(200);
    return { accountId: owner.accountId, token: response.body.accessToken as string };
  }
  async function member(): Promise<Member> {
    const owner = await account('MEMBER');
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: 'Hội viên US40 race', phone: owner.phone,
      account_id: new ObjectId(owner.accountId), version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return { ...(await login(owner)), memberId };
  }
  const adminSend = (method: 'post' | 'patch', path: string, body: object) => http()[method](`/api/admin/${path}`)
    .set('Authorization', `Bearer ${adminToken}`).set('Idempotency-Key', randomUUID()).send(body);
  let skuSeq = 0;
  async function product(price = '9000', stock = 2000) {
    skuSeq += 1;
    const categoryId = (await adminSend('post', 'categories', { name: `Danh mục race ${skuSeq}`, status: 'ACTIVE' }).expect(201)).body.id as string;
    const id = (await adminSend('post', 'products', {
      categoryId, sku: `RACE_${skuSeq}`, name: `Sản phẩm race ${skuSeq}`, price, status: 'ACTIVE',
    }).expect(201)).body.id as string;
    await db().collection('inventory').updateOne({ product_id: new ObjectId(id) }, { $set: { on_hand: new Int32(stock), reserved: new Int32(0) } });
    return id;
  }
  async function patchPrice(productId: string, price: string) {
    const version = Number((await db().collection('products').findOne({ _id: new ObjectId(productId) }))?.version ?? 0);
    await adminSend('patch', `products/${productId}`, { version, price }).expect(200);
  }

  // ---------- API giỏ, chọn instance ----------
  const add = (instance: INestApplication, who: Member, body: object, key: string = randomUUID()) =>
    http(instance).post('/api/me/cart/items').set('Authorization', `Bearer ${who.token}`).set('Idempotency-Key', key).send(body);
  const setQty = (instance: INestApplication, who: Member, productId: string, body: object, key: string = randomUUID()) =>
    http(instance).put(`/api/me/cart/items/${productId}`).set('Authorization', `Bearer ${who.token}`).set('Idempotency-Key', key).send(body);
  const remove = (instance: INestApplication, who: Member, productId: string, version: number, key: string = randomUUID()) =>
    http(instance).delete(`/api/me/cart/items/${productId}?version=${version}`).set('Authorization', `Bearer ${who.token}`).set('Idempotency-Key', key);
  async function cartOf(instance: INestApplication, who: Member): Promise<CartBody> {
    return (await http(instance).get('/api/me/cart').set('Authorization', `Bearer ${who.token}`).expect(200)).body as CartBody;
  }
  const count = (name: string, filter: object = {}) => db().collection(name).countDocuments(filter);
  const instanceAt = (index: number) => (index % 2 === 0 ? app : second);

  // =====================================================================
  describe('US-40-TC09: hai app cùng version', () => {
    it('US-40-TC09: 10 ADD cùng version 0, khác key, chia đều hai app → đúng một 201, chín 409 CART_VERSION_CONFLICT', async () => {
      const me = await member();
      const id = await product();
      const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
        add(instanceAt(index), me, { version: 0, productId: id, quantity: index + 1 })));

      const winners = results.filter(result => result.status === 201);
      expect(winners).toHaveLength(1);
      for (const loser of results.filter(result => result.status !== 201)) {
        expect(loser.status).toBe(409);
        expect(loser.body.error.code).toBe('CART_VERSION_CONFLICT');
      }
      // Không lost update: giỏ đúng bằng lệnh thắng, version 1, một dòng.
      const cart = await cartOf(second, me);
      expect(cart.version).toBe(1);
      expect(cart.items).toHaveLength(1);
      expect(cart.items[0].quantity).toBe(winners[0].body.quantity);
      expect(await count('carts', { member_id: me.memberId })).toBe(1);
      expect(await count('operation_requests', { operation: 'CART_ADD_ITEM' })).toBe(1);
    });

    it('US-40-TC09: dòng 998, hai app cùng cộng thêm 1 với cùng version → một thắng (999), lệnh kia 409; không bao giờ thành 1000', async () => {
      const me = await member();
      const id = await product();
      await add(app, me, { version: 0, productId: id, quantity: 998 }).expect(201);

      const results = await Promise.all([
        add(app, me, { version: 1, productId: id, quantity: 1 }),
        add(second, me, { version: 1, productId: id, quantity: 1 }),
      ]);
      expect(results.map(result => result.status).sort()).toEqual([201, 409]);
      expect((await cartOf(app, me)).items[0].quantity).toBe(999);

      // Thử lại với version mới cũng không vượt trần.
      const retry = await add(second, me, { version: 2, productId: id, quantity: 1 });
      expect(retry.status).toBe(400);
      expect(retry.body.error.code).toBe('QUANTITY_INVALID');
      expect((await cartOf(second, me)).items[0].quantity).toBe(999);
    });

    it('US-40-TC09: PUT và DELETE cùng version trên hai app → đúng một thắng, giỏ khớp lệnh thắng', async () => {
      const me = await member();
      const id = await product();
      await add(app, me, { version: 0, productId: id, quantity: 2 }).expect(201);

      const [put, del] = await Promise.all([setQty(app, me, id, { version: 1, quantity: 7 }), remove(second, me, id, 1)]);
      expect([put.status, del.status].sort()).toEqual([200, 409]);
      const cart = await cartOf(app, me);
      expect(cart.version).toBe(2);
      if (put.status === 200) expect(cart.items.map(item => item.quantity)).toEqual([7]);
      else expect(cart.items).toEqual([]);
    });
  });

  // =====================================================================
  describe('US-40-TC10: 20 request cùng key trên hai app', () => {
    it('US-40-TC10: 20 POST cùng key/payload song song → một tác động, mọi 201 cùng body gốc, quantity chỉ cộng một lần', async () => {
      const me = await member();
      const id = await product();
      const key = randomUUID();
      const body = { version: 0, productId: id, quantity: 3 };
      const results = await Promise.all(Array.from({ length: 20 }, (_, index) => add(instanceAt(index), me, body, key)));

      const ok = results.filter(result => result.status === 201);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const result of ok) expect(result.body).toEqual({ version: 1, productId: id, quantity: 3 });
      // Lệnh nào không 201 thì chỉ được là 409 (lệnh gốc đang chạy), không 5xx, không tự cộng thêm.
      for (const result of results.filter(r => r.status !== 201)) expect(result.status).toBe(409);

      const cart = await cartOf(app, me);
      expect(cart.version).toBe(1);
      expect(cart.items[0].quantity).toBe(3);
      expect(await count('operation_requests', { operation: 'CART_ADD_ITEM' })).toBe(1);

      // Sau khi lệnh gốc xong, gửi lại cùng key ở app nào cũng nhận body gốc.
      for (const instance of [app, second]) {
        const replay = await add(instance, me, body, key);
        expect(replay.status).toBe(201);
        expect(replay.body).toEqual({ version: 1, productId: id, quantity: 3 });
      }
    });

    it('US-40-TC10: 20 DELETE cùng key song song → xóa một lần, version +1 một lần, mọi 200 cùng body gốc', async () => {
      const me = await member();
      const id = await product();
      await add(app, me, { version: 0, productId: id, quantity: 1 }).expect(201);
      const key = randomUUID();
      const results = await Promise.all(Array.from({ length: 20 }, (_, index) => remove(instanceAt(index), me, id, 1, key)));

      const ok = results.filter(result => result.status === 200);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const result of ok) expect(result.body).toEqual({ version: 2, removedProductId: id });
      for (const result of results.filter(r => r.status !== 200)) expect(result.status).toBe(409);

      const cart = await cartOf(second, me);
      expect(cart.version).toBe(2);
      expect(cart.items).toEqual([]);
      expect(await count('operation_requests', { operation: 'CART_REMOVE_ITEM' })).toBe(1);
    });
  });

  // =====================================================================
  // Chuỗi PUT tuần tự luân phiên hai app, mỗi lệnh đặt quantity = version mới (bất biến: quantity === version).
  async function putChain(who: Member, productId: string, steps: number) {
    let version = 1;
    for (let step = 0; step < steps; step += 1) {
      const response = await setQty(instanceAt(step), who, productId, { version, quantity: version + 1 });
      expect(response.status).toBe(200);
      version = response.body.version as number;
    }
    return version;
  }

  describe('US-40-TC14: GET song song với sửa giỏ và đổi giá', () => {
    it('US-40-TC14: mỗi GET là một snapshot – quantity khớp version, lineTotal = giá × số lượng, subtotal = tổng dòng, có asOf, canCheckout false', async () => {
      const me = await member();
      const id = await product('1000');
      const other = await product('500');
      await add(app, me, { version: 0, productId: id, quantity: 1 }).expect(201);
      // Dòng thứ hai cố định để kiểm subtotal là tổng của nhiều dòng; thêm qua PUT chain nên phải giữ bất biến → đặt trước rồi đồng bộ version.
      await add(second, me, { version: 1, productId: other, quantity: 2 }).expect(201);
      await setQty(app, me, id, { version: 2, quantity: 3 }).expect(200);
      // Lúc này version 3, dòng chính quantity 3: bất biến quantity === version bắt đầu đúng.

      let done = false;
      const snapshots: CartBody[] = [];
      const reader = (async () => {
        let index = 0;
        while (!done) {
          snapshots.push(await cartOf(instanceAt(index), me));
          index += 1;
        }
      })();
      const prices = (async () => {
        for (const price of ['1100', '1200', '1300', '1400', '1500']) await patchPrice(id, price);
      })();

      let version = 3;
      for (let step = 0; step < 12; step += 1) {
        const response = await setQty(instanceAt(step), me, id, { version, quantity: version + 1 });
        expect(response.status).toBe(200);
        version = response.body.version as number;
      }
      await prices;
      done = true;
      await reader;

      expect(snapshots.length).toBeGreaterThan(0);
      for (const cart of snapshots) {
        const main = cart.items.find(item => item.productId === id)!;
        const fixed = cart.items.find(item => item.productId === other)!;
        expect(main.quantity).toBe(cart.version);
        expect(fixed.quantity).toBe(2);
        for (const item of cart.items) expect(BigInt(item.lineTotal!)).toBe(BigInt(item.unitPrice!) * BigInt(item.quantity));
        expect(BigInt(cart.subtotal!)).toBe(cart.items.reduce((sum, item) => sum + BigInt(item.lineTotal!), 0n));
        expect(Number.isNaN(Date.parse(cart.asOf))).toBe(false);
        expect(cart.canCheckout).toBe(false);
      }
    });
  });

  // =====================================================================
  // Adapter checkout S06 – CHỈ dùng trong test để kiểm hợp đồng khóa/version, KHÔNG phải cài đặt US-41.
  // Thứ tự như spec C01: khóa catalog_state → members (DataGuardsService), rồi đọc cart_states + carts trong CÙNG session.
  async function checkoutSnapshot(memberId: ObjectId) {
    const runner = app.get(TransactionRunner);
    const guards = app.get(DataGuardsService);
    return runner.run(async session => {
      await guards.acquire(session, { catalog: true, members: [memberId] });
      const state = await db().collection('cart_states').findOne({ _id: memberId }, { session });
      const lines = await db().collection('carts').find({ member_id: memberId }, { session }).toArray();
      return { version: Number(state?.version ?? 0), quantities: lines.map(line => Number(line.quantity)) };
    });
  }

  describe('US-40-TC15: adapter checkout S06 cạnh tranh sửa giỏ', () => {
    it('US-40-TC15: adapter khóa catalog → member rồi đọc giỏ trong một session, chạy song song với 15 PUT → mọi lần thấy dòng khớp version', async () => {
      const me = await member();
      const id = await product();
      await add(app, me, { version: 0, productId: id, quantity: 1 }).expect(201);

      let done = false;
      const seen: Array<{ version: number; quantities: number[] }> = [];
      const checkout = (async () => {
        while (!done) seen.push(await checkoutSnapshot(me.memberId));
      })();
      const finalVersion = await putChain(me, id, 15);
      done = true;
      await checkout;

      expect(finalVersion).toBe(16);
      expect(seen.length).toBeGreaterThan(0);
      for (const snapshot of seen) expect(snapshot.quantities).toEqual([snapshot.version]);
      // Version chỉ tiến lên, không lùi giữa các lần checkout đọc.
      const versions = seen.map(snapshot => snapshot.version);
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
    });

    it('US-40-TC15: checkout giữ khóa member xong, lệnh sửa giỏ chạy sau vẫn thành công đúng version (không lost update, không treo)', async () => {
      const me = await member();
      const id = await product();
      await add(app, me, { version: 0, productId: id, quantity: 1 }).expect(201);

      const [snapshot, put] = await Promise.all([checkoutSnapshot(me.memberId), setQty(second, me, id, { version: 1, quantity: 2 })]);
      expect(put.status).toBe(200);
      // Checkout thấy trọn vẹn trước hoặc sau lệnh sửa, không thấy nửa vời.
      expect([{ version: 1, quantities: [1] }, { version: 2, quantities: [2] }]).toContainEqual(snapshot);
      expect(await checkoutSnapshot(me.memberId)).toEqual({ version: 2, quantities: [2] });
    });
  });
});
