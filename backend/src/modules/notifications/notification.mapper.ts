// Tầng kiểu dữ liệu (EN-03 bước 1): đổi document notifications thành dữ liệu trả về client theo allowlist.
// Chỉ lấy các field công khai; không trả member_id, transaction_id hay danh sách người nhận.
import { NotificationRecipient } from './schemas/notification-recipient.schema';
import { Notification } from './schemas/notification.schema';
import { InboxDetail, InboxItem, NotificationCreatedPayload, NotificationItem } from './notifications.types';

// Nội dung worker gửi qua socket (EN-03 bước 2, sự kiện notification.created).
export function toCreatedPayload(notification: Notification): NotificationCreatedPayload {
  return {
    id: notification._id.toHexString(),
    eventKey: notification.event_key,
    title: notification.title,
    body: notification.body,
    createdAt: notification.created_at.toISOString(),
  };
}

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

// ----- Inbox của member (US-47). -----

const PREVIEW_LENGTH = 120;

// US-47-D03: lấy tối đa 120 ký tự Unicode đầu của body, đổi xuống dòng thành dấu cách, bị cắt thì thêm "…".
// Array.from tách chuỗi theo ký tự Unicode, nên một emoji (2 đơn vị UTF-16) vẫn tính là 1 ký tự, không bị cắt đôi.
export function toBodyPreview(body: string): string {
  const characters = Array.from(body.replace(/\r\n|\r|\n/g, ' '));
  if (characters.length <= PREVIEW_LENGTH) return characters.join('');
  return `${characters.slice(0, PREVIEW_LENGTH).join('')}…`;
}

// Trạng thái của recipient: chỉ thêm field khi có giá trị (read_at vắng mặt = chưa đọc, US-47-F02).
function recipientState(recipient: NotificationRecipient): { readAt?: string; deliveredAt?: string } {
  return {
    ...(recipient.read_at ? { readAt: recipient.read_at.toISOString() } : {}),
    ...(recipient.delivered_at ? { deliveredAt: recipient.delivered_at.toISOString() } : {}),
  };
}

export function toInboxItem(notification: Notification, recipient: NotificationRecipient): InboxItem {
  return {
    id: notification._id.toHexString(),
    title: notification.title,
    bodyPreview: toBodyPreview(notification.body),
    createdAt: notification.created_at.toISOString(),
    ...recipientState(recipient),
  };
}

// US-47-TC01: chi tiết trả body gốc đầy đủ, không trả eventKey, member_id hay người nhận khác.
export function toInboxDetail(notification: Notification, recipient: NotificationRecipient): InboxDetail {
  return {
    id: notification._id.toHexString(),
    title: notification.title,
    body: notification.body,
    createdAt: notification.created_at.toISOString(),
    ...recipientState(recipient),
  };
}
