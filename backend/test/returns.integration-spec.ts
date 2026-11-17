import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Int32, Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { ensureReturnsIntegrity } from '../src/modules/returns/returns-migration';
import { ensureRefundsIntegrity } from '../src/modules/refunds/refunds-migration';
import { ApplicationError } from '../src/common/errors/application-error';
import { configureHttp } from '../src/common/http/configure-http';
import { PasswordService } from '../src/common/security/password.service';
import { ServerClock } from '../src/common/utils/business-date';
import { ensureFinancialIntegrity } from '../src/infrastructure/transaction/financial-integrity';
import { ensureRetailCatalogIntegrity } from '../src/modules/catalog/retail-catalog.migration';
import { UsersRepository } from '../src/modules/users/users.repository';
import { ACCOUNT_ADMINISTRATION } from '../src/modules/users/schemas/security-state.schema';
import { En06Process as AppProcess } from './helpers/en06-fixture';
import { COLLECTIONS } from './helpers/en06-oracle';

const NOW = '2035-11-14T17:00:00.000Z', origin = 'http://localhost:5173';
type Actor = { id: string; token: string };
type Intent = { memberId?: string; buyerName?: string; recipientPhone?: string; preferredPaymentMethod: string; items: { productId: string; quantity: number }[]; quoteToken?: string };
describe('US-46 returns and payout: real POS writers, replica set and two processes', () => {
  const saved = { ...process.env }, clock = new ServerClock(); let now = NOW, sequence = 0;
  let mongo: MongoMemoryReplSet, app: INestApplication, connection: Connection, staff: Actor, admin: Actor, member: Actor, trainer: Actor;
  const children: AppProcess[] = [];
  const db = () => connection.db!, http = () => request(app.getHttpServer());
  clock.now = () => new Date(now);
  const post = (path: string, body: object, key: string = randomUUID(), actor = staff, child?: number) =>
    (child === undefined ? http() : request(children[child].url)).post(`/api${path}`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send(body);
  const get = (path: string, actor = staff) => http().get(`/api${path}`).set('Authorization', `Bearer ${actor.token}`);
  const cash = (amount = '25000') => ({ method: 'CASH', amount, evidenceNote: 'Đã đếm đủ tiền mặt thực nhận tại quầy' });
  const fulfill = (id: string, version: number, key: string = randomUUID()) => post(`/pos/orders/${id}/fulfill`, { version }, key);
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), MONGODB_DB: `gym_test_us46_${randomBytes(4).toString('hex')}`,
      EN06_NOW: NOW, FRONTEND_ORIGIN: origin, JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RETAIL_QUOTE_SECRET: randomBytes(32).toString('base64url'),
      PICKUP_LOCATION: 'Quầy kiểm thử US46', PAYOUT_ACCOUNTS: '["GYM_PAYOUT"]', RECEIVING_ACCOUNTS: '["GYM_MAIN"]', RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '' });
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false }); configureHttp(app); await app.init();
    connection = app.get(getConnectionToken()); await Promise.all(Object.values(connection.models).map(model => model.init()));
    await ensureFinancialIntegrity(connection); await ensureRetailCatalogIntegrity(connection);
    await db().collection<{ _id: string; revision: Long }>('security_state').insertOne({ _id: ACCOUNT_ADMINISTRATION, revision: Long.ZERO });
    for (let i = 0; i < 2; i++) { const child = new AppProcess(); children.push(child); await child.start(); }
    expect(new Set(children.map(child => child.child.pid)).size).toBe(2);
    staff = await login('STAFF'); admin = await login('ADMIN'); member = await login('MEMBER'); trainer = await login('TRAINER');
  }, 600000);
  beforeEach(async () => {
    now = NOW; jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const child of children) { await child.rpc('clear'); await child.rpc('clock', NOW); }
    for (const name of [...COLLECTIONS, 'returns', 'return_items', 'refund_attempts', 'members', 'categories', 'catalog_events', 'notification_counters', 'cart_states', 'cart_items']) await db().collection(name).deleteMany({});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { for (const child of children) await child.close(); await app?.close(); await mongo?.stop(); process.env = saved; });
  async function login(code: 'STAFF' | 'ADMIN' | 'MEMBER' | 'TRAINER') {
    const users = app.get(UsersRepository), role = await users.ensureRole(code, code), password = 'US46 integration password 123';
    const account = await users.createAccount({ roleId: String(role.id), fullName: `US46 ${code}`, phone: `095300${String(++sequence).padStart(4, '0')}`,
      passwordHash: await app.get(PasswordService).hash(password) });
    const result = await http().post('/api/auth/login').set('Origin', origin).send({ phone: account.phone, password }).expect(200);
    return { id: String(account._id), token: result.body.accessToken as string };
  }
  async function catalog(price = '25000', stock = 3, count = 1): Promise<Intent> {
    const category = await post('/admin/categories', { name: `US46 ${++sequence}`, status: 'ACTIVE' }, randomUUID(), admin).expect(201);
    const items = [];
    for (let i = 0; i < count; i++) {
      const product = await post('/admin/products', { categoryId: category.body.id, sku: `US46_${++sequence}`, name: 'Sản phẩm snapshot', price, status: 'ACTIVE' }, randomUUID(), admin).expect(201);
      items.push({ productId: product.body.id as string, quantity: 1 });
    }
    const receipt = await post('/stock-receipts', { reason: 'Nhập hàng kiểm thử US46, không phải hàng thật', items: items.map(item => ({ productId: item.productId, quantity: stock, unitCost: '1000' })) }).expect(201);
    await post(`/stock-receipts/${receipt.body.id}/post`, { version: 0 }).expect(200);
    return { preferredPaymentMethod: 'CASH', items };
  }
  async function quote(intent: Intent, actor = staff) {
    const result = await post('/pos/orders/preview', intent, randomUUID(), actor).expect(200);
    return { ...intent, quoteToken: result.body.quoteToken as string };
  }
  async function create(intent: Intent) { return (await post('/pos/orders', await quote(intent)).expect(201)).body as { id: string; transactionId: string; version: number; invoiceId?: string }; }
  async function snapshot() {
    const rows: Record<string, unknown[]> = {};
    for (const name of [...COLLECTIONS, 'returns', 'return_items', 'refund_attempts', 'members', 'notification_counters', 'cart_states', 'cart_items']) rows[name] = await db().collection(name).find().sort({ _id: 1 }).toArray();
    return rows;
  }
  async function linkedMember() {
    const existing = await db().collection('members').findOne({ account_id: new ObjectId(member.id) });
    if (existing) return String(existing._id);
    const result = await post('/members', { fullName: 'Hội viên snapshot', phone: `09653${String(++sequence).padStart(5, '0')}` }).expect(201);
    await db().collection('members').updateOne({ _id: new ObjectId(result.body.id) }, { $set: { account_id: new ObjectId(member.id) } });
    return result.body.id as string;
  }
  async function completed(price = '25000', count = 2, quantity = 2, linked = true) {
    let intent = await catalog(price, 10, count);
    intent = { ...intent, items: intent.items.map(item => ({ ...item, quantity })), ...(linked ? { memberId: await linkedMember() } : {}) };
    const row = await create(intent);
    if (price !== '0') await post(`/transactions/${row.transactionId}/confirm-payment`, cash(String(BigInt(price) * BigInt(count * quantity)))).expect(200);
    const order = (await get(`/orders/${row.id}`).expect(200)).body;
    await fulfill(row.id, order.version).expect(200);
    return (await get(`/orders/${row.id}`).expect(200)).body as { id: string; version: number; transactionId: string; items: { id: string; productId: string; quantity: number }[] };
  }
  const receiveBody = (row: Awaited<ReturnType<typeof completed>>, restockable = true, quantity = 1) => ({ version: row.version, reason: 'Tiếp nhận hàng trả theo yêu cầu khách',
    items: row.items.map(item => ({ orderItemId: item.id, quantity, restockable, conditionNote: 'Đã kiểm tra tình trạng sản phẩm thực tế' })) });
  const confirmBody = (amount = '50000', method = 'CASH') => ({ version: 0, method, amount, paidOutAt: now, evidenceNote: 'Đã đối soát thực chi với chứng từ fixture',
    ...(method === 'CASH' ? { cashVoucherReference: `CASH-${randomUUID()}` } : { payoutAccountCode: 'GYM_PAYOUT', bankReference: `BANK-${randomUUID()}` }) });
  async function setTime(value: string) { now = value; for (const child of children) await child.rpc('clock', value); }

  it('TC01/04/06/09: snapshot price, partial returns, damaged stock and outstanding obligations', async () => {
    const row = await completed(), body = receiveBody(row);
    await http().patch(`/api/admin/products/${row.items[0].productId}`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ version: 0, price: '99999' }).expect(200);
    const key = randomUUID(), result = await post(`/orders/${row.id}/returns`, body, key).expect(201);
    expect(result.body).toMatchObject({ amount: '50000', refundState: 'PENDING', orderVersion: row.version + 1 }); expect(result.body.movementIds).toHaveLength(2);
    expect((await post(`/orders/${row.id}/returns`, body, key).expect(201)).body).toEqual(result.body);
    await post(`/orders/${row.id}/returns`, { ...body, reason: 'Khác nội dung phiếu nhận trả' }, key).expect(409);
    const first = await db().collection('inventory').findOne({ product_id: new ObjectId(row.items[0].productId) }); expect(first).toMatchObject({ on_hand: 9, reserved: 0 });
    const failure = { version: 0, failureReason: 'Chứng từ xác nhận chưa chi thành công', evidenceNote: 'Đã xác minh ngân hàng chưa ghi nợ' };
    await post(`/refunds/${result.body.refundId}/fail`, failure).expect(200);
    const second = await post(`/orders/${row.id}/returns`, { ...receiveBody(row, false), version: row.version + 1 }).expect(201);
    expect(second.body.movementIds).toEqual([]);
    await post(`/orders/${row.id}/returns`, { ...body, version: row.version + 2 }).expect(409);
    expect(await db().collection('inventory').findOne({ product_id: new ObjectId(row.items[0].productId) })).toMatchObject({ on_hand: 9, reserved: 0 });
    expect((await get(`/orders/${row.id}`).expect(200)).body.status).toBe('COMPLETED');
    expect((await get(`/returns/${result.body.returnId}`).expect(200)).body).toMatchObject({ refundAmount: '50000', refundedAmount: '0', outstandingRefundAmount: '50000' });
    expect((await get(`/orders/${row.id}/return-eligibility`).expect(200)).body.items.every((item: { remaining: number }) => item.remaining === 0)).toBe(true);
    await ensureReturnsIntegrity(connection); await ensureRefundsIntegrity(connection);
  });
  it('TC02/05: strict DTO, roles, invalid state/items/quantities do not write', async () => {
    const row = await completed(), body = receiveBody(row), before = await snapshot();
    for (const actor of [member, trainer]) { await post(`/orders/${row.id}/returns`, body, randomUUID(), actor).expect(403); await get('/returns', actor).expect(403); await get('/refunds', actor).expect(403); }
    for (const input of [{ ...body, actorId: staff.id }, { ...body, receivedAt: NOW }, { ...body, items: [body.items[0], body.items[0]] },
      { ...body, items: [{ ...body.items[0], orderItemId: String(new ObjectId()) }] }, { ...body, items: [{ ...body.items[0], quantity: '1' }] },
      { ...body, items: [{ ...body.items[0], quantity: 0 }] }, { ...body, items: [{ ...body.items[0], conditionNote: 'short' }] }, { ...body, items: [{ ...body.items[0], restockable: 'true' }] }]) {
      await post(`/orders/${row.id}/returns`, input).expect(400);
    }
    await post(`/orders/${row.id}/returns`, receiveBody(row, true, 3)).expect(409);
    await post(`/orders/${row.id}/returns`, { ...body, version: 999 }).expect(409);
    await post(`/orders/${new ObjectId()}/returns`, body).expect(404);
    expect(await snapshot()).toEqual(before);
    await db().collection('orders').updateOne({ _id: new ObjectId(row.id) }, { $set: { status: 'CANCELLED' } });
    await post(`/orders/${row.id}/returns`, body).expect(409);
  });
  it('TC03/04: D 23:50 VN, D+6 23:59 accepted and D+7 00:00 expired', async () => {
    const row = await completed();
    await db().collection('orders').updateOne({ _id: new ObjectId(row.id) }, { $set: { fulfilled_at: new Date('2035-11-15T23:50:00+07:00') } });
    await setTime('2035-11-21T23:59:59+07:00');
    await post(`/orders/${row.id}/returns`, receiveBody(row)).expect(201);
    await setTime('2035-11-22T00:00:00+07:00');
    const before = await snapshot(); expect((await post(`/orders/${row.id}/returns`, { ...receiveBody(row), version: row.version + 1 }).expect(409)).body.error.code).toBe('RETURN_WINDOW_EXPIRED');
    expect(await snapshot()).toEqual(before);
  });
  it('TC07: zero order accepts return without fake refund/payment, anonymous has empty recipients', async () => {
    const row = await completed('0', 1, 1, false), result = await post(`/orders/${row.id}/returns`, receiveBody(row)).expect(201);
    expect(result.body).toMatchObject({ amount: '0', refundState: 'NONE' }); expect(result.body.refundId).toBeUndefined();
    expect(await db().collection('refunds').countDocuments()).toBe(0); expect(await db().collection('payments').countDocuments()).toBe(0);
    const notification = await db().collection('notifications').findOne({ event_key: `RETURN_RECEIVED:${result.body.returnId}` });
    expect(notification).not.toBeNull(); expect(await db().collection('notification_recipients').countDocuments()).toBe(0);
  });
  it('TC08: faults in movement/refund/audit/outbox/key roll back the entire receipt', async () => {
    const row = await completed(), body = receiveBody(row);
    for (const point of ['movement', 'refund', 'orderAudit', 'recipient', 'outbox', 'operation']) {
      const before = await snapshot(); await children[0].arm(point, 'rollback');
      await post(`/orders/${row.id}/returns`, body, randomUUID(), staff, 0).expect(503); expect(await snapshot()).toEqual(before);
    }
  });
  it('TC11/12/14/15/20: fail then CASH/TRANSFER confirm same refund, evidence, exact amount, terminal replay and cash separation', async () => {
    for (const method of ['CASH', 'TRANSFER']) {
      const row = await completed(), received = await post(`/orders/${row.id}/returns`, receiveBody(row)).expect(201), id = received.body.refundId as string;
      const body = confirmBody('50000', method);
      for (const actor of [member, trainer]) await post(`/refunds/${id}/confirm`, body, randomUUID(), actor).expect(403);
      await post(`/refunds/${id}/confirm`, { ...body, amount: '1' }).expect(409);
      await post(`/refunds/${id}/confirm`, { ...body, paidOutAt: '2099-01-01T00:00:00Z' }).expect(400);
      await post(`/refunds/${id}/confirm`, { ...body, paidOutAt: '2020-01-01T00:00:00Z' }).expect(400);
      await post(`/refunds/${id}/confirm`, { ...body, cashVoucherReference: undefined, bankReference: undefined }).expect(400);
      const failure = { version: 0, failureReason: 'Xác minh chưa thực hiện chi thành công', evidenceNote: 'Đã đối chiếu chứng từ chưa có khoản chi' };
      const failKey = randomUUID(), failed = await post(`/refunds/${id}/fail`, failure, failKey).expect(200);
      expect(failed.body.refundedAt).toBeNull(); expect((await post(`/refunds/${id}/fail`, failure, failKey).expect(200)).body).toEqual(failed.body);
      await setTime('2035-11-16T03:00:00Z'); const input = { ...body, version: 1, paidOutAt: now }, key = randomUUID();
      const beforeStock = await db().collection('inventory').find().sort({ _id: 1 }).toArray();
      const paid = await post(`/refunds/${id}/confirm`, input, key).expect(200);
      expect(paid.body).toMatchObject({ status: 'SUCCEEDED', version: 2, refundedAt: new Date(now).toISOString(), verifiedAt: new Date(now).toISOString() });
      expect((await post(`/refunds/${id}/confirm`, input, key).expect(200)).body).toEqual(paid.body);
      expect((await post(`/refunds/${id}/confirm`, input).expect(409)).body.error.code).toBe('REFUND_ALREADY_SUCCEEDED');
      await post(`/refunds/${id}/fail`, { ...failure, version: 2 }).expect(409);
      expect(await db().collection('refund_attempts').countDocuments({ refund_id: new ObjectId(id) })).toBe(2);
      expect(await db().collection('inventory').find().sort({ _id: 1 }).toArray()).toEqual(beforeStock);
      expect((await get(`/returns/${received.body.returnId}`).expect(200)).body).toMatchObject({ refundAmount: '50000', refundedAmount: '50000', outstandingRefundAmount: '0' });
      const detail = (await get(`/refunds/${id}`).expect(200)).body; expect(detail.attempts).toHaveLength(2); expect(detail.reference).toBe(`RF:${id}`);
      const notification = await db().collection('notifications').findOne({ event_key: `REFUND_SUCCEEDED:${id}` });
      expect(JSON.stringify(notification)).not.toContain(('cashVoucherReference' in input ? input.cashVoucherReference : input.bankReference));
      await setTime(NOW);
    }
  });
  it('TC10: existing cancellation and late receipt obligations pay out without return/movement', async () => {
    const intent = await catalog(), row = await create(intent);
    await post(`/transactions/${row.transactionId}/confirm-payment`, cash()).expect(200);
    const order = (await get(`/orders/${row.id}`).expect(200)).body;
    const cancelled = await post(`/orders/${row.id}/cancel`, { version: order.version, reason: 'Khách yêu cầu hủy đơn trước bàn giao' }).expect(200);
    const before = await db().collection('stock_movements').find().sort({ _id: 1 }).toArray();
    await post(`/refunds/${cancelled.body.refundId}/confirm`, confirmBody('25000')).expect(200);
    expect(await db().collection('returns').countDocuments()).toBe(0); expect(await db().collection('stock_movements').find().sort({ _id: 1 }).toArray()).toEqual(before);
    const lateRow = await create(await catalog());
    await post(`/orders/${lateRow.id}/cancel`, { version: 0, reason: 'Khách yêu cầu hủy khi chưa nhận tiền' }).expect(200);
    const late = await post(`/orders/${lateRow.id}/late-receipts`, { method: 'TRANSFER', amount: '25000', receivingAccountCode: 'GYM_MAIN', bankReference: randomUUID(), receivedAt: now, evidenceNote: 'Khoản tiền đến muộn sau khi đã hủy' }).expect(200);
    await post(`/refunds/${late.body.refundId}/confirm`, confirmBody('25000', 'TRANSFER')).expect(200);
    expect(await db().collection('returns').countDocuments()).toBe(0);
  });
  it('TC13/17: two processes compete for same payout reference and confirm/fail CAS', async () => {
    const a = await completed(), b = await completed();
    const first = (await post(`/orders/${a.id}/returns`, receiveBody(a)).expect(201)).body.refundId;
    const second = (await post(`/orders/${b.id}/returns`, receiveBody(b)).expect(201)).body.refundId;
    const body = { ...confirmBody(), cashVoucherReference: '  duplicated-reference  ' };
    const results = await Promise.all([post(`/refunds/${first}/confirm`, body, randomUUID(), staff, 0), post(`/refunds/${second}/confirm`, { ...body, cashVoucherReference: 'DUPLICATED-REFERENCE' }, randomUUID(), staff, 1)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]); expect(results.find(result => result.status === 409)!.body.error.code).toBe('PAYOUT_REFERENCE_USED');
    const remaining = results[0].status === 409 ? first : second;
    const race = await Promise.all([post(`/refunds/${remaining}/confirm`, confirmBody(), randomUUID(), staff, 0), post(`/refunds/${remaining}/fail`, { version: 0, evidenceNote: 'Đối soát chưa có chứng từ chi', failureReason: 'Chưa chi thành công theo đối soát' }, randomUUID(), staff, 1)]);
    expect(race.map(result => result.status).sort()).toEqual([200, 409]);
  });
  it('TC16/17: two processes return the last unit; lost response resolves original committed IDs', async () => {
    const row = await completed('25000', 1, 1), body = receiveBody(row), keys = [randomUUID(), randomUUID()];
    const results = await Promise.all(keys.map((key, i) => post(`/orders/${row.id}/returns`, body, key, staff, i)));
    expect(results.map(result => result.status).sort()).toEqual([201, 409]); expect(await db().collection('return_items').countDocuments()).toBe(1);
    const other = await completed('25000', 1, 1), key = randomUUID(); await children[0].arm('response');
    await expect(post(`/orders/${other.id}/returns`, receiveBody(other), key, staff, 0)).rejects.toThrow();
    const lookup = await get(`/operations/RETURN_RECEIVE/${key}`).expect(200);
    expect((await post(`/orders/${other.id}/returns`, receiveBody(other), key).expect(201)).body).toEqual(lookup.body.responseBody);
    await get(`/operations/RETURN_RECEIVE/${key}`, member).expect(403);
  });
  it('TC08/18: return and stock issue race keep contiguous ledger; payout faults preserve received goods', async () => {
    const row = await completed('25000', 1, 1), productId = row.items[0].productId;
    const issue = await post('/stock-issues', { reason: 'Xuất hàng kiểm thử cạnh tranh nhận trả', items: [{ productId, quantity: 2, unitCost: '1000' }] }, randomUUID(), admin).expect(201);
    const [received, issued] = await Promise.all([post(`/orders/${row.id}/returns`, receiveBody(row), randomUUID(), staff, 0), post(`/stock-issues/${issue.body.id}/post`, { version: 0 }, randomUUID(), admin, 1)]);
    expect(received.status).toBe(201); expect(issued.status).toBe(200);
    const balance = await db().collection('inventory').findOne({ product_id: new ObjectId(productId) }); expect(balance).toMatchObject({ on_hand: 8, reserved: 0 });
    const ledger = await db().collection('stock_movements').find({ product_id: new ObjectId(productId) }).sort({ sequence: 1 }).toArray();
    expect(ledger.map(row => row.sequence)).toEqual(ledger.map((_, index) => index + 1));
    for (const point of ['recipient', 'outbox', 'operation']) {
      const before = await snapshot(); await children[0].arm(point, 'rollback');
      await post(`/refunds/${received.body.refundId}/confirm`, confirmBody('25000'), randomUUID(), staff, 0).expect(503); expect(await snapshot()).toEqual(before);
    }
    await ensureReturnsIntegrity(connection); await ensureRefundsIntegrity(connection);
  });
  it('TC01/19: WEBSITE delivered snapshot is accepted, read filters validate VN dates and revoked session cannot replay', async () => {
    const row = await completed('25000', 1, 1);
    // US41 WEBSITE checkout is not exposed in this repository. Only channel routing is a fixture;
    // catalog, stock, POS creation, payment, fulfillment, returns and payout use real HTTP writers.
    await db().collection('orders').updateOne({ _id: new ObjectId(row.id) }, { $set: { channel: 'WEBSITE' } });
    const key = randomUUID(), received = await post(`/orders/${row.id}/returns`, receiveBody(row), key).expect(201);
    const list = await get(`/returns?orderId=${row.id}&fromDate=2035-11-15&toDate=2035-11-15`).expect(200);
    expect(list.body).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1, items: [{ channel: 'WEBSITE', id: received.body.returnId }] }); expect(list.body.asOf).toBe(NOW);
    await get('/returns?fromDate=2035-02-30').expect(400); await get('/returns?fromDate=2034-01-01&toDate=2035-11-15').expect(400);
    await get('/returns?ownerId=invalid').expect(400); await get('/refunds?limit=101').expect(400);
    const temp = await login('STAFF'), body = confirmBody('25000'), payoutKey = randomUUID();
    await post(`/refunds/${received.body.refundId}/confirm`, body, payoutKey, temp).expect(200);
    await http().post('/api/auth/logout').set('Origin', origin).set('Authorization', `Bearer ${temp.token}`).send({}).expect(204);
    await post(`/refunds/${received.body.refundId}/confirm`, body, payoutKey, temp).expect(401);
    await get(`/operations/REFUND_CONFIRM/${payoutKey}`, temp).expect(401);
  });
  it('TC06/09: missing inventory or occupied refund budget blocks receipt without partial writes', async () => {
    const row = await completed(), beforeStock = await db().collection('inventory').findOne({ product_id: new ObjectId(row.items[0].productId) });
    await db().collection('inventory').deleteOne({ _id: beforeStock!._id });
    const missing = await snapshot(); await post(`/orders/${row.id}/returns`, receiveBody(row)).expect(409); expect(await snapshot()).toEqual(missing);
    await db().collection('inventory').insertOne({ ...beforeStock!, on_hand: new Int32(beforeStock!.on_hand), reserved: new Int32(beforeStock!.reserved),
      version: new Int32(beforeStock!.version), guard_revision: Long.fromValue(beforeStock!.guard_revision) });
    const payment = await db().collection('payments').findOne({ transaction_id: new ObjectId(row.transactionId) }), refundId = new ObjectId();
    await db().collection('refunds').insertOne({ _id: refundId, id: refundId, order_id: new ObjectId(row.id), payment_id: payment!._id, reason: 'RETURN',
      reference: `RF:${refundId}`, obligation_key: `LEGACY:${refundId}`, amount: payment!.amount, status: 'FAILED', actor_type: 'SYSTEM', created_at: new Date(NOW), version: new Int32(0) });
    const before = await snapshot(); expect((await post(`/orders/${row.id}/returns`, receiveBody(row)).expect(409)).body.error.code).toBe('REFUND_BUDGET_EXCEEDED'); expect(await snapshot()).toEqual(before);
  });
  it('TC08/16: payout attempt fault rolls back money and lost confirm response resolves original payout', async () => {
    const row = await completed('25000', 1, 1), result = await post(`/orders/${row.id}/returns`, receiveBody(row)).expect(201), id = result.body.refundId as string;
    const before = await snapshot();
    jest.spyOn(connection.models.RefundAttempt, 'create').mockRejectedValueOnce(new ApplicationError(503, 'FIXTURE_ROLLBACK', 'Rollback fixture after refund CAS'));
    await post(`/refunds/${id}/confirm`, confirmBody('25000')).expect(503); expect(await snapshot()).toEqual(before); jest.restoreAllMocks();
    const body = confirmBody('25000'), key = randomUUID(); await children[0].arm('response');
    await expect(post(`/refunds/${id}/confirm`, body, key, staff, 0)).rejects.toThrow();
    const lookup = await get(`/operations/REFUND_CONFIRM/${key}`).expect(200);
    expect((await post(`/refunds/${id}/confirm`, body, key).expect(200)).body).toEqual(lookup.body.responseBody);
    expect(await db().collection('refund_attempts').countDocuments({ refund_id: new ObjectId(id) })).toBe(1);
  });
  it('migration backfills only version metadata and blocks a damaged return source', async () => {
    const row = await completed('25000', 1, 1), received = await post(`/orders/${row.id}/returns`, receiveBody(row)).expect(201);
    await db().collection('refunds').updateOne({ _id: new ObjectId(received.body.refundId) }, { $unset: { version: '' } });
    await ensureRefundsIntegrity(connection);
    const refund = await db().collection('refunds').findOne({ _id: new ObjectId(received.body.refundId) }); expect(refund).toMatchObject({ status: 'PENDING', version: 0 }); expect(refund!.refunded_at).toBeUndefined();
    const item = await db().collection('return_items').findOne();
    await db().collection('return_items').updateOne({ _id: item!._id }, { $set: { restockable: false } });
    await expect(ensureReturnsIntegrity(connection)).rejects.toThrow('RETURNS_MOVEMENT_RECONCILIATION_REQUIRED');
  });
  it('TC18: return competes with POS checkout and inventory adjustment using the same writer guards', async () => {
    const row = await completed('25000', 1, 1), productId = row.items[0].productId;
    const intent = await quote({ preferredPaymentMethod: 'CASH', items: [{ productId, quantity: 1 }] });
    const [received, checkout] = await Promise.all([post(`/orders/${row.id}/returns`, receiveBody(row), randomUUID(), staff, 0), post('/pos/orders', intent, randomUUID(), staff, 1)]);
    expect(received.status).toBe(201); expect(checkout.status).toBe(201);
    expect(await db().collection('inventory').findOne({ product_id: new ObjectId(productId) })).toMatchObject({ on_hand: 10, reserved: 1 });
    const other = await completed('25000', 1, 1), otherProduct = other.items[0].productId;
    const balance = await db().collection('inventory').findOne({ product_id: new ObjectId(otherProduct) });
    const adjustment = await post('/stock-adjustments', { reason: 'Kiểm kê hàng và nhận trả cạnh tranh', items: [{ productId: otherProduct, countedQuantity: 8, expectedInventoryVersion: balance!.version, unitCost: '1000' }] }, randomUUID(), admin).expect(201);
    const [returned, adjusted] = await Promise.all([post(`/orders/${other.id}/returns`, receiveBody(other), randomUUID(), staff, 0), post(`/stock-adjustments/${adjustment.body.id}/post`, { version: 0 }, randomUUID(), admin, 1)]);
    expect(returned.status).toBe(201); expect([200, 409]).toContain(adjusted.status);
    expect(await db().collection('inventory').findOne({ product_id: new ObjectId(otherProduct) })).toMatchObject({ on_hand: adjusted.status === 200 ? 9 : 10, reserved: 0 });
    await ensureReturnsIntegrity(connection);
  });
});
