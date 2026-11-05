// Tầng kiểu dữ liệu (EN-03 bước 1): đổi document notifications thành dữ liệu trả về client theo allowlist.
// Chỉ lấy các field công khai; không trả member_id, transaction_id hay danh sách người nhận.
import { Notification } from './schemas/notification.schema';
import { NotificationItem } from './notifications.types';

export function toNotificationItem(notification: Notification): NotificationItem {
  return {
    id: notification._id.toHexString(),
    eventKey: notification.event_key,
    title: notification.title,
    body: notification.body,
    // Int64 có thể vượt giới hạn Number an toàn của JavaScript nên trả dạng chuỗi số nguyên.
    sequence: notification.sequence.toString(),
    createdAt: notification.created_at.toISOString(),
  };
}
