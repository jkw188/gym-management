// Tầng dữ liệu (EN-03 bước 1, US-47 bước 1): nơi duy nhất đọc/ghi notifications, notification_recipients, notification_outbox, notification_counters.
// Mọi lệnh ghi nhận session rõ ràng để nằm trong transaction của lệnh nghiệp vụ; repository không tự mở transaction.
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, PipelineStage, Types } from 'mongoose';
import { ReadState } from './notifications.types';
import { NotificationCounter } from './schemas/notification-counter.schema';
import { NotificationOutbox } from './schemas/notification-outbox.schema';
import { NotificationRecipient } from './schemas/notification-recipient.schema';
import { Notification } from './schemas/notification.schema';

export interface NewNotification {
  eventKey: string; title: string; body: string; sequence: bigint; createdAt: Date;
  memberId?: Types.ObjectId; transactionId?: Types.ObjectId; createdBy?: Types.ObjectId;
}

const GLOBAL_COUNTER_ID = 'global';

@Injectable()
export class NotificationsRepository implements OnModuleInit {
  constructor(
    @InjectModel('Notification') private readonly notifications: Model<Notification>,
    @InjectModel('NotificationRecipient') private readonly recipients: Model<NotificationRecipient>,
    @InjectModel('NotificationOutbox') private readonly outbox: Model<NotificationOutbox>,
    @InjectModel('NotificationCounter') private readonly counters: Model<NotificationCounter>,
    private readonly config: ConfigService,
  ) {}

  // Tạo index và counter TRƯỚC khi nhận ghi (EN-03 bước 1). Dev/test tự tạo index; production chỉ kiểm tra.
  async onModuleInit(): Promise<void> {
    const models: Model<any>[] = [this.notifications, this.recipients, this.outbox];
    for (const model of models) {
      if (this.config.get('nodeEnv') !== 'production') await model.createIndexes();
      const actual = await model.collection.listIndexes().toArray();
      for (const [key, options] of model.schema.indexes()) {
        const found = actual.some(index => JSON.stringify(index.key) === JSON.stringify(key) && Boolean(index.unique) === Boolean(options.unique));
        if (!found) throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
      }
    }
    // Chỉ tạo counter khi chưa có; đã có thì giữ nguyên value.
    await this.counters.updateOne({ _id: GLOBAL_COUNTER_ID }, { $setOnInsert: { value: 0n } }, { upsert: true });
  }

  // Tìm thông báo đã có theo eventKey, đọc trong session để thấy dữ liệu của chính transaction (EN-03-TC02).
  findByEventKey(eventKey: string, session: ClientSession) {
    return this.notifications.findOne({ event_key: eventKey }).session(session).lean().exec();
  }

  countRecipients(notificationId: Types.ObjectId, session: ClientSession): Promise<number> {
    return this.recipients.countDocuments({ notification_id: notificationId }).session(session).exec();
  }

  // Tăng counter global trong transaction và trả số mới làm sequence. Hai transaction cùng ghi document này thì một bên
  // bị write conflict và driver chạy lại, nên sequence theo thứ tự commit. upsert phòng khi counter chưa được tạo.
  async nextSequence(session: ClientSession): Promise<bigint> {
    const counter = await this.counters.findOneAndUpdate(
      { _id: GLOBAL_COUNTER_ID }, { $inc: { value: 1n } }, { upsert: true, returnDocument: 'after', session },
    ).exec();
    return counter!.value;
  }

  async insertNotification(data: NewNotification, session: ClientSession): Promise<Types.ObjectId> {
    const [created] = await this.notifications.create([{
      event_key: data.eventKey, title: data.title, body: data.body, sequence: data.sequence, created_at: data.createdAt,
      member_id: data.memberId, transaction_id: data.transactionId, created_by: data.createdBy,
    }], { session });
    return created._id;
  }

  // EN-03-TC01: mỗi account một recipient, chưa có read_at/delivered_at.
  async insertRecipients(notificationId: Types.ObjectId, accountIds: Types.ObjectId[], session: ClientSession): Promise<void> {
    if (accountIds.length === 0) return;
    await this.recipients.create(accountIds.map(accountId => ({ notification_id: notificationId, account_id: accountId })), { session, ordered: true });
  }

