import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { ApplicationError } from '../src/common/errors/application-error';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import { NotificationOutboxService } from '../src/modules/notifications/notification-outbox.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { origin, seedUs18World, startUs18App, stopUs18App, Us18App, Us18World } from './helpers/us18-fixture';

const base = '/api/admin/notification-broadcasts';
const input = { audience: 'ROLES', roles: ['MEMBER', 'TRAINER', 'MEMBER'], title: '  Lịch vận hành  ', body: '  <b>Thông báo văn bản</b>  ' };
describe('US-48: preview, atomic send, quyền và trạng thái giao nhận', () => {
  let started: Us18App;
  let world: Us18World;
  const sockets: Socket[] = [];
  beforeAll(async () => {
    started = await startUs18App('gym_test_us48', {}, 2);
    await started.app.listen(0, '127.0.0.1');
  }, 600000);
  beforeEach(async () => { jest.spyOn(console, 'error').mockImplementation(() => undefined); world = await seedUs18World(started.app, started.connection); started.setNow(new Date('2026-11-01T03:00:00Z')); });
  afterEach(() => { for (const socket of sockets.splice(0)) socket.disconnect(); jest.restoreAllMocks(); });
  afterAll(async () => { await stopUs18App(started); });
  const db = () => started.connection.db!;
  const count = (name: string) => db().collection(name).countDocuments();
  const post = (path: string, body: object, token = world.tokens.ADMIN, key?: string, instance = 0) => {
    const call = request(started.apps[instance].getHttpServer()).post(`${base}${path}`).set('Origin', origin).set('Authorization', `Bearer ${token}`);
    if (key) call.set('Idempotency-Key', key);
    return call.send(body);
  };
  const get = (path = '', token = world.tokens.ADMIN, query: object = {}) =>
    request(started.app.getHttpServer()).get(`${base}${path}`).set('Authorization', `Bearer ${token}`).query(query);
  const preview = async (body = input) => (await post('/preview', body).expect(201)).body as { previewId: string; version: number; recipientCount: number };
  const send = (id: string, key = randomUUID(), version = 0, token = world.tokens.ADMIN, instance = 0) => post(`/${id}/send`, { version }, token, key, instance);
  async function connect(token: string) {
    const port = (started.app.getHttpServer().address() as AddressInfo).port;
    const socket = io(`http://127.0.0.1:${port}/notifications`, { transports: ['websocket'], reconnection: false, forceNew: true,
      auth: { accessToken: token }, extraHeaders: { Origin: origin } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SOCKET_CONNECT_TIMEOUT')), 3000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
    });
    return socket;
  }
  async function assertUnsent() {
    for (const name of ['notifications', 'notification_recipients', 'notification_outbox', 'operation_requests']) expect(await count(name)).toBe(0);
    expect((await db().collection('notification_broadcasts').findOne())!.status).toBe('PREVIEW');
  }
  it('TC01/05: preview dedupe roles, trim, snapshot; confirm chỉ account ACTIVE; HTML giữ nguyên text', async () => {
    await db().collection('accounts').updateOne({ _id: new ObjectId(world.memberAccountId) }, { $set: { status: 'LOCKED' } });
    const expected = await db().collection('accounts').countDocuments({ status: 'ACTIVE', _id: { $nin: [new ObjectId(world.adminId), new ObjectId(world.staffId)] } });
    const result = await preview();
    expect(result.recipientCount).toBe(expected);
    expect(result).toMatchObject({ title: 'Lịch vận hành', body: '<b>Thông báo văn bản</b>', snapshotAt: '2026-11-01T03:00:00.000Z', expiresAt: '2026-11-01T03:05:00.000Z' });
    await assertUnsent();
    const response = await send(result.previewId).expect(200);
    expect(response.body).toMatchObject({ status: 'SENT', recipientCount: expected, dispatchStatus: 'READY' });
    expect(await count('notifications')).toBe(1); expect(await count('notification_recipients')).toBe(expected);
    expect(await count('notification_outbox')).toBe(1); expect(await count('operation_requests')).toBe(1);
    expect(await db().collection('notification_recipients').countDocuments({ account_id: { $in: [new ObjectId(world.adminId), new ObjectId(world.staffId), new ObjectId(world.memberAccountId)] } })).toBe(0);
    expect((await db().collection('notifications').findOne())!.event_key).toBe(`BROADCAST:${result.previewId}`);
  });
  it.each([
    { title: ' ' }, { body: '' }, { title: 'x'.repeat(191) }, { body: 'x'.repeat(2001) }, { body: '\nabc' },
    { roles: ['GUEST'] }, { roles: [] }, { roles: undefined }, { accountIds: [new ObjectId().toHexString()] },
    { audience: 'ALL_ACTIVE', roles: ['ADMIN'] }, { room: 'accounts' }, { title: 1 },
  ])('TC02: từ chối DTO ngoài hợp đồng %j', async changes => { await post('/preview', { ...input, ...changes }).expect(400); });
  it('TC02: nhóm rỗng không phát hành', async () => {
    await db().collection('accounts').updateMany({ _id: { $ne: new ObjectId(world.adminId) } }, { $set: { status: 'LOCKED' } });
    const result = await preview(); expect(result.recipientCount).toBe(0);
    expect((await send(result.previewId).expect(409)).body.error.code).toBe('AUDIENCE_EMPTY'); await assertUnsent();
  });
  it.each(['STAFF', 'TRAINER', 'member'] as const)('TC03: %s không có quyền preview/send/list/detail', async role => {
    const row = await preview();
    await post('/preview', input, world.tokens[role]).expect(403); await send(row.previewId, randomUUID(), 0, world.tokens[role]).expect(403);
    await get('', world.tokens[role]).expect(403); await get(`/${row.previewId}`, world.tokens[role]).expect(403);
  });
  it('TC03/08: foreign preview 404; phiên bị thu hồi vẫn 401 cả khi replay', async () => {
    const users = started.app.get(UsersRepository);
    const foreign = await users.createAccount({ roleId: (await users.findRoleByCode('ADMIN'))!.id.toHexString(), fullName: 'Admin khác', phone: '0994888888', passwordHash: await started.connection.collection('accounts').findOne({ _id: new ObjectId(world.adminId) }).then(row => row!.password_hash as string) });
    const row = await preview();
    await db().collection('notification_broadcasts').updateOne({ _id: new ObjectId(row.previewId) }, { $set: { created_by: foreign._id } });
    await send(row.previewId).expect(404); await assertUnsent();
    const mine = await preview(); const key = randomUUID(); await send(mine.previewId, key).expect(200);
    await request(started.app.getHttpServer()).post('/api/auth/logout').set('Origin', origin).set('Authorization', `Bearer ${world.tokens.ADMIN}`).send({}).expect(204);
    await send(mine.previewId, key).expect(401);
  });
  it.each(['expiry', 'role', 'status', 'newAccount', 'content', 'version'])('TC04: drift %s → PREVIEW_STALE', async kind => {
    const row = await preview();
    if (kind === 'expiry') started.setNow(new Date('2026-11-01T03:05:00Z'));
    if (kind === 'role') await db().collection('accounts').updateOne({ _id: new ObjectId(world.memberAccountId) }, { $set: { role_id: (await started.app.get(UsersRepository).findRoleByCode('TRAINER'))!._id } });
    if (kind === 'status') await db().collection('accounts').updateOne({ _id: new ObjectId(world.memberAccountId) }, { $set: { status: 'LOCKED' } });
    if (kind === 'newAccount') await started.app.get(UsersRepository).createAccount({ roleId: (await started.app.get(UsersRepository).findRoleByCode('MEMBER'))!._id.toHexString(), fullName: 'Mới', phone: '0994888889', passwordHash: '$argon2id$fixture' });
    if (kind === 'content') await db().collection('notification_broadcasts').updateOne({ _id: new ObjectId(row.previewId) }, { $set: { body: 'Nội dung khác' } });
    expect((await send(row.previewId, randomUUID(), kind === 'version' ? 1 : 0).expect(409)).body.error.code).toBe('PREVIEW_STALE'); await assertUnsent();
  });
  it('TC06/08/12: 20 request cùng key trên 2 instance; replay gốc, conflict, key mới và resolve', async () => {
    const row = await preview(); const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => send(row.previewId, key, 0, world.tokens.ADMIN, index % 2)));
    for (const response of responses) { expect(response.status).toBe(200); expect(response.body).toEqual(responses[0].body); }
    started.setNow(new Date('2026-11-01T04:00:00Z'));
    expect((await send(row.previewId, key).expect(200)).body).toEqual(responses[0].body);
    expect((await send(row.previewId, key, 1).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await send(row.previewId).expect(409)).body.error.code).toBe('BROADCAST_ALREADY_SENT');
    const lookup = await request(started.apps[1].getHttpServer()).get(`/api/operations/NOTIFICATION_BROADCAST_SEND/${key}`).set('Authorization', `Bearer ${world.tokens.ADMIN}`).expect(200);
    expect(lookup.body.responseBody).toEqual(responses[0].body);
    expect(await count('notifications')).toBe(1); expect(await count('notification_outbox')).toBe(1); expect(await count('operation_requests')).toBe(1);
  });
  it.each(['insertRecipients', 'nextSequence', 'insertOutbox'] as const)('TC07: lỗi %s rollback toàn bộ và vẫn gửi lại được cùng preview/key', async method => {
    const row = await preview(); const key = randomUUID();
    const repository = started.app.get(NotificationsRepository);
    // Với recipients/outbox, ghi thật xong mới phát lỗi để chứng minh rollback các ghi trước đó.
    const original = repository[method].bind(repository) as (...args: unknown[]) => Promise<unknown>;
    const spy = jest.spyOn(repository, method).mockImplementationOnce((async (...args: unknown[]) => {
      await original(...args); throw new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Lỗi kiểm thử');
    }) as never);
    await send(row.previewId, key).expect(503); await assertUnsent();
    expect(await db().collection('notification_counters').findOne({ _id: 'global' } as never)).toBeNull();
    spy.mockRestore(); await send(row.previewId, key).expect(200);
  });
  it('TC09/11: dispatch offline DONE vẫn sync được, ack/read là hai số riêng; recipient lịch sử giữ nguyên', async () => {
    const row = await preview(); const response = await send(row.previewId).expect(200);
    await started.app.get(NotificationOutboxService).runOnce();
    let detail = (await get(`/${row.previewId}`).expect(200)).body;
    expect(detail).toMatchObject({ dispatchStatus: 'DONE', counts: { snapshot: row.recipientCount, sent: row.recipientCount, delivered: 0, read: 0 } });
    const sync = await request(started.app.getHttpServer()).get('/api/notifications/sync').set('Authorization', `Bearer ${world.tokens.member}`).expect(200);
    expect(sync.body.items.map((item: { id: string }) => item.id)).toContain(response.body.notificationId);
    await started.app.get(NotificationsService).acknowledge(world.memberAccountId.toHexString(), response.body.notificationId);
    await request(started.app.getHttpServer()).post(`/api/me/notifications/${response.body.notificationId}/read`).set('Origin', origin).set('Authorization', `Bearer ${world.tokens.member}`).send({}).expect(200);
    await db().collection('accounts').updateOne({ _id: new ObjectId(world.memberAccountId) }, { $set: { status: 'LOCKED' } });
    detail = (await get(`/${row.previewId}`).expect(200)).body;
    expect(detail.counts).toEqual({ snapshot: row.recipientCount, sent: row.recipientCount, delivered: 1, read: 1 });
    expect(JSON.stringify(detail)).not.toMatch(/account_id|password|phone|email/);
  });
  it('TC09: crash sau emit trước DONE được phát lại cùng notificationId, Staff ack không ghi read', async () => {
    const socket = await connect(world.tokens.STAFF);
    const received: string[] = [];
    socket.on('notification.created', (item: { id: string }) => received.push(item.id));
    const row = await preview({ audience: 'ALL_ACTIVE', title: input.title, body: input.body } as typeof input);
    const sent = (await send(row.previewId).expect(200)).body;
    const worker = started.app.get(NotificationOutboxService);
    const spy = jest.spyOn(started.app.get(NotificationsRepository), 'markJobDone').mockRejectedValueOnce(new Error('CRASH_AFTER_EMIT'));
    await expect(worker.runOnce()).rejects.toThrow('CRASH_AFTER_EMIT');
    await db().collection('notification_outbox').updateOne({ notification_id: new ObjectId(sent.notificationId) }, { $set: { lease_until: new Date(0) } });
    spy.mockRestore();
    await worker.runOnce();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('REDELIVERY_TIMEOUT')), 3000);
      const check = () => { if (received.length === 2) { clearTimeout(timer); resolve(); } };
      socket.on('notification.created', check); check();
    });
    expect(received).toEqual([sent.notificationId, sent.notificationId]);
    const ack = await new Promise(resolve => socket.emit('notification.ack', { notificationId: sent.notificationId }, resolve));
    expect(ack).toEqual({ ok: true });
    const detail = (await get(`/${row.previewId}`).expect(200)).body;
    expect(detail).toMatchObject({ dispatchStatus: 'DONE', counts: { delivered: 1, read: 0 } });
  });
  it.each(['role', 'locked'])('TC10: %s sau send chặn nội dung trên socket cũ; recipient lịch sử vẫn giữ', async kind => {
    const socket = await connect(world.tokens.member);
    const received: unknown[] = []; socket.on('notification.created', item => received.push(item));
    const row = await preview(); await send(row.previewId).expect(200);
    const change = kind === 'locked' ? { status: 'LOCKED' } : { role_id: (await started.app.get(UsersRepository).findRoleByCode('STAFF'))!._id };
    await db().collection('accounts').updateOne({ _id: new ObjectId(world.memberAccountId) }, { $set: change });
    const disconnected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DISCONNECT_TIMEOUT')), 3000);
      socket.once('disconnect', () => { clearTimeout(timer); resolve(); });
    });
    await started.app.get(NotificationOutboxService).runOnce(); await disconnected;
    expect(received).toEqual([]);
    expect((await get(`/${row.previewId}`).expect(200)).body.counts).toEqual({ snapshot: row.recipientCount, sent: row.recipientCount, delivered: 0, read: 0 });
  });
  it('ALL_ACTIVE gồm Admin/Staff qua sync nhưng không mở inbox; lọc kỳ VN/phân trang/id sai', async () => {
    const row = await preview({ audience: 'ALL_ACTIVE', title: input.title, body: input.body } as typeof input);
    await send(row.previewId).expect(200);
    for (const token of [world.tokens.ADMIN, world.tokens.STAFF]) {
      const sync = await request(started.app.getHttpServer()).get('/api/notifications/sync').set('Authorization', `Bearer ${token}`).expect(200);
      expect(sync.body.items).toHaveLength(1);
      await request(started.app.getHttpServer()).get('/api/me/notifications').set('Authorization', `Bearer ${token}`).expect(403);
    }
    expect((await get('', world.tokens.ADMIN, { status: 'SENT', fromDate: '2026-11-01', toDate: '2026-11-01' }).expect(200)).body).toMatchObject({ total: 1, totalPages: 1, page: 1, limit: 20 });
    expect((await get('', world.tokens.ADMIN, { page: 2 }).expect(200)).body.items).toEqual([]);
    expect((await get('', world.tokens.ADMIN, { fromDate: '2026-10-31', toDate: '2026-10-31' }).expect(200)).body).toMatchObject({ total: 0, totalPages: 0 });
    for (const query of [{ status: 'DONE' }, { fromDate: '2026-02-30' }, { fromDate: '2025-01-01', toDate: '2026-11-01' }, { page: 0 }, { limit: 101 }, { accountId: 'x' }]) await get('', world.tokens.ADMIN, query).expect(400);
    await get('/bad-id').expect(400); await get(`/${new ObjectId()}`).expect(404);
    await post(`/${row.previewId}/send`, { version: 0 }).expect(400);
  });
});
