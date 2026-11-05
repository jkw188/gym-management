// Tầng nghiệp vụ (EN-03 bước 1, 3): lưu thông báo cùng transaction nghiệp vụ; chính sách người nhận, REST sync và ack.
// Không phát socket ở đây; worker chỉ phát sau khi transaction đã commit (EN-03-F03).
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientSession, Types } from 'mongoose';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApplicationError } from '../../common/errors/application-error';
import { AuthService } from '../auth/auth.service';
import { AuthPrincipal } from '../auth/auth.types';
import { RoleCode } from '../users/schemas/role.schema';
import { toNotificationItem } from './notification.mapper';
import { NotificationsRepository } from './notifications.repository';
import { AckResult, BusinessEventSource, NotificationState, PersistedEvent, SyncResult } from './notifications.types';

// EN-03-F02: người nhận thông báo là account MEMBER. Socket và REST sync dùng chung chính sách này.
export const RECIPIENT_ROLE: RoleCode = 'MEMBER';
const DEFAULT_SYNC_LIMIT = 50;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const invalidCursor = () => new ApplicationError(400, 'VALIDATION_ERROR', 'Cursor không hợp lệ');

@Injectable()
export class NotificationsService {
  // Khóa ký cursor, suy ra từ JWT secret (không thêm biến môi trường); chỉ để phát hiện cursor bị sửa.
  private readonly cursorKey: Buffer;

  constructor(private readonly repository: NotificationsRepository, private readonly auth: AuthService, config: ConfigService) {
    this.cursorKey = createHash('sha256').update(`notification-cursor:${config.getOrThrow<string>('jwtAccessSecret')}`).digest();
  }

  // EN-03-F06: kiểm access token như HTTP (AUTH-F06) và account phải còn là người nhận (MEMBER).
  // Gateway gọi lúc handshake, trước mỗi emit và mỗi ack. Lỗi DB được ném nguyên để gateway chặn (không fail-open).
  async authenticateRecipient(accessToken: unknown): Promise<AuthPrincipal> {
    const principal = await this.auth.validateAccessToken(accessToken);
    if (principal.roleCode !== RECIPIENT_ROLE) throw new ApplicationError(403, 'FORBIDDEN', 'Không có quyền truy cập');
    return principal;
  }

  // EN-03-TC07, EN-03-TC11: chỉ trả thông báo có recipient là account này, sequence lớn hơn cursor, tăng dần.
  async sync(accountId: string, cursor: string | undefined, limitText: string | undefined): Promise<SyncResult> {
    const afterSequence = cursor === undefined ? 0n : this.readCursor(cursor);
    const limit = limitText === undefined ? DEFAULT_SYNC_LIMIT : Number(limitText);
    const notificationIds = await this.repository.findNotificationIdsOf(new Types.ObjectId(accountId));
    // Lấy dư một bản ghi để biết còn trang sau hay không.
    const rows = await this.repository.findNotificationsAfter(notificationIds, afterSequence, limit + 1);
    const items = rows.slice(0, limit).map(toNotificationItem);
    // Hết dữ liệu vẫn giữ cursor cũ để client đồng bộ tiếp sau reconnect.
    const nextCursor = items.length > 0 ? this.signCursor(items[items.length - 1].sequence) : (cursor ?? null);
    return { items, nextCursor, hasMore: rows.length > limit };
  }

  // EN-03-TC13: recipient ack thì ghi delivered_at lần đầu. EN-03-TC11: không sở hữu hoặc không có đều NOT_FOUND.
  async acknowledge(accountId: string, notificationId: unknown): Promise<AckResult> {
    if (typeof notificationId !== 'string' || !OBJECT_ID.test(notificationId)) return { ok: false, error: { code: 'VALIDATION_ERROR' } };
    const notification = new Types.ObjectId(notificationId);
    const account = new Types.ObjectId(accountId);
    if (!(await this.repository.findRecipient(notification, account))) return { ok: false, error: { code: 'NOT_FOUND' } };
    await this.repository.markDelivered(notification, account, new Date());
    return { ok: true };
  }

  // Cursor = base64url(sequence) + "." + chữ ký HMAC. Không chứa accountId (EN-03-TC11).
  private signCursor(sequence: string): string {
    return `${Buffer.from(sequence).toString('base64url')}.${this.signature(sequence)}`;
  }

  // EN-03-TC11: cursor rác hoặc bị sửa (sai chữ ký) thì 400, không chạy query với giá trị lạ.
  private readCursor(cursor: string): bigint {
    const [encoded, signature, extra] = cursor.split('.');
    if (!encoded || !signature || extra !== undefined) throw invalidCursor();
    const sequence = Buffer.from(encoded, 'base64url').toString();
    if (!/^\d{1,19}$/.test(sequence)) throw invalidCursor();
    const expected = Buffer.from(this.signature(sequence));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidCursor();
    return BigInt(sequence);
  }

  private signature(sequence: string): string {
    return createHmac('sha256', this.cursorKey).update(sequence).digest('base64url');
  }

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
