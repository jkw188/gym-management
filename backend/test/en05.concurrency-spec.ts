import { Decimal128, Long, ObjectId } from 'mongodb';
import { io, Socket } from 'socket.io-client';
import { En05Fixture, AppProcess, Call, DAY, NOW, at, reason, Outcome } from './helpers/en05-fixture';

// Stable EN-05 IDs. Missing production writers are explicit BLOCKED/PARTIAL, never acceptance passes.
describe('EN-05: two Node processes / committed MongoDB oracle', () => {
  const f = new En05Fixture();
  const count = (name: string, filter: Record<string, unknown> = {}) => f.db.collection(name).countDocuments(filter);
  const bookingId = (response: Outcome) => String(response.body.id);
  const ok = (response: Outcome, status: number) => expect({ status: response.status, code: (response.body.error as { code?: string } | undefined)?.code }).toEqual({ status, code: undefined });
  const codes = (responses: Outcome[], allowed = [200, 201, 409]) => responses.forEach(response => expect(allowed).toContain(response.status));
  const get = (path: string, actor = f.members[0], app = 0) => f.send({ app, actor, path, method: 'GET' });
  const created = async (member = 0, hour = '08:00', pt = 0) => {
    const response = await f.send(f.book(member, hour, pt)); ok(response, 201); return bookingId(response);
  };
  const shiftCall = (path: string, body: object, app: number, method = 'POST', operation = 'SHIFT_CREATE'): Call =>
    ({ path: `/me/work-shifts${path}`, actor: f.pts[0], app, body, method, key: f.key(), operation });
  const draft = (start: string, end: string) => ({ startAt: at(start), endAt: at(end), location: 'EN05' });
  beforeAll(async () => {
    await f.start();
    f.blocked('TC07', 'US-66 production publish/update controller/service are absent; fixtures cannot prove writer isolation.');
    f.blocked('TC08', 'US-66 publish-versus-book cannot execute through a real writer.');
  }, 120000);
  afterAll(async () => { await f.close(); });

  it('TC01: 20 different intents compete for one trainer slot', async () => f.run('TC01', async round => {
    const responses = await f.race(Array.from({ length: 20 }, (_, i) => f.book(i % 3, '08:00', 0, i % 2)), round);
    codes(responses); expect(await count('pt_bookings', { status: 'BOOKED' })).toBe(1);
    expect(await count('operation_requests', { operation: 'PT_BOOKING_CREATE' })).toBe(1);
  }));

  it('TC02: member conflict spans trainers and memberships', async () => f.run('TC02', async round => {
    const responses = await f.race(Array.from({ length: 20 }, (_, i) => f.book(0, '08:00', i % 2, i % 2)), round);
    codes(responses); expect(await count('pt_bookings', { member_id: f.memberIds[0], status: 'BOOKED' })).toBe(1);
    const winner = await f.db.collection('pt_bookings').findOne({ status: 'BOOKED' });
    const other = await f.plan(f.memberIds[0], 2);
    const otherPt = String(winner!.trainer_id) === String(f.trainers[0]) ? 1 : 0;
    const crossMembership = await f.send(f.book(0, '08:00', otherPt, 1, f.key(), other));
    expect(crossMembership.status).toBe(409);
    expect((crossMembership.body.error as { code: string }).code).toBe('MEMBER_TIME_CONFLICT');
  }));

  it('TC03: quota one under 20 different slots and keys', async () => f.run('TC03', async round => {
    const responses = await f.race(Array.from({ length: 20 }, (_, i) => f.book(0, `${String(i + 1).padStart(2, '0')}:00`, i % 2, i % 2)), round);
    codes(responses); expect(await count('pt_bookings', { status: 'BOOKED' })).toBe(1);
    expect((await f.db.collection('memberships').findOne({ _id: f.memberships[0] }))!.sessions_used).toBe(0);
  }, 1));

  it('TC04: 20 identical keys return the original committed body', async () => f.run('TC04', async round => {
    const key = f.key();
    const responses = await f.race(Array.from({ length: 20 }, (_, i) => f.book(0, '08:00', 0, i % 2, key)), round);
    responses.forEach(response => { ok(response, 201); expect(response.body).toEqual(responses[0].body); });
    expect(await count('pt_bookings')).toBe(1); expect(await count('operation_requests')).toBe(1);
    expect(await count('notifications')).toBe(1); expect(await count('notification_recipients')).toBe(2); expect(await count('notification_outbox')).toBe(1);
  }));

  it('TC05: same key with two payloads commits one intention', async () => f.run('TC05', async round => {
    const key = f.key();
    const responses = await f.race(Array.from({ length: 20 }, (_, i) => f.book(0, i % 2 ? '09:00' : '08:00', 0, i % 2, key)), round);
    codes(responses); expect(await count('pt_bookings')).toBe(1); expect(await count('operation_requests')).toBe(1);
    expect(responses.filter(response => response.status === 409)).toHaveLength(10);
    for (const response of responses.filter(item => item.status === 409)) expect((response.body.error as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
  }));

  it('TC06: overlapping create/update shifts, own exclusion and adjacency', async () => f.run('TC06', async round => {
    await f.db.collection('work_shifts').deleteOne({ _id: f.shifts[0] });
    const responses = await f.race(Array.from({ length: 20 }, (_, i) => shiftCall('', draft('08:00', '09:00'), i % 2)), round);
    codes(responses); expect(await count('work_shifts', { trainer_id: f.trainers[0], start_at: new Date(at('08:00')) })).toBe(1);
    const row = await f.db.collection('work_shifts').findOne({ trainer_id: f.trainers[0], start_at: new Date(at('08:00')) });
    ok(await f.send(shiftCall(`/${row!._id}`, { ...draft('08:00', '09:00'), version: 0 }, 0, 'PATCH', 'SHIFT_UPDATE')), 200);
    const adjacent = await f.send(shiftCall('', draft('09:00', '10:00'), 1)); ok(adjacent, 201);
    const before = await f.db.collection('work_shifts').findOne({ _id: new ObjectId(String(adjacent.body.id)) });
    expect((await f.send(shiftCall(`/${adjacent.body.id}`, { ...draft('08:30', '09:30'), version: 0 }, 1, 'PATCH', 'SHIFT_UPDATE'))).status).toBe(409);
    expect(await f.db.collection('work_shifts').findOne({ _id: before!._id })).toEqual(before);
    const updates = await f.race([
      shiftCall(`/${row!._id}`, { ...draft('10:00', '11:00'), version: 1 }, 0, 'PATCH', 'SHIFT_UPDATE'),
      shiftCall(`/${adjacent.body.id}`, { ...draft('10:30', '11:30'), version: 0 }, 1, 'PATCH', 'SHIFT_UPDATE'),
    ], round);
    expect(updates.map(response => response.status).sort()).toEqual([200, 409]);
    const currentWeek = await get('/me/work-shifts', f.pts[0]); ok(currentWeek, 200);
    expect(JSON.stringify(currentWeek.body)).toContain(String(row!._id));
    await f.clock(at('08:00'));
    expect((await f.send(shiftCall('', draft('07:00', '08:00'), 0))).status).toBe(400);
  }));

  it.todo('TC07: BLOCKED by missing US-66 publish/update writer');
  it.todo('TC08: BLOCKED by missing US-66 publish writer');

  it('TC09: cancelling a shift races with booking its slot', async () => f.run('TC09', async round => {
    const responses = await f.race([
      f.book(0, '08:00', 0, 0),
      { app: 1, actor: f.pts[0], path: `/me/work-shifts/${f.shifts[0]}/cancel`, operation: 'SHIFT_CANCEL', key: f.key(), body: { version: 0, reason } },
    ], round);
    expect(responses.map(response => response.status).sort()).toEqual([responses.some(response => response.status === 201) ? 201 : 200, 409]);
    const shift = await f.db.collection('work_shifts').findOne({ _id: f.shifts[0] });
    expect(await count('pt_bookings', { shift_id: f.shifts[0], status: 'BOOKED' })).toBe(shift!.status === 'CANCELLED' ? 0 : 1);
  }));

  it('TC10: trainer create/version/deactivate races with real shift and booking writers', async () => f.run('TC10', async round => {
    const trainerCall = (id: string, body: object, app: number): Call => ({ app, actor: f.admin, path: `/trainers${id ? `/${id}` : ''}`,
      method: id ? 'PATCH' : 'POST', operation: id ? 'TRAINER_UPDATE' : 'TRAINER_CREATE', key: f.key(), body });
    // Two independent processes link the same account: one profile and one CREATED audit.
    const account = await f.send({ app: 0, actor: f.admin, path: '/users', body: { fullName: 'EN05 US23 PT',
      phone: `+849991230${String(round).padStart(2, '0')}`, password: 'EN05 US23 account 123', roleCode: 'TRAINER' } });
    ok(account, 201);
    const creates = await f.race(Array.from({ length: 20 }, (_, i) => trainerCall('', {
      accountId: String(account.body.id), specialty: 'EN05 US23', status: 'ACTIVE',
    }, i % 2)), round);
    expect(creates.filter(result => result.status === 201)).toHaveLength(1);
    expect(creates.filter(result => result.status === 409)).toHaveLength(19);
    const newId = String(creates.find(result => result.status === 201)!.body.id);
    const updates = await f.race([trainerCall(newId, { version: 0, specialty: 'A' }, 0), trainerCall(newId, { version: 0, specialty: 'B' }, 1)], round);
    expect(updates.map(result => result.status).sort()).toEqual([200, 409]);
    expect(await count('trainer_events', { trainer_id: new ObjectId(newId) })).toBe(2);

    // No blockers for PT0: deactivate and a new shift may commit in either legal order.
    await f.db.collection('work_shifts').deleteMany({ trainer_id: f.trainers[0] });
    const id = String(f.trainers[0]);
    const responses = await f.race([trainerCall(id, { version: 0, status: 'INACTIVE' }, 0), shiftCall('', draft('08:00', '10:00'), 1)], round);
    expect(responses.map(result => result.status).sort()).toEqual([responses.some(result => result.status === 201) ? 201 : 200, 409]);
    const trainer = await f.db.collection('trainers').findOne({ _id: f.trainers[0] });
    const shifts = await f.db.collection('work_shifts').find({ trainer_id: f.trainers[0] }).toArray();
    expect(shifts.length).toBe(trainer!.status === 'INACTIVE' ? 0 : 1);
    await f.checkpoint('trainer_deactivate_vs_create_shift');
    if (trainer!.status === 'INACTIVE') ok(await f.send(trainerCall(id, { version: 1, status: 'ACTIVE' }, 0)), 200);
    else ok(await f.send(shiftCall(`/${shifts[0]._id}/cancel`, { version: 0, reason }, 1, 'POST', 'SHIFT_CANCEL')), 200);

    const draftShift = await f.send(shiftCall('', draft('08:00', '10:00'), 1)); ok(draftShift, 201);
    const version = Number((await f.db.collection('trainers').findOne({ _id: f.trainers[0] }))!.version);
    const confirmRace = await f.race([trainerCall(id, { version, status: 'INACTIVE' }, 0),
      shiftCall(`/${draftShift.body.id}/confirm`, { version: 0 }, 1, 'POST', 'SHIFT_CONFIRM')], round);
    expect(confirmRace.map(result => result.status).sort()).toEqual([200, 409]);
    expect((confirmRace.find(result => result.status === 409)!.body.error as { code: string }).code).toBe('TRAINER_HAS_ACTIVE_SCHEDULE');
    f.shifts[0] = new ObjectId(String(draftShift.body.id));
    const bookRace = await f.race([trainerCall(id, { version, status: 'INACTIVE' }, 0), f.book(0, '08:00', 0, 1)], round);
    expect(bookRace.map(result => result.status).sort()).toEqual([201, 409]);
    expect((await f.db.collection('trainers').findOne({ _id: f.trainers[0] }))!.status).toBe('ACTIVE');
  }, 2, 'US-23 create/version/deactivate versus US-24/25/28 executed; publish-class race still requires US-66.'));

  it('TC11: 20 cancellation commands, mixed actors and keys, one transition', async () => f.run('TC11', async round => {
    const id = await created(), key = f.key();
    const responses = await f.race(Array.from({ length: 20 }, (_, i) =>
      f.cancel(id, i % 2, i < 10 ? f.members[0] : i < 15 ? f.staff : f.admin, i < 6 ? key : f.key())), round);
    codes(responses); expect(await count('pt_bookings', { status: 'CANCELLED' })).toBe(1);
    expect(await count('booking_events', { action: 'CANCELLED' })).toBe(1);
    expect(await count('operation_requests', { operation: { $in: ['PT_BOOKING_CANCEL_OWN', 'PT_BOOKING_CANCEL_SUPPORT'] } })).toBe(1);
    expect(await count('notifications', { event_key: `BOOKING_CANCELLED:${id}` })).toBe(1);
    const state = await f.checkpoint('one_cancel'); expect(state.quota[0].used).toBe(0); expect(state.quota[0].reserved).toBe(0);
  }, 1));

  it('TC12: cancel versus booking another slot with one remaining session', async () => f.run('TC12', async round => {
    const id = await created();
    const responses = await f.race([f.cancel(id, 0), f.book(0, '09:00', 1, 1)], round);
    codes(responses); expect(await count('pt_bookings', { status: 'CANCELLED' })).toBe(1);
    expect(await count('pt_bookings', { status: 'BOOKED' })).toBeLessThanOrEqual(1);
  }, 1));

  async function upgrade() {
    const membership = await f.db.collection('memberships').findOne({ _id: f.memberships[0] });
    const sale = await f.db.collection('service_sales').findOne({ _id: membership!.service_sale_id });
    const target = await f.insert('plans', { code: 'EN05_TARGET', name: 'EN05 Target PT', kind: 'PT', duration_days: 30, session_quota: 4,
      price: Decimal128.fromString('1000000'), benefits: 'EN05 target', status: 'ACTIVE', version: 0, guard_revision: Long.ZERO,
      created_by: new ObjectId(f.admin.id), updated_by: new ObjectId(f.admin.id) });
    await f.insert('plan_conversion_policies', { from_plan_id: sale!.plan_id, to_plan_id: target, status: 'ACTIVE',
      rule_code: 'PRORATED_REMAINING_DAYS_V1', note: '', version: 0, created_by: new ObjectId(f.admin.id), updated_by: new ObjectId(f.admin.id) });
    const response = await f.send({ app: 0, actor: f.staff, path: '/service-upgrades', key: f.key(), operation: 'SALE_UPGRADE',
      body: { memberId: String(f.memberIds[0]), sourceMembershipId: String(f.memberships[0]), sourceVersion: 0,
        targetPlanId: String(target), targetPlanVersion: 0, policyVersion: 0 } });
    ok(response, 201); return response.body;
  }
  const settle = (sale: Record<string, unknown>, app: number): Call => ({ app, actor: f.staff, key: f.key(), operation: 'PAYMENT_CONFIRM',
    path: `/transactions/${sale.transactionId}/confirm-payment`, body: { method: 'CASH', amount: sale.amountDue, evidenceNote: 'EN05 đã nhận đủ tiền mặt' } });

  it('TC13: US-16 settlement versus book/cancel, US-20 remains missing', async () => f.run('TC13', async round => {
    const id = await created(), proposal = await upgrade();
    const calls = [settle(proposal, 0), f.book(0, '09:00', 1, 1), f.cancel(id, 1)];
    codes(await f.race(calls, round));
    const source = await f.db.collection('memberships').findOne({ _id: f.memberships[0] });
    expect(source!.status).toBe('SUPERSEDED');
    const target = await f.db.collection('memberships').findOne({ service_sale_id: new ObjectId(String(proposal.saleId)) });
    expect(target).not.toBeNull();
    expect(await count('pt_bookings', { membership_id: f.memberships[0], status: 'BOOKED' })).toBe(0);
    for (const booking of await f.db.collection('pt_bookings').find({ status: 'BOOKED' }).toArray()) {
      expect(String(booking.membership_id)).toBe(String(target!._id)); expect(String(booking.member_id)).toBe(String(f.memberIds[0]));
    }
    const replay = await f.send(calls[0]); ok(replay, 200);
    expect(await count('memberships', { service_sale_id: new ObjectId(String(proposal.saleId)) })).toBe(1);
  }, 2, 'US-16 real create/settlement covered; US-20 self-service ownership adapter/endpoints are absent.'));

  it('TC14: exact cancellation boundary and transaction retry crossing it', async () => f.run('TC14', async () => {
    const ids = [await created(0, '08:00'), await created(0, '09:00'), await created(0, '10:00')];
    await f.clock(at('06:00')); ok(await f.send(f.cancel(ids[0])), 200);
    await f.clock('2035-11-16T07:00:01+07:00');
    const late = await f.send(f.cancel(ids[1], 1)); expect(late.status).toBe(409);
    expect((late.body.error as { code: string }).code).toBe('CANCELLATION_WINDOW_CLOSED');
    await f.clock(at('08:00'));
    await f.apps[0].arm('audit', 'retry', '2035-11-16T08:00:01+07:00');
    const retry = await f.send(f.cancel(ids[2]));
    expect(retry.status).toBe(409); expect((retry.body.error as { code: string }).code).toBe('CANCELLATION_WINDOW_CLOSED');
    await f.apps[0].hit('audit');
    expect(await count('booking_events', { action: 'CANCELLED' })).toBe(1);
    expect(await count('pt_bookings', { status: 'BOOKED' })).toBe(2);
  }, 3));

  it('TC15: failure AFTER each write rolls back the entire transaction', async () => f.run('TC15', async () => {
    for (const point of ['booking', 'recipient', 'outbox', 'key']) {
      const before = await f.checkpoint(`before_create_${point}`);
      await f.apps[0].arm(point, 'rollback');
      const response = await f.send(f.book()); expect(response.status).toBe(503); await f.apps[0].hit(point);
      expect(await f.checkpoint(`after_create_${point}`)).toEqual(before);
    }
    const id = await created();
    for (const point of ['audit', 'recipient', 'outbox', 'key']) {
      const before = await f.checkpoint(`before_cancel_${point}`);
      await f.apps[1].arm(point, 'rollback');
      expect((await f.send(f.cancel(id, 1))).status).toBe(503); await f.apps[1].hit(point);
      expect(await f.checkpoint(`after_cancel_${point}`)).toEqual(before);
    }
  }));

  it('TC16: destroy HTTP response after commit, lookup and replay the original key', async () => f.run('TC16', async () => {
    const call = f.book();
    await f.apps[0].arm('response');
    const resolved = await f.send(call); ok(resolved, 201); await f.apps[0].hit('response');
    const replay = await f.send({ ...call, app: 1 }); expect(replay).toEqual(resolved);
    expect(await count('pt_bookings')).toBe(1); expect(await count('operation_requests')).toBe(1); expect(await count('notifications')).toBe(1);
    const unknownCall = f.book(0, '09:00');
    await f.apps[0].arm('responseUnknown');
    const unknown = await f.send(unknownCall); ok(unknown, 201); await f.apps[0].hit('responseUnknown');
    expect(await f.send({ ...unknownCall, app: 1 })).toEqual(unknown);
    expect(await count('pt_bookings')).toBe(2); expect(await count('operation_requests')).toBe(2); expect(await count('notifications')).toBe(2);
  }));

  async function socket(app: number): Promise<Socket> {
    const client = io(`${f.apps[app].url}/notifications`, { transports: ['websocket'], reconnection: false,
      auth: { accessToken: f.members[0].tokens[app] }, extraHeaders: { Origin: 'http://localhost:5173' } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { client.disconnect(); reject(new Error('EN05_SOCKET_TIMEOUT')); }, 10000);
      client.once('connect', () => { clearTimeout(timer); resolve(); });
      client.once('connect_error', () => { clearTimeout(timer); client.disconnect(); reject(new Error('EN05_SOCKET_AUTH_FAILED')); });
    }); return client;
  }
  const event = (client: Socket) => new Promise<{ id: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('EN05_SOCKET_EVENT_TIMEOUT')), 10000);
    client.once('notification.created', payload => { clearTimeout(timer); resolve(payload as { id: string }); });
  });
  it('TC17: offline sync and process crash after emit retain one DB event', async () => f.run('TC17', async () => {
    await created();
    const before = await f.checkpoint('offline_booking_committed');
    const sync = await get('/notifications/sync'); ok(sync, 200);
    expect((sync.body.items as unknown[]).length).toBe(1);
    const first = await socket(0);
    let second: Socket | undefined;
    try {
      const delivery = event(first);
      await f.apps[0].arm('afterEmit');
      const exited = new Promise<void>(resolve => f.apps[0].child.once('exit', () => resolve()));
      const worker = f.apps[0].rpc('worker').catch(() => undefined);
      const one = await delivery;
      await f.apps[0].hit('afterEmit');
      f.apps[0].child.kill('SIGKILL');
      await exited; await worker;
      const job = await f.db.collection('notification_outbox').findOne({}); expect(job!.status).toBe('PROCESSING');
      // Expire only the test lease; do not wait 30 seconds or change production retry policy.
      await f.db.collection('notification_outbox').updateOne({ _id: job!._id }, { $set: { lease_until: new Date(0) } });
      second = await socket(1); const replay = event(second);
      await f.apps[1].rpc('worker'); const two = await replay;
      expect(two.id).toBe(one.id);
      const inbox = await get('/me/notifications', f.members[0], 1); ok(inbox, 200);
      expect((inbox.body.items as unknown[]).length).toBe(1);
      expect((await f.checkpoint('after_recovery')).counts).toEqual(before.counts);
    } finally {
      first.disconnect(); second?.disconnect();
      if (f.apps[0].child.exitCode !== null || f.apps[0].child.signalCode !== null) {
        const replacement = new AppProcess(); f.apps[0] = replacement; await replacement.start();
      }
    }
  }));

  it('TC18: partial class overlap, adjacent slot, VN midnight and final/future periods', async () => f.run('TC18', async () => {
    await f.session(0, '07:00', '08:00'); await f.session(0, '10:30', '11:30');
    ok(await f.send(f.book(0, '08:00')), 201);
    expect((await f.send(f.book(1, '10:00'))).status).toBe(409);
    ok(await f.send(f.book(0, '09:00')), 201);
    const future = await f.plan(f.memberIds[1], 3, '2035-11-17', '2035-11-17');
    const shift = await f.shift(1, '00:00', '01:00', 'CONFIRMED', '2035-11-17');
    ok(await f.send(f.book(1, '00:00', 1, 1, f.key(), future, shift, '2035-11-17')), 201);
    const finalShift = await f.shift(1, '23:00', '00:00', 'CONFIRMED', '2035-11-17');
    ok(await f.send(f.book(1, '23:00', 1, 1, f.key(), future, finalShift, '2035-11-17')), 201);
    const next = await f.shift(1, '12:00', '13:00', 'CONFIRMED', '2035-11-18');
    expect((await f.send(f.book(1, '12:00', 1, 0, f.key(), future, next, '2035-11-18'))).status).toBe(409);
    expect((await f.send(f.book(2, '08:30'))).status).toBe(409);
  }));

  it('TC19: revoked session/role, foreign IDs and safe projections', async () => f.run('TC19', async () => {
    const id = await created();
    expect((await f.send({ ...f.book(), actor: undefined })).status).toBe(401);
    expect((await f.send({ ...f.book(), actor: f.pts[0] })).status).toBe(403);
    expect((await get(`/me/pt-bookings/${id}`, f.members[1], 1)).status).toBe(404);
    expect((await f.send(f.book(1, '09:00', 0, 1, f.key(), f.memberships[0]))).status).toBe(404);
    const ptView = await get('/me/trainer-bookings?fromDate=2035-11-16&toDate=2035-11-16', f.pts[0]); ok(ptView, 200);
    expect(JSON.stringify(ptView.body)).not.toMatch(/phone|email|address|amount|price|payment|password|contact/i);
    const otherPt = await get('/me/trainer-bookings?fromDate=2035-11-16&toDate=2035-11-16', f.pts[1], 1); ok(otherPt, 200);
    expect(JSON.stringify(otherPt.body)).not.toContain(id);
    const draftClass = await f.db.collection('public_sessions').findOne({ status: 'DRAFT' });
    const cancelled = await f.session(0, '12:00', '13:00', 'CANCELLED', '2035-11-18');
    for (const classId of [draftClass!._id, cancelled]) expect((await f.send({ app: 1, path: `/public-sessions/${classId}`, method: 'GET' })).status).toBe(404);
    const publicList = await f.send({ app: 1, path: '/public-sessions?fromDate=2035-11-18&toDate=2035-11-18', method: 'GET' }); ok(publicList, 200);
    expect(JSON.stringify(publicList.body)).not.toContain(String(draftClass!._id)); expect(JSON.stringify(publicList.body)).not.toContain(String(cancelled));
    const memberAccount = new ObjectId(f.members[0].id);
    try {
      await f.db.collection('auth_sessions').updateMany({ account_id: memberAccount }, { $set: { revoked_at: new Date() } });
      expect((await get(`/me/pt-bookings/${id}`, f.members[0], 1)).status).toBe(401);
      expect((await f.send(f.cancel(id))).status).toBe(401);
    } finally { await f.db.collection('auth_sessions').updateMany({ account_id: memberAccount }, { $unset: { revoked_at: '' } }); }
    const ptAccount = new ObjectId(f.pts[0].id), original = await f.db.collection('accounts').findOne({ _id: ptAccount });
    const memberRole = await f.db.collection('roles').findOne({ code: 'MEMBER' });
    try {
      await f.db.collection('accounts').updateOne({ _id: ptAccount }, { $set: { role_id: memberRole!._id } });
      expect((await get('/me/work-shifts', f.pts[0], 1)).status).toBe(403);
    } finally { await f.db.collection('accounts').updateOne({ _id: ptAccount }, { $set: { role_id: original!.role_id } }); }
    expect(await count('pt_bookings')).toBe(1);
  }));

  it('TC20: real US-64 completion competes with cancellation and upgrade', async () => f.run('TC20', async round => {
    const id = await created();
    // Same business date as completion, so settlement exercises booking/member gates,
    // rather than taking the unrelated QUOTE_EXPIRED path at midnight.
    await f.clock(at('07:00'));
    const proposal = await upgrade();
    await f.clock(at('09:00'));
    const complete: Call = { app: 0, actor: f.pts[0], path: `/me/pt-bookings/${id}/complete`, operation: 'PT_BOOKING_COMPLETE', key: f.key(), body: { version: 0 } };
    const responses = await f.race([complete, f.cancel(id, 1, f.staff), settle(proposal, 1)], round); codes(responses);
    const booking = await f.db.collection('pt_bookings').findOne({ _id: new ObjectId(id) });
    expect(['COMPLETED', 'CANCELLED']).toContain(booking!.status);
    const completeEvents = await count('booking_events', { booking_id: booking!._id, action: 'COMPLETE' });
    expect(completeEvents).toBe(booking!.status === 'COMPLETED' ? 1 : 0);
    expect(await count('booking_events', { booking_id: booking!._id })).toBe(1);
    const states = await f.db.collection('memberships').find({}).toArray();
    // SUPERSEDED keeps historical usage; count the currently active entitlement once.
    expect(states.filter(row => row.status === 'ACTIVE').reduce((sum, row) => sum + Number(row.sessions_used), 0)).toBe(completeEvents);
    const retry = await f.send(complete); expect([200, 409]).toContain(retry.status);
    expect(await count('booking_events', { action: 'COMPLETE' })).toBe(completeEvents);
  }));
});
