// Tầng nghiệp vụ (EN-03 bước 1): lưu thông báo, người nhận và outbox trong CÙNG transaction của lệnh nghiệp vụ.
// Không phát socket ở đây; worker chỉ phát sau khi transaction đã commit (EN-03-F03).
import { Injectable } from '@nestjs/common';
import { ClientSession, Types } from 'mongoose';
import { NotificationsRepository } from './notifications.repository';
import { BusinessEventSource, NotificationState, PersistedEvent } from './notifications.types';

@Injectable()
export class NotificationsService {
  constructor(private readonly repository: NotificationsRepository) {}

  // Module nghiệp vụ gọi trong callback transaction của mình và truyền session vào.
  // recipients là danh sách account đang liên kết với member lúc hoàn tất; rỗng thì vẫn lưu thông báo (EN-03-F02).
  async persistBusinessEvent(session: ClientSession, source: BusinessEventSource, recipients: string[]): Promise<PersistedEvent> {
    // EN-03-TC02, EN-03-TC04: cùng eventKey đã lưu thì trả lại thông báo cũ, không đổi body và không thêm recipient.
    const existing = await this.repository.findByEventKey(source.eventKey, session);
    if (existing) {
      const recipientCount = await this.repository.countRecipients(existing._id, session);
      return { notificationId: existing._id.toHexString(), notificationState: stateFor(recipientCount) };
    }

    // Đổi id sang ObjectId; id sai định dạng thì ném lỗi và cả transaction rollback (EN-03-TC03).
    // Bỏ account trùng trong danh sách để mỗi account chỉ một recipient.
    const accountIds = [...new Set(recipients)].map(id => new Types.ObjectId(id));
    const now = new Date();

    // EN-03-TC01: notification, recipients và outbox ghi cùng session; lỗi bất kỳ bước nào thì rollback tất cả (EN-03-TC03).
    const sequence = await this.repository.nextSequence(session);
    const notificationId = await this.repository.insertNotification({
      eventKey: source.eventKey, title: source.title, body: source.body, sequence, createdAt: now,
      memberId: toObjectId(source.memberId), transactionId: toObjectId(source.transactionId), createdBy: toObjectId(source.createdBy),
    }, session);
    await this.repository.insertRecipients(notificationId, accountIds, session);
    await this.repository.insertOutbox(source.eventKey, notificationId, now, session);

    return { notificationId: notificationId.toHexString(), notificationState: stateFor(accountIds.length) };
  }
}

// EN-03-TC04: không có account nhận thì trạng thái NO_LINKED_ACCOUNT, có thì STORED.
function stateFor(recipientCount: number): NotificationState {
  return recipientCount > 0 ? 'STORED' : 'NO_LINKED_ACCOUNT';
}

function toObjectId(id: string | undefined): Types.ObjectId | undefined {
  return id === undefined ? undefined : new Types.ObjectId(id);
}
