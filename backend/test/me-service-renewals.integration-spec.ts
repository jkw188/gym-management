// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-19 bước 1.
// Member tự xem trước/tạo kỳ gia hạn qua /api/me/service-renewals, dùng chung RenewalService của US-15 (TC01–TC03, TC05).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Types } from 'mongoose';
import { startUs18App, stopUs18App, seedUs18World, us18Api, Us18App, Us18World } from './helpers/us18-fixture';

// Hợp đồng test đặt ra cho Builder (US-19 bước 1, theo mục 1 và 2 của spec):
//   POST /api/me/service-renewals/preview  MEMBER; {previousSaleId,planVersion,preferredPaymentMethod}
//        -> kết quả giống hệt POST /api/service-renewals/preview của US-15 cho cùng hồ sơ; không tạo gì.
//   POST /api/me/service-renewals          MEMBER; Idempotency-Key; cùng input -> 201 SaleResult
//        {operation:'RENEW', previousSaleId, channel:'SELF_SERVICE', transactionStatus:'PENDING', ...}.
//   Member lấy từ members.account_id = principal; chưa liên kết -> 409 MEMBER_PROFILE_REQUIRED.
//   Nguồn của người khác hoặc không tồn tại -> 404. Sai role -> 403, không token -> 401.
//   Lỗi nguồn/gói dùng lại US-15: SOURCE_NOT_ELIGIBLE, SOURCE_NOT_LATEST, PLAN_CHANGED, PLAN_NOT_AVAILABLE.
//   Field thừa (TC04), preferred_payment_method, khóa SALE_RENEW và hủy thuộc bước 2.
//
// Dữ liệu: hôm nay 2026-11-01 (giờ VN). Kỳ nguồn GYM30 300000đ bán tại quầy từ 2026-11-01 đến 2026-11-30 rồi đã thu
// (SETTLED) -> kỳ gia hạn dự kiến 2026-12-01 đến 2026-12-30.

