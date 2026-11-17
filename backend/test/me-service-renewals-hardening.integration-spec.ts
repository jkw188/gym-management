// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật, 2 instance ứng dụng): US-19 bước 4.
// Làm chắc: quầy/self cùng kết quả, RENEW_V1, quota PT không chuyển, gửi lại khi mất response, tranh chấp tạo/thu/hủy (TC05–TC07, TC09–TC11).
import { ClientSession, MongoServerError } from 'mongodb';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { toVndDecimal } from '../src/common/utils/vnd-money';
import { Plan } from '../src/modules/plans/schemas/plan.schema';
import { origin, startUs18App, stopUs18App, seedUs18World, us18Api, Us18App, Us18World } from './helpers/us18-fixture';

// Không có hợp đồng mới: chỉ dùng các API đã chốt ở bước 1–3 và của US-15/US-18/US-22.
// Kỳ nguồn GYM30 300000đ bán tại quầy 2026-11-01 → 2026-11-30 rồi đã thu. Instance B dùng chung database để kiểm khóa thật.

type Source = { saleId: string; transactionId: string; membershipId: string };

describe('US-19 bước 4: parity, RENEW_V1, quota PT, gửi lại và tranh chấp', () => {
  let started: Us18App;
  let world: Us18World;
  let source: Source;
  const api = us18Api(() => world);
  const oid = (id: string) => new Types.ObjectId(id);

  beforeAll(async () => {
    started = await startUs18App('gym_management_test_us19_hardening', {}, 2);
  }, 600000);

  afterAll(async () => stopUs18App(started));

  beforeEach(async () => {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    world = await seedUs18World(started.app, started.connection);
    source = await settledSource(world.memberId);
  });

  afterEach(() => jest.restoreAllMocks());

  // instance = 0 là A, 1 là B.
  const server = (instance = 0) => started.apps[instance].getHttpServer();

  async function settledSource(memberId: string, planId = world.plan._id.toHexString()): Promise<Source> {
    const sale = await api.counterSale(api.counterInput({ memberId, planId })).expect(201);
    const settled = await api.confirmCash(sale.body.transactionId).expect(200);
    return { saleId: sale.body.saleId, transactionId: sale.body.transactionId, membershipId: settled.body.membershipId };
  }
  const selfInput = (extra: Record<string, unknown> = {}) => ({ previousSaleId: source.saleId, planVersion: 0,
    preferredPaymentMethod: 'CASH', ...extra });
  const renew = (body: Record<string, unknown> = selfInput(), key: string = randomUUID(), instance = 0, token = world.tokens.member) =>
    request(server(instance)).post('/api/me/service-renewals').set('Origin', origin)
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
  const previewSelf = (body: Record<string, unknown> = selfInput()) =>
    request(server()).post('/api/me/service-renewals/preview').set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.member}`).send(body);
  const counterRenew = (body: Record<string, unknown>, instance = 0) =>
    request(server(instance)).post('/api/service-renewals').set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.STAFF}`).set('Idempotency-Key', randomUUID()).send(body);
  const confirm = (transactionId: string, instance = 0) =>
    request(server(instance)).post(`/api/transactions/${transactionId}/confirm-payment`).set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.STAFF}`).set('Idempotency-Key', randomUUID())
      .send({ method: 'CASH', amount: '300000', evidenceNote: 'Đã đếm đủ tiền mặt thực nhận' });
  const cancelSelf = (saleId: string, instance = 0) =>
    request(server(instance)).post(`/api/me/service-sales/${saleId}/cancel`).set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.member}`).set('Idempotency-Key', randomUUID())
      .send({ version: 0, reason: 'Muốn đổi kế hoạch gia hạn' });
  const countRenewals = () => world.connection.collection('service_sales').countDocuments({ operation: 'RENEW' });
  const pendingCount = () => world.connection.collection('transactions').countDocuments({ status: 'PENDING' });
  // Đặt lại kỳ của sale nguồn (30 ngày, ngày cuối inclusive) để thử còn hạn/hết hạn.
  async function sourcePeriod(start: string, end: string) {
    await world.connection.collection('service_sales').updateOne({ _id: oid(source.saleId) }, { $set: { start_date: start, end_date: end } });
  }

  // ---------------- TC05: quầy và self cùng kết quả ----------------
  it('US-19-TC05: kỳ self của hội viên A và kỳ quầy của hội viên B (cùng gói, cùng kỳ nguồn) có cùng giá, thời hạn, ngày và RENEW_V1', async () => {
    const other = await settledSource(world.otherMemberId);
    const self = await renew().expect(201);
    const counter = await counterRenew({ memberId: world.otherMemberId, previousSaleId: other.saleId, planVersion: 0 }).expect(201);
    const fields = ['operation', 'amountDue', 'creditAmount', 'durationDays', 'startDate', 'endDate', 'benefits', 'sessions', 'transactionStatus'];
    const pick = (body: Record<string, unknown>) => Object.fromEntries(fields.filter(field => field in counter.body).map(field => [field, body[field]]));
    expect(pick(self.body)).toEqual(pick(counter.body));
    expect(JSON.parse(self.body.policySnapshot).rule).toBe('RENEW_V1');
    expect(self.body.channel).toBe('SELF_SERVICE');
    expect(counter.body.channel).toBe('COUNTER');
  });

  // ---------------- TC06: RENEW_V1 ----------------
  it.each([
    ['còn hạn: nối ngày sau ngày cuối nguồn', '2026-11-01', '2026-11-30', '2026-11-01T03:00:00Z', '2026-12-01', '2026-12-30'],
    ['ngày cuối nguồn đúng hôm nay: vẫn nối ngày mai', '2026-10-03', '2026-11-01', '2026-11-01T03:00:00Z', '2026-11-02', '2026-12-01'],
    ['nửa đêm giờ VN (17:00Z) đã sang ngày mới: nguồn hết hạn hôm qua', '2026-10-03', '2026-11-01', '2026-11-01T17:00:00Z', '2026-11-02', '2026-12-01'],
    ['đã hết hạn: tính từ ngày thu', '2026-09-21', '2026-10-20', '2026-11-01T03:00:00Z', '2026-11-01', '2026-11-30'],
  ])('US-19-TC06: %s', async (_case, start, end, now, expectedStart, expectedEnd) => {
    await sourcePeriod(start, end);
    started.setNow(new Date(now));
    const before = await api.findById('service_sales', source.saleId);
    const renewal = await renew().expect(201);
    const settled = await confirm(renewal.body.transactionId).expect(200);
    expect(settled.body).toMatchObject({ startDate: expectedStart, endDate: expectedEnd });
    expect(await api.findById('service_sales', source.saleId)).toEqual(before);
  });

  it('US-19-TC06: nguồn đã hết hạn, Staff thu trễ sau preview → kỳ mới chốt theo ngày thu, không theo ngày preview', async () => {
    await sourcePeriod('2026-09-21', '2026-10-20');
    expect((await previewSelf().expect(200)).body.expectedStartDate).toBe('2026-11-01');
    const renewal = await renew().expect(201);
    started.setNow(new Date('2026-11-05T03:00:00Z'));
    const settled = await confirm(renewal.body.transactionId).expect(200);
    expect(settled.body).toMatchObject({ startDate: '2026-11-05', endDate: '2026-12-04' });
    expect((await api.findById('service_sales', source.saleId))!.end_date).toBe('2026-10-20');
  });

  // ---------------- TC07: quota PT không chuyển ----------------
  it('US-19-TC07: nguồn PT còn buổi dư và có buổi BOOKED → kỳ mới used=0, buổi đã đặt và kỳ nguồn giữ nguyên', async () => {
    const pt = await world.app.get<Model<Plan>>(getModelToken('Plan')).create({ code: 'PT30', name: 'PT 30 ngày', kind: 'PT',
      duration_days: 30, session_quota: 10, price: toVndDecimal('300000'), benefits: '10 buổi PT', status: 'ACTIVE',
      created_by: world.adminId, updated_by: world.adminId });
    const ptSource = await settledSource(world.memberId, pt._id.toHexString());
    await world.connection.collection('memberships').updateOne({ _id: oid(ptSource.membershipId) }, { $set: { sessions_used: 3 } });
    const bookingId = new Types.ObjectId();
    await world.connection.collection('pt_bookings').insertOne({ _id: bookingId, id: bookingId, membership_id: oid(ptSource.membershipId),
      member_id: oid(world.memberId), trainer_id: new Types.ObjectId(), shift_id: new Types.ObjectId(),
      start_at: new Date('2026-11-16T03:00:00Z'), end_at: new Date('2026-11-16T04:00:00Z'), status: 'BOOKED',
      request_key: randomBytes(32).toString('hex'), created_at: new Date(), version: 0 });
    const booking = await world.connection.collection('pt_bookings').findOne({ _id: bookingId });
    const oldSale = await api.findById('service_sales', ptSource.saleId);
    const oldMembership = await api.findById('memberships', ptSource.membershipId);
    // Gói PT đổi quota sau lúc mua: kỳ mới theo quota mới.
    await world.connection.collection('plans').updateOne({ _id: pt._id }, { $set: { session_quota: 12 }, $inc: { version: 1 } });

    const renewal = await renew(selfInput({ previousSaleId: ptSource.saleId, planVersion: 1 })).expect(201);
    const settled = await confirm(renewal.body.transactionId).expect(200);
    expect((await api.findById('memberships', settled.body.membershipId))!.sessions_used).toBe(0);
    expect(await api.findById('service_sales', ptSource.saleId)).toEqual(oldSale);
    expect(await api.findById('memberships', ptSource.membershipId)).toEqual(oldMembership);
    expect(await world.connection.collection('pt_bookings').findOne({ _id: bookingId })).toEqual(booking);

    const own = await request(server()).get('/api/me/memberships?kind=PT').set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
    const items = own.body.items as { id: string; sessionsUsed: number; sessionsQuota: number }[];
    expect(items.find(item => item.id === ptSource.membershipId)!.sessionsUsed).toBe(3);
    const fresh = items.find(item => item.id === settled.body.membershipId)!;
    expect(fresh.sessionsUsed).toBe(0);
    expect(fresh.sessionsQuota).toBe(12);
  });

  // ---------------- TC09: gửi lại khi mất response, chủ sở hữu ----------------
  it('US-19-TC09: đã commit nhưng mất response → tra cứu operation và gửi lại cùng key ra đúng kết quả, chỉ một kỳ', async () => {
    const original = ClientSession.prototype.commitTransaction;
    const lost = new MongoServerError({ message: 'injected lost reply' });
    lost.addErrorLabel('UnknownTransactionCommitResult');
    jest.spyOn(ClientSession.prototype, 'commitTransaction').mockImplementation(async function (this: ClientSession, ...args) {
      await original.apply(this, args);
      throw lost;
    });
    const key = randomUUID();
    const failed = await renew(selfInput(), key);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    jest.restoreAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const lookup = await request(server()).get(`/api/operations/SALE_RENEW/${key}`)
      .set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
    const replay = await renew(selfInput(), key).expect(201);
    expect(replay.body).toEqual(lookup.body.responseBody);
    expect(await countRenewals()).toBe(1);
  }, 30000);

  it('US-19-TC09: gửi lại cùng key sau khi giá gói đổi → vẫn kết quả cũ với giá cũ, không tạo kỳ mới', async () => {
    const key = randomUUID();
    const first = await renew(selfInput(), key).expect(201);
    await world.connection.collection('plans').updateOne({ _id: world.plan._id }, { $set: { price: toVndDecimal('500000') }, $inc: { version: 1 } });
    const replay = await renew(selfInput(), key).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.body.amountDue).toBe('300000');
    expect(await countRenewals()).toBe(1);
  });

  it('US-19-TC09: cùng key gửi đồng thời trên hai instance → một kỳ, hai response giống nhau', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([renew(selfInput(), key, 0), renew(selfInput(), key, 1)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body).toEqual(a.body);
    expect(await countRenewals()).toBe(1);
    expect(await pendingCount()).toBe(1);
  });

  it('US-19-TC09: Member khác dùng trùng key → tạo kỳ riêng từ nguồn của họ, không nhận kết quả của người kia', async () => {
    const other = await settledSource(world.otherMemberId);
    const key = randomUUID();
    const mine = await renew(selfInput(), key).expect(201);
    const theirs = await renew(selfInput({ previousSaleId: other.saleId }), key, 0, world.tokens.otherMember).expect(201);
    expect(theirs.body.saleId).not.toBe(mine.body.saleId);
    expect((await api.findById('service_sales', theirs.body.saleId))!.member_id.toHexString()).toBe(world.otherMemberId);
  });

  it('US-19-TC09: Staff tra cứu operation SALE_RENEW theo key của Member → 404, không lộ kết quả', async () => {
    const key = randomUUID();
    await renew(selfInput(), key).expect(201);
    const response = await request(server()).get(`/api/operations/SALE_RENEW/${key}`)
      .set('Authorization', `Bearer ${world.tokens.STAFF}`).expect(404);
    expect(JSON.stringify(response.body)).not.toContain('saleId');
  });

  // ---------------- TC10: tranh chấp tạo/thu ----------------
  it('US-19-TC10: quầy ở A và Member ở B cùng tạo kỳ gia hạn (khác key) → chỉ một PENDING', async () => {
    const results = await Promise.all([
      counterRenew({ memberId: world.memberId, previousSaleId: source.saleId, planVersion: 0 }, 0),
      renew(selfInput(), randomUUID(), 1),
    ]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    expect(results.find(row => row.status === 409)!.body.error.code).toBe('PENDING_SALE_EXISTS');
    expect(await countRenewals()).toBe(1);
    expect(await pendingCount()).toBe(1);
  });

  it('US-19-TC10: Member gửi hai yêu cầu gia hạn khác key ở hai instance → một PENDING', async () => {
    const results = await Promise.all([renew(selfInput(), randomUUID(), 0), renew(selfInput(), randomUUID(), 1)]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    expect(await countRenewals()).toBe(1);
    expect(await pendingCount()).toBe(1);
  });

  it('US-19-TC10: nguồn đã hết hạn, Member tự đăng ký mới (A) và tự gia hạn (B) cùng lúc → chỉ một PENDING cùng loại', async () => {
    await sourcePeriod('2026-09-21', '2026-10-20');
    const register = request(server(0)).post('/api/me/service-registrations').set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.member}`).set('Idempotency-Key', randomUUID()).send(api.selfInput());
    const results = await Promise.all([register, renew(selfInput(), randomUUID(), 1)]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    expect(results.find(row => row.status === 409)!.body.error.code).toBe('PENDING_SALE_EXISTS');
    expect(await pendingCount()).toBe(1);
  });

  it('US-19-TC10: hai Staff xác nhận thu cùng kỳ gia hạn ở hai instance → một payment, một membership', async () => {
    const renewal = await renew().expect(201);
    const results = await Promise.all([confirm(renewal.body.transactionId, 0), confirm(renewal.body.transactionId, 1)]);
    expect(results.map(row => row.status).sort()).toEqual([200, 409]);
    expect(await world.connection.collection('payments').countDocuments({ transaction_id: oid(renewal.body.transactionId) })).toBe(1);
    expect(await world.connection.collection('memberships').countDocuments({ service_sale_id: oid(renewal.body.saleId) })).toBe(1);
  });

  // ---------------- TC11: hủy cạnh tranh thu ----------------
  it('US-19-TC11: Member hủy ở A, Staff thu ở B cùng lúc → một kết quả cuối, dữ liệu khớp', async () => {
    const renewal = await renew().expect(201);
    const [cancelled, confirmed] = await Promise.all([cancelSelf(renewal.body.saleId, 0), confirm(renewal.body.transactionId, 1)]);
    expect([cancelled.status, confirmed.status].sort()).toEqual([200, 409]);
    const transaction = await api.findById('transactions', renewal.body.transactionId);
    const payments = await world.connection.collection('payments').countDocuments({ transaction_id: oid(renewal.body.transactionId) });
    const memberships = await world.connection.collection('memberships').countDocuments({ service_sale_id: oid(renewal.body.saleId) });
    if (cancelled.status === 200) expect([transaction!.status, payments, memberships]).toEqual(['CANCELLED', 0, 0]);
    else expect([transaction!.status, payments, memberships]).toEqual(['SETTLED', 1, 1]);
  });

  it('US-19-TC11: đã hủy thì Staff thu → 409; đã thu thì Member hủy → 409; kỳ nguồn không đổi', async () => {
    const before = await api.findById('service_sales', source.saleId);
    const first = await renew().expect(201);
    await cancelSelf(first.body.saleId).expect(200);
    await confirm(first.body.transactionId, 1).expect(409);
    expect(await world.connection.collection('payments').countDocuments({ transaction_id: oid(first.body.transactionId) })).toBe(0);

    const second = await renew().expect(201);
    await confirm(second.body.transactionId).expect(200);
    const late = await request(server(1)).post(`/api/me/service-sales/${second.body.saleId}/cancel`).set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.member}`).set('Idempotency-Key', randomUUID())
      .send({ version: 1, reason: 'Muốn đổi kế hoạch gia hạn' }).expect(409);
    expect(late.body.error.code).toBe('INVALID_TRANSACTION_STATE');
    expect(await api.findById('service_sales', source.saleId)).toEqual(before);
  });
});
