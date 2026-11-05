// Tầng dữ liệu (EN-03 bước 1): nơi duy nhất đọc/ghi notifications, notification_recipients, notification_outbox, notification_counters.
// Mọi lệnh ghi nhận session rõ ràng để nằm trong transaction của lệnh nghiệp vụ; repository không tự mở transaction.
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
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
}
