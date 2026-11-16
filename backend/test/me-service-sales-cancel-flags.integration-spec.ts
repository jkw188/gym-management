// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-18 bước 3 (phần backend nhỏ).
// Lịch sử mua của Member cho biết yêu cầu nào được tự hủy (canCancel do server tính) và version để gửi lệnh hủy (TC11).
import { Types } from 'mongoose';
import request from 'supertest';
import { startUs18App, stopUs18App, seedUs18World, us18Api, Us18App, Us18World, TEST_RECEIVING_ACCOUNTS } from './helpers/us18-fixture';

// Hợp đồng test (sinh viên chốt 2026-11-15):
//   GET /api/me/service-sales (items) và GET /api/me/service-sales/:id (US-17) trả thêm:
//     channel: 'COUNTER' | 'SELF_SERVICE'
//     canCancel: boolean   – server tính: channel SELF_SERVICE + giao dịch do chính account tạo + status PENDING
//     transactionVersion: number – version hiện tại của giao dịch, dùng làm body.version khi hủy
//   Không trả created_by/createdBy, request_key hay hash.

describe('US-18 bước 3: lịch sử mua có canCancel và transactionVersion cho giao diện tự hủy', () => {
  let started: Us18App;
  let world: Us18World;
  const api = us18Api(() => world);

  beforeAll(async () => {
    started = await startUs18App('gym_management_test_us18_flags', {
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

  const list = (token = world.tokens.member) => request(world.app.getHttpServer()).get('/api/me/service-sales')
    .set('Authorization', `Bearer ${token}`);
  const detail = (id: string) => request(world.app.getHttpServer()).get(`/api/me/service-sales/${id}`)
    .set('Authorization', `Bearer ${world.tokens.member}`);
  const itemOf = async (saleId: string) => ((await list().expect(200)).body.items as Array<Record<string, unknown>>)
    .find(item => item.id === saleId)!;

  it('US-18-TC11: yêu cầu SELF_SERVICE đang chờ của mình -> canCancel=true, channel SELF_SERVICE, transactionVersion 0', async () => {
    const sale = await api.register().expect(201);
    expect(await itemOf(sale.body.saleId)).toMatchObject({ channel: 'SELF_SERVICE', canCancel: true, transactionVersion: 0, status: 'PENDING' });
    expect((await detail(sale.body.saleId).expect(200)).body).toMatchObject({ channel: 'SELF_SERVICE', canCancel: true, transactionVersion: 0 });
  });

  it('US-18-TC11: sale do quầy tạo cho chính hồ sơ của mình -> canCancel=false, channel COUNTER', async () => {
    const sale = await api.counterSale().expect(201);
    expect(await itemOf(sale.body.saleId)).toMatchObject({ channel: 'COUNTER', canCancel: false, status: 'PENDING' });
    expect((await detail(sale.body.saleId).expect(200)).body).toMatchObject({ channel: 'COUNTER', canCancel: false });
  });

  it('US-18-TC11: dùng transactionVersion từ lịch sử để hủy -> 200; sau đó CANCELLED, canCancel=false, version tăng', async () => {
    const sale = await api.register().expect(201);
    const before = await itemOf(sale.body.saleId);
    await api.cancel(sale.body.saleId, { version: before.transactionVersion, reason: 'Chọn sai ngày bắt đầu' }).expect(200);
    expect(await itemOf(sale.body.saleId)).toMatchObject({ status: 'CANCELLED', canCancel: false, transactionVersion: 1 });
  });

  it('US-18-TC11: gói 0đ đã SETTLED -> canCancel=false', async () => {
    await api.setPlanPrice('0');
    const sale = await api.register().expect(201);
    expect(await itemOf(sale.body.saleId)).toMatchObject({ status: 'SETTLED', canCancel: false, channel: 'SELF_SERVICE' });
  });

  it('US-18-TC11: Staff đã thu xong -> canCancel=false', async () => {
    const sale = await api.register().expect(201);
    await api.confirmCash(sale.body.transactionId).expect(200);
    expect(await itemOf(sale.body.saleId)).toMatchObject({ status: 'SETTLED', canCancel: false });
  });

  it('US-18-TC11: yêu cầu SELF_SERVICE không do account hiện tại tạo -> canCancel=false', async () => {
    // Hồ sơ đổi sang account khác: yêu cầu cũ vẫn thuộc hồ sơ nhưng không do account mới tạo.
    const sale = await api.register().expect(201);
    await world.connection.collection('transactions').updateOne({ _id: new Types.ObjectId(sale.body.transactionId) },
      { $set: { created_by: new Types.ObjectId() } });
    expect(await itemOf(sale.body.saleId)).toMatchObject({ channel: 'SELF_SERVICE', canCancel: false });
  });

  it('US-18-TC11: lịch sử không lộ người tạo, khóa yêu cầu hay hash', async () => {
    const sale = await api.register().expect(201);
    const text = JSON.stringify((await list().expect(200)).body) + JSON.stringify((await detail(sale.body.saleId).expect(200)).body);
    const transaction = await api.findById('transactions', sale.body.transactionId);
    expect(text).not.toContain(transaction!.request_key);
    expect(text).not.toContain(world.memberAccountId.toHexString());
    for (const word of ['createdBy', 'created_by', 'requestKey', 'request_key', 'hash']) expect(text).not.toContain(word);
  });
});
