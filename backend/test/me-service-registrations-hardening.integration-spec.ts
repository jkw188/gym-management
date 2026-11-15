// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật, 2 instance ứng dụng): US-18 bước 4.
// Làm chắc: quầy và Member dùng chung luật/snapshot, đúng chủ, gói 0đ rollback, tranh chấp cùng loại và gửi lại khi mất response.
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { toVndDecimal } from '../src/common/utils/vnd-money';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { Plan } from '../src/modules/plans/schemas/plan.schema';
import { origin, startUs18App, stopUs18App, seedUs18World, us18Api, Us18App, Us18World, TEST_RECEIVING_ACCOUNTS } from './helpers/us18-fixture';

// Không có hợp đồng mới: chỉ dùng các API đã chốt ở bước 1–3. Instance thứ hai dùng chung database để kiểm khóa thật.

describe('US-18 bước 4: làm chắc luật dùng chung, chủ sở hữu, gói 0đ, tranh chấp và gửi lại', () => {
  let started: Us18App;
  let world: Us18World;
  const api = us18Api(() => world);

  beforeAll(async () => {
    started = await startUs18App('gym_management_test_us18_hardening', {
      RECEIVING_ACCOUNTS: JSON.stringify(TEST_RECEIVING_ACCOUNTS.map(account => account.code)),
      RECEIVING_ACCOUNT_DETAILS: JSON.stringify(TEST_RECEIVING_ACCOUNTS),
    }, 2);
  }, 600000);

  afterAll(async () => stopUs18App(started));

  beforeEach(async () => {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    world = await seedUs18World(started.app, started.connection);
  });

  afterEach(() => jest.restoreAllMocks());

  // Gọi API trên instance thứ hai (B).
  const onB = () => request(started.apps[1].getHttpServer());
  const registerOnB = (body = api.selfInput(), key: string = randomUUID()) => onB().post('/api/me/service-registrations')
    .set('Origin', origin).set('Authorization', `Bearer ${world.tokens.member}`).set('Idempotency-Key', key).send(body);
  const confirmOnB = (transactionId: string) => onB().post(`/api/transactions/${transactionId}/confirm-payment`)
    .set('Origin', origin).set('Authorization', `Bearer ${world.tokens.STAFF}`).set('Idempotency-Key', randomUUID())
    .send({ method: 'CASH', amount: '300000', evidenceNote: 'Đã đếm đủ tiền mặt thực nhận' });
  const plans = () => world.app.get<Model<Plan>>(getModelToken('Plan'));
  const saleOf = (id: string) => api.findById('service_sales', id);

  // ---------------- TC03 / TC04: cùng luật, cùng snapshot ----------------
  it('US-18-TC04: sale Member tự tạo và sale quầy tạo cho cùng gói có snapshot giá/ngày/chính sách giống nhau', async () => {
    const self = await api.register().expect(201);
    // Hội viên khác mua tại quầy cùng gói, cùng ngày.
    const counter = await api.counterSale(api.counterInput({ memberId: world.otherMemberId })).expect(201);

    const selfSale = await saleOf(self.body.saleId);
    const counterSale = await saleOf(counter.body.saleId);
    for (const field of ['plan_name_snapshot', 'benefits_snapshot', 'policy_snapshot', 'start_date', 'end_date',
      'requested_start_date', 'duration_days_snapshot', 'kind_snapshot', 'plan_version_snapshot', 'operation']) {
      expect(selfSale![field]).toEqual(counterSale![field]);
    }
    expect(selfSale!.list_price_snapshot.toString()).toBe(counterSale!.list_price_snapshot.toString());
    expect(self.body.amountDue).toBe(counter.body.amountDue);
    expect(self.body.endDate).toBe(counter.body.endDate);
    expect(JSON.parse(selfSale!.policy_snapshot)).toMatchObject({ rule: 'REGISTER_V1', durationDays: 30, dayInclusive: true });
  });

  it.each([
    ['00:30 ngày 02/11 giờ VN, chọn 01/11 (đã qua theo giờ VN)', '2026-11-01T17:30:00Z', '2026-11-01', 'reject'],
    ['00:30 ngày 02/11 giờ VN, chọn 02/11 (hôm nay theo giờ VN)', '2026-11-01T17:30:00Z', '2026-11-02', 'accept'],
    ['23:30 ngày 01/11 giờ VN, chọn 01/11 (vẫn là hôm nay)', '2026-11-01T16:30:00Z', '2026-11-01', 'accept'],
  ])('US-18-TC03: biên ngày theo giờ Việt Nam lúc %s → Member và quầy cùng kết quả', async (_case, nowIso, startDate, expected) => {
    started.setNow(new Date(nowIso));
    const fromSelf = await api.register(api.selfInput({ startDate }));
    const fromCounter = await api.counterSale(api.counterInput({ memberId: world.otherMemberId, startDate }));
    expect(fromSelf.status).toBe(fromCounter.status);
    if (expected === 'accept') {
      expect(fromSelf.status).toBe(201);
      expect(fromSelf.body.endDate).toBe(fromCounter.body.endDate);
    } else {
      expect([400, 409]).toContain(fromSelf.status);
      expect(fromSelf.body.error.code).toBe(fromCounter.body.error.code);
    }
  });

  // ---------------- TC02 / TC09: chủ sở hữu khi gửi lại ----------------
  it('US-18-TC09: Member khác dùng trùng Idempotency-Key → tạo sale riêng cho hồ sơ của họ, không nhận kết quả của người kia', async () => {
    const key = randomUUID();
    const mine = await api.register(api.selfInput(), world.tokens.member, key).expect(201);
    const theirs = await api.register(api.selfInput(), world.tokens.otherMember, key).expect(201);
    expect(theirs.body.saleId).not.toBe(mine.body.saleId);
    expect((await saleOf(theirs.body.saleId))!.member_id.toHexString()).toBe(world.otherMemberId);
    expect((await saleOf(mine.body.saleId))!.member_id.toHexString()).toBe(world.memberId);
  });

  it('US-18-TC02: Staff tra cứu operation SALE_REGISTER theo key của Member → 404, không lộ kết quả', async () => {
    const key = randomUUID();
    await api.register(api.selfInput(), world.tokens.member, key).expect(201);
    const lookup = await request(world.app.getHttpServer()).get(`/api/operations/SALE_REGISTER/${key}`)
      .set('Authorization', `Bearer ${world.tokens.STAFF}`);
    expect(lookup.status).toBe(404);
    expect(JSON.stringify(lookup.body)).not.toContain('saleId');
  });

  // ---------------- TC09 / TC04: mất response rồi gửi lại ----------------
  it('US-18-TC09: mất response, giá gói đổi, gửi lại cùng key → vẫn đúng kết quả cũ với giá cũ, không tạo sale mới', async () => {
    const key = randomUUID();
    const first = await api.register(api.selfInput(), world.tokens.member, key).expect(201);
    await plans().updateOne({ _id: world.plan._id }, { $set: { price: toVndDecimal('500000') }, $inc: { version: 1 } });
    const replay = await api.register(api.selfInput(), world.tokens.member, key).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.body.amountDue).toBe('300000');
    expect(await api.count('service_sales')).toBe(1);
  });

  it('US-18-TC09: gửi lại cùng key đồng thời trên hai instance → một sale, hai response giống nhau', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([api.register(api.selfInput(), world.tokens.member, key), registerOnB(api.selfInput(), key)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body).toEqual(a.body);
    expect(await api.count('service_sales')).toBe(1);
    expect(await api.count('transactions')).toBe(1);
  });

  // ---------------- TC06 / TC09: gói 0đ ----------------
  it('US-18-TC06: gói 0đ lỗi khi ghi thông báo → rollback toàn bộ, không giữ key; gửi lại cùng key thì hoàn tất một lần', async () => {
    await api.setPlanPrice('0');
    const key = randomUUID();
    const spy = jest.spyOn(started.app.get(NotificationsService), 'persistBusinessEvent').mockRejectedValueOnce(new Error('Injected event failure'));
    const failed = await api.register(api.selfInput(), world.tokens.member, key);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    for (const collection of ['transactions', 'service_sales', 'memberships', 'invoices', 'notifications', 'operation_requests']) {
      expect(await api.count(collection)).toBe(0);
    }
    spy.mockRestore();
    const retried = await api.register(api.selfInput(), world.tokens.member, key).expect(201);
    expect(retried.body).toMatchObject({ transactionStatus: 'SETTLED', amountDue: '0', channel: 'SELF_SERVICE' });
    for (const collection of ['transactions', 'service_sales', 'memberships', 'invoices']) expect(await api.count(collection)).toBe(1);
    expect(await api.count('payments')).toBe(0);
  });

  it('US-18-TC06: hai yêu cầu gói 0đ khác key cùng lúc trên hai instance → chỉ một gói, không payment', async () => {
    await api.setPlanPrice('0');
    const results = await Promise.all([api.register(), registerOnB()]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    expect(['CURRENT_SERVICE_EXISTS', 'PENDING_SALE_EXISTS']).toContain(results.find(row => row.status === 409)!.body.error.code);
    expect(await api.count('memberships')).toBe(1);
    expect(await api.count('invoices')).toBe(1);
    expect(await api.count('payments')).toBe(0);
  });

  // ---------------- TC10: tranh chấp cùng loại giữa quầy và Member ----------------
  it('US-18-TC10: quầy ở instance A và Member ở instance B tạo cùng lúc (khác key, cùng hồ sơ/loại) → chỉ một PENDING', async () => {
    const results = await Promise.all([api.counterSale(), registerOnB()]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    expect(results.find(row => row.status === 409)!.body.error.code).toBe('PENDING_SALE_EXISTS');
    expect(await world.connection.collection('transactions').countDocuments({ status: 'PENDING' })).toBe(1);
    expect(await api.count('service_sales')).toBe(1);
  });

  it('US-18-TC10: Member gửi hai yêu cầu cùng loại khác key ở hai instance → một PENDING; hủy xong tạo lại được', async () => {
    const results = await Promise.all([api.register(), registerOnB()]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    const created = results.find(row => row.status === 201)!;
    await api.cancel(created.body.saleId, { version: 0, reason: 'Chọn sai ngày bắt đầu' }).expect(200);
    await api.register().expect(201);
    expect(await world.connection.collection('transactions').countDocuments({ status: 'PENDING' })).toBe(1);
  });

  // ---------------- TC11 / TC12: hủy ----------------
  it('US-18-TC11: mất response khi hủy → gửi lại cùng key ra cùng kết quả; key mới sau khi đã hủy → 409', async () => {
    const sale = await api.register().expect(201);
    const key = randomUUID();
    const body = { version: 0, reason: 'Chọn sai ngày bắt đầu' };
    const first = await api.cancel(sale.body.saleId, body, world.tokens.member, key).expect(200);
    expect((await api.cancel(sale.body.saleId, body, world.tokens.member, key).expect(200)).body).toEqual(first.body);
    const again = await api.cancel(sale.body.saleId, { version: 1, reason: 'Chọn sai ngày bắt đầu' }).expect(409);
    expect(again.body.error.code).toBe('INVALID_TRANSACTION_STATE');
    expect(await api.count('payments')).toBe(0);
  });

  it('US-18-TC12: Member hủy ở instance A, Staff thu tiền ở instance B cùng lúc → một kết quả cuối, dữ liệu khớp', async () => {
    const sale = await api.register().expect(201);
    const [cancelled, confirmed] = await Promise.all([
      api.cancel(sale.body.saleId, { version: 0, reason: 'Đổi ý, chưa muốn mua' }),
      confirmOnB(sale.body.transactionId),
    ]);
    expect([cancelled.status, confirmed.status].sort()).toEqual([200, 409]);
    const transaction = await api.findById('transactions', sale.body.transactionId);
    const payments = await api.count('payments');
    const memberships = await api.count('memberships');
    if (cancelled.status === 200) {
      expect([transaction!.status, payments, memberships]).toEqual(['CANCELLED', 0, 0]);
    } else {
      expect([transaction!.status, payments, memberships]).toEqual(['SETTLED', 1, 1]);
    }
  });

  it('US-18-TC12: sau khi hủy, Staff thu tiền giao dịch đó → 409, không tạo payment hay gói', async () => {
    const sale = await api.register().expect(201);
    await api.cancel(sale.body.saleId, { version: 0, reason: 'Đổi ý, chưa muốn mua' }).expect(200);
    await confirmOnB(sale.body.transactionId).expect(409);
    expect(await api.count('payments')).toBe(0);
    expect(await api.count('memberships')).toBe(0);
  });

  // ---------------- TC07: chủ sở hữu hướng dẫn thanh toán sau khi gỡ liên kết ----------------
  it('US-18-TC07: account bị gỡ liên kết hồ sơ → không xem được hướng dẫn của giao dịch cũ nữa', async () => {
    const sale = await api.register().expect(201);
    await api.instructions(sale.body.transactionId).expect(200);
    await world.connection.collection('members').updateOne({ _id: new Types.ObjectId(world.memberId) }, { $unset: { account_id: '' } });
    const response = await api.instructions(sale.body.transactionId);
    expect([404, 409]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain('300000');
  });
});
