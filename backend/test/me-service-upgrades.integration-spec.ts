// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-20 bước 1.
// Member xem gói đích được phép và xem trước/tạo đề nghị nâng cấp qua /api/me, dùng chung UpgradeService của US-16 (TC01, TC02, TC04, TC05).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Model, Types } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import { Plan } from '../src/modules/plans/schemas/plan.schema';
import { toVndDecimal } from '../src/common/utils/vnd-money';
import { origin, startUs18App, stopUs18App, seedUs18World, us18Api, Us18App, Us18World } from './helpers/us18-fixture';

// Hợp đồng test đặt ra cho Builder (US-20 bước 1, theo mục 1 và 2 của spec):
//   GET  /api/me/memberships/:id/upgrade-options  MEMBER owner
//        -> 200 {items:[{targetPlanId,targetPlanVersion,policyVersion,name,price,durationDays,sessionsQuota}],sourceVersion,asOf}
//        chỉ đích có cạnh policy ACTIVE, gói đích ACTIVE, cùng kind; không có thì items = [].
//   POST /api/me/service-upgrades/preview  MEMBER; {sourceMembershipId,sourceVersion,targetPlanId,targetPlanVersion,policyVersion,
//        preferredPaymentMethod} -> quote giống POST /api/service-upgrades/preview của US-16 cho cùng hồ sơ; không tạo gì.
//   POST /api/me/service-upgrades          MEMBER; Idempotency-Key; cùng input -> 201 SaleResult
//        {operation:'UPGRADE', channel:'SELF_SERVICE', sourceMembershipId, previousSaleId, transactionStatus:'PENDING', ...}.
//   Member lấy từ members.account_id = principal; chưa liên kết -> 409 MEMBER_PROFILE_REQUIRED.
//   Nguồn của người khác hoặc không tồn tại -> 404. Sai role -> 403, không token -> 401.
//   Version/policy đổi sau khi đọc options -> 409 SOURCE_CHANGED / PLAN_CHANGED / POLICY_CHANGED / POLICY_NOT_ALLOWED (US-16).
//   Field thừa (TC03), cách trả dự kiến và khóa SALE_UPGRADE đầy đủ thuộc bước 2.
//
// Dữ liệu: ngày 2026-11-01 (giờ VN) quầy bán GYM30 300000đ, kỳ 2026-11-01 đến 2026-11-30, Staff thu tiền (SETTLED).
// Sau đó đồng hồ chuyển sang 2026-11-16: còn 15/30 ngày (tính cả ngày nâng cấp) -> rawCredit 150000.
// Gói đích GYM_VIP 30 ngày 600000đ có cạnh policy ACTIVE từ GYM30 -> phải thu 600000 - 150000 = 450000.

