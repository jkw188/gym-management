// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-18 bước 2.
// Kênh SELF_SERVICE, phương thức dự kiến, khóa idempotency, hướng dẫn thanh toán và Member tự hủy (TC01, TC05–TC07, TC09–TC12).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Types } from 'mongoose';
import { startUs18App, stopUs18App, seedUs18World, us18Api, Us18App, Us18World, TEST_RECEIVING_ACCOUNTS } from './helpers/us18-fixture';

// Hợp đồng test đặt ra cho Builder (US-18 bước 2, theo mục 1 và 2 của spec; sinh viên chốt 2026-11-15):
//   service_sales.channel = 'SELF_SERVICE' và service_sales.preferred_payment_method = CASH|TRANSFER do server ghi
//   khi Member tạo; 201 SaleResult có channel 'SELF_SERVICE'. Sale tại quầy không phải SELF_SERVICE.
//   Key SALE_REGISTER: cùng key + cùng body -> trả lại đúng kết quả; cùng key khác body (plan, ngày, cách trả) -> 409
//   IDEMPOTENCY_CONFLICT. Replay vẫn kiểm owner hiện hành (gỡ liên kết -> 409 MEMBER_PROFILE_REQUIRED).
//   GET /api/operations/SALE_REGISTER/:key: Member đọc được kết quả do chính mình tạo.
//   GET /api/me/transactions/:id/payment-instructions -> 200 {transactionCode, amountDue, preferredPaymentMethod,
//     cashInstruction, transferOptions?}; transferOptions mỗi phần tử ĐÚNG 5 field {receivingAccountCode, bankName,
//     accountNumber, accountName, transferContent = transactionCode}. Thông tin ngân hàng lấy từ biến môi trường mới
//     RECEIVING_ACCOUNT_DETAILS = JSON [{code,bankName,accountNumber,accountName}], code phải có trong RECEIVING_ACCOUNTS.
//     Không phải của mình/không có -> 404; id sai -> 400; amountDue 0 -> 409 NO_PAYMENT_REQUIRED;
//     không còn PENDING -> 409 INVALID_TRANSACTION_STATE; sai role -> 403.
//   POST /api/me/service-sales/:id/cancel (Idempotency-Key SALE_CANCEL) {version, reason 10–500} -> 200
//     {saleId, transactionId, status:'CANCELLED'}; chỉ sale SELF_SERVICE PENDING do chính account tạo.
//     Sale quầy của chính hồ sơ -> 403; đã SETTLED -> 409 INVALID_TRANSACTION_STATE; của người khác -> 404.
//   POST /api/transactions/:id/confirm-payment (US-22) với token Member -> 403.

