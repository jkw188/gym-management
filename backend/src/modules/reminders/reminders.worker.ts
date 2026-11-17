import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ServerClock } from '../../common/utils/business-date';
import { reminderEventKey } from './reminder.policy';
import { RemindersRepository } from './reminders.repository';
import { RemindersService } from './reminders.service';

@Injectable()
export class RemindersWorker implements OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  constructor(private readonly repository: RemindersRepository, private readonly reminders: RemindersService,
    private readonly clock: ServerClock, private readonly config: ConfigService) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.config.getOrThrow<number>('reminderTickMs'));
    void this.tick();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }
  onModuleDestroy(): void { this.stop(); }
  private async tick(): Promise<void> {
    // Chỉ tránh timer cùng instance chồng nhau; correctness dựa vào gate + unique trong DB.
    if (this.ticking) return;
    this.ticking = true;
    try { await this.runOnce(); }
    catch { console.error(JSON.stringify({ code: 'REMINDER_SCAN_FAILED', requestId: randomUUID() })); }
    finally { this.ticking = false; }
  }
  async runOnce() {
    const requestId = randomUUID();
    const stats = { stored: 0, skipped: 0, failed: 0, existing: 0, lagMs: 0 };
    const candidates = await this.repository.candidates(this.clock.now(), this.config.getOrThrow<number>('reminderBatchSize'));
    for (const candidate of candidates) {
      const context = { requestId, eventKey: reminderEventKey(candidate.sourceType, candidate.sourceId.toHexString(), candidate.milestone),
        sourceId: candidate.sourceId.toHexString(), dueAt: candidate.dueAt.toISOString() };
      try {
        const result = await this.reminders.process(candidate);
        if (result.outcome === 'STORED') stats.stored++;
        else if (result.outcome.startsWith('SKIPPED')) stats.skipped++;
        else stats.existing++;
        stats.lagMs = Math.max(stats.lagMs, result.lagMs);
        console.info(JSON.stringify({ ...context, ...result }));
      } catch {
        stats.failed++;
        // Không có terminal occurrence: tick sau (<=60s) đọc lại nguồn, window và retry.
        console.error(JSON.stringify({ ...context, outcome: 'FAILED' }));
      }
    }
    // Bootstrap tắt Nest logger; dùng structured console như log vận hành main/filter.
    console.info(JSON.stringify({ requestId, code: 'REMINDER_BATCH', ...stats }));
    return stats;
  }
}
