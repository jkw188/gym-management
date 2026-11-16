import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CancelOrderService } from './cancel-order.service';
import { OrdersRepository } from './orders.repository';
import { ServerClock } from '../../common/utils/business-date';
import { ApplicationError } from '../../common/errors/application-error';

@Injectable()
export class OrderExpiryWorker implements OnModuleDestroy {
  private readonly logger = new Logger(OrderExpiryWorker.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;
  readonly metrics = { expiredHeldCount: 0, cancelledCount: 0, failureCount: 0 };
  constructor(private readonly repository: OrdersRepository, private readonly cancellation: CancelOrderService, private readonly clock: ServerClock) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5000);
    void this.tick(); // Catch up all overdue orders immediately after restart.
  }
  onModuleDestroy() { clearInterval(this.timer); this.timer = undefined; }
  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try { await this.runOnce(); }
    catch { this.logger.error('ORDER_EXPIRY_SCAN_FAILED'); }
    finally { this.ticking = false; }
  }
  async runOnce() {
    const now = this.clock.now(), orders = this.repository.connection.db!.collection('orders');
    const eligible = { reservation_state: 'HELD', status: { $in: ['PENDING', 'CONFIRMED'] }, reservation_expires_at: { $lte: now } };
    this.metrics.expiredHeldCount = await orders.countDocuments(eligible);
    const rows = await orders.find({ ...eligible, $or: [{ expiry_retry_at: { $exists: false } }, { expiry_retry_at: { $lte: now } }] })
      .sort({ reservation_expires_at: 1, _id: 1 }).limit(50).toArray();
    for (const row of rows) {
      try { const result = await this.cancellation.expire(String(row._id)); if (result.changed) this.metrics.cancelledCount++; }
      catch (error) {
        this.metrics.failureCount++;
        const code = error instanceof ApplicationError && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'ORDER_EXPIRY_FAILED';
        this.logger.warn(`orderId=${row._id} code=${code}`);
        // Retry metadata is independent of the aborted business transaction. Persist it to avoid starvation across restarts.
        const attempts = Math.min(30, (Number.isInteger(row.expiry_attempts) ? Number(row.expiry_attempts) : 0) + 1);
        try { await orders.updateOne({ _id: row._id, ...eligible }, { $set: { expiry_attempts: attempts,
          expiry_retry_at: new Date(this.clock.now().getTime() + Math.min(60000, 5000 * 2 ** (attempts - 1))) } }); }
        catch { this.logger.error(`orderId=${row._id} code=ORDER_EXPIRY_RETRY_SAVE_FAILED`); }
      }
    }
    return { attempted: rows.length, ...this.metrics };
  }
}
