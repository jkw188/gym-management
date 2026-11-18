import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { io } from 'socket.io-client';
import { Long, ObjectId } from 'mongodb';
import request from 'supertest';
import { ApplicationError } from '../src/common/errors/application-error';
import { DataGuardsService } from '../src/infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { CancelBookingService } from '../src/modules/bookings/cancel-booking.service';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import { NotificationOutboxService } from '../src/modules/notifications/notification-outbox.service';
import { RemindersRepository } from '../src/modules/reminders/reminders.repository';
import { RemindersService } from '../src/modules/reminders/reminders.service';
import { RemindersWorker } from '../src/modules/reminders/reminders.worker';
import { ensureRemindersIntegrity } from '../src/modules/reminders/reminders-migration';
import { origin, seedUs18World, startUs18App, stopUs18App, Us18App, Us18World } from './helpers/us18-fixture';

describe('US-49: occurrence, source gates, EN-03 và nhiều instance trên replica set', () => {
  let started: Us18App;
  let world: Us18World;
  const db = () => started.connection.db!;
  const worker = (index = 0) => started.apps[index].get(RemindersWorker);
  const reminders = (index = 0) => started.apps[index].get(RemindersService);
  const now = (value: string) => started.setNow(new Date(value));
  beforeAll(async () => { started = await startUs18App('gym_test_us49', {}, 2); await started.app.listen(0, '127.0.0.1'); }, 600000);
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    world = await seedUs18World(started.app, started.connection);
    now('2026-11-06T17:00:00Z');
    await db().collection('schedule_guards').insertOne({ _id: 'global', revision: Long.ZERO } as never);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await stopUs18App(started); });

  async function membership(extra: { start?: string; end?: string; createdAt?: string; status?: string; settledAt?: string; transactionStatus?: string; kind?: string } = {}) {
    const id = new ObjectId(), saleId = new ObjectId(), transactionId = new ObjectId();
    await db().collection('transactions').insertOne({ _id: transactionId, id: transactionId, member_id: new ObjectId(world.memberId),
      kind: extra.kind ?? 'GYM', status: extra.transactionStatus ?? 'SETTLED', settled_at: new Date(extra.settledAt ?? '2026-11-01T03:00:00Z'), guard_revision: Long.ZERO,
      request_key: transactionId.toHexString(), code: transactionId.toHexString(), created_at: new Date('2026-11-01T03:00:00Z') });
    await db().collection('service_sales').insertOne({ _id: saleId, id: saleId, transaction_id: transactionId, member_id: new ObjectId(world.memberId),
      plan_id: world.plan._id, operation: 'REGISTER', start_date: extra.start ?? '2026-11-01', end_date: extra.end ?? '2026-11-10', plan_name_snapshot: 'Gói Gym US49', created_at: new Date('2026-11-01T03:00:00Z') });
    await db().collection('memberships').insertOne({ _id: id, id, service_sale_id: saleId, status: extra.status ?? 'ACTIVE', sessions_used: 0,
      version: 0, created_at: new Date(extra.createdAt ?? '2026-11-01T03:00:00Z') });
    return { id, saleId, transactionId };
  }
  async function booking(extra: { createdAt?: string; status?: string; start?: string; trainerAccount?: ObjectId } = {}) {
    const id = new ObjectId();
    const trainerRole = (await db().collection('roles').findOne({ code: 'TRAINER' }))!;
    const trainerAccount = extra.trainerAccount ?? (await db().collection('accounts').findOne({ role_id: trainerRole._id }))!._id;
    const existingTrainer = await db().collection('trainers').findOne({ account_id: trainerAccount });
    const trainerId = existingTrainer?._id ?? new ObjectId();
    if (!existingTrainer) await db().collection('trainers').insertOne({ _id: trainerId, account_id: trainerAccount });
    await db().collection('pt_bookings').insertOne({ _id: id, id, member_id: new ObjectId(world.memberId), membership_id: new ObjectId(), trainer_id: trainerId,
      shift_id: new ObjectId(), start_at: new Date(extra.start ?? '2026-11-10T11:00:00Z'), end_at: new Date('2026-11-10T12:00:00Z'),
      status: extra.status ?? 'BOOKED', created_at: new Date(extra.createdAt ?? '2026-11-01T03:00:00Z'), version: 0, completion_revision: 0,
      request_key: id.toHexString(), trainer_name_snapshot: 'PT US49', location_snapshot: 'Phòng A' });
    return { id, trainerAccount };
  }
  async function candidates() { return started.app.get(RemindersRepository).candidates(new Date('2026-11-09T12:00:00Z'), 50); }
  const occurrence = (id: ObjectId, milestone: string) => db().collection('reminder_occurrences').findOne({ source_id: id, milestone });
  const count = (collection: string) => db().collection(collection).countDocuments();

  it('TC01/06: bắt kịp3D, due VN, snapshot và recipient đúng; REST bền vững khi offline', async () => {
    const source = await membership(); now('2026-11-07T04:00:00Z');
    expect(await worker().runOnce()).toMatchObject({ stored: 1, failed: 0 });
    const row = (await occurrence(source.id, '3D'))!;
    expect(row.due_at.toISOString()).toBe('2026-11-06T17:00:00.000Z');
    expect(row.source_snapshot).toMatchObject({ end_date: '2026-11-10', plan_name: 'Gói Gym US49' });
    expect((await db().collection('notification_recipients').findOne())!.account_id).toEqual(world.memberAccountId);
    const sync = await request(started.app.getHttpServer()).get('/api/notifications/sync').set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
    expect(sync.body.items[0].source).toEqual({ type: 'MEMBERSHIP', id: source.id.toHexString(), dueAt: row.due_at.toISOString() });
    await request(started.app.getHttpServer()).get(`/api/me/notifications/${row.notification_id}`).set('Authorization', `Bearer ${world.tokens.otherMember}`).expect(404);
    const detail = await request(started.app.getHttpServer()).get(`/api/me/notifications/${row.notification_id}`).set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
    expect(detail.body.source.id).toBe(source.id.toHexString());
    await started.app.get(NotificationOutboxService).runOnce();
    expect((await db().collection('notification_outbox').findOne())!.status).toBe('DONE');
  });
  it('TC02/06: bắt kịp24H cho cả hai recipients và không gửi2H sớm', async () => {
    const source = await booking(); now('2026-11-09T12:00:00Z');
    expect(await worker().runOnce()).toMatchObject({ stored: 1 });
    expect(await occurrence(source.id, '2H')).toBeNull();
    expect(await count('notification_recipients')).toBe(2);
    expect((await occurrence(source.id, '24H'))!.due_at.toISOString()).toBe('2026-11-09T11:00:00.000Z');
  });
  it('TC03: mua/tạo sau mốc đầu bỏ nhắc bù nhưng mốc sau vẫn phát', async () => {
    const m = await membership({ createdAt: '2026-11-07T03:00:00Z', settledAt: '2026-11-07T03:00:00Z' });
    const b = await booking({ createdAt: '2026-11-09T12:00:00Z' });
    now('2026-11-09T12:00:00Z'); await worker().runOnce();
    // Tại đây3D đã stale;1D đủ điều kiện. Booking24H ineligible,2H chưa đến.
    expect((await occurrence(m.id, '3D'))!.status).toBe('SKIPPED_STALE');
    expect((await occurrence(m.id, '1D'))!.status).toBe('STORED');
    expect((await occurrence(b.id, '24H'))!.reason_code).toBe('CREATED_AFTER_DUE');
    now('2026-11-10T09:00:00Z'); await worker(1).runOnce();
    expect((await occurrence(b.id, '2H'))!.status).toBe('STORED');
  });
  it.each(['SUPERSEDED', 'CANCELLED'])('TC04: gói %s không nhắc', async status => {
    const source = await membership({ status }); await worker().runOnce();
    expect((await occurrence(source.id, '3D'))!.status).toBe('SKIPPED_INELIGIBLE'); expect(await count('notifications')).toBe(0);
  });
  it('TC04: future/PENDING không phát, cả GYM/PT đang có hiệu lực đều nhận', async () => {
    const future = await membership({ start: '2026-11-08', end: '2026-11-10' });
    const pending = await membership({ transactionStatus: 'PENDING' });
    const gym = await membership(); const pt = await membership({ kind: 'PT' }); await worker().runOnce();
    expect((await occurrence(future.id, '3D'))!.reason_code).toBe('OUTSIDE_MEMBERSHIP_PERIOD');
    expect((await occurrence(pending.id, '3D'))!.reason_code).toBe('NOT_SETTLED');
    expect((await occurrence(gym.id, '3D'))!.status).toBe('STORED'); expect((await occurrence(pt.id, '3D'))!.status).toBe('STORED');
  });
  it('TC05/15: member chưa link vẫn giữ event rỗng; link về sau không hồi tố', async () => {
    const source = await membership();
    await db().collection('members').updateOne({ _id: new ObjectId(world.memberId) }, { $unset: { account_id: 1 } });
    await worker().runOnce();
    expect((await occurrence(source.id, '3D'))!.reason_code).toBe('NO_LINKED_ACCOUNT'); expect(await count('notifications')).toBe(1);
    expect(await count('notification_recipients')).toBe(0);
    await db().collection('members').updateOne({ _id: new ObjectId(world.memberId) }, { $set: { account_id: world.memberAccountId } });
    await worker(1).runOnce(); expect(await count('notification_recipients')).toBe(0);
  });
  it('TC05: liên kết account không còn MEMBER không tạo recipient member', async () => {
    const source = await membership();
    await db().collection('members').updateOne({ _id: new ObjectId(world.memberId) }, { $set: { account_id: world.staffId } });
    await worker().runOnce(); expect(await count('notification_recipients')).toBe(0);
    expect((await occurrence(source.id, '3D'))!.reason_code).toBe('NO_LINKED_ACCOUNT');
  });
  it('TC15: đổi gói/link sau commit giữ body/recipient lịch sử; mốc mới chụp lại nguồn hiện hành', async () => {
    const source = await membership(); await worker().runOnce();
    const original = (await occurrence(source.id, '3D'))!;
    const notification = (await db().collection('notifications').findOne({ _id: original.notification_id }))!;
    const oldRecipient = (await db().collection('notification_recipients').findOne({ notification_id: notification._id }))!;
    const other = (await db().collection('members').findOne({ _id: new ObjectId(world.otherMemberId) }))!;
    await started.app.get(TransactionRunner).run(async session => {
      await started.app.get(DataGuardsService).acquire(session, { members: [new ObjectId(world.memberId), other._id] });
      await db().collection('members').updateOne({ _id: other._id }, { $unset: { account_id: 1 } }, { session });
      await db().collection('members').updateOne({ _id: new ObjectId(world.memberId) }, { $set: { account_id: other.account_id } }, { session });
      await db().collection('service_sales').updateOne({ _id: source.saleId }, { $set: { plan_name_snapshot: 'Gói đã đổi sau nhắc' } }, { session });
    });
    await worker(1).runOnce(); expect(await occurrence(source.id, '3D')).toEqual(original);
    expect(await db().collection('notifications').findOne({ _id: notification._id })).toEqual(notification);
    expect(await db().collection('notification_recipients').findOne({ notification_id: notification._id })).toEqual(oldRecipient);
    now('2026-11-08T17:00:00Z'); await worker(1).runOnce();
    const next = (await occurrence(source.id, '1D'))!;
    expect(next.source_snapshot.plan_name).toBe('Gói đã đổi sau nhắc');
    expect((await db().collection('notification_recipients').findOne({ notification_id: next.notification_id }))!.account_id).toEqual(other.account_id);
  });
  it('TC05: booking thiếu link chỉ PT; trùng account được dedupe', async () => {
    const source = await booking({ trainerAccount: world.memberAccountId }); now('2026-11-09T12:00:00Z'); await worker().runOnce();
    expect(await count('notification_recipients')).toBe(1);
    await db().collection('members').updateOne({ _id: new ObjectId(world.memberId) }, { $unset: { account_id: 1 } });
    now('2026-11-10T09:00:00Z'); await worker().runOnce();
    expect((await occurrence(source.id, '2H'))!.reason_code).toBe('NO_LINKED_ACCOUNT'); expect(await count('notification_recipients')).toBe(2);
  });
  it('TC07: restart sau mốc sau chỉ phát1D/2H; sau buổi/ngày hết hạn chỉ stale', async () => {
    const m = await membership(); const b = await booking(); now('2026-11-10T09:00:00Z');
    expect(await worker(1).runOnce()).toMatchObject({ stored: 2, skipped: 2 });
    expect((await occurrence(m.id, '3D'))!.status).toBe('SKIPPED_STALE'); expect((await occurrence(b.id, '24H'))!.status).toBe('SKIPPED_STALE');
    const oldM = await membership(); const oldB = await booking(); now('2026-11-10T17:00:00Z');
    expect(await worker().runOnce()).toMatchObject({ stored: 0, skipped: 4 });
    expect((await occurrence(oldM.id, '1D'))!.status).toBe('SKIPPED_STALE'); expect((await occurrence(oldB.id, '2H'))!.status).toBe('SKIPPED_STALE');
  });
  it.each(['PENDING', 'SETTLED'])('TC08: continuation %s chỉ suppress khi đã thu', async transactionStatus => {
    const old = await membership(); await membership({ start: '2026-11-11', end: '2026-12-10', transactionStatus }); await worker().runOnce();
    expect((await occurrence(old.id, '3D'))!.status).toBe(transactionStatus === 'SETTLED' ? 'SKIPPED_INELIGIBLE' : 'STORED');
  });
  it('TC09: cancellation commit trước → không phát reminder; reminder trước → giữ lịch sử', async () => {
    const source = await booking(); now('2026-11-09T12:00:00Z');
    const cancel = (id: ObjectId) => started.app.get(CancelBookingService).cancel({ policy: 'SUPPORT', actorId: world.staffId.toHexString(), actorRole: 'STAFF', bookingId: id.toHexString(), version: 0, reason: 'Hủy hỗ trợ kiểm thử US49', idempotencyKey: randomUUID() });
    await cancel(source.id); await worker().runOnce();
    expect((await occurrence(source.id, '24H'))!.reason_code).toBe('BOOKING_NOT_BOOKED');
    const other = await booking(); await worker().runOnce(); const old = await occurrence(other.id, '24H'); await cancel(other.id);
    await worker(1).runOnce(); expect(await occurrence(other.id, '24H')).toEqual(old);
  });
  it('TC09: cancellation đang giữ schedule/member gate; reminder retry đọc trạng thái sau commit', async () => {
    const source = await booking(); now('2026-11-09T12:00:00Z');
    const candidate = (await candidates()).find(row => row.sourceId.equals(source.id))!;
    let release!: () => void; let acquired!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const writer = started.app.get(TransactionRunner).run(async session => {
      await started.app.get(DataGuardsService).acquire(session, { schedule: true, members: [new ObjectId(world.memberId)] });
      await db().collection('pt_bookings').updateOne({ _id: source.id }, { $set: { status: 'CANCELLED' } }, { session }); acquired(); await waiting;
    });
    await locked; const reminder = reminders(1).process(candidate); release(); await writer;
    expect((await reminder).outcome).toBe('SKIPPED_INELIGIBLE'); expect(await count('notifications')).toBe(0);
  });
  it('TC09: COMPLETED không phát; TC10 upgrade đổi membership không thay event hoặc snapshot', async () => {
    const completed = await booking({ status: 'COMPLETED' }); const source = await booking(); now('2026-11-09T12:00:00Z'); await worker().runOnce();
    expect((await occurrence(completed.id, '24H'))!.status).toBe('SKIPPED_INELIGIBLE');
    const original = await occurrence(source.id, '24H'); const candidate = (await candidates()).find(row => row.sourceId.equals(source.id));
    expect(candidate).toBeUndefined();
    await started.app.get(TransactionRunner).run(async session => {
      await started.app.get(DataGuardsService).acquire(session, { members: [new ObjectId(world.memberId)] });
      await db().collection('pt_bookings').updateOne({ _id: source.id }, { $set: { membership_id: new ObjectId() }, $inc: { version: 1 } }, { session });
    });
    await worker(1).runOnce(); expect(await occurrence(source.id, '24H')).toEqual(original); expect(await count('notifications')).toBe(1);
  });
  it('TC11:20 lần hai worker cùng candidate → một occurrence/event/outbox, recipients unique', async () => {
    const source = await booking(); now('2026-11-09T12:00:00Z'); const candidate = (await candidates()).find(row => row.sourceId.equals(source.id))!;
    await Promise.all(Array.from({ length: 20 }, (_, index) => reminders(index % 2).process(candidate)));
    expect(await count('reminder_occurrences')).toBe(1); expect(await count('notifications')).toBe(1); expect(await count('notification_outbox')).toBe(1); expect(await count('notification_recipients')).toBe(2);
    expect(await worker(1).runOnce()).toMatchObject({ stored: 0, skipped: 0 });
  });
  it.each(['insertNotification', 'insertOutbox'] as const)('TC12: lỗi %s rollback; nguồn khác tiếp tục, retry cùng mốc sau60s', async method => {
    await membership(); await membership();
    const repository = started.app.get(NotificationsRepository); const original = repository[method].bind(repository) as (...args: unknown[]) => Promise<unknown>;
    jest.spyOn(repository, method).mockImplementationOnce((async (...args: unknown[]) => { await original(...args); throw new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'fixture'); }) as never);
    expect(await worker().runOnce()).toMatchObject({ stored: 1, failed: 1 });
    for (const name of ['reminder_occurrences', 'notifications', 'notification_outbox']) expect(await count(name)).toBe(1);
    now('2026-11-06T17:01:00Z'); expect(await worker(1).runOnce()).toMatchObject({ stored: 1, failed: 0 });
    for (const name of ['reminder_occurrences', 'notifications', 'notification_outbox']) expect(await count(name)).toBe(2);
  });
  it('TC12: retry sau hết cửa sổ chỉ ghi stale, không phát mốc cũ', async () => {
    const source = await membership(); jest.spyOn(started.app.get(NotificationsRepository), 'insertOutbox').mockRejectedValueOnce(new Error('fixture'));
    expect(await worker().runOnce()).toMatchObject({ failed: 1 });
    now('2026-11-08T17:00:00Z'); expect(await worker(1).runOnce()).toMatchObject({ skipped: 1, stored: 1 });
    expect((await occurrence(source.id, '3D'))!.status).toBe('SKIPPED_STALE'); expect(await count('notifications')).toBe(1);
  });
  it('TC13: crash trước dispatch/DEAD retry giữ occurrence, notification và eventKey', async () => {
    const source = await membership(); await worker().runOnce(); const original = await occurrence(source.id, '3D');
    await db().collection('notification_outbox').updateOne({}, { $set: { status: 'PROCESSING', lease_owner: 'crashed', lease_until: new Date(0) } });
    await started.apps[1].get(NotificationOutboxService).runOnce();
    expect((await db().collection('notification_outbox').findOne())!.status).toBe('DONE');
    await db().collection('notification_outbox').updateOne({}, { $set: { status: 'DEAD' } });
    await started.app.get(NotificationOutboxService).retryDead(original!.event_key);
    await started.app.get(NotificationOutboxService).runOnce();
    expect(await occurrence(source.id, '3D')).toEqual(original); expect(await count('notifications')).toBe(1);
  });
  it.each(['emit', 'ack'])('TC14: thu hồi auth trước %s không gửi nội dung/ghi delivered', async action => {
    await membership(); await worker().runOnce(); const notification = (await db().collection('notifications').findOne())!;
    const address = started.app.getHttpServer().address() as AddressInfo;
    const socket = io(`http://127.0.0.1:${address.port}/notifications`, { transports: ['websocket'], reconnection: false, forceNew: true,
      auth: { accessToken: world.tokens.member }, extraHeaders: { Origin: origin } });
    try {
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('SOCKET_TIMEOUT')), 3000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); }); socket.once('connect_error', error => { clearTimeout(timer); reject(error); }); });
      const received: unknown[] = []; socket.on('notification.created', payload => received.push(payload));
      if (action === 'emit') await db().collection('accounts').updateOne({ _id: world.memberAccountId }, { $set: { status: 'LOCKED' } });
      else await request(started.app.getHttpServer()).post('/api/auth/logout').set('Origin', origin).set('Authorization', `Bearer ${world.tokens.member}`).send({}).expect(204);
      const disconnected = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('DISCONNECT_TIMEOUT')), 3000);
        socket.once('disconnect', () => { clearTimeout(timer); resolve(); }); });
      if (action === 'emit') await started.app.get(NotificationOutboxService).runOnce();
      else socket.emit('notification.ack', { notificationId: notification._id.toHexString() }, () => undefined);
      await disconnected; expect(received).toEqual([]);
      expect((await db().collection('notification_recipients').findOne())!.delivered_at).toBeUndefined();
      await request(started.app.getHttpServer()).get('/api/notifications/sync').set('Authorization', `Bearer ${world.tokens.member}`).expect(401);
    } finally { socket.disconnect(); }
  });
  it('migration lặp lại giữ unique, không TTL; batch50 và lần sau lấy nguồn còn lại', async () => {
    await ensureRemindersIntegrity(started.connection); await ensureRemindersIntegrity(started.connection);
    for (let index = 0; index < 51; index++) await membership();
    expect(await worker().runOnce()).toMatchObject({ stored: 50 }); expect(await worker().runOnce()).toMatchObject({ stored: 1 });
    const indexes = await db().collection('reminder_occurrences').listIndexes().toArray();
    expect(indexes.filter(index => index.unique)).toHaveLength(2); expect(indexes.some(index => index.expireAfterSeconds !== undefined)).toBe(false);
  });
});
