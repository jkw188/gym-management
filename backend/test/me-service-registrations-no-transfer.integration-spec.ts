// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-18 bước 2, TC08.
// App khởi động KHÔNG có tài khoản nhận chuyển khoản: chặn TRANSFER từ lúc tạo, CASH vẫn dùng được, không hiện tài khoản giả.
import { startUs18App, stopUs18App, seedUs18World, us18Api, Us18App, Us18World } from './helpers/us18-fixture';

// Hợp đồng test (sinh viên chốt 2026-11-15):
//   RECEIVING_ACCOUNTS=[] và không có RECEIVING_ACCOUNT_DETAILS:
//   preview/tạo với TRANSFER -> 503 RECEIVING_ACCOUNTS_NOT_CONFIGURED (mã US-22 đã dùng), không tạo sale; CASH vẫn 201.
//   Giao dịch cũ đã chọn TRANSFER -> payment-instructions vẫn 200, có cashInstruction, KHÔNG có transferOptions
//   (vắng mặt hoặc mảng rỗng), không có số tài khoản nào.

describe('US-18 bước 2: thiếu cấu hình tài khoản nhận chuyển khoản', () => {
  let started: Us18App;
  let world: Us18World;
  const api = us18Api(() => world);

  beforeAll(async () => {
    delete process.env.RECEIVING_ACCOUNT_DETAILS;
    started = await startUs18App('gym_management_test_us18_no_transfer', { RECEIVING_ACCOUNTS: '[]' });
  }, 600000);

  afterAll(async () => stopUs18App(started));

  beforeEach(async () => {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    world = await seedUs18World(started.app, started.connection);
  });

  afterEach(() => jest.restoreAllMocks());

  it('US-18-TC08: xem trước với TRANSFER -> 503 RECEIVING_ACCOUNTS_NOT_CONFIGURED', async () => {
    const response = await api.preview(api.selfInput({ preferredPaymentMethod: 'TRANSFER' })).expect(503);
    expect(response.body.error.code).toBe('RECEIVING_ACCOUNTS_NOT_CONFIGURED');
  });

  it('US-18-TC08: tạo với TRANSFER -> 503, không tạo sale; chọn CASH thì tạo được', async () => {
    const response = await api.register(api.selfInput({ preferredPaymentMethod: 'TRANSFER' })).expect(503);
    expect(response.body.error.code).toBe('RECEIVING_ACCOUNTS_NOT_CONFIGURED');
    expect(await api.count('service_sales')).toBe(0);
    expect(await api.count('transactions')).toBe(0);

    const cash = await api.register(api.selfInput({ preferredPaymentMethod: 'CASH' })).expect(201);
    expect(cash.body.transactionStatus).toBe('PENDING');
  });

  it('US-18-TC08: giao dịch cũ đã chọn TRANSFER -> hướng dẫn chỉ có tiền mặt, không có tài khoản giả', async () => {
    // Giả lập yêu cầu tạo lúc còn cấu hình: tạo CASH rồi đổi cách trả dự kiến đã lưu thành TRANSFER.
    const sale = await api.register().expect(201);
    await world.connection.collection('service_sales').updateOne({ _id: (await api.findById('service_sales', sale.body.saleId))!._id },
      { $set: { preferred_payment_method: 'TRANSFER' } });
    const response = await api.instructions(sale.body.transactionId).expect(200);
    expect(response.body).toMatchObject({ transactionCode: `TX-${sale.body.transactionId}`, amountDue: '300000', preferredPaymentMethod: 'TRANSFER' });
    expect(typeof response.body.cashInstruction).toBe('string');
    expect(response.body.cashInstruction.length).toBeGreaterThan(0);
    expect(response.body.transferOptions ?? []).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain('accountNumber');
  });
});
