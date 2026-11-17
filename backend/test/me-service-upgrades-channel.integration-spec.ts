// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-20 bước 2.
// DTO chặt, cách trả dự kiến, nhánh phải thu 0, khóa SALE_UPGRADE, một PENDING/member/kind và Member tự hủy (TC03, TC06, TC09, TC10, TC12).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { toVndDecimal } from '../src/common/utils/vnd-money';
import { Plan } from '../src/modules/plans/schemas/plan.schema';
import { origin, startUs18App, stopUs18App, seedUs18World, us18Api, Us18App, Us18World, TEST_RECEIVING_ACCOUNTS } from './helpers/us18-fixture';

// Hợp đồng test đặt ra cho Builder (US-20 bước 2, theo mục 1–2 của spec và hợp đồng US-18/US-19 bước 2):
//   POST /api/me/service-upgrades(/preview) chỉ nhận {sourceMembershipId, sourceVersion, targetPlanId, targetPlanVersion,
//     policyVersion, preferredPaymentMethod CASH|TRANSFER}; field khác (credit, amountDue, quota, memberId, policy...) -> 400 (TC03).
//   Server ghi service_sales.channel='SELF_SERVICE', preferred_payment_method; phải thu>0 vẫn PENDING tới khi Staff thu (TC09).
//   TRANSFER khi chưa cấu hình tài khoản nhận -> 503 RECEIVING_ACCOUNTS_NOT_CONFIGURED (giống US-18/US-19).
//   Phải thu 0 (credit >= giá đích) -> SETTLED ngay theo nhánh 0 của US-16: invoice 0đ, không payment 0đ, không ví/refund (TC06).
//   Key SALE_UPGRADE: cùng key + cùng body -> kết quả cũ; cùng key khác body (kể cả cách trả) -> 409 IDEMPOTENCY_CONFLICT;
//     replay vẫn kiểm owner hiện hành; GET /api/operations/SALE_UPGRADE/:key cho chính Member đã tạo (TC10).
//   Quầy và Member dùng chung giới hạn một PENDING/member/kind -> 409 PENDING_SALE_EXISTS (TC10, F03).
//   Hủy dùng lại US-18: POST /api/me/service-sales/:id/cancel {version, reason}; chỉ PENDING SELF_SERVICE do chính account tạo (TC12).
//
// Dữ liệu: 2026-11-01 quầy bán GYM30 300000đ (2026-11-01 → 2026-11-30), Staff thu. Ngày 2026-11-16 còn 15/30 ngày -> rawCredit 150000.
// Gói đích GYM_VIP 600000đ -> phải thu 450000.
// TC06 (giống US-16-TC07): Admin hạ giá niêm yết GYM30 xuống 100000đ sau khi bán (US-12 chỉ cho cạnh tới gói đắt hơn giá niêm yết),
// gói đích GYM_LITE 200000đ, nâng cấp ngay 2026-11-01: rawCredit 300000 (từ tiền đã thu) -> applied 200000, phải thu 0, excess 100000.
type Source = { saleId: string; transactionId: string; membershipId: string };

