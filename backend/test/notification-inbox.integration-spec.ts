// Tầng kiểm thử backend (Jest + MongoDB replica set thật trong bộ nhớ): US-47 bước 1.
// Kiểm tra service inbox của chính member: chỉ đọc theo recipient, lọc/phân trang, đánh dấu đã đọc idempotent.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
// Hợp đồng test đặt ra cho Builder (US-47 bước 1), id dạng chuỗi ObjectId, ngày dạng chuỗi ISO:
//   NotificationInboxService.listOwn(accountId, { readState: 'ALL'|'UNREAD'|'READ', page, limit })
//     -> { items: [{ id, title, bodyPreview, createdAt, readAt?, deliveredAt?, source? }], page, limit, total, totalPages, unreadCount, asOf }
//   NotificationInboxService.countUnread(accountId) -> { unreadCount, asOf }
//   NotificationInboxService.getOwn(accountId, notificationId) -> { id, title, body, createdAt, readAt?, deliveredAt?, source? }
//   NotificationInboxService.markReadOwn(accountId, notificationId) -> { id, readAt }
//   Không phải recipient hoặc không tồn tại: ném ApplicationError status 404, code 'NOT_FOUND'.
import { NotificationInboxService } from '../src/modules/notifications/notification-inbox.service';

const origin = 'http://localhost:5173';
const databaseName = 'gym_management_test_us47_inbox';