describe('US-20 bước 1: Member tự nâng cấp qua UpgradeService dùng chung', () => {
  let started: Us18App;
  let world: Us18World;
  const api = us18Api(() => world);
  let source: { saleId: string; transactionId: string; membershipId: string };
  let targetPlanId: string;

  beforeAll(async () => {
    started = await startUs18App('gym_management_test_us20', {});
  }, 600000);

  afterAll(async () => stopUs18App(started));

  beforeEach(async () => {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    world = await seedUs18World(started.app, started.connection);
    source = await settledSource(world.memberId);
    targetPlanId = await targetPlan('GYM_VIP', '600000');
    started.setNow(new Date('2026-11-16T03:00:00Z'));
  });

  afterEach(() => jest.restoreAllMocks());

  const server = () => world.app.getHttpServer();
  const oid = (id: string) => new Types.ObjectId(id);

  // Quầy bán GYM30 cho một hồ sơ rồi Staff xác nhận thu -> membership nguồn ACTIVE, sale SETTLED.
  async function settledSource(memberId: string) {
    const sale = await api.counterSale(api.counterInput({ memberId })).expect(201);
    const settled = await api.confirmCash(sale.body.transactionId).expect(200);
    return { saleId: sale.body.saleId as string, transactionId: sale.body.transactionId as string,
      membershipId: settled.body.membershipId as string };
  }

  // Tạo gói đích (mặc định GYM ACTIVE 30 ngày) và cạnh policy ACTIVE từ GYM30 bằng API Admin của US-12.
  async function targetPlan(code: string, price: string, kind: 'GYM' | 'PT' = 'GYM', quota = 0) {
    const planId = await createPlan(code, price, kind, quota);
    await request(server()).post('/api/admin/plan-policies').set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.ADMIN}`).set('Idempotency-Key', randomUUID())
      .send({ fromPlanId: world.plan._id.toHexString(), toPlanId: planId, status: 'ACTIVE' }).expect(201);
    return planId;
  }

  // Tạo một gói bằng model Mongoose (giống fixture US-18), chưa có cạnh policy.
  async function createPlan(code: string, price: string, kind: 'GYM' | 'PT' = 'GYM', quota = 0) {
    const plan = await world.app.get<Model<Plan>>(getModelToken('Plan')).create({ code, name: `Gói ${code}`, kind, duration_days: 30,
      session_quota: quota, price: toVndDecimal(price), benefits: `Quyền lợi ${code}`, status: 'ACTIVE',
      created_by: world.adminId, updated_by: world.adminId });
    return plan._id.toHexString();
  }

  // Body đúng hợp đồng của Member: không có memberId.
  const selfInput = (extra: Record<string, unknown> = {}) => ({ sourceMembershipId: source.membershipId, sourceVersion: 0,
    targetPlanId, targetPlanVersion: 0, policyVersion: 0, preferredPaymentMethod: 'CASH', ...extra });
  // Body của quầy (US-16) cho cùng hồ sơ, để so sánh hai kênh.
  const counterInput = (extra: Record<string, unknown> = {}) => ({ memberId: world.memberId, sourceMembershipId: source.membershipId,
    sourceVersion: 0, targetPlanId, targetPlanVersion: 0, policyVersion: 0, ...extra });

  const options = (membershipId: string = source.membershipId, token: string = world.tokens.member) =>
    request(server()).get(`/api/me/memberships/${membershipId}/upgrade-options`).set('Authorization', `Bearer ${token}`);
  const self = (path: string, body: Record<string, unknown>, token: string = world.tokens.member, key: string = randomUUID()) =>
    request(server()).post(`/api/me/service-upgrades${path}`).set('Origin', origin)
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
  const counter = (path: string, body: Record<string, unknown>, key: string = randomUUID()) =>
    request(server()).post(`/api/service-upgrades${path}`).set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.STAFF}`).set('Idempotency-Key', key).send(body);
  const countUpgrades = () => world.connection.collection('service_sales').countDocuments({ operation: 'UPGRADE' });
  const sourceMembership = () => api.findById('memberships', source.membershipId);

  // ---------------- TC01 ----------------
  it('US-20-TC01: Member đọc options của gói mình -> chỉ đích có policy hợp lệ, kèm sourceVersion và asOf', async () => {
    const response = await options().expect(200);
    expect(response.body.sourceVersion).toBe(0);
    expect(response.body.asOf).toBeDefined();
    expect(response.body.items).toEqual([{ targetPlanId, targetPlanVersion: 0, policyVersion: 0, name: 'Gói GYM_VIP',
      price: '600000', durationDays: 30, sessionsQuota: 0 }]);
  });

  // Mỗi trường hợp tạo thêm một gói đích KHÔNG hợp lệ; options vẫn chỉ trả đúng GYM_VIP.
  const invalidTargets: [string, () => Promise<void>][] = [
    ['gói ACTIVE nhưng không có cạnh policy', async () => {
      await createPlan('NO_POLICY', '900000');
    }],
    ['cạnh policy INACTIVE', async () => {
      const id = await targetPlan('POLICY_OFF', '700000');
      await world.connection.collection('plan_conversion_policies').updateOne({ to_plan_id: oid(id) }, { $set: { status: 'INACTIVE' } });    }],
    ['gói đích INACTIVE (ngừng bán)', async () => {
      const id = await targetPlan('PLAN_OFF', '700000');
      await world.connection.collection('plans').updateOne({ _id: oid(id) }, { $set: { status: 'INACTIVE' } });
    }],
    ['gói đích khác kind (PT)', async () => {
      const id = await targetPlan('OTHER_KIND', '700000');
      await world.connection.collection('plans').updateOne({ _id: oid(id) }, { $set: { kind: 'PT', session_quota: 10 } });
    }],
  ];

  it.each(invalidTargets)('US-20-TC01: %s -> không xuất hiện trong options', async (_case, arrange) => {
    await arrange();
    const response = await options().expect(200);
    expect(response.body.items.map((item: { targetPlanId: string }) => item.targetPlanId)).toEqual([targetPlanId]);
  });

  it('US-20-TC01: không còn đích nào hợp lệ -> 200 items = []', async () => {
    await world.connection.collection('plan_conversion_policies').updateMany({}, { $set: { status: 'INACTIVE' } });
    expect((await options().expect(200)).body.items).toEqual([]);
  });

  it('US-20-TC01: Member tạo đề nghị nâng cấp -> 201 UPGRADE, channel SELF_SERVICE, gắn đúng hồ sơ và created_by', async () => {
    const upgrade = await self('', selfInput()).expect(201);
    expect(upgrade.body).toMatchObject({ operation: 'UPGRADE', channel: 'SELF_SERVICE', sourceMembershipId: source.membershipId,
      previousSaleId: source.saleId, transactionStatus: 'PENDING', amountDue: '450000', creditAmount: '150000' });

    const savedSale = await api.findById('service_sales', upgrade.body.saleId);
    expect(savedSale).toMatchObject({ operation: 'UPGRADE', channel: 'SELF_SERVICE' });
    expect(savedSale!.member_id.toHexString()).toBe(world.memberId);
    const transaction = await api.findById('transactions', upgrade.body.transactionId);
    expect(transaction!.member_id.toHexString()).toBe(world.memberId);
    expect(transaction!.created_by.toHexString()).toBe(world.memberAccountId.toHexString());
    expect(transaction!.status).toBe('PENDING');
  });

  it('US-20-TC01: tạo đề nghị chưa chuyển gói, không sửa membership/sale nguồn; Member đọc lại được qua API US-17', async () => {
    const membershipBefore = await sourceMembership();
    const saleBefore = await api.findById('service_sales', source.saleId);
    const upgrade = await self('', selfInput()).expect(201);
    expect(upgrade.body.membershipId).toBeUndefined();
    expect(await world.connection.collection('memberships').countDocuments({ service_sale_id: oid(upgrade.body.saleId) })).toBe(0);
    expect(await world.connection.collection('payments').countDocuments({ transaction_id: oid(upgrade.body.transactionId) })).toBe(0);
    expect(await sourceMembership()).toEqual(membershipBefore);
    expect(await api.findById('service_sales', source.saleId)).toEqual(saleBefore);

    await request(server()).get(`/api/me/service-sales/${upgrade.body.saleId}`)
      .set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
  });

  it('US-20-TC01: preview của Member chỉ đọc, trả credit/phải thu, không tạo sale/transaction/operation', async () => {
    const counts = async () => Promise.all(['service_sales', 'transactions', 'memberships', 'operation_requests']
      .map(name => world.connection.collection(name).countDocuments()));
    const before = await counts();
    const preview = await self('/preview', selfInput()).expect(200);
    expect(preview.body).toMatchObject({ baseValue: '300000', totalDays: 30, remainingDays: 15, rawCredit: '150000',
      appliedCredit: '150000', excessCredit: '0', amountDue: '450000', asOfDate: '2026-11-16', canProceed: true });
    expect(await counts()).toEqual(before);
  });

  // ---------------- TC02 ----------------
  it('US-20-TC02: membership nguồn của hội viên khác -> 404 ở options, preview và tạo, không lộ thông tin', async () => {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    const foreign = await settledSource(world.otherMemberId);
    started.setNow(new Date('2026-11-16T03:00:00Z'));
    // Điều kiện trước: nguồn của chính mình đọc được, để chắc 404 bên dưới là do không thuộc chủ thể chứ không phải thiếu route.
    await options().expect(200);
    await self('/preview', selfInput()).expect(200);

    const responses = [
      await options(foreign.membershipId).expect(404),
      await self('/preview', selfInput({ sourceMembershipId: foreign.membershipId })).expect(404),
      await self('', selfInput({ sourceMembershipId: foreign.membershipId })).expect(404),
    ];
    for (const response of responses) {
      expect(JSON.stringify(response.body)).not.toContain(world.otherMemberId);
      expect(JSON.stringify(response.body)).not.toContain(foreign.saleId);
      expect(JSON.stringify(response.body)).not.toContain(foreign.transactionId);
    }
    expect(await countUpgrades()).toBe(0);
  });

  it('US-20-TC02: sourceMembershipId không tồn tại -> 404', async () => {
    const missing = new Types.ObjectId().toHexString();
    await options().expect(200);
    await options(missing).expect(404);
    await self('/preview', selfInput({ sourceMembershipId: missing })).expect(404);
    await self('', selfInput({ sourceMembershipId: missing })).expect(404);
    expect(await countUpgrades()).toBe(0);
  });

  it('US-20-TC02: account MEMBER chưa liên kết hồ sơ -> 409 MEMBER_PROFILE_REQUIRED, không tạo sale', async () => {
    const responses = [
      await options(source.membershipId, world.tokens.unlinked).expect(409),
      await self('/preview', selfInput(), world.tokens.unlinked).expect(409),
      await self('', selfInput(), world.tokens.unlinked).expect(409),
    ];
    for (const response of responses) expect(response.body.error.code).toBe('MEMBER_PROFILE_REQUIRED');
    expect(await countUpgrades()).toBe(0);
  });

  it.each(['STAFF', 'ADMIN', 'TRAINER'] as const)('US-20-TC02: role %s gọi API cá nhân -> 403, không tạo sale', async role => {
    await options(source.membershipId, world.tokens[role]).expect(403);
    await self('/preview', selfInput(), world.tokens[role]).expect(403);
    await self('', selfInput(), world.tokens[role]).expect(403);
    expect(await countUpgrades()).toBe(0);
  });

  it('US-20-TC02: không có token -> 401', async () => {
    await request(server()).get(`/api/me/memberships/${source.membershipId}/upgrade-options`).expect(401);
    await request(server()).post('/api/me/service-upgrades/preview').set('Origin', origin).send(selfInput()).expect(401);
    await request(server()).post('/api/me/service-upgrades').set('Origin', origin)
      .set('Idempotency-Key', randomUUID()).send(selfInput()).expect(401);
    expect(await countUpgrades()).toBe(0);
  });

  // ---------------- TC04 ----------------
  // Mỗi trường hợp: Member đã đọc options (version 0), sau đó cấu hình/nguồn đổi; tạo bằng dữ liệu cũ phải 409 đúng mã,
  // giống hệt quầy, và không có đề nghị nào được tạo với giá mới.
  const changedCases: [string, string, () => Promise<void>][] = [
    ['membership nguồn đổi version', 'SOURCE_CHANGED', async () => {
      await world.connection.collection('memberships').updateOne({ _id: oid(source.membershipId) }, { $inc: { version: 1 } });
    }],
    ['Admin đổi giá gói đích (version tăng)', 'PLAN_CHANGED', async () => {
      await request(server()).patch(`/api/admin/plans/${targetPlanId}`).set('Origin', origin)
        .set('Authorization', `Bearer ${world.tokens.ADMIN}`).send({ version: 0, price: '800000' }).expect(200);
    }],
    ['cạnh policy đổi version', 'POLICY_CHANGED', async () => {
      await world.connection.collection('plan_conversion_policies').updateMany({}, { $inc: { version: 1 } });
    }],
    ['cạnh policy bị tắt', 'POLICY_NOT_ALLOWED', async () => {
      await world.connection.collection('plan_conversion_policies').updateMany({}, { $set: { status: 'INACTIVE' } });
    }],
  ];

  it.each(changedCases)('US-20-TC04: %s sau khi đọc options -> 409 %s, giống quầy, không tạo đề nghị', async (_case, code, arrange) => {
    const item = (await options().expect(200)).body.items[0];
    await arrange();
    const stale = selfInput({ targetPlanVersion: item.targetPlanVersion, policyVersion: item.policyVersion });
    const fromSelf = await self('', stale);
    const fromCounter = await counter('', counterInput({ targetPlanVersion: item.targetPlanVersion, policyVersion: item.policyVersion }));
    expect(fromSelf.status).toBe(409);
    expect(fromSelf.body.error.code).toBe(code);
    expect(fromSelf.status).toBe(fromCounter.status);
    expect(fromSelf.body.error.code).toBe(fromCounter.body.error.code);
    expect(await countUpgrades()).toBe(0);
  });

  it('US-20-TC04: giá gói đích đổi -> đọc lại options thấy version/giá mới, tạo lại theo giá server, không tự tăng ở đề nghị cũ', async () => {
    await options().expect(200);
    await request(server()).patch(`/api/admin/plans/${targetPlanId}`).set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.ADMIN}`).send({ version: 0, price: '800000' }).expect(200);
    expect((await self('', selfInput()).expect(409)).body.error.code).toBe('PLAN_CHANGED');

    const fresh = (await options().expect(200)).body.items[0];
    expect(fresh).toMatchObject({ targetPlanId, price: '800000' });
    expect(fresh.targetPlanVersion).toBeGreaterThan(0);
    const upgrade = await self('', selfInput({ targetPlanVersion: fresh.targetPlanVersion, policyVersion: fresh.policyVersion })).expect(201);
    expect(upgrade.body).toMatchObject({ amountDue: '650000', creditAmount: '150000' });
    expect(await countUpgrades()).toBe(1);
  });

  // ---------------- TC05 ----------------
  it('US-20-TC05: cùng dữ liệu, preview của Member và của quầy trả cùng credit/phải thu/ngày báo giá', async () => {
    const fromSelf = await self('/preview', selfInput()).expect(200);
    const fromCounter = await counter('/preview', counterInput()).expect(200);
    expect(fromSelf.body).toEqual(fromCounter.body);
  });
});