function upgradeHelpers(world: () => Us18World) {
  const api = us18Api(world);
  const server = () => world().app.getHttpServer();

  async function settledSource(memberId: string): Promise<Source> {
    const sale = await api.counterSale(api.counterInput({ memberId })).expect(201);
    const settled = await api.confirmCash(sale.body.transactionId).expect(200);
    return { saleId: sale.body.saleId, transactionId: sale.body.transactionId, membershipId: settled.body.membershipId };
  }
  // Gói đích GYM 30 ngày + cạnh policy ACTIVE từ GYM30 (API Admin US-12).
  async function targetPlan(code: string, price: string) {
    const plan = await world().app.get<Model<Plan>>(getModelToken('Plan')).create({ code, name: `Gói ${code}`, kind: 'GYM',
      duration_days: 30, session_quota: 0, price: toVndDecimal(price), benefits: `Quyền lợi ${code}`, status: 'ACTIVE',
      created_by: world().adminId, updated_by: world().adminId });
    const planId = plan._id.toHexString();
    await request(server()).post('/api/admin/plan-policies').set('Origin', origin)
      .set('Authorization', `Bearer ${world().tokens.ADMIN}`).set('Idempotency-Key', randomUUID())
      .send({ fromPlanId: world().plan._id.toHexString(), toPlanId: planId, status: 'ACTIVE' }).expect(201);
    return planId;
  }
  const upgrade = (body: Record<string, unknown>, token = world().tokens.member, key: string = randomUUID()) =>
    request(server()).post('/api/me/service-upgrades').set('Origin', origin)
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
  const preview = (body: Record<string, unknown>, token = world().tokens.member) =>
    request(server()).post('/api/me/service-upgrades/preview').set('Origin', origin)
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send(body);
  const counterUpgrade = (body: Record<string, unknown>) =>
    request(server()).post('/api/service-upgrades').set('Origin', origin)
      .set('Authorization', `Bearer ${world().tokens.STAFF}`).set('Idempotency-Key', randomUUID()).send(body);
  // Staff/Admin xác nhận thu tiền mặt đúng số phải thu (US-22).
  const confirm = (transactionId: string, amount: string, token = world().tokens.STAFF) =>
    request(server()).post(`/api/transactions/${transactionId}/confirm-payment`).set('Origin', origin)
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID())
      .send({ method: 'CASH', amount, evidenceNote: 'Đã đếm đủ tiền mặt thực nhận' });
  const countUpgrades = () => world().connection.collection('service_sales').countDocuments({ operation: 'UPGRADE' });
  return { api, server, settledSource, targetPlan, upgrade, preview, counterUpgrade, confirm, countUpgrades };
}

