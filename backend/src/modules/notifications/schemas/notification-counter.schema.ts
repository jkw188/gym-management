// Tầng dữ liệu (EN-03 bước 1): collection notification_counters, chỉ có document {_id:"global", value:Int64}.
// Tăng value trong cùng transaction để cấp sequence cho thông báo; rollback có thể để lại khoảng trống số.
import { Schema } from 'mongoose';

export interface NotificationCounter {
  _id: string;
  value: bigint;
}

export const NotificationCounterSchema = new Schema<NotificationCounter>({
  _id: { type: String, required: true },
  value: { type: Schema.Types.BigInt, required: true },
}, { collection: 'notification_counters', versionKey: false, strict: 'throw' });
