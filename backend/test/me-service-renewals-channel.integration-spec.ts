// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-19 bước 2.
// DTO chặt, cách trả dự kiến, khóa SALE_RENEW, hướng dẫn thanh toán và Member tự hủy kỳ gia hạn (TC04, TC08, TC09, TC11).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Types } from 'mongoose';
import { startUs18App, stopUs18App, seedUs18World, us18Api, Us18App, Us18World, TEST_RECEIVING_ACCOUNTS } from './helpers/us18-fixture';

// Hợp đồng test đặt ra cho Builder (US-19 bước 2, theo mục 1–2 của spec và hợp đồng US-18 bước 2 đã chốt 2026-11-15):
//   POST /api/me/service-renewals(/preview) chỉ nhận {previousSaleId, planVersion, preferredPaymentMethod CASH|TRANSFER};
//     field khác (endDate, amountDue, memberId, creditAmount, ...) -> 400 (TC04).
//   Server ghi service_sales.channel='SELF_SERVICE', preferred_payment_method; giá>0 vẫn PENDING tới khi Staff thu.
//   TRANSFER khi chưa cấu hình tài khoản nhận -> 503 RECEIVING_ACCOUNTS_NOT_CONFIGURED (giống US-18-TC08).
//   Giá 0 -> SETTLED ngay, invoice 0đ, membership mới, không payment 0đ.
//   Key SALE_RENEW: cùng key + cùng body -> trả lại kết quả cũ; cùng key khác body (kể cả cách trả) -> 409 IDEMPOTENCY_CONFLICT;
//     replay vẫn kiểm owner hiện hành; GET /api/operations/SALE_RENEW/:key cho chính Member đã tạo.
//   Theo dõi/thu/hủy dùng lại endpoint US-18: GET /api/me/transactions/:id/payment-instructions,
//     POST /api/me/service-sales/:id/cancel {version, reason}; confirm-payment US-22 với token Member -> 403.

// Kỳ nguồn: GYM30 300000đ bán tại quầy 2026-11-01 → 2026-11-30, đã thu. Kỳ gia hạn dự kiến 2026-12-01 → 2026-12-30.
type Source = { saleId: string; transactionId: string; membershipId: string };

function renewalHelpers(world: () => Us18World) {
  const api = us18Api(world);
  const server = () => world().app.getHttpServer();
  const origin = 'http://localhost:5173';

  async function settledSource(memberId: string): Promise<Source> {
    const sale = await api.counterSale(api.counterInput({ memberId })).expect(201);
    const settled = await api.confirmCash(sale.body.transactionId).expect(200);
    return { saleId: sale.body.saleId, transactionId: sale.body.transactionId, membershipId: settled.body.membershipId };
  }
  const renew = (body: Record<string, unknown>, token = world().tokens.member, key: string = randomUUID()) =>
    request(server()).post('/api/me/service-renewals').set('Origin', origin)
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
  const preview = (body: Record<string, unknown>, token = world().tokens.member) =>
    request(server()).post('/api/me/service-renewals/preview').set('Origin', origin)
      .set('Authorization', `Bearer ${token}`).send(body);
  const counterRenew = (body: Record<string, unknown>) =>
    request(server()).post('/api/service-renewals').set('Origin', origin)
      .set('Authorization', `Bearer ${world().tokens.STAFF}`).set('Idempotency-Key', randomUUID()).send(body);
  const countRenewals = () => world().connection.collection('service_sales').countDocuments({ operation: 'RENEW' });
  return { api, server, settledSource, renew, preview, counterRenew, countRenewals };
}

