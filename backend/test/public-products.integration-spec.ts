// Kiểm thử tích hợp (Jest) – US-35 bước 1–4: API công khai xem danh mục/sản phẩm, tình trạng kho, đọc thuần và dữ liệu đổi sau khi xem.
// Dữ liệu mẫu tạo qua API Admin của US-34; test gọi GET /api/categories, /api/products, /api/products/:id.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Decimal128, Int32, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PasswordService } from '../src/common/security/password.service';
import { configureHttp } from '../src/common/http/configure-http';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';
import { ensureRetailCatalogIntegrity } from '../src/modules/catalog/retail-catalog.migration';
import { UsersRepository } from '../src/modules/users/users.repository';

const origin = 'http://localhost:5173';
// Các field sản phẩm được phép trả ra công khai (US-35-F03). availability làm ở bước 2.
const PRODUCT_FIELDS = ['id', 'sku', 'name', 'category', 'description', 'imageUrl', 'price', 'version', 'availability', 'asOf'];

describe('US-35 bước 1: tra cứu sản phẩm công khai', () => {
  let mongo: MongoMemoryReplSet, app: INestApplication, connection: Connection;
  let adminToken = '', memberToken = '', sequence = 0;
  const saved = { ...process.env };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: 'gym_management_test_us35', FRONTEND_ORIGIN: origin,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'no-reply@gym.test' });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(app); await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = new LoginLimiter();
    jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    for (const collection of await connection.db!.collections()) if (collection.collectionName !== 'roles') await collection.deleteMany({});
    await ensureRetailCatalogIntegrity(connection);
    adminToken = await login('ADMIN');
    memberToken = await login('MEMBER');
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); await mongo?.stop(); process.env = saved; });

  // Tạo tài khoản theo vai trò rồi đăng nhập, trả về access token.
  async function login(code: 'ADMIN' | 'MEMBER'): Promise<string> {
    const users = app.get(UsersRepository), role = await users.ensureRole(code, code), password = 'US35 test password 123';
    const account = await users.createAccount({ roleId: String(role.id), fullName: `US35 ${code}`, phone: `093350${String(++sequence).padStart(4, '0')}`,
      passwordHash: await app.get(PasswordService).hash(password) });
    const response = await http().post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
    return response.body.accessToken as string;
  }

  // ---- Tạo dữ liệu mẫu qua API Admin của US-34 ----
  const adminPost = (kind: string, body: object) => http().post(`/api/admin/${kind}`)
    .set('Authorization', `Bearer ${adminToken}`).set('Idempotency-Key', randomUUID()).send(body);
  async function createCategory(name: string, status = 'ACTIVE'): Promise<string> {
    return (await adminPost('categories', { name, status }).expect(201)).body.id as string;
  }
  async function createProduct(categoryId: string, sku: string, name: string, price: string, status = 'ACTIVE'): Promise<string> {
    return (await adminPost('products', { categoryId, sku, name, price, status }).expect(201)).body.id as string;
  }
  // Ngừng danh mục sau khi đã có sản phẩm (version 0 vì vừa tạo).
  async function stopCategory(categoryId: string) {
    await http().patch(`/api/admin/categories/${categoryId}`).set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', randomUUID()).send({ version: 0, status: 'INACTIVE' }).expect(200);
  }

  // ---- Gọi API công khai (không gửi token = Guest) ----
  const guestGet = (path: string) => http().get(`/api${path}`);
  const memberGet = (path: string) => http().get(`/api${path}`).set('Authorization', `Bearer ${memberToken}`);
  const names = (body: { items: Array<{ name: string }> }) => body.items.map(item => item.name);

  describe('US-35-TC01: Guest/Member tải catalog ACTIVE', () => {
    it('US-35-TC01: Guest xem list sản phẩm, đúng allowlist, giá là chuỗi VND, có envelope phân trang', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');

      const response = await guestGet('/products').expect(200);

      expect(response.body).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
      expect(response.body.items).toHaveLength(1);
      const item = response.body.items[0];
      expect(item).toMatchObject({ id: productId, sku: 'WATER_01', name: 'Nước suối', price: '9000', version: 0,
        category: { id: categoryId, name: 'Đồ uống' } });
      expect(typeof item.price).toBe('string');
      // Không có field nào ngoài allowlist; category chỉ có {id,name}
      for (const key of Object.keys(item)) expect(PRODUCT_FIELDS).toContain(key);
      expect(Object.keys(item.category).sort()).toEqual(['id', 'name']);
      // asOf là thời điểm đọc (US-35-F04)
      expect(Number.isNaN(Date.parse(item.asOf))).toBe(false);
    });

    it('US-35-TC01: Guest xem detail sản phẩm, đúng allowlist và có asOf', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');

      const response = await guestGet(`/products/${productId}`).expect(200);

      expect(response.body).toMatchObject({ id: productId, sku: 'WATER_01', name: 'Nước suối', price: '9000',
        category: { id: categoryId, name: 'Đồ uống' } });
      for (const key of Object.keys(response.body)) expect(PRODUCT_FIELDS).toContain(key);
      expect(Number.isNaN(Date.parse(response.body.asOf))).toBe(false);
    });

    it('US-35-TC01: Member đăng nhập nhận cùng dữ liệu như Guest', async () => {
      const categoryId = await createCategory('Đồ uống');
      await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');

      const guest = await guestGet('/products').expect(200);
      const member = await memberGet('/products').expect(200);

      // Bỏ asOf vì hai lần đọc khác thời điểm
      const strip = (body: { items: Array<Record<string, unknown>> }) => body.items.map(({ asOf: _asOf, ...rest }) => rest);
      expect(strip(member.body)).toEqual(strip(guest.body));
    });

    it('US-35-TC01: /categories chỉ trả {id,name} của danh mục ACTIVE, kể cả danh mục chưa có sản phẩm, sắp theo tên', async () => {
      const drinks = await createCategory('Đồ uống');
      await createProduct(drinks, 'WATER_01', 'Nước suối', '9000');
      const empty = await createCategory('Áo tập');          // ACTIVE nhưng chưa có sản phẩm
      await createCategory('Ẩn', 'INACTIVE');

      const response = await guestGet('/categories').expect(200);

      expect(response.body).toMatchObject({ page: 1, limit: 20, total: 2, totalPages: 1 });
      expect(response.body.items.map((item: { id: string }) => item.id).sort()).toEqual([drinks, empty].sort());
      for (const item of response.body.items) expect(Object.keys(item).sort()).toEqual(['id', 'name']);
      // Sắp name ASC
      const listed = response.body.items.map((item: { name: string }) => item.name);
      expect(listed).toEqual([...listed].sort((a: string, b: string) => a.localeCompare(b, 'vi')));
    });
  });

  describe('US-35-TC02: hàng/danh mục INACTIVE bị ẩn', () => {
    it('US-35-TC02: list không có sản phẩm INACTIVE và sản phẩm thuộc danh mục INACTIVE', async () => {
      const active = await createCategory('Đồ uống');
      await createProduct(active, 'SHOW_01', 'Hàng đang bán', '1000');
      await createProduct(active, 'HIDE_01', 'Hàng ngừng bán', '1000', 'INACTIVE');
      const stopped = await createCategory('Sắp ngừng');
      await createProduct(stopped, 'HIDE_02', 'Hàng trong danh mục ngừng', '1000');
      await stopCategory(stopped);

      const response = await guestGet('/products').expect(200);

      expect(names(response.body)).toEqual(['Hàng đang bán']);
      expect(response.body.total).toBe(1);
    });

    it('US-35-TC02: đoán id detail của sản phẩm INACTIVE trả 404 PRODUCT_NOT_AVAILABLE, không lộ tên/giá', async () => {
      const categoryId = await createCategory('Đồ uống');
      const hiddenId = await createProduct(categoryId, 'HIDE_01', 'Hàng bí mật', '123456', 'INACTIVE');

      const response = await guestGet(`/products/${hiddenId}`).expect(404);

      expect(response.body.error.code).toBe('PRODUCT_NOT_AVAILABLE');
      expect(JSON.stringify(response.body)).not.toMatch(/Hàng bí mật|123456|HIDE_01/);
    });

    it('US-35-TC02: detail sản phẩm ACTIVE nhưng danh mục INACTIVE trả 404 PRODUCT_NOT_AVAILABLE', async () => {
      const categoryId = await createCategory('Sắp ngừng');
      const productId = await createProduct(categoryId, 'HIDE_02', 'Hàng trong danh mục ngừng', '5000');
      await stopCategory(categoryId);

      const response = await guestGet(`/products/${productId}`).expect(404);

      expect(response.body.error.code).toBe('PRODUCT_NOT_AVAILABLE');
      expect(JSON.stringify(response.body)).not.toMatch(/Hàng trong danh mục ngừng|5000/);
    });

    it('US-35-TC02: id hợp lệ nhưng không tồn tại trả 404', async () => {
      await guestGet(`/products/${new ObjectId()}`).expect(404);
    });

    it('US-35-TC02: query status (hoặc field lạ) để mở hàng ẩn trả 400', async () => {
      const categoryId = await createCategory('Đồ uống');
      const hiddenId = await createProduct(categoryId, 'HIDE_01', 'Hàng ngừng bán', '1000', 'INACTIVE');

      await guestGet('/products?status=INACTIVE').expect(400);
      await guestGet('/products?status=ACTIVE').expect(400);
      await guestGet('/categories?status=INACTIVE').expect(400);
      await guestGet(`/products/${hiddenId}?status=INACTIVE`).expect(400);
      await guestGet('/products?unitCost=1').expect(400);
    });
  });

  describe('US-35-TC05: tìm kiếm và bộ lọc kết hợp', () => {
    it('US-35-TC05: q tìm theo name không phân biệt hoa/thường và giữ dấu tiếng Việt', async () => {
      const categoryId = await createCategory('Đồ uống');
      await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');
      await createProduct(categoryId, 'WHEY_01', 'Whey Protein', '900000');

      expect(names((await guestGet(`/products?q=${encodeURIComponent('NƯỚC')}`).expect(200)).body)).toEqual(['Nước suối']);
      expect(names((await guestGet('/products?q=protein').expect(200)).body)).toEqual(['Whey Protein']);
      // Chưa có tìm bỏ dấu: "nuoc" không khớp "Nước"
      expect((await guestGet('/products?q=nuoc').expect(200)).body).toMatchObject({ items: [], total: 0, totalPages: 0 });
    });

    it('US-35-TC05: q tìm theo SKU (chữ thường vẫn khớp SKU đã chuẩn hóa)', async () => {
      const categoryId = await createCategory('Đồ uống');
      await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');
      await createProduct(categoryId, 'WHEY_01', 'Whey Protein', '900000');

      expect(names((await guestGet('/products?q=water_01').expect(200)).body)).toEqual(['Nước suối']);
    });

    it('US-35-TC05: q là chuỗi literal, ký tự regex không bị hiểu thành biểu thức', async () => {
      const categoryId = await createCategory('Đồ uống');
      await createProduct(categoryId, 'BOX_01', 'Hộp [x] đặc biệt', '1000');
      await createProduct(categoryId, 'BOX_02', 'Hộp thường', '1000');

      expect(names((await guestGet(`/products?q=${encodeURIComponent('[x]')}`).expect(200)).body)).toEqual(['Hộp [x] đặc biệt']);
      expect((await guestGet(`/products?q=${encodeURIComponent('.*')}`).expect(200)).body.items).toEqual([]);
    });

    it('US-35-TC05: categoryId + minPrice + maxPrice + q kết hợp AND', async () => {
      const drinks = await createCategory('Đồ uống'), clothes = await createCategory('Áo tập');
      await createProduct(drinks, 'D_CHEAP', 'Nước rẻ', '5000');
      await createProduct(drinks, 'D_MID', 'Nước vừa', '20000');
      await createProduct(drinks, 'D_HIGH', 'Nước đắt', '90000');
      await createProduct(clothes, 'C_MID', 'Áo nước', '20000');

      const response = await guestGet(`/products?categoryId=${drinks}&minPrice=10000&maxPrice=50000&q=${encodeURIComponent('nước')}`).expect(200);

      expect(names(response.body)).toEqual(['Nước vừa']);
    });

    it('US-35-TC05: minPrice/maxPrice tính cả biên (min ≤ price ≤ max) và min = max hợp lệ', async () => {
      const categoryId = await createCategory('Đồ uống');
      await createProduct(categoryId, 'P_1', 'A giá 10000', '10000');
      await createProduct(categoryId, 'P_2', 'B giá 20000', '20000');

      expect(names((await guestGet('/products?minPrice=10000&maxPrice=20000').expect(200)).body)).toEqual(['A giá 10000', 'B giá 20000']);
      expect(names((await guestGet('/products?minPrice=20000&maxPrice=20000').expect(200)).body)).toEqual(['B giá 20000']);
    });

    it('US-35-TC05: không có kết quả trả items=[] rõ ràng, không tự bỏ filter', async () => {
      const categoryId = await createCategory('Đồ uống');
      await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');

      const response = await guestGet('/products?q=khongco&minPrice=1').expect(200);

      expect(response.body).toMatchObject({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
    });

    it('US-35-TC05: categoryId của danh mục INACTIVE hoặc không tồn tại trả list rỗng', async () => {
      const stopped = await createCategory('Sắp ngừng');
      await createProduct(stopped, 'HIDE_02', 'Hàng ẩn', '1000');
      await stopCategory(stopped);

      expect((await guestGet(`/products?categoryId=${stopped}`).expect(200)).body).toMatchObject({ items: [], total: 0 });
      expect((await guestGet(`/products?categoryId=${new ObjectId()}`).expect(200)).body).toMatchObject({ items: [], total: 0 });
    });

    it('US-35-TC05: /categories?q tìm literal theo tên danh mục ACTIVE', async () => {
      await createCategory('Đồ uống');
      await createCategory('Áo tập');

      const response = await guestGet(`/categories?q=${encodeURIComponent('uống')}`).expect(200);

      expect(names(response.body)).toEqual(['Đồ uống']);
      expect((await guestGet(`/categories?q=${encodeURIComponent('.*')}`).expect(200)).body.items).toEqual([]);
    });
  });

  describe('US-35-TC06: sắp xếp và phân trang', () => {
    it('US-35-TC06: PRICE_ASC so sánh theo số (9000 trước 100000), không theo chuỗi', async () => {
      const categoryId = await createCategory('Đồ uống');
      await createProduct(categoryId, 'P_BIG', 'Hàng 100000', '100000');
      await createProduct(categoryId, 'P_SMALL', 'Hàng 9000', '9000');

      expect(names((await guestGet('/products?sort=PRICE_ASC').expect(200)).body)).toEqual(['Hàng 9000', 'Hàng 100000']);
    });

    it('US-35-TC06: PRICE_DESC so sánh theo số (100000 trước 9000)', async () => {
      const categoryId = await createCategory('Đồ uống');
      await createProduct(categoryId, 'P_SMALL', 'Hàng 9000', '9000');
      await createProduct(categoryId, 'P_BIG', 'Hàng 100000', '100000');

      expect(names((await guestGet('/products?sort=PRICE_DESC').expect(200)).body)).toEqual(['Hàng 100000', 'Hàng 9000']);
    });

    it('US-35-TC06: mặc định sắp NAME_ASC', async () => {
      const categoryId = await createCategory('Đồ uống');
      await createProduct(categoryId, 'P_C', 'Cam', '1000');
      await createProduct(categoryId, 'P_A', 'Bơ', '1000');
      await createProduct(categoryId, 'P_B', 'Chanh', '1000');

      expect(names((await guestGet('/products').expect(200)).body)).toEqual(['Bơ', 'Cam', 'Chanh']);
    });

    it('US-35-TC06: giá bằng nhau thì tie-break id ASC, phân trang không trùng không sót', async () => {
      const categoryId = await createCategory('Đồ uống');
      const ids: string[] = [];
      for (let index = 1; index <= 5; index++) ids.push(await createProduct(categoryId, `SAME_${index}`, `Hàng cùng giá ${6 - index}`, '50000'));
      const expected = [...ids].sort();   // ObjectId dạng hex: sắp chuỗi = sắp id

      const page1 = (await guestGet('/products?sort=PRICE_ASC&limit=2&page=1').expect(200)).body;
      const page2 = (await guestGet('/products?sort=PRICE_ASC&limit=2&page=2').expect(200)).body;
      const page3 = (await guestGet('/products?sort=PRICE_ASC&limit=2&page=3').expect(200)).body;

      expect(page1).toMatchObject({ page: 1, limit: 2, total: 5, totalPages: 3 });
      const seen = [...page1.items, ...page2.items, ...page3.items].map((item: { id: string }) => item.id);
      expect(seen).toEqual(expected);
    });

    it('US-35-TC06: limit=100 hợp lệ; trang vượt quá trả items rỗng', async () => {
      const categoryId = await createCategory('Đồ uống');
      await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');

      expect((await guestGet('/products?limit=100').expect(200)).body).toMatchObject({ limit: 100, total: 1 });
      expect((await guestGet('/products?page=5').expect(200)).body).toMatchObject({ items: [], page: 5, total: 1, totalPages: 1 });
    });
  });

  describe('US-35-TC07: filter sai trả 400', () => {
    it('US-35-TC07: minPrice > maxPrice trả 400', async () => {
      const response = await guestGet('/products?minPrice=50000&maxPrice=10000').expect(400);
      expect(response.body).not.toHaveProperty('items');
      expect(response.body.error.code).toEqual(expect.any(String));
    });

    it.each(['1e3', '1.5', '1,000', '1.000', '-1', 'abc', '1000000000000'])('US-35-TC07: minPrice/maxPrice không phải chuỗi VND hợp lệ (%s) trả 400', async (value) => {
      await guestGet(`/products?minPrice=${encodeURIComponent(value)}`).expect(400);
      await guestGet(`/products?maxPrice=${encodeURIComponent(value)}`).expect(400);
    });

    it('US-35-TC07: q dài quá 120 ký tự trả 400, đúng 120 ký tự vẫn hợp lệ', async () => {
      await guestGet(`/products?q=${'a'.repeat(121)}`).expect(400);
      await guestGet(`/products?q=${'a'.repeat(120)}`).expect(200);
      await guestGet(`/categories?q=${'a'.repeat(121)}`).expect(400);
    });

    it('US-35-TC07: ObjectId sai cú pháp ở detail và categoryId trả 400', async () => {
      await guestGet('/products/khong-phai-id').expect(400);
      await guestGet('/products?categoryId=bad').expect(400);
    });

    it('US-35-TC07: sort ngoài NAME_ASC/PRICE_ASC/PRICE_DESC trả 400', async () => {
      await guestGet('/products?sort=price').expect(400);
      await guestGet('/products?sort=createdAt').expect(400);
    });

    it('US-35-TC07: page/limit sai (limit>100, page=0, page lẻ) trả 400', async () => {
      await guestGet('/products?limit=101').expect(400);
      await guestGet('/products?limit=0').expect(400);
      await guestGet('/products?page=0').expect(400);
      await guestGet('/products?page=1.5').expect(400);
      await guestGet('/categories?limit=101').expect(400);
    });
  });

  // ================= Bước 2: tồn kho công khai (US-35-F03) =================

  // Đặt tồn kho của sản phẩm (inventory do US-34 tạo sẵn khi tạo sản phẩm, on_hand = reserved = 0).
  async function setStock(productId: string, onHand: number, reserved: number) {
    await connection.db!.collection('inventory').updateOne({ product_id: new ObjectId(productId) },
      { $set: { on_hand: new Int32(onHand), reserved: new Int32(reserved) } });
  }
  // Dữ liệu lỗi: sản phẩm không có bản ghi inventory.
  async function removeInventory(productId: string) {
    await connection.db!.collection('inventory').deleteOne({ product_id: new ObjectId(productId) });
  }
  const availabilityOf = (body: { items: Array<{ name: string; availability: string }> }) =>
    Object.fromEntries(body.items.map(item => [item.name, item.availability]));

  describe('US-35-TC03: hàng hết tồn và hàng thiếu inventory', () => {
    it('US-35-TC03: hàng tồn 0 vẫn hiện trong list với OUT_OF_STOCK, detail vẫn 200', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'EMPTY_01', 'Hàng hết', '9000');
      await setStock(productId, 0, 0);

      const list = await guestGet('/products').expect(200);
      expect(availabilityOf(list.body)).toEqual({ 'Hàng hết': 'OUT_OF_STOCK' });

      const detail = await guestGet(`/products/${productId}`).expect(200);
      expect(detail.body.availability).toBe('OUT_OF_STOCK');
    });

    it('US-35-TC03: hàng còn tồn trả IN_STOCK', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'HAVE_01', 'Hàng còn', '9000');
      await setStock(productId, 3, 0);

      expect((await guestGet(`/products/${productId}`).expect(200)).body.availability).toBe('IN_STOCK');
    });

    it('US-35-TC03: hàng thiếu inventory trả UNAVAILABLE ở list và detail, không giả định còn hàng', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'BROKEN_01', 'Hàng lỗi dữ liệu', '9000');
      await removeInventory(productId);

      const list = await guestGet('/products').expect(200);
      expect(availabilityOf(list.body)).toEqual({ 'Hàng lỗi dữ liệu': 'UNAVAILABLE' });

      const detail = await guestGet(`/products/${productId}`).expect(200);
      expect(detail.body.availability).toBe('UNAVAILABLE');
    });
  });

  describe('US-35-TC04: response công khai không lộ dữ liệu kho/nội bộ', () => {
    it('US-35-TC04: list và detail không trả tồn số chính xác, giá vốn hay audit', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'SECRET_01', 'Hàng kiểm riêng tư', '9000');
      // Số tồn dễ nhận ra để kiểm không lọt ra ngoài: on_hand 4321, reserved 1234 → còn 3087.
      await setStock(productId, 4321, 1234);
      // Field "mồi": nếu code trả nguyên document inventory thì giá vốn 777777 sẽ lộ ra.
      await connection.db!.collection('inventory').updateOne({ product_id: new ObjectId(productId) },
        { $set: { unit_cost: Decimal128.fromString('777777') } });

      const list = await guestGet('/products').expect(200);
      const detail = await guestGet(`/products/${productId}`).expect(200);

      for (const body of [list.body.items[0], detail.body]) {
        expect(body.availability).toBe('IN_STOCK');
        for (const key of Object.keys(body)) expect(PRODUCT_FIELDS).toContain(key);
        // Bỏ id/asOf/category.id trước khi dò số, vì chuỗi hex/thời gian có thể tình cờ chứa "1234".
        const { id: _id, asOf: _asOf, category: _category, ...rest } = body;
        const text = JSON.stringify(rest);
        expect(text).not.toMatch(/onHand|on_hand|reserved|quantityAvailable|available"|unitCost|unit_cost|guard_revision|created_by|updated_by|movement|receipt/i);
        expect(text).not.toMatch(/4321|1234|3087|777777/);
      }
    });

    it('US-35-TC04: mô tả và ảnh HTTPS trả nguyên văn dạng text, không có field nội bộ kèm theo', async () => {
      const categoryId = await createCategory('Đồ uống');
      const created = await adminPost('products', { categoryId, sku: 'IMG_01', name: 'Hàng có ảnh', price: '9000', status: 'ACTIVE',
        description: '<b>Đậm</b> & ngon', imageUrl: 'https://example.test/a.png' }).expect(201);

      const detail = await guestGet(`/products/${created.body.id}`).expect(200);

      expect(detail.body).toMatchObject({ description: '<b>Đậm</b> & ngon', imageUrl: 'https://example.test/a.png' });
      for (const key of Object.keys(detail.body)) expect(PRODUCT_FIELDS).toContain(key);
    });
  });

  describe('US-35-TC05: lọc theo tình trạng kho', () => {
    async function seedThreeStates() {
      const categoryId = await createCategory('Đồ uống');
      const have = await createProduct(categoryId, 'S_HAVE', 'Còn hàng', '1000');
      const empty = await createProduct(categoryId, 'S_EMPTY', 'Hết hàng', '1000');
      const broken = await createProduct(categoryId, 'S_BROKEN', 'Thiếu kho', '1000');
      await setStock(have, 2, 0);
      await setStock(empty, 0, 0);
      await removeInventory(broken);
    }

    it('US-35-TC05: availability=IN_STOCK chỉ trả hàng còn, không nhận bản UNAVAILABLE', async () => {
      await seedThreeStates();
      const response = await guestGet('/products?availability=IN_STOCK').expect(200);
      expect(names(response.body)).toEqual(['Còn hàng']);
      expect(response.body.total).toBe(1);
    });

    it('US-35-TC05: availability=OUT_OF_STOCK chỉ trả hàng hết, không nhận bản UNAVAILABLE', async () => {
      await seedThreeStates();
      const response = await guestGet('/products?availability=OUT_OF_STOCK').expect(200);
      expect(names(response.body)).toEqual(['Hết hàng']);
      expect(response.body.total).toBe(1);
    });

    it('US-35-TC05: không gửi availability thì trả cả ba trạng thái', async () => {
      await seedThreeStates();
      const response = await guestGet('/products').expect(200);
      expect(availabilityOf(response.body)).toEqual({ 'Còn hàng': 'IN_STOCK', 'Hết hàng': 'OUT_OF_STOCK', 'Thiếu kho': 'UNAVAILABLE' });
    });

    it('US-35-TC05: availability kết hợp AND với khoảng giá', async () => {
      const categoryId = await createCategory('Đồ uống');
      const cheap = await createProduct(categoryId, 'A_CHEAP', 'Rẻ còn hàng', '1000');
      const pricey = await createProduct(categoryId, 'A_PRICEY', 'Đắt còn hàng', '90000');
      const cheapEmpty = await createProduct(categoryId, 'A_EMPTY', 'Rẻ hết hàng', '1000');
      await setStock(cheap, 1, 0); await setStock(pricey, 1, 0); await setStock(cheapEmpty, 0, 0);

      const response = await guestGet('/products?availability=IN_STOCK&maxPrice=5000').expect(200);
      expect(names(response.body)).toEqual(['Rẻ còn hàng']);
    });
  });

  describe('US-35-TC07: giá trị availability sai trả 400', () => {
    it.each(['UNAVAILABLE', 'in_stock', 'ALL', ''])('US-35-TC07: availability=%s trả 400', async (value) => {
      await guestGet(`/products?availability=${encodeURIComponent(value)}`).expect(400);
    });
  });

  describe('US-35-TC08: tình trạng tính theo onHand − reserved', () => {
    it('US-35-TC08: reserved bằng onHand thì OUT_OF_STOCK dù onHand > 0', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'RES_01', 'Hàng đã giữ hết', '9000');
      await setStock(productId, 5, 5);

      expect((await guestGet(`/products/${productId}`).expect(200)).body.availability).toBe('OUT_OF_STOCK');
      expect(names((await guestGet('/products?availability=OUT_OF_STOCK').expect(200)).body)).toEqual(['Hàng đã giữ hết']);
      expect((await guestGet('/products?availability=IN_STOCK').expect(200)).body.items).toEqual([]);
    });

    it('US-35-TC08: reserved tăng nhưng onHand giữ nguyên, còn 1 thì vẫn IN_STOCK, hết thì đổi sang OUT_OF_STOCK', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'RES_02', 'Hàng đang được giữ', '9000');

      await setStock(productId, 5, 4);
      expect((await guestGet(`/products/${productId}`).expect(200)).body.availability).toBe('IN_STOCK');

      await setStock(productId, 5, 5);
      expect((await guestGet(`/products/${productId}`).expect(200)).body.availability).toBe('OUT_OF_STOCK');
    });
  });

  // ================= Bước 4: đọc thuần và thay đổi sau khi đã xem (US-35-F04) =================

  // Chụp toàn bộ dữ liệu (trừ phiên đăng nhập) thành chuỗi để so sánh trước/sau.
  async function snapshotDatabase(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const collection of await connection.db!.collections()) {
      if (collection.collectionName === 'auth_sessions') continue;
      const rows = await collection.find({}).sort({ _id: 1 }).toArray();
      result[collection.collectionName] = JSON.stringify(rows);
    }
    return result;
  }
  // Admin sửa sản phẩm (US-34) với version hiện tại.
  async function patchProduct(productId: string, body: object) {
    await http().patch(`/api/admin/products/${productId}`).set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', randomUUID()).send(body).expect(200);
  }

  describe('US-35-TC09: GET không tạo tác động kinh doanh', () => {
    it('US-35-TC09: GET lặp và nhiều người xem cùng lúc không đổi bất kỳ dữ liệu nào (không cart/order/reserved/payment/movement)', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');
      await setStock(productId, 10, 2);
      const before = await snapshotDatabase();

      // 10 Guest + 10 Member xem list, detail và danh mục song song
      const calls = Array.from({ length: 10 }, () => [
        guestGet('/products'), guestGet(`/products/${productId}`), guestGet('/categories'),
        memberGet('/products?availability=IN_STOCK'), memberGet(`/products/${productId}`),
      ]).flat();
      for (const response of await Promise.all(calls)) expect(response.status).toBe(200);

      expect(await snapshotDatabase()).toEqual(before);
    });

    it('US-35-TC09: GET detail của sản phẩm bị ẩn hoặc id sai cũng không ghi dữ liệu', async () => {
      const categoryId = await createCategory('Đồ uống');
      const hiddenId = await createProduct(categoryId, 'HIDE_01', 'Hàng ngừng bán', '1000', 'INACTIVE');
      const before = await snapshotDatabase();

      await guestGet(`/products/${hiddenId}`).expect(404);
      await guestGet('/products/khong-phai-id').expect(400);
      await guestGet('/products?status=INACTIVE').expect(400);

      expect(await snapshotDatabase()).toEqual(before);
    });
  });

  describe('US-35-TC10: catalog/tồn đổi sau khi đã xem', () => {
    it('US-35-TC10: Admin đổi giá sau khi Guest đã xem list → detail và list trả giá mới, version mới', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');
      expect((await guestGet('/products').expect(200)).body.items[0]).toMatchObject({ price: '9000', version: 0 });

      await patchProduct(productId, { version: 0, price: '12000' });

      expect((await guestGet(`/products/${productId}`).expect(200)).body).toMatchObject({ price: '12000', version: 1 });
      expect((await guestGet('/products').expect(200)).body.items[0]).toMatchObject({ price: '12000', version: 1 });
    });

    it('US-35-TC10: Admin ngừng sản phẩm sau khi đã xem list → detail 404 PRODUCT_NOT_AVAILABLE, list không còn', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');
      expect(names((await guestGet('/products').expect(200)).body)).toEqual(['Nước suối']);

      await patchProduct(productId, { version: 0, status: 'INACTIVE' });

      expect((await guestGet(`/products/${productId}`).expect(404)).body.error.code).toBe('PRODUCT_NOT_AVAILABLE');
      expect((await guestGet('/products').expect(200)).body.items).toEqual([]);
    });

    it('US-35-TC10: Admin ngừng danh mục sau khi đã xem detail → detail 404, danh mục biến khỏi /categories', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');
      await guestGet(`/products/${productId}`).expect(200);

      await stopCategory(categoryId);

      expect((await guestGet(`/products/${productId}`).expect(404)).body.error.code).toBe('PRODUCT_NOT_AVAILABLE');
      expect((await guestGet('/categories').expect(200)).body.items).toEqual([]);
    });

    it('US-35-TC10: tồn bị giữ hết sau khi đã xem → lần xem sau đổi sang OUT_OF_STOCK, không giữ trạng thái cũ', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');
      await setStock(productId, 3, 0);
      expect((await guestGet(`/products/${productId}`).expect(200)).body.availability).toBe('IN_STOCK');

      await setStock(productId, 3, 3);

      expect((await guestGet(`/products/${productId}`).expect(200)).body.availability).toBe('OUT_OF_STOCK');
      expect((await guestGet('/products?availability=IN_STOCK').expect(200)).body.items).toEqual([]);
    });

    it('US-35-TC10: asOf của lần xem sau không sớm hơn lần xem trước', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');

      const first = (await guestGet(`/products/${productId}`).expect(200)).body.asOf as string;
      const second = (await guestGet(`/products/${productId}`).expect(200)).body.asOf as string;

      expect(Date.parse(second)).toBeGreaterThanOrEqual(Date.parse(first));
    });

    it('US-35-TC10: GET public trả Cache-Control no-store để không dùng bản cũ sau khi Admin sửa', async () => {
      const categoryId = await createCategory('Đồ uống');
      const productId = await createProduct(categoryId, 'WATER_01', 'Nước suối', '9000');

      for (const path of ['/products', `/products/${productId}`, '/categories']) {
        expect((await guestGet(path).expect(200)).headers['cache-control']).toContain('no-store');
      }
    });
  });

  describe('US-35-TC06: sắp giá theo số ở biên lớn', () => {
    it('US-35-TC06: giá tới 999999999999 vẫn sắp đúng theo số (PRICE_ASC và PRICE_DESC)', async () => {
      const categoryId = await createCategory('Đồ uống');
      await createProduct(categoryId, 'P_MAX', 'Giá tối đa', '999999999999');
      await createProduct(categoryId, 'P_9', 'Giá 9', '9');
      await createProduct(categoryId, 'P_BIG', 'Giá trăm tỷ', '100000000000');
      await createProduct(categoryId, 'P_10', 'Giá 10', '10');

      expect(names((await guestGet('/products?sort=PRICE_ASC').expect(200)).body)).toEqual(['Giá 9', 'Giá 10', 'Giá trăm tỷ', 'Giá tối đa']);
      expect(names((await guestGet('/products?sort=PRICE_DESC').expect(200)).body)).toEqual(['Giá tối đa', 'Giá trăm tỷ', 'Giá 10', 'Giá 9']);
      // Giá vẫn là chuỗi chính xác, không bị làm tròn qua kiểu số
      const max = (await guestGet('/products?minPrice=999999999999').expect(200)).body.items;
      expect(max.map((item: { price: string }) => item.price)).toEqual(['999999999999']);
    });
  });
});
