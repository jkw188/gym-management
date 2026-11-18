// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật, 2 instance ứng dụng): US-20 bước 4.
// Làm chắc: quầy/self cùng UPGRADE_V1, chuỗi credit, quote qua nửa đêm, quota/lịch PT, gửi lại/tranh chấp, rollback, hủy cạnh tranh thu
// (TC05, TC07, TC08, TC10, TC11, TC12).
import { ClientSession, MongoServerError } from 'mongodb';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { toVndDecimal } from '../src/common/utils/vnd-money';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import { Plan } from '../src/modules/plans/schemas/plan.schema';
import { UpgradeBookingsAdapter } from '../src/modules/sales/upgrade-bookings.adapter';
import { origin, startUs18App, stopUs18App, seedUs18World, us18Api, Us18App, Us18World } from './helpers/us18-fixture';

// Không có hợp đồng mới: chỉ dùng API đã chốt ở bước 1–3 và của US-16/US-18/US-22. Instance B dùng chung database để kiểm khóa thật.
// Dữ liệu: 2026-11-01 quầy bán GYM30 300000đ (2026-11-01 → 2026-11-30), Staff thu. Ngày 2026-11-16 (10:00 giờ VN) còn 15/30 ngày:
// rawCredit 150000; gói đích GYM_VIP 600000đ → phải thu 450000; quoteExpiresAt = 2026-11-16T17:00:00Z (00:00 17/11 giờ VN).
// Gói PT: PT30 300000đ 10 buổi, used 3; đích PT_VIP 600000đ 12 buổi; kỳ mới nếu thu hôm 16/11: 2026-11-16 → 2026-12-15.

type Source = { saleId: string; transactionId: string; membershipId: string };
const TODAY = new Date('2026-11-16T03:00:00Z');