describe('US-19 bước 1: Member tự gia hạn qua RenewalService dùng chung', () => {
  let started: Us18App;
  let world: Us18World;
  const api = us18Api(() => world);
  let source: { saleId: string; transactionId: string; membershipId: string };

  beforeAll(async () => {
    started = await startUs18App('gym_management_test_us19', {});
  }, 600000);

  afterAll(async () => stopUs18App(started));

  beforeEach(async () => {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    world = await seedUs18World(started.app, started.connection);
    source = await settledSource(world.memberId);
  });

  afterEach(() => jest.restoreAllMocks());

  const server = () => world.app.getHttpServer();
  const oid = (id: string) => new Types.ObjectId(id);

  // Quầy bán gói cho một hồ sơ rồi Staff xác nhận thu -> kỳ nguồn SETTLED có membership.
  async function settledSource(memberId: string) {
    const sale = await api.counterSale(api.counterInput({ memberId })).expect(201);
    const settled = await api.confirmCash(sale.body.transactionId).expect(200);
    return { saleId: sale.body.saleId as string, transactionId: sale.body.transactionId as string,
      membershipId: settled.body.membershipId as string };
  }

  // Body đúng hợp đồng của Member: không có memberId.
  const selfInput = (extra: Record<string, unknown> = {}) => ({ previousSaleId: source.saleId, planVersion: 0,
    preferredPaymentMethod: 'CASH', ...extra });
  // Body của quầy (US-15) cho cùng hồ sơ, để so sánh hai kênh.
  const counterInput = (extra: Record<string, unknown> = {}) => ({ memberId: world.memberId, previousSaleId: source.saleId,
    planVersion: 0, ...extra });

  const self = (path: string, body: Record<string, unknown>, token: string = world.tokens.member, key: string = randomUUID()) =>
    request(server()).post(`/api/me/service-renewals${path}`).set('Origin', 'http://localhost:5173')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
  const counter = (path: string, body: Record<string, unknown>, key: string = randomUUID()) =>
    request(server()).post(`/api/service-renewals${path}`).set('Origin', 'http://localhost:5173')
      .set('Authorization', `Bearer ${world.tokens.STAFF}`).set('Idempotency-Key', key).send(body);
  const countRenewals = () => world.connection.collection('service_sales').countDocuments({ operation: 'RENEW' });

  // ---------------- TC01 ----------------
  it('US-19-TC01: Member gia hạn kỳ đuôi của mình -> 201 RENEW, channel SELF_SERVICE, gắn đúng hồ sơ và created_by', async () => {
    const renewal = await self('', selfInput()).expect(201);
    expect(renewal.body).toMatchObject({ operation: 'RENEW', previousSaleId: source.saleId, channel: 'SELF_SERVICE',
      transactionStatus: 'PENDING', amountDue: '300000', creditAmount: '0' });

    const savedSale = await api.findById('service_sales', renewal.body.saleId);
    expect(savedSale).toMatchObject({ operation: 'RENEW', channel: 'SELF_SERVICE' });
    expect(savedSale!.member_id.toHexString()).toBe(world.memberId);
    const transaction = await api.findById('transactions', renewal.body.transactionId);
    expect(transaction!.member_id.toHexString()).toBe(world.memberId);
    expect(transaction!.created_by.toHexString()).toBe(world.memberAccountId.toHexString());
    expect(transaction!.status).toBe('PENDING');
  });

  it('US-19-TC01: tạo kỳ gia hạn chưa cấp gói mới và không sửa kỳ nguồn; Member đọc lại được qua API US-17', async () => {
    const before = await api.findById('service_sales', source.saleId);
    const renewal = await self('', selfInput()).expect(201);
    expect(renewal.body.membershipId).toBeUndefined();
    expect(await world.connection.collection('memberships').countDocuments({ service_sale_id: oid(renewal.body.saleId) })).toBe(0);
    expect(await world.connection.collection('payments').countDocuments({ transaction_id: oid(renewal.body.transactionId) })).toBe(0);
    expect(await api.findById('service_sales', source.saleId)).toEqual(before);

    await request(server()).get(`/api/me/service-sales/${renewal.body.saleId}`)
      .set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
  });

  it('US-19-TC01: preview của Member chỉ đọc, không tạo sale/transaction/operation', async () => {
    const counts = async () => Promise.all(['service_sales', 'transactions', 'memberships', 'operation_requests']
      .map(name => world.connection.collection(name).countDocuments()));
    const before = await counts();
    const preview = await self('/preview', selfInput()).expect(200);
    expect(preview.body).toMatchObject({ previousSaleId: source.saleId, amountDue: '300000', sourceEndDate: '2026-11-30',
      expectedStartDate: '2026-12-01', expectedEndDate: '2026-12-30', canProceed: true });
    expect(await counts()).toEqual(before);
  });

  // ---------------- TC02 ----------------
  it('US-19-TC02: nguồn của hội viên khác -> 404 ở preview và tạo, không lộ thông tin nguồn đó', async () => {
    const foreign = await settledSource(world.otherMemberId);
    // Điều kiện trước: nguồn của chính mình xem được, để chắc 404 bên dưới là do không thuộc chủ thể chứ không phải thiếu route.
    await self('/preview', selfInput()).expect(200);
    for (const path of ['/preview', '']) {
      const response = await self(path, selfInput({ previousSaleId: foreign.saleId })).expect(404);
      expect(JSON.stringify(response.body)).not.toContain(world.otherMemberId);
      expect(JSON.stringify(response.body)).not.toContain(foreign.transactionId);
    }
    expect(await countRenewals()).toBe(0);
  });

  it('US-19-TC02: previousSaleId không tồn tại -> 404', async () => {
    await self('/preview', selfInput()).expect(200);
    await self('', selfInput({ previousSaleId: new Types.ObjectId().toHexString() })).expect(404);
    expect(await countRenewals()).toBe(0);
  });

  it('US-19-TC02: account MEMBER chưa liên kết hồ sơ -> 409 MEMBER_PROFILE_REQUIRED, không tạo sale', async () => {
    for (const path of ['/preview', '']) {
      const response = await self(path, selfInput(), world.tokens.unlinked).expect(409);
      expect(response.body.error.code).toBe('MEMBER_PROFILE_REQUIRED');
    }
    expect(await countRenewals()).toBe(0);
  });

  it.each(['STAFF', 'ADMIN', 'TRAINER'] as const)('US-19-TC02: role %s gọi API cá nhân -> 403, không tạo sale', async role => {
    await self('/preview', selfInput(), world.tokens[role]).expect(403);
    await self('', selfInput(), world.tokens[role]).expect(403);
    expect(await countRenewals()).toBe(0);
  });

  it('US-19-TC02: không có token -> 401', async () => {
    await request(server()).post('/api/me/service-renewals/preview').set('Origin', 'http://localhost:5173').send(selfInput()).expect(401);
    await request(server()).post('/api/me/service-renewals').set('Origin', 'http://localhost:5173')
      .set('Idempotency-Key', randomUUID()).send(selfInput()).expect(401);
    expect(await countRenewals()).toBe(0);
  });

  // ---------------- TC03 ----------------
  // Mỗi trường hợp: đưa dữ liệu vào trạng thái không hợp lệ, rồi self và quầy phải trả cùng status + mã lỗi US-15.
  const sourceCases: [string, string, () => Promise<Record<string, unknown>>][] = [
    ['membership nguồn SUPERSEDED', 'SOURCE_NOT_ELIGIBLE', async () => {
      await world.connection.collection('memberships').updateOne({ _id: oid(source.membershipId) }, { $set: { status: 'SUPERSEDED' } });
      return {};
    }],
    ['membership nguồn CANCELLED', 'SOURCE_NOT_ELIGIBLE', async () => {
      await world.connection.collection('memberships').updateOne({ _id: oid(source.membershipId) }, { $set: { status: 'CANCELLED' } });
      return {};
    }],
    ['giao dịch nguồn còn PENDING', 'SOURCE_NOT_ELIGIBLE', async () => {
      await world.connection.collection('transactions').updateOne({ _id: oid(source.transactionId) }, { $set: { status: 'PENDING' } });
      return {};
    }],
    ['nguồn cũ đã có kỳ gia hạn SETTLED phía sau', 'SOURCE_NOT_LATEST', async () => {
      const next = await counter('', counterInput()).expect(201);
      await api.confirmCash(next.body.transactionId).expect(200);
      return {};
    }],
    ['gói ngừng bán (INACTIVE)', 'PLAN_NOT_AVAILABLE', async () => {
      await world.connection.collection('plans').updateOne({ _id: world.plan._id }, { $set: { status: 'INACTIVE' } });
      return {};
    }],
    ['planVersion cũ', 'PLAN_CHANGED', async () => {
      await world.connection.collection('plans').updateOne({ _id: world.plan._id }, { $inc: { version: 1 } });
      return { planVersion: 0 };
    }],
  ];

  it.each(sourceCases)('US-19-TC03: %s -> 409 %s ở bước tạo, giống hệt quầy', async (_case, code, arrange) => {
    const extra = await arrange();
    const renewalsBefore = await countRenewals();
    const fromSelf = await self('', selfInput(extra));
    const fromCounter = await counter('', counterInput(extra));
    expect(fromSelf.status).toBe(409);
    expect(fromSelf.body.error.code).toBe(code);
    expect(fromSelf.status).toBe(fromCounter.status);
    expect(fromSelf.body.error.code).toBe(fromCounter.body.error.code);
    expect(await countRenewals()).toBe(renewalsBefore);
  });

  it.each(sourceCases)('US-19-TC03: %s -> preview của Member giống hệt preview của quầy', async (_case, _code, arrange) => {
    const extra = await arrange();
    const fromSelf = await self('/preview', selfInput(extra));
    const fromCounter = await counter('/preview', counterInput(extra));
    expect(fromSelf.status).toBe(fromCounter.status);
    if (fromCounter.status === 200) expect(fromSelf.body).toEqual(fromCounter.body);
    else expect(fromSelf.body.error.code).toBe(fromCounter.body.error.code);
  });

  it('US-19-TC03: đã có sale PENDING cùng loại (tạo tại quầy) -> 409 PENDING_SALE_EXISTS', async () => {
    await counter('', counterInput()).expect(201);
    expect((await self('', selfInput()).expect(409)).body.error.code).toBe('PENDING_SALE_EXISTS');
    expect(await countRenewals()).toBe(1);
  });

  // ---------------- TC05 ----------------
  it('US-19-TC05: cùng dữ liệu, preview của Member và của quầy trả cùng amountDue và ngày dự kiến', async () => {
    const fromSelf = await self('/preview', selfInput()).expect(200);
    const fromCounter = await counter('/preview', counterInput()).expect(200);
    expect(fromSelf.body).toEqual(fromCounter.body);
  });

  it('US-19-TC05: kỳ tự gia hạn sau khi Staff thu có cùng giá, thời hạn và ngày như quầy dự kiến', async () => {
    const quote = (await counter('/preview', counterInput()).expect(200)).body;
    const renewal = await self('', selfInput()).expect(201);
    expect(renewal.body.amountDue).toBe(quote.amountDue);
    expect(renewal.body.durationDays).toBe(30);
    const settled = await api.confirmCash(renewal.body.transactionId).expect(200);
    expect(settled.body).toMatchObject({ startDate: quote.expectedStartDate, endDate: quote.expectedEndDate });
    expect(settled.body).toMatchObject({ startDate: '2026-12-01', endDate: '2026-12-30' });
  });
});