describe('US-20 bước 2: DTO, cách trả, nhánh 0, khóa SALE_UPGRADE và tự hủy', () => {
  let started: Us18App;
  let world: Us18World;
  let source: Source;
  let targetPlanId: string;
  const { api, server, settledSource, targetPlan, upgrade, preview, counterUpgrade, confirm, countUpgrades } = upgradeHelpers(() => world);
  const oid = (id: string) => new Types.ObjectId(id);
  const sourceMembership = () => api.findById('memberships', source.membershipId);

  beforeAll(async () => {
    started = await startUs18App('gym_management_test_us20_channel', {
      RECEIVING_ACCOUNTS: JSON.stringify(TEST_RECEIVING_ACCOUNTS.map(account => account.code)),
      RECEIVING_ACCOUNT_DETAILS: JSON.stringify(TEST_RECEIVING_ACCOUNTS),
    });
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

  const selfInput = (extra: Record<string, unknown> = {}) => ({ sourceMembershipId: source.membershipId, sourceVersion: 0,
    targetPlanId, targetPlanVersion: 0, policyVersion: 0, preferredPaymentMethod: 'CASH', ...extra });
  const counterInput = (extra: Record<string, unknown> = {}) => ({ memberId: world.memberId, sourceMembershipId: source.membershipId,
    sourceVersion: 0, targetPlanId, targetPlanVersion: 0, policyVersion: 0, ...extra });

  // ---------------- TC03 ----------------
  it.each([
    ['creditAmount', { creditAmount: '600000' }],
    ['rawCredit', { rawCredit: '600000' }],
    ['appliedCredit', { appliedCredit: '600000' }],
    ['excessCredit', { excessCredit: '0' }],
    ['amountDue', { amountDue: '0' }],
    ['price', { price: '0' }],
    ['targetListPrice', { targetListPrice: '1' }],
    ['sessionsQuota', { sessionsQuota: 999 }],
    ['quota', { quota: 999 }],
    ['sessionsUsed', { sessionsUsed: 0 }],
    ['memberId', { memberId: new Types.ObjectId().toHexString() }],
    ['policyId', { policyId: new Types.ObjectId().toHexString() }],
    ['policy', { policy: 'UPGRADE_V2' }],
    ['asOfDate', { asOfDate: '2026-11-01' }],
    ['quoteExpiresAt', { quoteExpiresAt: '2099-01-01T00:00:00.000Z' }],
    ['channel', { channel: 'COUNTER' }],
    ['createdBy', { createdBy: new Types.ObjectId().toHexString() }],
  ])('US-20-TC03: body có field tự gửi %s -> 400 ở preview và tạo, không tạo đề nghị', async (_field, extra) => {
    await preview(selfInput(extra)).expect(400);
    await upgrade(selfInput(extra)).expect(400);
    expect(await countUpgrades()).toBe(0);
  });

  it('US-20-TC03: memberId của hội viên khác trong body -> 400, không tạo đề nghị cho người đó', async () => {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    const foreign = await settledSource(world.otherMemberId);
    started.setNow(new Date('2026-11-16T03:00:00Z'));
    await upgrade(selfInput({ memberId: world.otherMemberId, sourceMembershipId: foreign.membershipId })).expect(400);
    expect(await countUpgrades()).toBe(0);
  });

  it.each([
    ['sourceVersion là chuỗi', { sourceVersion: '0' }],
    ['targetPlanVersion âm', { targetPlanVersion: -1 }],
    ['policyVersion số lẻ', { policyVersion: 0.5 }],
    ['sourceMembershipId sai định dạng', { sourceMembershipId: 'bad' }],
    ['thiếu targetPlanId', { targetPlanId: undefined }],
  ])('US-20-TC03: %s -> 400, không tạo đề nghị', async (_case, extra) => {
    await upgrade(selfInput(extra)).expect(400);
    expect(await countUpgrades()).toBe(0);
  });

  // ---------------- TC06 ----------------
  async function zeroDueTarget() {
    await request(server()).patch(`/api/admin/plans/${world.plan._id.toHexString()}`).set('Origin', origin)
      .set('Authorization', `Bearer ${world.tokens.ADMIN}`).send({ version: 0, price: '100000' }).expect(200);
    const liteId = await targetPlan('GYM_LITE', '200000');
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    return liteId;
  }

  it('US-20-TC06: rawCredit vượt giá đích -> SETTLED ngay qua nhánh 0, invoice 0đ, không payment/ví/refund', async () => {
    const liteId = await zeroDueTarget();
    const saleBefore = await api.findById('service_sales', source.saleId);
    const done = await upgrade(selfInput({ targetPlanId: liteId })).expect(201);
    expect(done.body).toMatchObject({ operation: 'UPGRADE', channel: 'SELF_SERVICE', transactionStatus: 'SETTLED',
      amountDue: '0', creditAmount: '200000', quote: { rawCredit: '300000', appliedCredit: '200000', excessCredit: '100000' } });
    expect(done.body.membershipId).toBeDefined();

    expect(await world.connection.collection('payments').countDocuments({ transaction_id: oid(done.body.transactionId) })).toBe(0);
    const invoice = await world.connection.collection('invoices').findOne({ transaction_id: oid(done.body.transactionId) });
    expect(invoice!.total_amount.toString()).toBe('0');
    // Phần dư 100000 không thành khoản hoàn tiền.
    expect(await world.connection.collection('refunds').countDocuments()).toBe(0);

    expect(await sourceMembership()).toMatchObject({ status: 'SUPERSEDED' });
    expect(await api.findById('memberships', done.body.membershipId)).toMatchObject({ status: 'ACTIVE' });
    const newSale = await api.findById('service_sales', done.body.saleId);
    expect(newSale).toMatchObject({ start_date: '2026-11-01', end_date: '2026-11-30' });
    expect(newSale!.credit_amount.toString()).toBe('200000');
    expect(await api.findById('service_sales', source.saleId)).toEqual(saleBefore);
  });

  it('US-20-TC06: preview nhánh 0 nói rõ phần dư không được dùng, canProceed và phải thu 0', async () => {
    const liteId = await zeroDueTarget();
    const quote = await preview(selfInput({ targetPlanId: liteId })).expect(200);
    expect(quote.body).toMatchObject({ rawCredit: '300000', appliedCredit: '200000', excessCredit: '100000', amountDue: '0', canProceed: true });
  });

  // ---------------- TC09 ----------------
  it.each(['CASH', 'TRANSFER'])('US-20-TC09: chọn %s, phải thu>0 -> 201 PENDING, server ghi SELF_SERVICE và cách trả, chưa chuyển gói', async method => {
    const before = await sourceMembership();
    const created = await upgrade(selfInput({ preferredPaymentMethod: method })).expect(201);
    expect(created.body).toMatchObject({ operation: 'UPGRADE', channel: 'SELF_SERVICE', transactionStatus: 'PENDING', amountDue: '450000' });
    expect(await api.findById('service_sales', created.body.saleId)).toMatchObject({ channel: 'SELF_SERVICE', preferred_payment_method: method });
    expect(await world.connection.collection('memberships').countDocuments({ service_sale_id: oid(created.body.saleId) })).toBe(0);
    for (const name of ['payments', 'invoices']) {
      expect(await world.connection.collection(name).countDocuments({ transaction_id: oid(created.body.transactionId) })).toBe(0);
    }
    expect(await sourceMembership()).toEqual(before);
  });

  it.each([{ preferredPaymentMethod: 'MOMO' }, { preferredPaymentMethod: undefined }])(
    'US-20-TC09: preferredPaymentMethod %p không hợp lệ -> 400, không tạo đề nghị', async extra => {
      await upgrade(selfInput(extra)).expect(400);
      expect(await countUpgrades()).toBe(0);
    });

  it('US-20-TC09: Member gọi confirm-payment cho đề nghị của mình -> 403, vẫn PENDING, gói cũ còn ACTIVE', async () => {
    const created = await upgrade(selfInput({ preferredPaymentMethod: 'TRANSFER' })).expect(201);
    await confirm(created.body.transactionId, '450000', world.tokens.member).expect(403);
    expect((await api.findById('transactions', created.body.transactionId))!.status).toBe('PENDING');
    expect(await world.connection.collection('memberships').countDocuments({ service_sale_id: oid(created.body.saleId) })).toBe(0);
    expect(await sourceMembership()).toMatchObject({ status: 'ACTIVE' });
  });

  it('US-20-TC09: đề nghị nâng cấp tạo tại quầy không bị ghi là SELF_SERVICE', async () => {
    const created = await counterUpgrade(counterInput()).expect(201);
    expect((await api.findById('service_sales', created.body.saleId))!.channel).not.toBe('SELF_SERVICE');
  });

  it('US-20-TC09: hướng dẫn thanh toán CASH lấy số phải thu và mã giao dịch từ server', async () => {
    const created = await upgrade(selfInput()).expect(201);
    const response = await api.instructions(created.body.transactionId).expect(200);
    expect(response.body).toMatchObject({ transactionCode: `TX-${created.body.transactionId}`, amountDue: '450000', preferredPaymentMethod: 'CASH' });
    expect(typeof response.body.cashInstruction).toBe('string');
  });

  it('US-20-TC09: hướng dẫn TRANSFER liệt kê tài khoản cấu hình, nội dung chuyển khoản = mã giao dịch', async () => {
    const created = await upgrade(selfInput({ preferredPaymentMethod: 'TRANSFER' })).expect(201);
    const response = await api.instructions(created.body.transactionId).expect(200);
    const code = `TX-${created.body.transactionId}`;
    expect(response.body).toMatchObject({ transactionCode: code, amountDue: '450000', preferredPaymentMethod: 'TRANSFER' });
    expect(response.body.transferOptions).toEqual(TEST_RECEIVING_ACCOUNTS.map(account => ({
      receivingAccountCode: account.code, bankName: account.bankName, accountNumber: account.accountNumber,
      accountName: account.accountName, transferContent: code,
    })));
  });

  it('US-20-TC09: chỉ khi Staff thu đủ mới chuyển gói: nguồn SUPERSEDED, gói mới từ hôm thu', async () => {
    const created = await upgrade(selfInput()).expect(201);
    const settled = await confirm(created.body.transactionId, '450000').expect(200);
    expect(settled.body.membershipId).toBeDefined();
    expect(settled.body.membershipId).not.toBe(source.membershipId);
    expect(await sourceMembership()).toMatchObject({ status: 'SUPERSEDED' });
    expect(await api.findById('service_sales', created.body.saleId)).toMatchObject({ start_date: '2026-11-16', end_date: '2026-12-15' });
  });

  // ---------------- TC10 (phần tuần tự; hai kênh chạy song song làm ở bước 4) ----------------
  it('US-20-TC10: gửi lại cùng key và cùng body (mất response) -> cùng kết quả, chỉ một đề nghị', async () => {
    const key = randomUUID();
    const first = await upgrade(selfInput(), world.tokens.member, key).expect(201);
    const again = await upgrade(selfInput(), world.tokens.member, key).expect(201);
    expect(again.body).toEqual(first.body);
    expect(await countUpgrades()).toBe(1);
  });

  it.each([
    ['đổi cách trả dự kiến', { preferredPaymentMethod: 'TRANSFER' }],
    ['đổi targetPlanVersion', { targetPlanVersion: 1 }],
    ['đổi sourceVersion', { sourceVersion: 1 }],
    ['đổi targetPlanId', { targetPlanId: new Types.ObjectId().toHexString() }],
  ])('US-20-TC10: cùng key nhưng %s -> 409 IDEMPOTENCY_CONFLICT, không tạo đề nghị thứ hai', async (_case, extra) => {
    const key = randomUUID();
    await upgrade(selfInput(), world.tokens.member, key).expect(201);
    const changed = await upgrade(selfInput(extra), world.tokens.member, key).expect(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await countUpgrades()).toBe(1);
  });

  it('US-20-TC10: replay sau khi account bị gỡ liên kết hồ sơ -> 409 MEMBER_PROFILE_REQUIRED, không trả kết quả cũ', async () => {
    const key = randomUUID();
    await upgrade(selfInput(), world.tokens.member, key).expect(201);
    await world.connection.collection('members').updateOne({ _id: oid(world.memberId) }, { $unset: { account_id: '' } });
    const replay = await upgrade(selfInput(), world.tokens.member, key).expect(409);
    expect(replay.body.error.code).toBe('MEMBER_PROFILE_REQUIRED');
    expect(JSON.stringify(replay.body)).not.toContain('saleId');
  });

  it('US-20-TC10: Member tra cứu operation SALE_UPGRADE của chính mình sau mất response; Member khác không thấy', async () => {
    const key = randomUUID();
    const created = await upgrade(selfInput(), world.tokens.member, key).expect(201);
    const lookup = await request(server()).get(`/api/operations/SALE_UPGRADE/${key}`)
      .set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
    expect(lookup.body.responseBody).toEqual(created.body);
    await request(server()).get(`/api/operations/SALE_UPGRADE/${key}`)
      .set('Authorization', `Bearer ${world.tokens.otherMember}`).expect(404);
  });

  it('US-20-TC10: quầy đã tạo đề nghị PENDING, Member tạo khác key -> 409 PENDING_SALE_EXISTS, chỉ một ý định', async () => {
    await counterUpgrade(counterInput()).expect(201);
    expect((await upgrade(selfInput()).expect(409)).body.error.code).toBe('PENDING_SALE_EXISTS');
    expect(await countUpgrades()).toBe(1);
  });

  it('US-20-TC10: Member đã tạo đề nghị PENDING, quầy tạo khác key -> 409 PENDING_SALE_EXISTS, chỉ một ý định', async () => {
    await upgrade(selfInput()).expect(201);
    expect((await counterUpgrade(counterInput()).expect(409)).body.error.code).toBe('PENDING_SALE_EXISTS');
    expect(await countUpgrades()).toBe(1);
  });

  it('US-20-TC10: Member gửi hai lần khác key -> lần hai 409 PENDING_SALE_EXISTS', async () => {
    await upgrade(selfInput()).expect(201);
    expect((await upgrade(selfInput()).expect(409)).body.error.code).toBe('PENDING_SALE_EXISTS');
    expect(await countUpgrades()).toBe(1);
  });

  // ---------------- TC12 (phần không đồng thời; cạnh tranh với thu tiền làm ở bước 4) ----------------
  it('US-20-TC12: Member hủy đề nghị SELF_SERVICE đang chờ -> 200 CANCELLED, gói cũ giữ nguyên, không refund, tạo lại được', async () => {
    const before = await sourceMembership();
    const created = await upgrade(selfInput()).expect(201);
    const cancelled = await api.cancel(created.body.saleId, { version: 0, reason: 'Muốn chọn gói khác' }).expect(200);
    expect(cancelled.body).toMatchObject({ saleId: created.body.saleId, transactionId: created.body.transactionId, status: 'CANCELLED' });
    expect((await api.findById('transactions', created.body.transactionId))!.status).toBe('CANCELLED');
    // Không xóa lịch sử: sale vẫn còn.
    expect(await api.findById('service_sales', created.body.saleId)).not.toBeNull();
    expect(await world.connection.collection('payments').countDocuments({ transaction_id: oid(created.body.transactionId) })).toBe(0);
    expect(await world.connection.collection('refunds').countDocuments()).toBe(0);
    expect(await sourceMembership()).toEqual(before);
    // F03: muốn đổi ý định thì hủy rồi tạo mới.
    await upgrade(selfInput({ preferredPaymentMethod: 'TRANSFER' })).expect(201);
  });

  it('US-20-TC12: đề nghị do quầy tạo cho chính hồ sơ của mình -> Member không được hủy (403)', async () => {
    const created = await counterUpgrade(counterInput()).expect(201);
    await api.cancel(created.body.saleId, { version: 0, reason: 'Không còn nhu cầu nâng cấp' }).expect(403);
    expect((await api.findById('transactions', created.body.transactionId))!.status).toBe('PENDING');
  });

  it('US-20-TC12: đề nghị đã SETTLED -> 409 INVALID_TRANSACTION_STATE, gói mới vẫn còn, không refund', async () => {
    const created = await upgrade(selfInput()).expect(201);
    const settled = await confirm(created.body.transactionId, '450000').expect(200);
    const response = await api.cancel(created.body.saleId, { version: 1, reason: 'Không còn nhu cầu nâng cấp' }).expect(409);
    expect(response.body.error.code).toBe('INVALID_TRANSACTION_STATE');
    expect((await api.findById('transactions', created.body.transactionId))!.status).toBe('SETTLED');
    expect(await api.findById('memberships', settled.body.membershipId)).toMatchObject({ status: 'ACTIVE' });
    expect(await world.connection.collection('refunds').countDocuments()).toBe(0);
  });

  it('US-20-TC12: hủy đề nghị của hội viên khác -> 404, của họ vẫn PENDING', async () => {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    const foreignSource = await settledSource(world.otherMemberId);
    started.setNow(new Date('2026-11-16T03:00:00Z'));
    const foreign = await upgrade(selfInput({ sourceMembershipId: foreignSource.membershipId }), world.tokens.otherMember).expect(201);
    await api.cancel(foreign.body.saleId, { version: 0, reason: 'Không còn nhu cầu nâng cấp' }).expect(404);
    expect((await api.findById('transactions', foreign.body.transactionId))!.status).toBe('PENDING');
  });
});

describe('US-20 bước 2: chưa cấu hình tài khoản nhận chuyển khoản', () => {
  let started: Us18App;
  let world: Us18World;
  let source: Source;
  let targetPlanId: string;
  const { settledSource, targetPlan, upgrade, preview, countUpgrades } = upgradeHelpers(() => world);

  beforeAll(async () => {
    delete process.env.RECEIVING_ACCOUNT_DETAILS;
    started = await startUs18App('gym_management_test_us20_no_transfer', { RECEIVING_ACCOUNTS: '[]' });
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

  const selfInput = (extra: Record<string, unknown> = {}) => ({ sourceMembershipId: source.membershipId, sourceVersion: 0,
    targetPlanId, targetPlanVersion: 0, policyVersion: 0, preferredPaymentMethod: 'CASH', ...extra });

  it('US-20-TC09: xem trước với TRANSFER -> 503 RECEIVING_ACCOUNTS_NOT_CONFIGURED', async () => {
    const response = await preview(selfInput({ preferredPaymentMethod: 'TRANSFER' })).expect(503);
    expect(response.body.error.code).toBe('RECEIVING_ACCOUNTS_NOT_CONFIGURED');
  });

  it('US-20-TC09: tạo với TRANSFER -> 503, không tạo đề nghị; chọn CASH thì tạo được', async () => {
    const response = await upgrade(selfInput({ preferredPaymentMethod: 'TRANSFER' })).expect(503);
    expect(response.body.error.code).toBe('RECEIVING_ACCOUNTS_NOT_CONFIGURED');
    expect(await countUpgrades()).toBe(0);
    expect((await upgrade(selfInput()).expect(201)).body.transactionStatus).toBe('PENDING');
  });
});
