// Tầng kiểm thử backend (Jest + supertest + MongoDB replica set thật trong bộ nhớ): US-19 bước 3 (phần dữ liệu cho giao diện).
// GET /api/me/memberships cho biết kỳ nào hiện nút "Gia hạn" qua field renewal (TC12), luật do backend quyết định.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Types } from 'mongoose';
import { startUs18App, stopUs18App, seedUs18World, us18Api, Us18App, Us18World } from './helpers/us18-fixture';

// Hợp đồng test (sinh viên chốt 2026-11-17, thay đổi thiết kế bổ sung cho US-17):
//   Mỗi item của GET /api/me/memberships có thêm field renewal:
//     { previousSaleId: <serviceSale của kỳ này>, planVersion: <version HIỆN HÀNH của gói> } hoặc null.
//   renewal khác null khi và chỉ khi kỳ này đạt điều kiện NGUỒN của RenewalService US-15:
//     sale SETTLED, membership không SUPERSEDED/CANCELLED, và là kỳ đuôi (chưa có kỳ gia hạn SETTLED phía sau).
//   Kỳ đã hết hạn vẫn là nguồn hợp lệ (RENEW_V1 tính từ ngày thu). Gói ngừng bán hoặc đang có yêu cầu chờ KHÔNG làm
//   renewal = null: giao diện vẫn hiện nút, preview trả lý do (PLAN_NOT_AVAILABLE / PENDING_SALE_EXISTS) để báo cho Member.

describe('US-19 bước 3: field renewal trong GET /api/me/memberships', () => {
  let started: Us18App;
  let world: Us18World;
  const api = us18Api(() => world);
  let source: { saleId: string; transactionId: string; membershipId: string };
  const oid = (id: string) => new Types.ObjectId(id);

  beforeAll(async () => {
    started = await startUs18App('gym_management_test_us19_renewal_field', {});
  }, 600000);

  afterAll(async () => stopUs18App(started));

  beforeEach(async () => {
    started.setNow(new Date('2026-11-01T03:00:00Z'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    world = await seedUs18World(started.app, started.connection);
    const sale = await api.counterSale().expect(201);
    const settled = await api.confirmCash(sale.body.transactionId).expect(200);
    source = { saleId: sale.body.saleId, transactionId: sale.body.transactionId, membershipId: settled.body.membershipId };
  });

  afterEach(() => jest.restoreAllMocks());

  const server = () => world.app.getHttpServer();
  async function itemOf(membershipId: string) {
    const list = await request(server()).get('/api/me/memberships').set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
    const item = (list.body.items as { id: string; renewal?: unknown }[]).find(row => row.id === membershipId);
    expect(item).toBeDefined();
    return item!;
  }
  const renewAtCounter = () => request(server()).post('/api/service-renewals').set('Origin', 'http://localhost:5173')
    .set('Authorization', `Bearer ${world.tokens.STAFF}`).set('Idempotency-Key', randomUUID())
    .send({ memberId: world.memberId, previousSaleId: source.saleId, planVersion: 0 });

  it('US-19-TC12: kỳ đuôi đã thu -> renewal {previousSaleId của kỳ đó, planVersion hiện hành}', async () => {
    expect((await itemOf(source.membershipId)).renewal).toEqual({ previousSaleId: source.saleId, planVersion: 0 });
  });

  it('US-19-TC12: gói đổi version sau khi mua -> renewal trả version mới để preview không bị PLAN_CHANGED', async () => {
    await world.connection.collection('plans').updateOne({ _id: world.plan._id }, { $inc: { version: 1 } });
    expect((await itemOf(source.membershipId)).renewal).toEqual({ previousSaleId: source.saleId, planVersion: 1 });
  });

  it('US-19-TC12: đã có kỳ gia hạn SETTLED phía sau -> kỳ cũ renewal=null, kỳ mới là kỳ đuôi', async () => {
    const renewal = await renewAtCounter().expect(201);
    const settled = await api.confirmCash(renewal.body.transactionId).expect(200);
    expect((await itemOf(source.membershipId)).renewal).toBeNull();
    expect((await itemOf(settled.body.membershipId)).renewal).toEqual({ previousSaleId: renewal.body.saleId, planVersion: 0 });
  });

  it.each(['SUPERSEDED', 'CANCELLED'])('US-19-TC12: membership %s -> renewal=null', async status => {
    await world.connection.collection('memberships').updateOne({ _id: oid(source.membershipId) }, { $set: { status } });
    expect((await itemOf(source.membershipId)).renewal).toBeNull();
  });

  it('US-19-TC12: kỳ đã hết hạn vẫn là kỳ đuôi -> vẫn có renewal', async () => {
    started.setNow(new Date('2026-12-15T03:00:00Z'));
    expect((await itemOf(source.membershipId)).renewal).toEqual({ previousSaleId: source.saleId, planVersion: 0 });
  });

  it('US-19-TC12: đang có yêu cầu gia hạn chờ thu -> vẫn có renewal (preview sẽ báo PENDING_SALE_EXISTS)', async () => {
    await renewAtCounter().expect(201);
    expect((await itemOf(source.membershipId)).renewal).toEqual({ previousSaleId: source.saleId, planVersion: 0 });
  });

  it('US-19-TC12: gói ngừng bán -> vẫn có renewal (preview sẽ báo PLAN_NOT_AVAILABLE)', async () => {
    await world.connection.collection('plans').updateOne({ _id: world.plan._id }, { $set: { status: 'INACTIVE' } });
    expect((await itemOf(source.membershipId)).renewal).toEqual({ previousSaleId: source.saleId, planVersion: 0 });
  });
});