describe('US-47 bước 1: service inbox thông báo của chính member', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let connection: Connection;
  let inbox: NotificationInboxService;
  let notifications: NotificationsService;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '8.0.17' },
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName: databaseName },
    });
    Object.assign(process.env, {
      NODE_ENV: 'test',
      PORT: '3000',
      FRONTEND_ORIGIN: origin,
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB: databaseName,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
      // Ứng dụng bắt buộc có cấu hình SMTP/pepper khi khởi động (US-05); test này không gửi thư.
      RESET_OTP_PEPPER: randomBytes(32).toString('base64url'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
      SMTP_USER: 'us47-test', SMTP_PASS: 'us47-test', SMTP_FROM: 'no-reply@gym.test',
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    const { configureHttp } = await import('../src/common/http/configure-http');
    configureHttp(app);
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    inbox = app.get(NotificationInboxService);
    notifications = app.get(NotificationsService);
  }, 600000);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Chỉ xóa dữ liệu, giữ index.
    for (const collection of await connection.db!.collections()) await collection.deleteMany({});
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.env = savedEnv;
  });

  const db = () => connection.db!;
  const newId = () => new ObjectId().toHexString();

  // Ghi thẳng một thông báo theo schema EN-03 (sequence Int64) để test điều khiển được sequence và created_at.
  let sequenceSeed = 1000n;
  async function seedNotification(options: { title?: string; body?: string; sequence?: bigint; createdAt?: Date; memberId?: string } = {}) {
    const _id = new ObjectId();
    sequenceSeed += 1n;
    const doc = {
      _id,
      id: _id,
      title: options.title ?? 'Gói tập đã được kích hoạt',
      body: options.body ?? 'Gói Gym 1 tháng, hạn dùng đến 2026-12-04, mã giao dịch GD0001',
      event_key: `SERVICE_SALE_SETTLED:${newId()}`,
      sequence: Long.fromBigInt(options.sequence ?? sequenceSeed),
      created_at: options.createdAt ?? new Date(),
      ...(options.memberId ? { member_id: new ObjectId(options.memberId) } : {}),
    };
    await db().collection('notifications').insertOne(doc);
    return _id.toHexString();
  }

  // Một account nhận một thông báo; có thể đặt sẵn read_at/delivered_at.
  async function addRecipient(notificationId: string, accountId: string, state: { readAt?: Date; deliveredAt?: Date } = {}) {
    await db().collection('notification_recipients').insertOne({
      notification_id: new ObjectId(notificationId),
      account_id: new ObjectId(accountId),
      ...(state.readAt ? { read_at: state.readAt } : {}),
      ...(state.deliveredAt ? { delivered_at: state.deliveredAt } : {}),
    });
  }

  const recipientOf = (notificationId: string, accountId: string) =>
    db().collection('notification_recipients').findOne({ notification_id: new ObjectId(notificationId), account_id: new ObjectId(accountId) });

  async function expectNotFound(action: Promise<unknown>) {
    await expect(action).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  }

  const all = (accountId: string, page = 1, limit = 20) => inbox.listOwn(accountId, { readState: 'ALL', page, limit });

  // ---------- US-47-AC01: đúng recipient ----------
  describe('US-47-AC01: inbox/chi tiết chỉ đúng recipient', () => {
    it('US-47-TC01: list chỉ trả thông báo có recipient là account hiện hành, đủ field theo hợp đồng', async () => {
      const me = newId();
      const other = newId();
      const mine = await seedNotification({ title: 'Của tôi' });
      const shared = await seedNotification({ title: 'Gửi cả hai' });
      const notMine = await seedNotification({ title: 'Của người khác' });
      await addRecipient(mine, me);
      await addRecipient(shared, me);
      await addRecipient(shared, other);
      await addRecipient(notMine, other);

      const result = await all(me);

      expect(result.items.map((item) => item.id).sort()).toEqual([mine, shared].sort());
      expect(result).toMatchObject({ page: 1, limit: 20, total: 2, totalPages: 1, unreadCount: 2 });
      expect(typeof result.asOf).toBe('string');
      expect(Number.isNaN(Date.parse(result.asOf))).toBe(false);
      const item = result.items.find((entry) => entry.id === mine)!;
      expect(item.title).toBe('Của tôi');
      // US-47-D03: body ngắn hơn 120 ký tự, không xuống dòng thì preview giữ nguyên.
      expect(item.bodyPreview).toBe('Gói Gym 1 tháng, hạn dùng đến 2026-12-04, mã giao dịch GD0001');
      expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);
      expect(item.readAt ?? null).toBeNull();
    });

    it('US-47-TC01: detail trả body đầy đủ của thông báo mình nhận, không lộ người nhận hay event routing nội bộ', async () => {
      const me = newId();
      const id = await seedNotification({ title: 'Chi tiết', body: 'Nội dung đầy đủ của thông báo' });
      await addRecipient(id, me);
      await addRecipient(id, newId());

      const detail = await inbox.getOwn(me, id);

      expect(detail).toMatchObject({ id, title: 'Chi tiết', body: 'Nội dung đầy đủ của thông báo' });
      expect(Number.isNaN(Date.parse(detail.createdAt))).toBe(false);
      for (const key of ['recipients', 'accountId', 'account_id', 'eventKey', 'event_key']) expect(detail).not.toHaveProperty(key);
    });

    it('US-47-TC01: unread-count chỉ đếm recipient chưa đọc của account hiện hành', async () => {
      const me = newId();
      const other = newId();
      const unread = await seedNotification();
      const read = await seedNotification();
      const othersOnly = await seedNotification();
      await addRecipient(unread, me);
      await addRecipient(read, me, { readAt: new Date('2026-11-01T01:00:00Z') });
      await addRecipient(othersOnly, other);
      await addRecipient(unread, other);

      const result = await inbox.countUnread(me);

      expect(result.unreadCount).toBe(1);
      expect(Number.isNaN(Date.parse(result.asOf))).toBe(false);
    });

    // US-47-D03: bodyPreview tối đa 120 ký tự Unicode đầu của body, xuống dòng thành dấu cách, cắt thì thêm "…".
    async function previewOf(body: string) {
      const me = newId();
      const id = await seedNotification({ body });
      await addRecipient(id, me);
      return (await all(me)).items[0].bodyPreview;
    }

    it('US-47-TC01: (D03) body đúng 120 ký tự thì preview giữ nguyên, không thêm "…"', async () => {
      const body = 'a'.repeat(120);
      expect(await previewOf(body)).toBe(body);
    });

    it('US-47-TC01: (D03) body 2000 ký tự thì preview là 120 ký tự đầu kèm "…"', async () => {
      const body = 'Gói tập '.repeat(250); // 2000 ký tự
      expect(await previewOf(body)).toBe(`${body.slice(0, 120)}…`);
    });

    it('US-47-TC01: (D03) đếm theo ký tự Unicode, không cắt đôi emoji', async () => {
      // Mỗi emoji là 1 ký tự Unicode nhưng chiếm 2 đơn vị UTF-16 trong chuỗi JS.
      const body = '😀'.repeat(130);
      expect(await previewOf(body)).toBe(`${'😀'.repeat(120)}…`);
    });

    it('US-47-TC01: (D03) xuống dòng trong body được đổi thành dấu cách', async () => {
      expect(await previewOf('Dòng một\nDòng hai\nDòng ba')).toBe('Dòng một Dòng hai Dòng ba');
    });

    it('US-47-TC01: (D03) detail vẫn trả body gốc đầy đủ, không bị cắt hay đổi xuống dòng', async () => {
      const me = newId();
      const body = `Dòng một\n${'x'.repeat(300)}`;
      const id = await seedNotification({ body });
      await addRecipient(id, me);
      expect((await inbox.getOwn(me, id)).body).toBe(body);
    });

    it('US-47-TC02: xem detail notificationId của người khác trả 404 NOT_FOUND', async () => {
      const me = newId();
      const id = await seedNotification();
      await addRecipient(id, newId());
      await expectNotFound(inbox.getOwn(me, id));
    });

    it('US-47-TC02: detail notificationId không tồn tại trả 404 NOT_FOUND', async () => {
      await expectNotFound(inbox.getOwn(newId(), newId()));
    });

    it('US-47-TC02: đánh dấu đã đọc thông báo của người khác trả 404 và không đổi recipient của họ', async () => {
      const me = newId();
      const other = newId();
      const id = await seedNotification();
      await addRecipient(id, other);

      await expectNotFound(inbox.markReadOwn(me, id));

      expect((await recipientOf(id, other))!.read_at).toBeUndefined();
      expect(await recipientOf(id, me)).toBeNull();
    });

    it('US-47-TC02: đánh dấu đã đọc notificationId không tồn tại trả 404 và không tạo recipient mới', async () => {
      const me = newId();
      await expectNotFound(inbox.markReadOwn(me, newId()));
      expect(await db().collection('notification_recipients').countDocuments({})).toBe(0);
    });

    it('US-47-TC04: notifications.member_id trùng nhưng không có recipient thì không thấy trong list/count/detail', async () => {
      const me = newId();
      // member_id trùng chính id của account gọi, nhưng recipient chỉ chốt cho account khác (EN-03 snapshot).
      const sameMember = await seedNotification({ memberId: me });
      await addRecipient(sameMember, newId());

      expect((await all(me)).items).toEqual([]);
      expect((await inbox.countUnread(me)).unreadCount).toBe(0);
      await expectNotFound(inbox.getOwn(me, sameMember));
      await expectNotFound(inbox.markReadOwn(me, sameMember));
    });

    it('US-47-TC04: mua trước khi link account (không có recipient) thì sau khi link cũng không tự mở thông báo', async () => {
      const me = newId();
      const memberId = newId();
      // Thông báo lúc mua chưa có account nhận: không có recipient nào.
      const beforeLink = await seedNotification({ memberId });

      expect((await all(me)).total).toBe(0);
      await expectNotFound(inbox.getOwn(me, beforeLink));
      // Inbox không tự sinh recipient hồi tố.
      expect(await db().collection('notification_recipients').countDocuments({})).toBe(0);
    });
  });

  // ---------- US-47-AC02: read/delivered/idempotency ----------
  describe('US-47-AC02: read, delivered và idempotency', () => {
    it('US-47-TC05: GET list và detail không tự ghi read_at', async () => {
      const me = newId();
      const id = await seedNotification();
      await addRecipient(id, me);

      await all(me);
      await inbox.getOwn(me, id);
      await inbox.countUnread(me);

      const recipient = await recipientOf(id, me);
      expect(recipient!.read_at).toBeUndefined();
      expect((await inbox.countUnread(me)).unreadCount).toBe(1);
    });

    it('US-47-TC05: ack EN-03 chỉ ghi delivered_at, inbox vẫn coi là chưa đọc', async () => {
      const me = newId();
      const id = await seedNotification();
      await addRecipient(id, me);

      await expect(notifications.acknowledge(me, id)).resolves.toEqual({ ok: true });

      const recipient = await recipientOf(id, me);
      expect(recipient!.delivered_at).toBeInstanceOf(Date);
      expect(recipient!.read_at).toBeUndefined();
      const detail = await inbox.getOwn(me, id);
      expect(detail.readAt ?? null).toBeNull();
      expect(detail.deliveredAt).toBe(recipient!.delivered_at.toISOString());
      expect((await inbox.countUnread(me)).unreadCount).toBe(1);
    });

    it('US-47-TC05: mark-read không ghi delivered_at', async () => {
      const me = newId();
      const id = await seedNotification();
      await addRecipient(id, me);

      await inbox.markReadOwn(me, id);

      const recipient = await recipientOf(id, me);
      expect(recipient!.read_at).toBeInstanceOf(Date);
      expect(recipient!.delivered_at).toBeUndefined();
    });

    it('US-47-TC06: POST read nhiều lần giữ nguyên read_at lần đầu', async () => {
      const me = newId();
      const id = await seedNotification();
      await addRecipient(id, me);

      const first = await inbox.markReadOwn(me, id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await inbox.markReadOwn(me, id);

      expect(first.id).toBe(id);
      expect(Number.isNaN(Date.parse(first.readAt))).toBe(false);
      expect(second).toEqual(first);
      expect((await recipientOf(id, me))!.read_at.toISOString()).toBe(first.readAt);
    });

    it('US-47-TC06: thông báo đã có read_at sẵn thì gọi read trả lại đúng timestamp cũ', async () => {
      const me = newId();
      const id = await seedNotification();
      const firstRead = new Date('2026-11-01T02:03:04.000Z');
      await addRecipient(id, me, { readAt: firstRead });

      await expect(inbox.markReadOwn(me, id)).resolves.toEqual({ id, readAt: firstRead.toISOString() });
      expect((await recipientOf(id, me))!.read_at.toISOString()).toBe(firstRead.toISOString());
    });

    it('US-47-TC06: hai tab đánh dấu đồng thời cùng nhận một read_at, chỉ recipient của mình đổi', async () => {
      const me = newId();
      const other = newId();
      const id = await seedNotification();
      const sibling = await seedNotification();
      await addRecipient(id, me);
      await addRecipient(id, other);
      await addRecipient(sibling, me);

      const [tabA, tabB] = await Promise.all([inbox.markReadOwn(me, id), inbox.markReadOwn(me, id)]);

      expect(tabA.readAt).toBe(tabB.readAt);
      expect((await recipientOf(id, me))!.read_at.toISOString()).toBe(tabA.readAt);
      expect((await recipientOf(id, other))!.read_at).toBeUndefined();
      expect((await recipientOf(sibling, me))!.read_at).toBeUndefined();
      expect(await db().collection('notification_recipients').countDocuments({ read_at: { $exists: true } })).toBe(1);
    });

    it('US-47-TC07: sau khi mở detail rồi read, unreadCount giảm theo server, nội dung và lịch sử giữ nguyên', async () => {
      const me = newId();
      const id = await seedNotification({ title: 'Giữ nguyên', body: 'Nội dung không đổi' });
      const another = await seedNotification();
      await addRecipient(id, me);
      await addRecipient(another, me);
      const before = await db().collection('notifications').findOne({ _id: new ObjectId(id) });

      expect((await inbox.countUnread(me)).unreadCount).toBe(2);
      await inbox.getOwn(me, id);
      const read = await inbox.markReadOwn(me, id);

      expect((await inbox.countUnread(me)).unreadCount).toBe(1);
      expect(await db().collection('notifications').findOne({ _id: new ObjectId(id) })).toEqual(before);
      const detail = await inbox.getOwn(me, id);
      expect(detail).toMatchObject({ id, title: 'Giữ nguyên', body: 'Nội dung không đổi', readAt: read.readAt });
      const listed = await all(me);
      expect(listed.total).toBe(2);
      expect(listed.unreadCount).toBe(1);
      expect(listed.items.find((item) => item.id === id)!.readAt).toBe(read.readAt);
    });

    it('US-47-TC08: readState UNREAD/READ/ALL lọc đúng và unreadCount không phụ thuộc bộ lọc', async () => {
      const me = newId();
      const unreadA = await seedNotification();
      const unreadB = await seedNotification();
      const readC = await seedNotification();
      await addRecipient(unreadA, me);
      await addRecipient(unreadB, me);
      await addRecipient(readC, me, { readAt: new Date('2026-11-02T00:00:00Z') });

      const unread = await inbox.listOwn(me, { readState: 'UNREAD', page: 1, limit: 20 });
      const read = await inbox.listOwn(me, { readState: 'READ', page: 1, limit: 20 });
      const everything = await all(me);

      expect(unread.items.map((item) => item.id).sort()).toEqual([unreadA, unreadB].sort());
      expect(unread.total).toBe(2);
      expect(read.items.map((item) => item.id)).toEqual([readC]);
      expect(read.total).toBe(1);
      expect(everything.total).toBe(3);
      for (const page of [unread, read, everything]) expect(page.unreadCount).toBe(2);
    });

    it('US-47-TC08: sắp theo sequence giảm dần (không theo created_at), kể cả sequence Int64 vượt 2^53', async () => {
      const me = newId();
      // 2^53 và 2^53+1 đổi sang JS Number sẽ bằng nhau; created_at cố ý đặt ngược thứ tự sequence.
      const big = 9007199254740992n;
      const low = await seedNotification({ sequence: big, createdAt: new Date('2026-11-03T00:00:00Z') });
      const high = await seedNotification({ sequence: big + 1n, createdAt: new Date('2026-11-01T00:00:00Z') });
      const highest = await seedNotification({ sequence: 9223372036854775806n, createdAt: new Date('2026-10-01T00:00:00Z') });
      for (const id of [low, high, highest]) await addRecipient(id, me);

      const result = await all(me);

      expect(result.items.map((item) => item.id)).toEqual([highest, high, low]);
      // Nếu Builder có trả sequence thì phải là chuỗi số đúng chính xác, không phải JS Number.
      const withSequence = result.items as Array<{ id: string; sequence?: unknown }>;
      if (withSequence[0].sequence !== undefined) {
        expect(withSequence.map((item) => item.sequence)).toEqual(['9223372036854775806', String(big + 1n), String(big)]);
      }
    });

    it('US-47-TC08: phân trang nhiều trang đúng total/totalPages, không trùng, không sót', async () => {
      const me = newId();
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const id = await seedNotification();
        await addRecipient(id, me);
        ids.push(id);
      }
      const expectedOrder = [...ids].reverse(); // sequence tăng theo thứ tự tạo nên DESC là đảo ngược

      const page1 = await all(me, 1, 2);
      const page2 = await all(me, 2, 2);
      const page3 = await all(me, 3, 2);
      const page4 = await all(me, 4, 2);

      for (const page of [page1, page2, page3, page4]) expect(page).toMatchObject({ limit: 2, total: 5, totalPages: 3 });
      expect([page1.page, page2.page, page3.page, page4.page]).toEqual([1, 2, 3, 4]);
      expect([...page1.items, ...page2.items, ...page3.items].map((item) => item.id)).toEqual(expectedOrder);
      // US-47-D02: page lớn hơn totalPages vẫn trả bình thường, items rỗng, total/totalPages thật.
      expect(page4.items).toEqual([]);
    });

    it('US-47-TC08: inbox rỗng trả total 0, totalPages 0, unreadCount 0', async () => {
      const result = await all(newId());
      expect(result).toMatchObject({ items: [], page: 1, limit: 20, total: 0, totalPages: 0, unreadCount: 0 });
    });

    it('US-47-TC08: recipient trỏ tới notification không còn hợp lệ thì không được đếm vào unreadCount/total', async () => {
      const me = newId();
      const valid = await seedNotification();
      await addRecipient(valid, me);
      await addRecipient(newId(), me); // recipient mồ côi, không có notification tương ứng

      expect((await inbox.countUnread(me)).unreadCount).toBe(1);
      const result = await all(me);
      expect(result.total).toBe(1);
      expect(result.unreadCount).toBe(1);
      expect(result.items.map((item) => item.id)).toEqual([valid]);
    });
  });
});