describe('US-18 bước 2: kênh SELF_SERVICE, khóa yêu cầu, hướng dẫn thanh toán và tự hủy', () => {
  let started: Us18App;
  let world: Us18World;
  const api = us18Api(() => world);

  beforeAll(async () => {
    started = await startUs18App('gym_management_test_us18_channel', {
      RECEIVING_ACCOUNTS: JSON.stringify(TEST_RECEIVING_ACCOUNTS.map(account => account.code)),
      RECEIVING_ACCOUNT_DETAILS: JSON.stringify(TEST_RECEIVING_ACCOUNTS),
    });
  }, 600000);

  afterAll(async () => stopUs18App(started));

  beforeEach(async () => {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    world = await seedUs18World(started.app, started.connection);
  });

  afterEach(() => jest.restoreAllMocks());

  // ---------------- TC01 (phần kênh của bước 2) ----------------
  it.each(['CASH', 'TRANSFER'])('US-18-TC01: Member tạo với %s -> 201 channel SELF_SERVICE, server ghi channel, cách trả dự kiến và created_by', async method => {
    const sale = await api.register(api.selfInput({ preferredPaymentMethod: method })).expect(201);
    expect(sale.body.channel).toBe('SELF_SERVICE');
    const savedSale = await api.findById('service_sales', sale.body.saleId);
    expect(savedSale).toMatchObject({ channel: 'SELF_SERVICE', preferred_payment_method: method });
    const transaction = await api.findById('transactions', sale.body.transactionId);
    expect(transaction!.created_by.toHexString()).toBe(world.memberAccountId.toHexString());
    expect(transaction!.member_id.toHexString()).toBe(world.memberId);
  });

  it('US-18-TC01: sale tạo tại quầy không bị ghi là SELF_SERVICE', async () => {
    const sale = await api.counterSale().expect(201);
    const savedSale = await api.findById('service_sales', sale.body.saleId);
    expect(savedSale!.channel).not.toBe('SELF_SERVICE');
  });

  it.each([{ preferredPaymentMethod: 'MOMO' }, { preferredPaymentMethod: undefined }])(
    'US-18-TC01: preferredPaymentMethod %p không hợp lệ -> 400, không tạo sale', async extra => {
      await api.register(api.selfInput(extra)).expect(400);
      expect(await api.count('service_sales')).toBe(0);
    });

  // ---------------- TC05 ----------------
  it.each(['CASH', 'TRANSFER'])('US-18-TC05: gói giá > 0 chọn %s vẫn PENDING, chưa có membership/payment/invoice', async method => {
    const sale = await api.register(api.selfInput({ preferredPaymentMethod: method })).expect(201);
    expect(sale.body.transactionStatus).toBe('PENDING');
    expect(sale.body.membershipId).toBeUndefined();
    expect(sale.body.invoiceId).toBeUndefined();
    for (const collection of ['memberships', 'payments', 'invoices']) expect(await api.count(collection)).toBe(0);
  });

  it('US-18-TC05: Member gọi confirm-payment cho giao dịch của mình -> 403, giao dịch vẫn PENDING', async () => {
    const sale = await api.register().expect(201);
    await api.confirmCash(sale.body.transactionId, world.tokens.member).expect(403);
    expect((await api.findById('transactions', sale.body.transactionId))!.status).toBe('PENDING');
    for (const collection of ['memberships', 'payments', 'invoices']) expect(await api.count(collection)).toBe(0);
  });

  it('US-18-TC05: Member PATCH trạng thái SETTLED không được nhận, giao dịch vẫn PENDING', async () => {
    const sale = await api.register().expect(201);
    const response = await request(world.app.getHttpServer()).patch(`/api/transactions/${sale.body.transactionId}`)
      .set('Origin', 'http://localhost:5173').set('Authorization', `Bearer ${world.tokens.member}`).send({ status: 'SETTLED' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await api.findById('transactions', sale.body.transactionId))!.status).toBe('PENDING');
    expect(await api.count('memberships')).toBe(0);
  });

  // ---------------- TC06 ----------------
  it('US-18-TC06: gói 0đ hợp lệ -> SETTLED ngay, có invoice 0đ, membership, event; không có payment 0đ', async () => {
    await api.setPlanPrice('0');
    const sale = await api.register().expect(201);
    expect(sale.body).toMatchObject({ transactionStatus: 'SETTLED', amountDue: '0', channel: 'SELF_SERVICE' });
    expect(sale.body.membershipId).toBeDefined();
    expect(sale.body.invoiceId).toBeDefined();
    for (const collection of ['memberships', 'invoices', 'notifications']) expect(await api.count(collection)).toBe(1);
    expect(await api.count('payments')).toBe(0);
    const invoice = await world.connection.collection('invoices').findOne({});
    expect(invoice!.total_amount.toString()).toBe('0');
    const membership = await world.connection.collection('memberships').findOne({});
    expect(membership!.service_sale_id.toHexString()).toBe(sale.body.saleId);
  });

  // ---------------- TC07 ----------------
  it('US-18-TC07: hướng dẫn thanh toán CASH của giao dịch của mình lấy số tiền và mã từ server', async () => {
    const sale = await api.register().expect(201);
    const response = await api.instructions(sale.body.transactionId).expect(200);
    expect(response.body).toMatchObject({ transactionCode: `TX-${sale.body.transactionId}`, amountDue: '300000', preferredPaymentMethod: 'CASH' });
    expect(typeof response.body.cashInstruction).toBe('string');
    expect(response.body.cashInstruction.length).toBeGreaterThan(0);
  });

  it('US-18-TC07: hướng dẫn TRANSFER liệt kê đúng tài khoản cấu hình, nội dung chuyển khoản = mã giao dịch, không field thừa', async () => {
    const sale = await api.register(api.selfInput({ preferredPaymentMethod: 'TRANSFER' })).expect(201);
    const response = await api.instructions(sale.body.transactionId).expect(200);
    const code = `TX-${sale.body.transactionId}`;
    expect(response.body).toMatchObject({ transactionCode: code, amountDue: '300000', preferredPaymentMethod: 'TRANSFER' });
    expect(typeof response.body.cashInstruction).toBe('string');
    expect(response.body.transferOptions).toEqual(TEST_RECEIVING_ACCOUNTS.map(account => ({
      receivingAccountCode: account.code, bankName: account.bankName, accountNumber: account.accountNumber,
      accountName: account.accountName, transferContent: code,
    })));
  });

  it('US-18-TC07: không lộ khóa yêu cầu/hash nội bộ trong hướng dẫn', async () => {
    const sale = await api.register(api.selfInput({ preferredPaymentMethod: 'TRANSFER' })).expect(201);
    const text = JSON.stringify((await api.instructions(sale.body.transactionId).expect(200)).body);
    const transaction = await api.findById('transactions', sale.body.transactionId);
    expect(text).not.toContain(transaction!.request_key);
    for (const word of ['requestKey', 'request_key', 'hash', 'password', 'secret']) expect(text).not.toContain(word);
  });

  it('US-18-TC07: giao dịch của hội viên khác -> 404, không lộ số tiền', async () => {
    const foreign = await api.register(api.selfInput(), world.tokens.otherMember).expect(201);
    const response = await api.instructions(foreign.body.transactionId).expect(404);
    expect(JSON.stringify(response.body)).not.toContain('300000');
    expect(response.body.error).toBeDefined();
  });

  it('US-18-TC07: id không tồn tại -> 404, id sai định dạng -> 400', async () => {
    await api.instructions(new Types.ObjectId().toHexString()).expect(404);
    await api.instructions('not-an-id').expect(400);
  });

  it.each(['STAFF', 'ADMIN', 'TRAINER'] as const)('US-18-TC07: role %s gọi hướng dẫn cá nhân -> 403', async role => {
    const sale = await api.register().expect(201);
    await api.instructions(sale.body.transactionId, world.tokens[role]).expect(403);
  });

  it('US-18-TC07: giao dịch 0đ đã hoàn tất -> 409 NO_PAYMENT_REQUIRED', async () => {
    await api.setPlanPrice('0');
    const sale = await api.register().expect(201);
    expect((await api.instructions(sale.body.transactionId).expect(409)).body.error.code).toBe('NO_PAYMENT_REQUIRED');
  });

  it('US-18-TC07: giao dịch đã hủy (không còn PENDING) -> 409 INVALID_TRANSACTION_STATE', async () => {
    const sale = await api.register().expect(201);
    await api.cancel(sale.body.saleId, { version: 0, reason: 'Đổi ý, chưa muốn mua' }).expect(200);
    expect((await api.instructions(sale.body.transactionId).expect(409)).body.error.code).toBe('INVALID_TRANSACTION_STATE');
  });

  // ---------------- TC09 ----------------
  it('US-18-TC09: gửi lại cùng key và cùng body (mất response) -> cùng kết quả, chỉ một sale', async () => {
    const key = randomUUID();
    const first = await api.register(api.selfInput(), world.tokens.member, key).expect(201);
    const again = await api.register(api.selfInput(), world.tokens.member, key).expect(201);
    expect(again.body).toEqual(first.body);
    expect(await api.count('service_sales')).toBe(1);
    expect(await api.count('transactions')).toBe(1);
  });

  it('US-18-TC09: hai request cùng key gửi đồng thời -> cùng một sale', async () => {
    const key = randomUUID();
    const responses = await Promise.all([
      api.register(api.selfInput(), world.tokens.member, key),
      api.register(api.selfInput(), world.tokens.member, key),
    ]);
    expect(responses.map(row => row.status)).toEqual([201, 201]);
    expect(responses[1].body).toEqual(responses[0].body);
    expect(await api.count('service_sales')).toBe(1);
  });

  it.each([
    ['đổi gói', async (w: Us18World) => {
      const { getModelToken } = await import('@nestjs/mongoose');
      const { toVndDecimal } = await import('../src/common/utils/vnd-money');
      const pt = await w.app.get(getModelToken('Plan')).create({ code: 'PT30', name: 'PT 30 ngày', kind: 'PT', duration_days: 30,
        session_quota: 10, price: toVndDecimal('1000000'), benefits: '10 buổi PT', status: 'ACTIVE', created_by: w.adminId, updated_by: w.adminId });
      return { planId: pt._id.toHexString() };
    }],
    ['đổi ngày bắt đầu', async () => ({ startDate: '2026-11-02' })],
    ['đổi cách trả dự kiến', async () => ({ preferredPaymentMethod: 'TRANSFER' })],
  ])('US-18-TC09: cùng key nhưng %s -> 409 IDEMPOTENCY_CONFLICT, không tạo sale thứ hai', async (_case, change) => {
    const key = randomUUID();
    await api.register(api.selfInput(), world.tokens.member, key).expect(201);
    const changed = await api.register(api.selfInput(await change(world)), world.tokens.member, key).expect(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await api.count('service_sales')).toBe(1);
  });

  it('US-18-TC09: replay sau khi account bị gỡ liên kết hồ sơ -> 409 MEMBER_PROFILE_REQUIRED, không trả kết quả cũ', async () => {
    const key = randomUUID();
    await api.register(api.selfInput(), world.tokens.member, key).expect(201);
    await world.connection.collection('members').updateOne({ _id: new Types.ObjectId(world.memberId) }, { $unset: { account_id: '' } });
    const replay = await api.register(api.selfInput(), world.tokens.member, key).expect(409);
    expect(replay.body.error.code).toBe('MEMBER_PROFILE_REQUIRED');
    expect(JSON.stringify(replay.body)).not.toContain('saleId');
  });

  it('US-18-TC09: Member tra cứu operation SALE_REGISTER của chính mình sau mất response; Member khác không thấy', async () => {
    const key = randomUUID();
    const created = await api.register(api.selfInput(), world.tokens.member, key).expect(201);
    const lookup = await request(world.app.getHttpServer()).get(`/api/operations/SALE_REGISTER/${key}`)
      .set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
    expect(lookup.body.responseBody).toEqual(created.body);
    await request(world.app.getHttpServer()).get(`/api/operations/SALE_REGISTER/${key}`)
      .set('Authorization', `Bearer ${world.tokens.otherMember}`).expect(404);
  });

  // ---------------- TC10 ----------------
  it('US-18-TC10: quầy và Member tạo đồng thời khác key cho cùng hội viên/loại gói -> chỉ một PENDING', async () => {
    const results = await Promise.all([api.counterSale(), api.register()]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    expect(results.find(row => row.status === 409)!.body.error.code).toBe('PENDING_SALE_EXISTS');
    expect(await api.count('service_sales')).toBe(1);
    expect(await world.connection.collection('transactions').countDocuments({ status: 'PENDING' })).toBe(1);
  });

  it('US-18-TC10: Member đã có yêu cầu chờ thì quầy tạo thêm cùng loại -> 409 PENDING_SALE_EXISTS', async () => {
    await api.register().expect(201);
    expect((await api.counterSale().expect(409)).body.error.code).toBe('PENDING_SALE_EXISTS');
    expect(await api.count('service_sales')).toBe(1);
  });

  // ---------------- TC11 ----------------
  it('US-18-TC11: Member hủy yêu cầu SELF_SERVICE đang chờ của mình -> 200 CANCELLED, giữ lịch sử, không hoàn tiền', async () => {
    const sale = await api.register().expect(201);
    const key = randomUUID();
    const body = { version: 0, reason: 'Chọn sai ngày bắt đầu' };
    const cancelled = await api.cancel(sale.body.saleId, body, world.tokens.member, key).expect(200);
    expect(cancelled.body).toMatchObject({ saleId: sale.body.saleId, transactionId: sale.body.transactionId, status: 'CANCELLED' });
    // Gửi lại cùng key -> cùng kết quả.
    expect((await api.cancel(sale.body.saleId, body, world.tokens.member, key).expect(200)).body).toEqual(cancelled.body);
    const transaction = await api.findById('transactions', sale.body.transactionId);
    expect(transaction).toMatchObject({ status: 'CANCELLED', cancel_reason: body.reason });
    expect(transaction!.cancelled_by.toHexString()).toBe(world.memberAccountId.toHexString());
    expect(await api.count('service_sales')).toBe(1);
    expect(await api.count('payments')).toBe(0);
  });

  it('US-18-TC11: lý do dưới 10 ký tự -> 400; version cũ -> 409 VERSION_CONFLICT; giao dịch vẫn PENDING', async () => {
    const sale = await api.register().expect(201);
    await api.cancel(sale.body.saleId, { version: 0, reason: 'ngắn' }).expect(400);
    expect((await api.cancel(sale.body.saleId, { version: 1, reason: 'Không còn nhu cầu' }).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
    expect((await api.findById('transactions', sale.body.transactionId))!.status).toBe('PENDING');
  });

  it('US-18-TC11: sale do quầy tạo cho chính hồ sơ của mình -> Member không được hủy (403)', async () => {
    const sale = await api.counterSale().expect(201);
    await api.cancel(sale.body.saleId, { version: 0, reason: 'Không còn nhu cầu' }).expect(403);
    expect((await api.findById('transactions', sale.body.transactionId))!.status).toBe('PENDING');
  });

  it('US-18-TC11: sale đã SETTLED (gói 0đ) -> 409 INVALID_TRANSACTION_STATE, gói vẫn còn', async () => {
    await api.setPlanPrice('0');
    const sale = await api.register().expect(201);
    expect((await api.cancel(sale.body.saleId, { version: 1, reason: 'Không còn nhu cầu' }).expect(409)).body.error.code)
      .toBe('INVALID_TRANSACTION_STATE');
    expect((await api.findById('transactions', sale.body.transactionId))!.status).toBe('SETTLED');
    expect((await world.connection.collection('memberships').findOne({}))!.status).toBe('ACTIVE');
  });

  it('US-18-TC11: hủy yêu cầu của hội viên khác -> 404, yêu cầu của họ vẫn PENDING', async () => {
    const foreign = await api.register(api.selfInput(), world.tokens.otherMember).expect(201);
    await api.cancel(foreign.body.saleId, { version: 0, reason: 'Không còn nhu cầu' }).expect(404);
    expect((await api.findById('transactions', foreign.body.transactionId))!.status).toBe('PENDING');
  });

  it.each(['STAFF', 'ADMIN', 'TRAINER'] as const)('US-18-TC11: role %s gọi API tự hủy của Member -> 403', async role => {
    const sale = await api.register().expect(201);
    await api.cancel(sale.body.saleId, { version: 0, reason: 'Không còn nhu cầu' }, world.tokens[role]).expect(403);
    expect((await api.findById('transactions', sale.body.transactionId))!.status).toBe('PENDING');
  });

  // ---------------- TC12 (phần API; phần submit kép trên giao diện thuộc bước 3) ----------------
  it('US-18-TC12: Member hủy và Staff xác nhận thu cùng lúc -> chỉ một kết quả cuối, dữ liệu nhất quán', async () => {
    const sale = await api.register().expect(201);
    const [cancelled, confirmed] = await Promise.all([
      api.cancel(sale.body.saleId, { version: 0, reason: 'Đổi ý, chưa muốn mua' }),
      api.confirmCash(sale.body.transactionId),
    ]);
    const statuses = [cancelled.status, confirmed.status].sort();
    expect(statuses).toEqual([200, 409]);
    const transaction = await api.findById('transactions', sale.body.transactionId);
    if (cancelled.status === 200) {
      expect(transaction!.status).toBe('CANCELLED');
      expect(await api.count('payments')).toBe(0);
      expect(await api.count('memberships')).toBe(0);
    } else {
      expect(transaction!.status).toBe('SETTLED');
      expect(await api.count('payments')).toBe(1);
      expect(await api.count('memberships')).toBe(1);
    }
  });

  it('US-18-TC12: Staff đã thu xong thì Member hủy -> 409, không tự hoàn tiền', async () => {
    const sale = await api.register().expect(201);
    await api.confirmCash(sale.body.transactionId).expect(200);
    const transaction = await api.findById('transactions', sale.body.transactionId);
    await api.cancel(sale.body.saleId, { version: transaction!.version, reason: 'Đổi ý, chưa muốn mua' }).expect(409);
    expect((await api.findById('transactions', sale.body.transactionId))!.status).toBe('SETTLED');
    expect(await world.connection.collection('payments').countDocuments({ status: 'SUCCEEDED' })).toBe(1);
  });
});
