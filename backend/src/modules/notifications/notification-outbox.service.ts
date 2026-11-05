// Tầng nghiệp vụ (EN-03 bước 2): outbox worker lấy job đã commit, gọi dispatcher, rồi DONE hoặc hẹn retry/DEAD.
// Luật: lease 30 giây, tick tối đa mỗi 5 giây, batch 50, retry sau 10/30/60/120/300 giây, lần thử thứ 6 vẫn lỗi thì DEAD.
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { NotificationDispatcher } from './notification-dispatcher';
import { toCreatedPayload } from './notification.mapper';
import { NotificationsRepository } from './notifications.repository';
import { NotificationOutbox } from './schemas/notification-outbox.schema';

const LEASE_SECONDS = 30;
const TICK_INTERVAL_MS = 5000;
const BATCH_SIZE = 50;
// Spec 1.1: 1 lần đầu + 5 lần retry. Phần tử thứ i là số giây chờ sau lần thử thất bại thứ i+1.
const RETRY_DELAYS_SECONDS = [10, 30, 60, 120, 300];

@Injectable()
export class NotificationOutboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationOutboxService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly repository: NotificationsRepository,
    private readonly dispatcher: NotificationDispatcher,
    private readonly config: ConfigService,
  ) {}

  // Ứng dụng chạy thật thì tự bật worker; khi test thì test tự gọi runOnce() hoặc start().
  onApplicationBootstrap(): void {
    if (this.config.get('nodeEnv') !== 'test') this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  // EN-03-TC18: tick tự động mỗi 5 giây. Tick trước chưa xong thì bỏ qua lượt này để không chạy chồng.
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.autoTick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async autoTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runOnce();
    } catch (error) {
      // Lỗi hạ tầng (mất DB...) không làm sập ứng dụng; tick sau thử lại. Chỉ ghi tên lỗi, không ghi message thô.
      this.logger.error(`Outbox tick lỗi: ${error instanceof Error ? error.name : 'UNKNOWN'}`);
    } finally {
      this.ticking = false;
    }
  }

  // Một lượt tick: nhận và xử lý lần lượt tối đa 50 job đến hạn (EN-03-TC17). Trả về số job đã nhận.
  async runOnce(): Promise<number> {
    // lease_owner ngẫu nhiên cho mỗi lượt tick, để hai lượt chạy song song không nhận nhầm là của nhau.
    const leaseOwner = randomUUID();
    const handled: Types.ObjectId[] = [];
    while (handled.length < BATCH_SIZE) {
      const now = new Date();
      const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000);
      // Mỗi job tối đa một lần trong một lượt tick (EN-03-TC06: mất lease thì để lượt sau xử lý lại).
      const job = await this.repository.claimNextJob(leaseOwner, now, leaseUntil, handled);
      if (!job) break;
      handled.push(job._id);
      await this.processJob(job, leaseOwner);
    }
    return handled.length;
  }

  private async processJob(job: NotificationOutbox, leaseOwner: string): Promise<void> {
    try {
      const recipientIds = await this.repository.findRecipientAccountIds(job.notification_id);
      // EN-03-TC20: thông báo không có người nhận (NO_LINKED_ACCOUNT) thì DONE ngay, không gọi dispatch.
      if (recipientIds.length > 0) {
        const notification = await this.repository.findNotificationById(job.notification_id);
        if (!notification) throw new ApplicationError(500, 'NOTIFICATION_NOT_FOUND', 'Không tìm thấy thông báo của job');
        // EN-03-TC06, EN-03-TC07: gửi lại vẫn cùng notification id để client gộp; người nhận offline vẫn là thành công.
        await this.dispatcher.dispatch({
          notification: toCreatedPayload(notification),
          recipientAccountIds: recipientIds.map(id => id.toHexString()),
        });
      }
    } catch (error) {
      await this.handleFailure(job, leaseOwner, error);
      return;
    }
    // EN-03-TC05: chỉ ghi DONE nếu vẫn còn giữ lease; worker khác đã lấy job thì không ghi gì.
    await this.repository.markJobDone(job._id, leaseOwner, new Date());
  }

  // EN-03-TC08: lỗi thì tăng attempts; còn lượt thì hẹn retry theo lịch, hết lượt thì DEAD.
  private async handleFailure(job: NotificationOutbox, leaseOwner: string, error: unknown): Promise<void> {
    const attempts = job.attempts + 1;
    const errorCode = safeErrorCode(error);
    if (attempts <= RETRY_DELAYS_SECONDS.length) {
      const availableAt = new Date(Date.now() + RETRY_DELAYS_SECONDS[attempts - 1] * 1000);
      await this.repository.scheduleJobRetry(job._id, leaseOwner, attempts, availableAt, errorCode);
      return;
    }
    const markedDead = await this.repository.markJobDead(job._id, leaseOwner, attempts, errorCode);
    // EN-03-TC19: log mức error có eventKey và mã lỗi an toàn; không ghi message lỗi thô, stack hay secret.
    if (markedDead) this.logger.error(`Outbox job DEAD eventKey=${job.event_key} lastErrorCode=${errorCode}`);
  }

  // Công cụ vận hành (EN-03-TC08, EN-03-TC20): đưa job DEAD về READY để gửi lại, giữ nguyên eventKey và notification.
  async retryDead(eventKey: string): Promise<void> {
    const job = await this.repository.findJobByEventKey(eventKey);
    if (!job) throw new ApplicationError(404, 'NOTIFICATION_OUTBOX_NOT_FOUND', 'Không tìm thấy job thông báo');
    if (job.status !== 'DEAD') throw new ApplicationError(409, 'NOTIFICATION_OUTBOX_NOT_DEAD', 'Job thông báo không ở trạng thái DEAD');
    await this.repository.reopenDeadJob(job._id, new Date());
  }
}

// EN-03-TC08: chỉ lưu mã lỗi dạng CHỮ_HOA (vd mã của ApplicationError); lỗi khác ghi chung DISPATCH_FAILED.
// Không bao giờ lưu message vì message có thể chứa URI, mật khẩu hay token.
function safeErrorCode(error: unknown): string {
  if (error instanceof ApplicationError && /^[A-Z0-9_]{1,64}$/.test(error.code)) return error.code;
  return 'DISPATCH_FAILED';
}
