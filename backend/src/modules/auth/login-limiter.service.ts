import { Injectable } from '@nestjs/common';

interface Window { count: number; resetAt: number }
@Injectable()
export class LoginLimiter {
  private readonly windows = new Map<string, Window>();

  consume(ip: string, normalizedPhone: string, now = Date.now()): number {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
    const limits = [[JSON.stringify([ip]), 20], [JSON.stringify([ip, normalizedPhone]), 5]] as const;
    let retryAfter = 0;
    for (const [key, max] of limits) {
      const window = this.windows.get(key);
      if (window && window.count >= max) retryAfter = Math.max(retryAfter, Math.ceil((window.resetAt - now) / 1000));
    }
    if (retryAfter) return retryAfter;
    for (const [key] of limits) {
      const window = this.windows.get(key) ?? { count: 0, resetAt: now + 60_000 };
      window.count++;
      this.windows.set(key, window);
    }
    return 0;
  }
}