describe('US-19 bước 2: DTO, cách trả, khóa SALE_RENEW, hướng dẫn thanh toán và tự hủy', () => {
  let started: Us18App;
  let world: Us18World;
  let source: Source;
  const { api, server, settledSource, renew, preview, counterRenew, countRenewals } = renewalHelpers(() => world);
  const oid = (id: string) => new Types.ObjectId(id);

  beforeAll(async () => {
    started = await startUs18App('gym_management_test_us19_channel', {
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
  });

  afterEach(() => jest.restoreAllMocks());

  const selfInput = (extra: Record<string, unknown> = {}) => ({ previousSaleId: source.saleId, planVersion: 0,
    preferredPaymentMethod: 'CASH', ...extra });

  // ---------------- TC04 ----------------
  it.each([
    ['endDate', { endDate: '2027-12-31' }],
    ['startDate', { startDate: '2026-11-15' }],
    ['amountDue', { amountDue: '0' }],
    ['price', { price: '0' }],
    ['creditAmount', { creditAmount: '300000' }],
    ['credit', { credit: '300000' }],
    ['durationDays', { durationDays: 365 }],
    ['sessions', { sessions: 999 }],
    ['memberId', { memberId: new Types.ObjectId().toHexString() }],
    ['accountId', { accountId: new Types.ObjectId().toHexString() }],
    ['createdBy', { createdBy: new Types.ObjectId().toHexString() }],
    ['channel', { channel: 'COUNTER' }],
  ])('US-19-TC04: body có field thừa %s -> 400 ở preview và tạo, không tạo sale', async (_field, extra) => {
    await preview(selfInput(extra)).expect(400);
    await renew(selfInput(extra)).expect(400);
    expect(await countRenewals()).toBe(0);
  });

  it('US-19-TC04: memberId của hội viên khác trong body -> 400, không tạo kỳ gia hạn cho người đó', async () => {
    const foreign = await settledSource(world.otherMemberId);
    await renew(selfInput({ memberId: world.otherMemberId, previousSaleId: foreign.saleId })).expect(400);
    expect(await countRenewals()).toBe(0);
  });

  // ---------------- TC08 ----------------
  it.each(['CASH', 'TRANSFER'])('US-19-TC08: chọn %s -> 201 PENDING, server ghi channel SELF_SERVICE và cách trả dự kiến, chưa có gói mới', async method => {
    const renewal = await renew(selfInput({ preferredPaymentMethod: method })).expect(201);
    expect(renewal.body).toMatchObject({ operation: 'RENEW', channel: 'SELF_SERVICE', transactionStatus: 'PENDING' });
    expect(await api.findById('service_sales', renewal.body.saleId)).toMatchObject({ channel: 'SELF_SERVICE', preferred_payment_method: method });
    for (const name of ['memberships', 'payments', 'invoices']) {
      const field = name === 'memberships' ? 'service_sale_id' : 'transaction_id';
      const id = name === 'memberships' ? renewal.body.saleId : renewal.body.transactionId;
      expect(await world.connection.collection(name).countDocuments({ [field]: oid(id) })).toBe(0);
    }
  });

  it.each([{ preferredPaymentMethod: 'MOMO' }, { preferredPaymentMethod: undefined }])(
    'US-19-TC08: preferredPaymentMethod %p không hợp lệ -> 400, không tạo sale', async extra => {
      await renew(selfInput(extra)).expect(400);
      expect(await countRenewals()).toBe(0);
    });

  it('US-19-TC08: kỳ gia hạn tạo tại quầy không bị ghi là SELF_SERVICE', async () => {
    const renewal = await counterRenew({ memberId: world.memberId, previousSaleId: source.saleId, planVersion: 0 }).expect(201);
    expect((await api.findById('service_sales', renewal.body.saleId))!.channel).not.toBe('SELF_SERVICE');
  });

  it('US-19-TC08: Member gọi confirm-payment cho kỳ gia hạn của mình -> 403, vẫn PENDING, không cấp gói', async () => {
    const renewal = await renew(selfInput()).expect(201);
    await api.confirmCash(renewal.body.transactionId, world.tokens.member).expect(403);
    expect((await api.findById('transactions', renewal.body.transactionId))!.status).toBe('PENDING');
    expect(await world.connection.collection('memberships').countDocuments({ service_sale_id: oid(renewal.body.saleId) })).toBe(0);
  });

  it('US-19-TC08: Staff xác nhận thu thì kỳ gia hạn mới có membership riêng, kỳ nguồn giữ nguyên', async () => {
    const before = await api.findById('service_sales', source.saleId);
    const renewal = await renew(selfInput()).expect(201);
    const settled = await api.confirmCash(renewal.body.transactionId).expect(200);
    expect(settled.body.membershipId).toBeDefined();
    expect(settled.body.membershipId).not.toBe(source.membershipId);
    expect(await api.findById('service_sales', source.saleId)).toEqual(before);
  });

  it('US-19-TC08: hướng dẫn thanh toán CASH của kỳ gia hạn lấy số tiền và mã giao dịch từ server', async () => {
    const renewal = await renew(selfInput()).expect(201);
    const response = await api.instructions(renewal.body.transactionId).expect(200);
    expect(response.body).toMatchObject({ transactionCode: `TX-${renewal.body.transactionId}`, amountDue: '300000', preferredPaymentMethod: 'CASH' });
    expect(typeof response.body.cashInstruction).toBe('string');
  });

  it('US-19-TC08: hướng dẫn TRANSFER của kỳ gia hạn liệt kê tài khoản cấu hình, nội dung chuyển khoản = mã giao dịch', async () => {
    const renewal = await renew(selfInput({ preferredPaymentMethod: 'TRANSFER' })).expect(201);
    const response = await api.instructions(renewal.body.transactionId).expect(200);
    const code = `TX-${renewal.body.transactionId}`;
    expect(response.body).toMatchObject({ transactionCode: code, amountDue: '300000', preferredPaymentMethod: 'TRANSFER' });
    expect(response.body.transferOptions).toEqual(TEST_RECEIVING_ACCOUNTS.map(account => ({
      receivingAccountCode: account.code, bankName: account.bankName, accountNumber: account.accountNumber,
      accountName: account.accountName, transferContent: code,
    })));
  });

  it('US-19-TC08: gói giá 0 -> SETTLED ngay, invoice 0đ, membership mới từ 2026-12-01, không có payment 0đ', async () => {
    await api.setPlanPrice('0');
    const before = await api.findById('service_sales', source.saleId);
    const renewal = await renew(selfInput()).expect(201);
    expect(renewal.body).toMatchObject({ operation: 'RENEW', channel: 'SELF_SERVICE', transactionStatus: 'SETTLED', amountDue: '0',
      startDate: '2026-12-01' });
    expect(await world.connection.collection('payments').countDocuments({ transaction_id: oid(renewal.body.transactionId) })).toBe(0);
    const invoice = await world.connection.collection('invoices').findOne({ transaction_id: oid(renewal.body.transactionId) });
    expect(invoice!.total_amount.toString()).toBe('0');
    expect(await world.connection.collection('memberships').countDocuments({ service_sale_id: oid(renewal.body.saleId) })).toBe(1);
    expect(await api.findById('service_sales', source.saleId)).toEqual(before);
  });

  // ---------------- TC09 ----------------
  it('US-19-TC09: gửi lại cùng key và cùng body (mất response) -> cùng kết quả, chỉ một kỳ gia hạn', async () => {
    const key = randomUUID();
    const first = await renew(selfInput(), world.tokens.member, key).expect(201);
    const again = await renew(selfInput(), world.tokens.member, key).expect(201);
    expect(again.body).toEqual(first.body);
    expect(await countRenewals()).toBe(1);
    expect(await world.connection.collection('transactions').countDocuments({ status: 'PENDING' })).toBe(1);
  });

  it.each([
    ['đổi cách trả dự kiến', { preferredPaymentMethod: 'TRANSFER' }],
    ['đổi planVersion', { planVersion: 1 }],
    ['đổi previousSaleId', { previousSaleId: new Types.ObjectId().toHexString() }],
  ])('US-19-TC09: cùng key nhưng %s -> 409 IDEMPOTENCY_CONFLICT, không tạo kỳ thứ hai', async (_case, extra) => {
    const key = randomUUID();
    await renew(selfInput(), world.tokens.member, key).expect(201);
    const changed = await renew(selfInput(extra), world.tokens.member, key).expect(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await countRenewals()).toBe(1);
  });

  it('US-19-TC09: replay sau khi account bị gỡ liên kết hồ sơ -> 409 MEMBER_PROFILE_REQUIRED, không trả kết quả cũ', async () => {
    const key = randomUUID();
    await renew(selfInput(), world.tokens.member, key).expect(201);
    await world.connection.collection('members').updateOne({ _id: oid(world.memberId) }, { $unset: { account_id: '' } });
    const replay = await renew(selfInput(), world.tokens.member, key).expect(409);
    expect(replay.body.error.code).toBe('MEMBER_PROFILE_REQUIRED');
    expect(JSON.stringify(replay.body)).not.toContain('saleId');
  });

  it('US-19-TC09: Member tra cứu operation SALE_RENEW của chính mình sau mất response; Member khác không thấy', async () => {
    const key = randomUUID();
    const created = await renew(selfInput(), world.tokens.member, key).expect(201);
    const lookup = await request(server()).get(`/api/operations/SALE_RENEW/${key}`)
      .set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
    expect(lookup.body.responseBody).toEqual(created.body);
    await request(server()).get(`/api/operations/SALE_RENEW/${key}`)
      .set('Authorization', `Bearer ${world.tokens.otherMember}`).expect(404);
  });

  // ---------------- TC11 (phần không đồng thời; cạnh tranh với thanh toán làm ở bước 4) ----------------
  it('US-19-TC11: Member hủy kỳ gia hạn SELF_SERVICE đang chờ -> 200 CANCELLED, kỳ nguồn giữ nguyên, tạo lại được yêu cầu mới', async () => {
    const before = await api.findById('service_sales', source.saleId);
    const renewal = await renew(selfInput()).expect(201);
    const cancelled = await api.cancel(renewal.body.saleId, { version: 0, reason: 'Muốn đổi sang chuyển khoản' }).expect(200);
    expect(cancelled.body).toMatchObject({ saleId: renewal.body.saleId, transactionId: renewal.body.transactionId, status: 'CANCELLED' });
    expect((await api.findById('transactions', renewal.body.transactionId))!.status).toBe('CANCELLED');
    expect(await world.connection.collection('payments').countDocuments({ transaction_id: oid(renewal.body.transactionId) })).toBe(0);
    expect(await api.findById('service_sales', source.saleId)).toEqual(before);
    // F05: muốn sửa ý định thì hủy rồi tạo mới.
    await renew(selfInput({ preferredPaymentMethod: 'TRANSFER' })).expect(201);
  });

  it('US-19-TC11: kỳ gia hạn do quầy tạo cho chính hồ sơ của mình -> Member không được hủy (403)', async () => {
    const renewal = await counterRenew({ memberId: world.memberId, previousSaleId: source.saleId, planVersion: 0 }).expect(201);
    await api.cancel(renewal.body.saleId, { version: 0, reason: 'Không còn nhu cầu gia hạn' }).expect(403);
    expect((await api.findById('transactions', renewal.body.transactionId))!.status).toBe('PENDING');
  });

  it('US-19-TC11: kỳ gia hạn đã SETTLED -> 409 INVALID_TRANSACTION_STATE, gói mới vẫn còn', async () => {
    const renewal = await renew(selfInput()).expect(201);
    const settled = await api.confirmCash(renewal.body.transactionId).expect(200);
    const response = await api.cancel(renewal.body.saleId, { version: 1, reason: 'Không còn nhu cầu gia hạn' }).expect(409);
    expect(response.body.error.code).toBe('INVALID_TRANSACTION_STATE');
    expect((await api.findById('transactions', renewal.body.transactionId))!.status).toBe('SETTLED');
    expect((await api.findById('memberships', settled.body.membershipId))).not.toBeNull();
  });

  it('US-19-TC11: hủy kỳ gia hạn của hội viên khác -> 404, của họ vẫn PENDING', async () => {
    const foreignSource = await settledSource(world.otherMemberId);
    const foreign = await renew(selfInput({ previousSaleId: foreignSource.saleId }), world.tokens.otherMember).expect(201);
    await api.cancel(foreign.body.saleId, { version: 0, reason: 'Không còn nhu cầu gia hạn' }).expect(404);
    expect((await api.findById('transactions', foreign.body.transactionId))!.status).toBe('PENDING');
  });
});

describe('US-19 bước 2: chưa cấu hình tài khoản nhận chuyển khoản', () => {
  let started: Us18App;
  let world: Us18World;
  let source: Source;
  const { settledSource, renew, preview, countRenewals } = renewalHelpers(() => world);

  beforeAll(async () => {
    delete process.env.RECEIVING_ACCOUNT_DETAILS;
    started = await startUs18App('gym_management_test_us19_no_transfer', { RECEIVING_ACCOUNTS: '[]' });
  }, 600000);

  afterAll(async () => stopUs18App(started));

  beforeEach(async () => {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    world = await seedUs18World(started.app, started.connection);
    source = await settledSource(world.memberId);
  });

  afterEach(() => jest.restoreAllMocks());

  const selfInput = (extra: Record<string, unknown> = {}) => ({ previousSaleId: source.saleId, planVersion: 0,
    preferredPaymentMethod: 'CASH', ...extra });

  it('US-19-TC08: xem trước với TRANSFER -> 503 RECEIVING_ACCOUNTS_NOT_CONFIGURED', async () => {
    const response = await preview(selfInput({ preferredPaymentMethod: 'TRANSFER' })).expect(503);
    expect(response.body.error.code).toBe('RECEIVING_ACCOUNTS_NOT_CONFIGURED');
  });

  it('US-19-TC08: tạo với TRANSFER -> 503, không tạo kỳ gia hạn; chọn CASH thì tạo được', async () => {
    const response = await renew(selfInput({ preferredPaymentMethod: 'TRANSFER' })).expect(503);
    expect(response.body.error.code).toBe('RECEIVING_ACCOUNTS_NOT_CONFIGURED');
    expect(await countRenewals()).toBe(0);
    expect((await renew(selfInput()).expect(201)).body.transactionStatus).toBe('PENDING');
  });
});