  // EN-03-TC01: job READY, attempts 0, sẵn sàng xử lý ngay sau commit.
  async insertOutbox(eventKey: string, notificationId: Types.ObjectId, now: Date, session: ClientSession): Promise<void> {
    await this.outbox.create([{ event_key: eventKey, notification_id: notificationId, status: 'READY', attempts: 0, available_at: now }], { session });
  }

  // ----- Các hàm cho outbox worker (EN-03 bước 2). Không dùng session: worker chỉ thấy dữ liệu đã commit (EN-03-TC16). -----

  // Nhận MỘT job bằng findOneAndUpdate có điều kiện: job READY đã đến hạn, hoặc PROCESSING mà lease đã hết (EN-03-TC05).
  // Chỉ một worker cập nhật được document nên hai worker không nhận trùng job. skipIds: job đã xử lý trong lượt tick này.
  claimNextJob(leaseOwner: string, now: Date, leaseUntil: Date, skipIds: Types.ObjectId[]) {
    return this.outbox.findOneAndUpdate(
      {
        _id: { $nin: skipIds },
        $or: [
          { status: 'READY', available_at: { $lte: now } },
          { status: 'PROCESSING', lease_until: { $lte: now } },
        ],
      },
      { $set: { status: 'PROCESSING', lease_owner: leaseOwner, lease_until: leaseUntil } },
      { sort: { available_at: 1, _id: 1 }, returnDocument: 'after' },
    ).lean().exec();
  }

  findNotificationById(notificationId: Types.ObjectId) {
    return this.notifications.findById(notificationId).lean().exec();
  }

  async findRecipientAccountIds(notificationId: Types.ObjectId): Promise<Types.ObjectId[]> {
    const rows = await this.recipients.find({ notification_id: notificationId }, { account_id: 1 }).lean().exec();
    return rows.map(row => row.account_id);
  }

  // Các hàm kết thúc job đều lọc theo lease_owner: worker đã mất lease thì không ghi được gì (EN-03-TC05).
  async markJobDone(jobId: Types.ObjectId, leaseOwner: string, now: Date): Promise<void> {
    await this.outbox.updateOne(
      { _id: jobId, status: 'PROCESSING', lease_owner: leaseOwner },
      { $set: { status: 'DONE', completed_at: now }, $unset: { lease_owner: 1, lease_until: 1 } },
    ).exec();
  }

  // EN-03-TC08: hẹn lần thử sau, job về READY với available_at mới.
  async scheduleJobRetry(jobId: Types.ObjectId, leaseOwner: string, attempts: number, availableAt: Date, errorCode: string): Promise<void> {
    await this.outbox.updateOne(
      { _id: jobId, status: 'PROCESSING', lease_owner: leaseOwner },
      { $set: { status: 'READY', attempts, available_at: availableAt, last_error_code: errorCode }, $unset: { lease_owner: 1, lease_until: 1 } },
    ).exec();
  }

  // EN-03-TC08: hết lượt retry thì DEAD; worker không tự lấy job DEAD nữa. Trả về true nếu thật sự đã ghi.
  async markJobDead(jobId: Types.ObjectId, leaseOwner: string, attempts: number, errorCode: string): Promise<boolean> {
    const result = await this.outbox.updateOne(
      { _id: jobId, status: 'PROCESSING', lease_owner: leaseOwner },
      { $set: { status: 'DEAD', attempts, last_error_code: errorCode }, $unset: { lease_owner: 1, lease_until: 1 } },
    ).exec();
    return result.modifiedCount === 1;
  }

  findJobByEventKey(eventKey: string) {
    return this.outbox.findOne({ event_key: eventKey }).lean().exec();
  }

  // ----- Các hàm cho REST sync và ack (EN-03 bước 3). Luôn lọc theo account của người đang đăng nhập. -----

  // Id các thông báo mà account này là người nhận (dùng index account_id, notification_id).
  async findNotificationIdsOf(accountId: Types.ObjectId): Promise<Types.ObjectId[]> {
    const rows = await this.recipients.find({ account_id: accountId }, { notification_id: 1 }).lean().exec();
    return rows.map(row => row.notification_id);
  }