describe('US-20 bước 4: parity, chuỗi credit, quote, quota/lịch PT, tranh chấp và rollback', () => {
  let started: Us18App;
  let world: Us18World;
  let source: Source;
  let targetPlanId: string;
  const api = us18Api(() => world);
  const oid = (id: string) => new Types.ObjectId(id);

  beforeAll(async () => {
    started = await startUs18App('gym_management_test_us20_hardening', {}, 2);
  }, 600000);

  afterAll(async () => stopUs18App(started));

  beforeEach(async () => {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    world = await seedUs18World(started.app, started.connection);
    source = await settledSource(world.memberId);
    targetPlanId = await targetPlan('GYM_VIP', '600000');
    started.setNow(TODAY);
  });

  afterEach(() => jest.restoreAllMocks());

  // instance = 0 là A, 1 là B.
  const server = (instance = 0) => started.apps[instance].getHttpServer();
  const plans = () => world.app.get<Model<Plan>>(getModelToken('Plan'));

  async function settledSource(memberId: string, planId = world.plan._id.toHexString(), amount = '300000'): Promise<Source> {
    const sale = await api.counterSale(api.counterInput({ memberId, planId })).expect(201);
    const settled = await confirm(sale.body.transactionId, amount).expect(200);
    return { saleId: sale.body.saleId, transactionId: sale.body.transactionId, membershipId: settled.body.membershipId };
  }
  async function createPlan(code: string, price: string, kind: 'GYM' | 'PT' = 'GYM', quota = 0) {
    const plan = await plans().create({ code, name: `Gói ${code}`, kind, duration_days: 30, session_quota: quota,
      price: toVndDecimal(price), benefits: `Quyền lợi ${code}`, status: 'ACTIVE', created_by: world.adminId, updated_by: world.adminId });
    return plan._id.toHexString();
  }
  // Gói đích + cạnh policy ACTIVE từ fromPlanId (API Admin US-12).
  async function targetPlan(code: string, price: string, kind: 'GYM' | 'PT' = 'GYM', quota = 0, fromPlanId = world.plan._id.toHexString()) {
    const planId = await createPlan(code, price, kind, quota);
    await request(server()).post('/api/admin/plan-policies').set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.ADMIN}`).set('Idempotency-Key', randomUUID())
      .send({ fromPlanId, toPlanId: planId, status: 'ACTIVE' }).expect(201);
    return planId;
  }
  const patchPlan = (planId: string, body: Record<string, unknown>) => request(server()).patch(`/api/admin/plans/${planId}`)
    .set('Origin', origin).set('Authorization', `Bearer ${world.tokens.ADMIN}`).send(body).expect(200);

  const selfInput = (extra: Record<string, unknown> = {}) => ({ sourceMembershipId: source.membershipId, sourceVersion: 0,
    targetPlanId, targetPlanVersion: 0, policyVersion: 0, preferredPaymentMethod: 'CASH', ...extra });
  const counterInput = (extra: Record<string, unknown> = {}) => ({ memberId: world.memberId, sourceMembershipId: source.membershipId,
    sourceVersion: 0, targetPlanId, targetPlanVersion: 0, policyVersion: 0, ...extra });
  const upgrade = (body: Record<string, unknown> = selfInput(), key: string = randomUUID(), instance = 0, token = world.tokens.member) =>
    request(server(instance)).post('/api/me/service-upgrades').set('Origin', origin)
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
  const previewSelf = (body: Record<string, unknown> = selfInput()) =>
    request(server()).post('/api/me/service-upgrades/preview').set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.member}`).set('Idempotency-Key', randomUUID()).send(body);
  const counter = (path: string, body: Record<string, unknown>, instance = 0) =>
    request(server(instance)).post(`/api/service-upgrades${path}`).set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.STAFF}`).set('Idempotency-Key', randomUUID()).send(body);
  function confirm(transactionId: string, amount = '450000', instance = 0) {
    return request(server(instance)).post(`/api/transactions/${transactionId}/confirm-payment`).set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.STAFF}`).set('Idempotency-Key', randomUUID())
      .send({ method: 'CASH', amount, evidenceNote: 'Đã đếm đủ tiền mặt thực nhận' });
  }
  const cancelSelf = (saleId: string, version = 0, instance = 0) =>
    request(server(instance)).post(`/api/me/service-sales/${saleId}/cancel`).set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.member}`).set('Idempotency-Key', randomUUID())
      .send({ version, reason: 'Muốn đổi kế hoạch nâng cấp' });
  const countUpgrades = () => world.connection.collection('service_sales').countDocuments({ operation: 'UPGRADE' });
  const pendingCount = () => world.connection.collection('transactions').countDocuments({ status: 'PENDING' });
  const sourceMembership = () => api.findById('memberships', source.membershipId);
  async function assertStillPending(sale: { saleId: string; transactionId: string }) {
    expect((await api.findById('transactions', sale.transactionId))!.status).toBe('PENDING');
    expect(await world.connection.collection('memberships').countDocuments({ service_sale_id: oid(sale.saleId) })).toBe(0);
    expect(await world.connection.collection('payments').countDocuments({ transaction_id: oid(sale.transactionId) })).toBe(0);
  }

  // ---------- Dữ liệu PT ----------
  // Nguồn PT30 (10 buổi, used 3) của memberId; đích PT_VIP 600000đ với quota targetQuota.
  async function ptSource(targetQuota = 12) {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    const ptPlanId = await createPlan('PT30', '300000', 'PT', 10);
    source = await settledSource(world.memberId, ptPlanId);
    await world.connection.collection('memberships').updateOne({ _id: oid(source.membershipId) }, { $set: { sessions_used: 3 } });
    if (targetQuota < 10) await patchPlan(ptPlanId, { version: 0, sessionsQuota: 1 }); // US-12: quota đích không thấp hơn nguồn.
    targetPlanId = await targetPlan('PT_VIP', '600000', 'PT', targetQuota, ptPlanId);
    started.setNow(TODAY);
  }
  async function booking(status: 'BOOKED' | 'COMPLETED' | 'CANCELLED' = 'BOOKED', start = new Date('2026-11-17T03:00:00Z')) {
    const trainerId = new Types.ObjectId(), shiftId = new Types.ObjectId(), id = new Types.ObjectId();
    const end = new Date(start.getTime() + 3600000), now = new Date();
    await world.connection.collection('trainers').insertOne({ _id: trainerId, id: trainerId, account_id: new Types.ObjectId(),
      specialty: 'PT', status: 'ACTIVE', version: 0 });
    await world.connection.collection('work_shifts').insertOne({ _id: shiftId, id: shiftId, trainer_id: trainerId, start_at: start,
      end_at: end, status: 'CONFIRMED', location: 'Phòng PT', version: 1, created_by: world.adminId, updated_by: world.adminId,
      created_at: now, updated_at: now, confirmed_at: now });
    await world.connection.model('PtBooking').create({ _id: id, id, member_id: oid(world.memberId), membership_id: oid(source.membershipId),
      trainer_id: trainerId, shift_id: shiftId, start_at: start, end_at: end, status, request_key: randomBytes(32).toString('hex'),
      version: 0, created_at: now, trainer_name_snapshot: 'PT thử nghiệm', location_snapshot: 'Phòng PT',
      completion_revision: status === 'COMPLETED' ? 1 : 0,
      ...(status === 'COMPLETED' ? { completed_at: end, completed_by: world.adminId, completed_actor_type: 'TRAINER',
        completion_membership_id: oid(source.membershipId) } : {}) });
    return id.toHexString();
  }
  const readBooking = (id: string) => world.connection.collection('pt_bookings').findOne({ _id: oid(id) });

  // ---------------- TC05: quầy và self cùng UPGRADE_V1 ----------------
  it('US-20-TC05: preview self của A và preview quầy cho cùng hồ sơ trả giống hệt nhau', async () => {
    const fromSelf = await previewSelf().expect(200);
    const fromCounter = await counter('/preview', counterInput()).expect(200);
    expect(fromSelf.body).toEqual(fromCounter.body);
  });

  it('US-20-TC05: đề nghị self của A và đề nghị quầy của B (cùng gói, cùng kỳ) có cùng credit/phải thu/ngày và snapshot UPGRADE_V1', async () => {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    const other = await settledSource(world.otherMemberId);
    started.setNow(TODAY);
    const self = await upgrade().expect(201);
    const quay = await counter('', counterInput({ memberId: world.otherMemberId, sourceMembershipId: other.membershipId })).expect(201);
    const fields = ['operation', 'amountDue', 'creditAmount', 'quote', 'transactionStatus'];
    // quote chứa id kỳ nguồn của từng hội viên (khác nhau là đúng), nên bỏ hai field đó khi so sánh.
    const pick = (body: Record<string, unknown>) => {
      const picked = Object.fromEntries(fields.map(field => [field, body[field]]));
      const { previousSaleId: _sale, sourceMembershipId: _membership, ...terms } = picked.quote as Record<string, unknown>;
      return { ...picked, quote: terms };
    };
    expect(pick(self.body)).toEqual(pick(quay.body));
    expect(self.body.channel).toBe('SELF_SERVICE');
    expect(quay.body.channel).not.toBe('SELF_SERVICE');
    const [selfSale, counterSale] = await Promise.all([api.findById('service_sales', self.body.saleId), api.findById('service_sales', quay.body.saleId)]);
    // policy_snapshot có id kỳ nguồn riêng của từng hội viên: chỉ so quy tắc và các con số của báo giá.
    const snapshotTerms = (raw: string) => {
      const parsed = JSON.parse(raw) as { rule: string; quote: Record<string, unknown> };
      const { previousSaleId: _sale, sourceMembershipId: _membership, ...quote } = parsed.quote;
      return { rule: parsed.rule, quote };
    };
    expect(snapshotTerms(selfSale!.policy_snapshot).rule).toBe('UPGRADE_V1');
    expect(snapshotTerms(selfSale!.policy_snapshot)).toEqual(snapshotTerms(counterSale!.policy_snapshot));
    for (const field of ['valuation_date', 'quote_expires_at', 'raw_credit_snapshot', 'excess_credit_snapshot', 'credit_amount']) {
      expect(String(selfSale![field])).toBe(String(counterSale![field]));
    }
  });

  it('US-20-TC05: credit có phần lẻ .5 VND → self và quầy cùng làm tròn half-up (300015 × 15/30 = 150007,5 → 150008)', async () => {
    // Dùng hội viên khác: hội viên chính đã có kỳ GYM 01/11–30/11 nên quầy không bán thêm kỳ GYM trùng ngày.
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    const oddPlanId = await createPlan('GYM_ODD', '300015');
    source = await settledSource(world.otherMemberId, oddPlanId, '300015');
    targetPlanId = await targetPlan('ODD_VIP', '600000', 'GYM', 0, oddPlanId);
    started.setNow(TODAY);
    const fromSelf = await request(server()).post('/api/me/service-upgrades/preview').set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.otherMember}`).send(selfInput()).expect(200);
    const fromCounter = await counter('/preview', counterInput({ memberId: world.otherMemberId })).expect(200);
    expect(fromSelf.body).toMatchObject({ baseValue: '300015', rawCredit: '150008', appliedCredit: '150008', amountDue: '449992' });
    expect(fromSelf.body).toEqual(fromCounter.body);
  });

  it('US-20-TC05: chuỗi credit – nâng cấp tiếp từ gói đã dùng credit lấy base = tiền thu + credit đã áp dụng, không cộng phần dư', async () => {
    // Lần 1 (self, nhánh 0): hạ giá niêm yết GYM30 xuống 100000 để có cạnh tới GYM_LITE 200000; nâng cấp ngay 01/11:
    // raw 300000 → applied 200000, excess 100000 (bị loại), phải thu 0.
    await patchPlan(world.plan._id.toHexString(), { version: 0, price: '100000' });
    const liteId = await targetPlan('GYM_LITE', '200000');
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    const first = await upgrade(selfInput({ targetPlanId: liteId })).expect(201);
    expect(first.body).toMatchObject({ transactionStatus: 'SETTLED', amountDue: '0', creditAmount: '200000' });

    // Lần 2 (self): từ gói GYM_LITE mới sang GYM_NEXT 800000, cùng ngày → còn 30/30; base phải là 0 + 200000.
    const nextId = await targetPlan('GYM_NEXT', '800000', 'GYM', 0, liteId);
    const next = await previewSelf(selfInput({ sourceMembershipId: first.body.membershipId, targetPlanId: nextId })).expect(200);
    expect(next.body).toMatchObject({ baseValue: '200000', rawCredit: '200000', appliedCredit: '200000', amountDue: '600000' });
  });

  // ---------------- TC07: quote qua 00:00 VN hoặc nguồn bị thay ----------------
  it('US-20-TC07: đúng 00:00 VN ngày kế tiếp (17:00Z) Staff mới thu → 409 QUOTE_EXPIRED, vẫn PENDING, gói cũ giữ, số phải thu không đổi', async () => {
    const created = await upgrade().expect(201);
    started.setNow(new Date('2026-11-16T17:00:00.000Z'));
    expect((await confirm(created.body.transactionId).expect(409)).body.error.code).toBe('QUOTE_EXPIRED');
    await assertStillPending(created.body);
    expect(await sourceMembership()).toMatchObject({ status: 'ACTIVE' });
    const own = await request(server()).get(`/api/me/service-sales/${created.body.saleId}`)
      .set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
    expect(own.body.amountDue).toBe('450000');
  });

  it('US-20-TC07: 1 ms trước 00:00 VN (16:59:59.999Z) Staff thu → 200, chuyển gói', async () => {
    const created = await upgrade().expect(201);
    started.setNow(new Date('2026-11-16T16:59:59.999Z'));
    await confirm(created.body.transactionId).expect(200);
    expect(await sourceMembership()).toMatchObject({ status: 'SUPERSEDED' });
  });

  it('US-20-TC07: quote hết hạn → Member hủy đề nghị cũ rồi xem báo giá mới theo ngày mới (không sửa tiền đề nghị cũ)', async () => {
    const created = await upgrade().expect(201);
    started.setNow(new Date('2026-11-17T03:00:00Z'));
    await confirm(created.body.transactionId).expect(409);
    await cancelSelf(created.body.saleId).expect(200);
    expect((await api.findById('transactions', created.body.transactionId))!.amount_due.toString()).toBe('450000');
    // Còn 14/30 ngày → raw 140000 → phải thu 460000.
    const fresh = await previewSelf().expect(200);
    expect(fresh.body).toMatchObject({ remainingDays: 14, rawCredit: '140000', amountDue: '460000', asOfDate: '2026-11-17' });
  });

  // US-16: sourceVersion chỉ để phát hiện form cũ lúc tạo; lúc thu thì kiểm lại nguồn còn ACTIVE, chưa bị chuyển/hủy.
  // Sinh viên chốt 2026-11-18 (spec bản 1.2): nguồn bị hủy/thay lúc thu → SOURCE_CHANGED hoặc SOURCE_NOT_CURRENT của US-16.
  it('US-20-TC07: nguồn bị hủy sau khi tạo đề nghị → Staff thu 409 SOURCE_CHANGED/SOURCE_NOT_CURRENT, không chuyển gói', async () => {
    const created = await upgrade().expect(201);
    await world.connection.collection('memberships').updateOne({ _id: oid(source.membershipId) }, { $set: { status: 'CANCELLED' }, $inc: { version: 1 } });
    expect(['SOURCE_CHANGED', 'SOURCE_NOT_CURRENT']).toContain((await confirm(created.body.transactionId).expect(409)).body.error.code);
    await assertStillPending(created.body);
  });

  // ---------------- TC08: quota/lịch PT ----------------
  it('US-20-TC08: PT used 3 + BOOKED 2, đích 4 buổi → preview canProceed=false QUOTA_INSUFFICIENT, tạo 409, không hủy buổi', async () => {
    await ptSource(4);
    const first = await booking(), second = await booking('BOOKED', new Date('2026-11-18T03:00:00Z'));
    const preview = await previewSelf().expect(200);
    expect(preview.body).toMatchObject({ canProceed: false, blockingCode: 'QUOTA_INSUFFICIENT', quotaSummary: { used: 3, reserved: 2 } });
    expect((await upgrade().expect(409)).body.error.code).toBe('QUOTA_INSUFFICIENT');
    expect((await readBooking(first))!.status).toBe('BOOKED');
    expect((await readBooking(second))!.status).toBe('BOOKED');
    expect(await countUpgrades()).toBe(0);
  });

  it('US-20-TC08: đề nghị tạo khi còn đủ quota, sau đó thêm BOOKED làm thiếu → Staff thu 409 QUOTA_INSUFFICIENT, vẫn PENDING', async () => {
    await ptSource(4);
    const created = await upgrade().expect(201);
    await booking(); await booking('BOOKED', new Date('2026-11-18T03:00:00Z'));
    expect((await confirm(created.body.transactionId).expect(409)).body.error.code).toBe('QUOTA_INSUFFICIENT');
    await assertStillPending(created.body);
  });

  it.each([
    ['đang diễn ra', () => new Date(TODAY.getTime() - 30 * 60000)],
    ['ngoài kỳ mới', () => new Date('2027-01-01T03:00:00Z')],
  ])('US-20-TC08: có BOOKED %s → 409 BOOKING_CONFLICT, buổi vẫn BOOKED và thuộc gói cũ', async (_case, startOf) => {
    await ptSource();
    const id = await booking('BOOKED', startOf());
    const before = await readBooking(id);
    expect((await upgrade().expect(409)).body.error.code).toBe('BOOKING_CONFLICT');
    expect(await readBooking(id)).toEqual(before);
  });

  it('US-20-TC08: đủ quota, BOOKED trong kỳ mới → sau khi thu: used 3 mang sang, chỉ BOOKED chuyển gói, COMPLETED/CANCELLED giữ nguyên', async () => {
    await ptSource();
    const booked = await booking(), completed = await booking('COMPLETED', new Date('2026-11-10T03:00:00Z'));
    const cancelled = await booking('CANCELLED', new Date('2026-11-12T03:00:00Z'));
    const [bookedBefore, completedBefore, cancelledBefore] = await Promise.all([readBooking(booked), readBooking(completed), readBooking(cancelled)]);
    const created = await upgrade().expect(201);
    // Trước khi thu: gói cũ và buổi đã đặt không đổi.
    expect(await readBooking(booked)).toEqual(bookedBefore);
    const settled = await confirm(created.body.transactionId).expect(200);

    expect((await api.findById('memberships', settled.body.membershipId))!.sessions_used).toBe(3);
    const moved = await readBooking(booked);
    expect(moved!.membership_id.toHexString()).toBe(settled.body.membershipId);
    expect(moved).toMatchObject({ status: 'BOOKED', trainer_id: bookedBefore!.trainer_id, shift_id: bookedBefore!.shift_id,
      start_at: bookedBefore!.start_at });
    expect(await readBooking(completed)).toEqual(completedBefore);
    expect(await readBooking(cancelled)).toEqual(cancelledBefore);

    const own = await request(server()).get('/api/me/memberships?kind=PT').set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
    const fresh = (own.body.items as { id: string; sessionsUsed: number; sessionsQuota: number }[]).find(item => item.id === settled.body.membershipId)!;
    expect(fresh).toMatchObject({ sessionsUsed: 3, sessionsQuota: 12 });
  });

  // ---------------- TC10: gửi lại, hai kênh, đồng thời ----------------
  it('US-20-TC10: đã commit nhưng mất response → tra cứu operation và gửi lại cùng key ra đúng kết quả, chỉ một đề nghị', async () => {
    const original = ClientSession.prototype.commitTransaction;
    const lost = new MongoServerError({ message: 'injected lost reply' });
    lost.addErrorLabel('UnknownTransactionCommitResult');
    jest.spyOn(ClientSession.prototype, 'commitTransaction').mockImplementation(async function (this: ClientSession, ...args) {
      await original.apply(this, args);
      throw lost;
    });
    const key = randomUUID();
    expect((await upgrade(selfInput(), key)).status).toBeGreaterThanOrEqual(500);
    jest.restoreAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const lookup = await request(server()).get(`/api/operations/SALE_UPGRADE/${key}`)
      .set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
    const replay = await upgrade(selfInput(), key).expect(201);
    expect(replay.body).toEqual(lookup.body.responseBody);
    expect(await countUpgrades()).toBe(1);
  }, 30000);

  it('US-20-TC10: gửi lại cùng key sau khi giá gói đích đổi → kết quả cũ với số phải thu cũ, không tạo đề nghị mới', async () => {
    const key = randomUUID();
    const first = await upgrade(selfInput(), key).expect(201);
    await world.connection.collection('plans').updateOne({ _id: oid(targetPlanId) }, { $set: { price: toVndDecimal('900000') }, $inc: { version: 1 } });
    const replay = await upgrade(selfInput(), key).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.body.amountDue).toBe('450000');
    expect(await countUpgrades()).toBe(1);
  });

  it('US-20-TC10: cùng key gửi đồng thời trên hai instance → một đề nghị, hai response giống nhau', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([upgrade(selfInput(), key, 0), upgrade(selfInput(), key, 1)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body).toEqual(a.body);
    expect(await countUpgrades()).toBe(1);
    expect(await pendingCount()).toBe(1);
  });

  it('US-20-TC10: quầy ở A và Member ở B cùng tạo đề nghị (khác key) → chỉ một PENDING', async () => {
    const results = await Promise.all([counter('', counterInput(), 0), upgrade(selfInput(), randomUUID(), 1)]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    expect(results.find(row => row.status === 409)!.body.error.code).toBe('PENDING_SALE_EXISTS');
    expect(await countUpgrades()).toBe(1);
    expect(await pendingCount()).toBe(1);
  });

  it('US-20-TC10: Member tự nâng cấp (A) và tự gia hạn (B) cùng lúc → chỉ một PENDING cùng loại GYM', async () => {
    const renew = request(server(1)).post('/api/me/service-renewals').set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.member}`).set('Idempotency-Key', randomUUID())
      .send({ previousSaleId: source.saleId, planVersion: 0, preferredPaymentMethod: 'CASH' });
    const results = await Promise.all([upgrade(selfInput(), randomUUID(), 0), renew]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    expect(results.find(row => row.status === 409)!.body.error.code).toBe('PENDING_SALE_EXISTS');
    expect(await pendingCount()).toBe(1);
  });

  it('US-20-TC10: hai Staff xác nhận thu cùng đề nghị ở hai instance → một payment, một gói mới, nguồn thay đúng một lần', async () => {
    const created = await upgrade().expect(201);
    const results = await Promise.all([confirm(created.body.transactionId, '450000', 0), confirm(created.body.transactionId, '450000', 1)]);
    expect(results.map(row => row.status).sort()).toEqual([200, 409]);
    expect(await world.connection.collection('payments').countDocuments({ transaction_id: oid(created.body.transactionId) })).toBe(1);
    expect(await world.connection.collection('memberships').countDocuments({ service_sale_id: oid(created.body.saleId) })).toBe(1);
    expect(await sourceMembership()).toMatchObject({ status: 'SUPERSEDED', version: 1 });
  });

  it('US-20-TC10: Staff tra cứu operation SALE_UPGRADE theo key của Member → 404; Member khác trùng key tạo đề nghị riêng', async () => {
    const key = randomUUID();
    const mine = await upgrade(selfInput(), key).expect(201);
    await request(server()).get(`/api/operations/SALE_UPGRADE/${key}`).set('Authorization', `Bearer ${world.tokens.STAFF}`).expect(404);
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    const other = await settledSource(world.otherMemberId);
    started.setNow(TODAY);
    const theirs = await upgrade(selfInput({ sourceMembershipId: other.membershipId }), key, 0, world.tokens.otherMember).expect(201);
    expect(theirs.body.saleId).not.toBe(mine.body.saleId);
    expect((await api.findById('service_sales', theirs.body.saleId))!.member_id.toHexString()).toBe(world.otherMemberId);
  });

  // ---------------- TC11: confirm lỗi giữa chừng → rollback như quầy ----------------
  it.each(['booking', 'outbox'] as const)('US-20-TC11: thu đề nghị self lỗi sau khi ghi %s → rollback thu/gói/lịch, thu lại được', async stage => {
    await ptSource();
    const bookingId = await booking();
    const created = await upgrade().expect(201);
    const membershipBefore = await sourceMembership(), bookingBefore = await readBooking(bookingId);
    if (stage === 'booking') {
      const adapter = started.apps[0].get(UpgradeBookingsAdapter), original = adapter.moveWithinSession.bind(adapter);
      jest.spyOn(adapter, 'moveWithinSession').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('Injected booking failure after write');
      });
    } else {
      jest.spyOn(started.apps[0].get(NotificationsRepository), 'insertOutbox').mockRejectedValueOnce(new Error('Injected outbox failure'));
    }
    expect((await confirm(created.body.transactionId)).status).toBeGreaterThanOrEqual(500);
    await assertStillPending(created.body);
    expect(await world.connection.collection('invoices').countDocuments({ transaction_id: oid(created.body.transactionId) })).toBe(0);
    expect(await sourceMembership()).toEqual(membershipBefore);
    expect(await readBooking(bookingId)).toEqual(bookingBefore);
    await confirm(created.body.transactionId).expect(200);
  });

  // ---------------- TC12: hủy cạnh tranh thu ----------------
  it('US-20-TC12: Member hủy ở A, Staff thu ở B cùng lúc → một kết quả cuối, dữ liệu khớp', async () => {
    const created = await upgrade().expect(201);
    const [cancelled, confirmed] = await Promise.all([cancelSelf(created.body.saleId, 0, 0), confirm(created.body.transactionId, '450000', 1)]);
    expect([cancelled.status, confirmed.status].sort()).toEqual([200, 409]);
    const transaction = await api.findById('transactions', created.body.transactionId);
    const payments = await world.connection.collection('payments').countDocuments({ transaction_id: oid(created.body.transactionId) });
    const memberships = await world.connection.collection('memberships').countDocuments({ service_sale_id: oid(created.body.saleId) });
    const sourceStatus = (await sourceMembership())!.status;
    if (cancelled.status === 200) expect([transaction!.status, payments, memberships, sourceStatus]).toEqual(['CANCELLED', 0, 0, 'ACTIVE']);
    else expect([transaction!.status, payments, memberships, sourceStatus]).toEqual(['SETTLED', 1, 1, 'SUPERSEDED']);
  });

  it('US-20-TC12: đã hủy thì Staff thu → 409; đã thu thì Member hủy → 409, không refund, lịch sử giữ nguyên', async () => {
    const first = await upgrade().expect(201);
    await cancelSelf(first.body.saleId).expect(200);
    await confirm(first.body.transactionId, '450000', 1).expect(409);
    expect(await world.connection.collection('payments').countDocuments({ transaction_id: oid(first.body.transactionId) })).toBe(0);
    expect(await sourceMembership()).toMatchObject({ status: 'ACTIVE' });

    const second = await upgrade().expect(201);
    await confirm(second.body.transactionId).expect(200);
    const late = await cancelSelf(second.body.saleId, 1, 1).expect(409);
    expect(late.body.error.code).toBe('INVALID_TRANSACTION_STATE');
    expect(await world.connection.collection('refunds').countDocuments()).toBe(0);
    expect(await api.findById('service_sales', first.body.saleId)).not.toBeNull();
  });
});
