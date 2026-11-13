// Tầng nghiệp vụ (US-47 bước 1): inbox thông báo của chính member – xem danh sách, đếm chưa đọc, xem chi tiết, đánh dấu đã đọc.
// Luôn lấy accountId của người đang đăng nhập và chỉ đọc qua notification_recipients của account đó (US-47-F01).
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { toInboxDetail, toInboxItem } from './notification.mapper';
import { NotificationsRepository } from './notifications.repository';
import { InboxDetail, InboxPage, InboxQuery, MarkReadResult, UnreadCountResult } from './notifications.types';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

// US-47-TC02: không tồn tại và của người khác trả CÙNG một lỗi, để không lộ thông báo nào đang có.
const notFound = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy thông báo');

@Injectable()
export class NotificationInboxService {
  constructor(private readonly repository: NotificationsRepository) {}

  // US-47-TC01, US-47-TC08: một trang inbox của account, kèm unreadCount (không phụ thuộc bộ lọc readState).
  async listOwn(accountId: string, query: InboxQuery): Promise<InboxPage> {
    const account = new Types.ObjectId(accountId);
    const skip = (query.page - 1) * query.limit;
    const rows = await this.repository.findInboxPage(account, query.readState, skip, query.limit);
    const total = await this.repository.countInbox(account, query.readState);
    const unreadCount = await this.repository.countInbox(account, 'UNREAD');
    return {
      items: rows.map(row => toInboxItem(row.notification, row)),
      page: query.page,
      limit: query.limit,
      total,
      // Inbox rỗng thì totalPages = 0. US-47-D02: page lớn hơn totalPages vẫn trả items rỗng, không báo lỗi.
      totalPages: Math.ceil(total / query.limit),
      unreadCount,
      asOf: new Date().toISOString(),
    };
  }

  // US-47-TC01: chỉ đếm recipient chưa đọc của chính account, có notification hợp lệ.
  async countUnread(accountId: string): Promise<UnreadCountResult> {
    const unreadCount = await this.repository.countInbox(new Types.ObjectId(accountId), 'UNREAD');
    return { unreadCount, asOf: new Date().toISOString() };
  }

  // US-47-TC01, US-47-TC05: xem chi tiết KHÔNG tự ghi read_at.
  async getOwn(accountId: string, notificationId: string): Promise<InboxDetail> {
    const { notification, recipient } = await this.findOwn(accountId, notificationId);
    return toInboxDetail(notification, recipient);
  }

  // US-47-F03, US-47-TC06: idempotent – gọi lại vẫn trả read_at của lần đầu. Không ghi delivered_at (US-47-TC05).
  async markReadOwn(accountId: string, notificationId: string): Promise<MarkReadResult> {
    const { notification } = await this.findOwn(accountId, notificationId);
    const account = new Types.ObjectId(accountId);
    await this.repository.markRead(notification._id, account, new Date());
    // Đọc lại recipient: dù lần này có ghi hay không, read_at trong DB luôn là timestamp lần đầu.
    const recipient = await this.repository.findRecipient(notification._id, account);
    // Phòng trường hợp recipient biến mất giữa hai lệnh: trả 404 theo hợp đồng lỗi, không để TypeError thành 500.
    if (!recipient || !recipient.read_at) throw notFound();
    return { id: notification._id.toHexString(), readAt: recipient.read_at.toISOString() };
  }

  // US-47-TC02, US-47-TC04: phải có recipient của CHÍNH account; member_id trùng cũng không đủ quyền xem.
  private async findOwn(accountId: string, notificationId: string) {
    // US-47-D01: id sai định dạng là dữ liệu sai → 400; đúng định dạng mà không có/của người khác → 404.
    if (!OBJECT_ID.test(notificationId)) throw new ApplicationError(400, 'INVALID_ID', 'Mã thông báo không hợp lệ');
    const id = new Types.ObjectId(notificationId);
    const recipient = await this.repository.findRecipient(id, new Types.ObjectId(accountId));
    if (!recipient) throw notFound();
    const notification = await this.repository.findNotificationById(id);
    if (!notification) throw notFound();
    return { notification, recipient };
  }
}
