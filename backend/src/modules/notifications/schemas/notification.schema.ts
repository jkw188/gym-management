// Tầng dữ liệu (EN-03 bước 1): cấu trúc collection notifications, mỗi document là một thông báo nghiệp vụ.
// Nội dung không đổi sau khi commit; không chứa token, mật khẩu hay thông tin ngân hàng (EN-03-F01).
import { Schema, Types } from 'mongoose';

export interface Notification {
  _id: Types.ObjectId;
  created_by?: Types.ObjectId;
  title: string;
  body: string;
  event_key: string;
  sequence: bigint;
  member_id?: Types.ObjectId;
  transaction_id?: Types.ObjectId;
  created_at: Date;
}

export const NotificationSchema = new Schema<Notification>({
  created_by: { type: Schema.Types.ObjectId, ref: 'Account' },
  title: { type: String, required: true, maxlength: 190 },
  body: { type: String, required: true, maxlength: 2000 },
  // Ví dụ "SERVICE_SALE_SETTLED:<saleId>"; unique để một sự kiện chỉ có một thông báo (EN-03-TC02).
  event_key: { type: String, required: true, maxlength: 120 },
  // Số thứ tự Int64 lấy từ notification_counters trong cùng transaction; REST sync đọc theo thứ tự này.
  sequence: { type: Schema.Types.BigInt, required: true },
  // member_id, transaction_id để truy vết nguồn, kể cả khi chưa có account nhận (EN-03-TC04).
  member_id: { type: Schema.Types.ObjectId },
  transaction_id: { type: Schema.Types.ObjectId },
  created_at: { type: Date, required: true },
}, { collection: 'notifications', versionKey: false, strict: 'throw' });

// EN-03-TC02: cùng eventKey không tạo thông báo thứ hai.
NotificationSchema.index({ event_key: 1 }, { unique: true, name: 'notifications_event_key_unique' });
NotificationSchema.index({ sequence: 1 }, { unique: true, name: 'notifications_sequence_unique' });