  // EN-03-TC07: chỉ lấy thông báo có sequence lớn hơn cursor, sắp sequence tăng dần.
  findNotificationsAfter(notificationIds: Types.ObjectId[], afterSequence: bigint, limit: number) {
    return this.notifications.find({ _id: { $in: notificationIds }, sequence: { $gt: afterSequence } })
      .sort({ sequence: 1 }).limit(limit).lean().exec();
  }

  findRecipient(notificationId: Types.ObjectId, accountId: Types.ObjectId) {
    return this.recipients.findOne({ notification_id: notificationId, account_id: accountId }).lean().exec();
  }

  // EN-03-TC13: chỉ ghi delivered_at khi chưa có, nên ack nhiều lần vẫn giữ giá trị lần đầu; không đụng read_at.
  async markDelivered(notificationId: Types.ObjectId, accountId: Types.ObjectId, now: Date): Promise<void> {
    await this.recipients.updateOne(
      { notification_id: notificationId, account_id: accountId, delivered_at: null },
      { $set: { delivered_at: now } },
    ).exec();
  }

  // EN-03-TC08: retry vận hành đưa job DEAD về READY, giữ nguyên _id, eventKey và notification.
  async reopenDeadJob(jobId: Types.ObjectId, now: Date): Promise<void> {
    await this.outbox.updateOne(
      { _id: jobId, status: 'DEAD' },
      { $set: { status: 'READY', attempts: 0, available_at: now } },
    ).exec();
  }

  // ----- Các hàm cho inbox của member (US-47 bước 1). Mọi truy vấn BẮT ĐẦU từ recipient của account (US-47-F01). -----

  // Các bước đầu dùng chung cho danh sách và đếm: lọc recipient của account theo trạng thái đọc,
  // nối sang notifications. $unwind bỏ recipient mồ côi (không còn notification) nên không bị đếm (US-47-TC08).
  private ownRecipientStages(accountId: Types.ObjectId, readState: ReadState): PipelineStage[] {
    const match: Record<string, unknown> = { account_id: accountId };
    // US-47-F02: read_at vắng mặt là chưa đọc, có giá trị là đã đọc.
    if (readState === 'UNREAD') match.read_at = { $exists: false };
    if (readState === 'READ') match.read_at = { $exists: true };
    return [
      { $match: match },
      { $lookup: { from: 'notifications', localField: 'notification_id', foreignField: '_id', as: 'notification' } },
      { $unwind: '$notification' },
    ];
  }

  // US-47-TC08: một trang inbox, sắp notifications.sequence giảm dần. MongoDB so sánh Int64 chính xác, không qua JS Number.
  findInboxPage(accountId: Types.ObjectId, readState: ReadState, skip: number, limit: number): Promise<InboxRow[]> {
    return this.recipients.aggregate<InboxRow>([
      ...this.ownRecipientStages(accountId, readState),
      { $sort: { 'notification.sequence': -1 } },
      { $skip: skip },
      { $limit: limit },
    ]).exec();
  }

  // Số recipient của account khớp bộ lọc và có notification hợp lệ (dùng cho total và unreadCount).
  async countInbox(accountId: Types.ObjectId, readState: ReadState): Promise<number> {
    const [result] = await this.recipients.aggregate<{ total: number }>([
      ...this.ownRecipientStages(accountId, readState),
      { $count: 'total' },
    ]).exec();
    // $count không trả document nào khi không có dòng khớp.
    return result ? result.total : 0;
  }

  // US-47-F03, US-47-TC06: chỉ set read_at khi chưa có, trong MỘT lệnh cập nhật atomic trên đúng recipient của account.
  // Hai tab gọi cùng lúc thì chỉ một lệnh khớp điều kiện; lệnh còn lại không ghi gì.
  // Không trả kết quả: service luôn đọc lại recipient để lấy read_at của lần đầu.
  async markRead(notificationId: Types.ObjectId, accountId: Types.ObjectId, now: Date): Promise<void> {
    await this.recipients.updateOne(
      { notification_id: notificationId, account_id: accountId, read_at: { $exists: false } },
      { $set: { read_at: now } },
    ).exec();
  }
}

// Một dòng kết quả inbox: recipient của account kèm notification đã nối.
export type InboxRow = NotificationRecipient & { notification: Notification };
