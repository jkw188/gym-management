// Tầng dữ liệu (EN-03 bước 1): cấu trúc collection notification_outbox, hàng đợi việc phát realtime sau commit.
// Bước 1 chỉ tạo job READY; worker lấy job, lease và retry thuộc bước 2.
import { Schema, Types } from 'mongoose';

export const OUTBOX_STATUSES = ['READY', 'PROCESSING', 'DONE', 'DEAD'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface NotificationOutbox {
  _id: Types.ObjectId;
  event_key: string;
  notification_id: Types.ObjectId;
  status: OutboxStatus;
  attempts: number;
  available_at: Date;
  lease_until?: Date;
  lease_owner?: string;
  completed_at?: Date;
  last_error_code?: string; // chỉ mã lỗi an toàn, không lưu stack hay secret
}

export const NotificationOutboxSchema = new Schema<NotificationOutbox>({
  event_key: { type: String, required: true, maxlength: 120 },
  notification_id: { type: Schema.Types.ObjectId, ref: 'Notification', required: true },
  status: { type: String, required: true, enum: OUTBOX_STATUSES },
  attempts: { type: Schema.Types.Int32, required: true },
  available_at: { type: Date, required: true },
  lease_until: { type: Date },
  lease_owner: { type: String },
  completed_at: { type: Date },
  last_error_code: { type: String },
}, { collection: 'notification_outbox', versionKey: false, strict: 'throw' });

// EN-03-TC02, EN-03-TC03: mỗi sự kiện chỉ có một job; trùng thì insert lỗi và transaction rollback.
NotificationOutboxSchema.index({ event_key: 1 }, { unique: true, name: 'notification_outbox_event_key_unique' });
// Chỉ mục để worker tìm job đến hạn (bước 2).
NotificationOutboxSchema.index({ status: 1, available_at: 1, lease_until: 1 }, { name: 'notification_outbox_worker' });
