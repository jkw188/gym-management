// Tầng dữ liệu (EN-03 bước 1): cấu trúc collection notification_recipients, mỗi document là một account nhận một thông báo.
// Người nhận được chốt lúc commit, không đổi lại khi hồ sơ được liên kết account khác sau này (EN-03-F02).
import { Schema, Types } from 'mongoose';

export interface NotificationRecipient {
  _id: Types.ObjectId;
  notification_id: Types.ObjectId;
  account_id: Types.ObjectId;
  read_at?: Date;      // chỉ US-47 ghi
  delivered_at?: Date; // ghi khi ack hợp lệ lần đầu (bước 3)
}

export const NotificationRecipientSchema = new Schema<NotificationRecipient>({
  notification_id: { type: Schema.Types.ObjectId, ref: 'Notification', required: true },
  account_id: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  read_at: { type: Date },
  delivered_at: { type: Date },
}, { collection: 'notification_recipients', versionKey: false, strict: 'throw' });

// EN-03-TC02: một account chỉ nhận một lần cho mỗi thông báo.
NotificationRecipientSchema.index({ notification_id: 1, account_id: 1 }, { unique: true, name: 'notification_recipients_notification_account_unique' });
// Tìm thông báo của một account (REST sync ở bước 3).
NotificationRecipientSchema.index({ account_id: 1, notification_id: 1 }, { name: 'notification_recipients_account_notification' });
