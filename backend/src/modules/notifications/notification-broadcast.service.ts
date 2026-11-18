import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ClientSession, Types } from 'mongoose';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { IdempotencyService } from '../operations/idempotency.service';
import { ROLE_CODES } from '../users/schemas/role.schema';
import { reviewPeriod } from '../reviews/review-period';
import { BroadcastQueryDto, PreviewBroadcastDto } from './notification-broadcast.dto';
import { AudienceAccount, NotificationBroadcastRepository } from './notification-broadcast.repository';
import { NotificationsService } from './notifications.service';
import { NotificationBroadcast } from './schemas/notification-broadcast.schema';

function digest(input: { audience: string; roles: readonly string[]; title: string; body: string }, accounts: AudienceAccount[]) {
  return createHash('sha256').update(JSON.stringify([input.audience, input.roles, input.title, input.body,
    accounts.map(row => [row._id.toHexString(), row.roleId.toHexString(), row.role])])).digest('hex');
}
const previewView = (row: NotificationBroadcast) => ({ previewId: row._id.toHexString(), version: row.version,
  expiresAt: row.preview_expires_at.toISOString(), snapshotAt: (row.sent_at ?? row.created_at).toISOString(), recipientCount: row.recipient_count,
  audienceSummary: row.audience === 'ALL_ACTIVE' ? 'Tất cả tài khoản ACTIVE' : `Vai trò: ${row.roles.join(', ')}`,
  title: row.title, body: row.body });

@Injectable()
export class NotificationBroadcastService {
  constructor(private readonly repository: NotificationBroadcastRepository, private readonly transactions: TransactionRunner,
    private readonly idempotency: IdempotencyService, private readonly notifications: NotificationsService, private readonly clock: ServerClock) {}

  preview(actorId: string, input: PreviewBroadcastDto) {
    // ALL_ACTIVE không chấp nhận thêm điều kiện role gây hiểu nhầm nhóm sẽ nhận.
    if (input.audience === 'ALL_ACTIVE' && input.roles !== undefined) invalidField('roles', 'Chỉ chọn roles với audience ROLES');
    const roles = input.audience === 'ALL_ACTIVE' ? [] : [...new Set(input.roles!)].sort();
    return this.transactions.run(async session => {
      const now = this.clock.now();
      const accounts = await this.repository.audience(input.audience === 'ALL_ACTIVE' ? ROLE_CODES : roles, session);
      const row = await this.repository.insert({ created_by: new Types.ObjectId(actorId), audience: input.audience, roles,
        title: input.title, body: input.body, recipient_digest: digest({ ...input, roles }, accounts), recipient_count: accounts.length,
        preview_expires_at: new Date(now.getTime() + 300_000), version: 0, status: 'PREVIEW', created_at: now }, session);
      return previewView(row);
    });
  }
  send(actorId: string, id: string, version: number, key: string) {
    return this.idempotency.execute({ actorId, operation: 'NOTIFICATION_BROADCAST_SEND', clientKey: key, targetId: id.toLowerCase(), payload: { version } }, async session => {
      const now = this.clock.now();
      const row = await this.repository.find(new Types.ObjectId(id), session);
      if (!row || !row.created_by.equals(actorId)) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy bản xem trước');
      if (row.status === 'SENT') throw new ApplicationError(409, 'BROADCAST_ALREADY_SENT', 'Thông báo đã được lưu, không gửi lại bằng khóa mới');
      if (row.version !== version || row.preview_expires_at <= now) throw stale();
      const accounts = await this.repository.audience(row.audience === 'ALL_ACTIVE' ? ROLE_CODES : row.roles, session);
      if (row.recipient_digest !== digest(row, accounts)) throw stale();
      if (accounts.length === 0) throw new ApplicationError(409, 'AUDIENCE_EMPTY', 'Không có tài khoản ACTIVE trong nhóm nhận');
      const event = await this.notifications.persistBusinessEvent(session, { eventKey: `BROADCAST:${id.toLowerCase()}`,
        title: row.title, body: row.body, createdBy: actorId }, accounts.map(account => account._id.toHexString()));
      await this.repository.markSent(row, new Types.ObjectId(event.notificationId), now, session);
      return { status: 200, body: { broadcastId: row._id.toHexString(), notificationId: event.notificationId,
        status: 'SENT', recipientCount: accounts.length, dispatchStatus: 'READY' }, resultIds: { broadcastId: row._id.toHexString(), notificationId: event.notificationId } };
    });
  }
  list(query: BroadcastQueryDto) {
    if (!Number.isSafeInteger(query.page * query.limit)) invalidField('page', 'Trang vượt giới hạn');
    return this.transactions.run(async session => {
      const asOf = this.clock.now().toISOString();
      const range = reviewPeriod(this.clock.today(), query.fromDate, query.toDate);
      const [data] = await this.repository.page({ ...range, status: query.status }, query.page, query.limit, session);
      const items = [];
      for (const row of data.items) items.push(await this.view(row, session, asOf));
      const total = data.counts[0]?.total ?? 0;
      return { items, page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit), asOf };
    });
  }
  detail(id: string) {
    return this.transactions.run(async session => {
      const asOf = this.clock.now().toISOString();
      const row = await this.repository.find(new Types.ObjectId(id), session);
      if (!row) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy broadcast');
      return this.view(row, session, asOf);
    });
  }
  private async view(row: NotificationBroadcast, session: ClientSession, asOf: string) {
    const progress = row.notification_id ? await this.repository.progress(row.notification_id, session) :
      { counts: { sent: 0, delivered: 0, read: 0 }, dispatchStatus: null };
    return { ...previewView(row), broadcastId: row._id.toHexString(), status: row.status, notificationId: row.notification_id?.toHexString(),
      counts: { snapshot: row.recipient_count, ...progress.counts }, dispatchStatus: progress.dispatchStatus,
      createdAt: row.created_at.toISOString(), sentAt: row.sent_at?.toISOString(), asOf };
  }
}
function stale() { return new ApplicationError(409, 'PREVIEW_STALE', 'Bản xem trước đã hết hạn hoặc nhóm nhận thay đổi. Hãy xem trước lại'); }
