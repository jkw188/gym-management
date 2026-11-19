// Tầng kiểm thử backend (Jest + MongoDB replica set thật): US-40 bước 1 – CartModule, index thật trong DB và owner resolver.
// Kiểm tra mỗi member/product một dòng, nhiều Member cùng chọn một SKU, resolver chỉ trả Member của chính account, không tự link (TC01–TC03).
// Hợp đồng test đặt ra cho Builder (US-40 bước 1, theo US-40-F01 và bảng Index mục 2 của spec):
//   - CartModule được nạp trong AppModule; khi app khởi động, collection carts và cart_states có index:
//       carts: unique (member_id, product_id); (member_id, created_at, _id); không unique product_id một mình.
//   - CartOwnerResolver (src/modules/cart/cart-owner.resolver.ts), hàm resolve(accountId: string):
//       account đã liên kết members.account_id → { memberLinked: true, memberId: '<hex>' }.
//       chưa liên kết → { memberLinked: false, reason: 'MEMBER_PROFILE_REQUIRED' }.
//     Chỉ đọc: không tạo/link hồ sơ dựa trên phone, không tạo cart hoặc cart_states.
//   Để bước sau: API GET/POST/PUT/DELETE, version CAS, replay key, tổng tiền (bước 2); UI (bước 3); hai app (bước 4).
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Int32, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { CartOwnerResolver } from '../src/modules/cart/cart-owner.resolver';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us40_foundation';

describe('US-40 bước 1: CartModule, index giỏ và owner resolver', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
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
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    for (const name of ['members', 'carts', 'cart_states']) {
      await db().collection(name).deleteMany({});
    }
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const resolver = () => app.get(CartOwnerResolver);

  // Hồ sơ hội viên mẫu (thay US-09). accountId = null nghĩa là chưa liên kết tài khoản.
  let phoneSeq = 0;
  async function insertMember(accountId: ObjectId | null, phone?: string) {
    phoneSeq += 1;
    const memberId = new ObjectId();
    const staffId = new ObjectId();
    await db().collection('members').insertOne({
      _id: memberId, id: memberId, member_code: `HV-${memberId.toHexString()}`, full_name: 'Hội viên US40',
      phone: phone ?? `0914400${String(phoneSeq).padStart(3, '0')}`, ...(accountId ? { account_id: accountId } : {}),
      version: 0, service_revision: Long.ZERO, created_by: staffId, updated_by: staffId,
    });
    return memberId;
  }

  async function counts() {
    return {
      members: await db().collection('members').countDocuments(),
      carts: await db().collection('carts').countDocuments(),
      cartStates: await db().collection('cart_states').countDocuments(),
    };
  }

  function cartLine(memberId: ObjectId, productId: ObjectId, quantity = 1) {
    const now = new Date();
    return { member_id: memberId, product_id: productId, quantity: new Int32(quantity), created_at: now, updated_at: now };
  }

  describe('index trong MongoDB', () => {
    it('US-40-TC01: carts có index unique (member_id, product_id) và (member_id, created_at, _id)', async () => {
      const list = await db().collection('carts').indexes();
      const unique = list.find(index => JSON.stringify(index.key) === JSON.stringify({ member_id: 1, product_id: 1 }));
      expect(unique?.unique).toBe(true);
      expect(list.some(index => JSON.stringify(index.key) === JSON.stringify({ member_id: 1, created_at: 1, _id: 1 }))).toBe(true);
    });

    it('US-40-TC01: cùng Member thêm cùng SKU hai lần ở tầng DB → lần hai bị lỗi trùng (E11000)', async () => {
      const memberId = new ObjectId();
      const productId = new ObjectId();
      await db().collection('carts').insertOne(cartLine(memberId, productId));
      await expect(db().collection('carts').insertOne(cartLine(memberId, productId, 2))).rejects.toMatchObject({ code: 11000 });
      expect(await db().collection('carts').countDocuments({ member_id: memberId })).toBe(1);
    });

    it('US-40-TC01: hai Member khác nhau cùng chọn một SKU → đều lưu được (không unique product_id toàn collection)', async () => {
      const productId = new ObjectId();
      await db().collection('carts').insertOne(cartLine(new ObjectId(), productId));
      await db().collection('carts').insertOne(cartLine(new ObjectId(), productId));
      expect(await db().collection('carts').countDocuments({ product_id: productId })).toBe(2);
    });

    it('US-40-TC03: collection cart_states tồn tại sau khi app khởi động (_id = member_id, một state mỗi member)', async () => {
      const names = (await db().listCollections({}, { nameOnly: true }).toArray()).map(collection => collection.name);
      expect(names).toEqual(expect.arrayContaining(['carts', 'cart_states']));
      const memberId = new ObjectId();
      const now = new Date();
      await db().collection('cart_states').insertOne({ _id: memberId, version: new Int32(0), created_at: now, updated_at: now });
      await expect(db().collection('cart_states').insertOne({ _id: memberId, version: new Int32(1), created_at: now, updated_at: now }))
        .rejects.toMatchObject({ code: 11000 });
    });
  });

  describe('CartOwnerResolver', () => {
    it('US-40-TC01: account đã liên kết → memberLinked true và đúng memberId', async () => {
      const accountId = new ObjectId();
      const memberId = await insertMember(accountId);
      await expect(resolver().resolve(accountId.toHexString())).resolves.toEqual({ memberLinked: true, memberId: memberId.toHexString() });
    });

    it('US-40-TC02: hai Member đã liên kết → mỗi account chỉ ra Member của chính mình', async () => {
      const accountA = new ObjectId();
      const accountB = new ObjectId();
      const memberA = await insertMember(accountA);
      const memberB = await insertMember(accountB);
      expect(await resolver().resolve(accountA.toHexString())).toEqual({ memberLinked: true, memberId: memberA.toHexString() });
      expect(await resolver().resolve(accountB.toHexString())).toEqual({ memberLinked: true, memberId: memberB.toHexString() });
    });

    it('US-40-TC03: account chưa liên kết hồ sơ nào → memberLinked false, reason MEMBER_PROFILE_REQUIRED', async () => {
      await insertMember(new ObjectId());
      await expect(resolver().resolve(new ObjectId().toHexString()))
        .resolves.toEqual({ memberLinked: false, reason: 'MEMBER_PROFILE_REQUIRED' });
    });

    it('US-40-TC03: có hồ sơ cùng số điện thoại nhưng chưa liên kết → không tự link, không ghi DB', async () => {
      const memberId = await insertMember(null, '0914400999');
      const before = await counts();
      await expect(resolver().resolve(new ObjectId().toHexString()))
        .resolves.toEqual({ memberLinked: false, reason: 'MEMBER_PROFILE_REQUIRED' });
      const member = await db().collection('members').findOne({ _id: memberId });
      expect(member?.account_id).toBeUndefined();
      expect(await counts()).toEqual(before);
    });

    it('US-40-TC03: resolve chỉ đọc → không tạo carts hoặc cart_states', async () => {
      const accountId = new ObjectId();
      await insertMember(accountId);
      await resolver().resolve(accountId.toHexString());
      expect(await counts()).toEqual({ members: 1, carts: 0, cartStates: 0 });
    });
  });
});
