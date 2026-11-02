// Tầng nghiệp vụ: giới hạn số lần đổi mật khẩu theo US-67-F05, bộ đếm lưu trong MongoDB.
// Tối đa 20 request/IP và 5 lần sai mật khẩu hiện tại/account+IP trong mỗi khung 15 phút.
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApplicationError } from '../../common/errors/application-error';
import { AuthRateLimitsRepository } from './auth-rate-limits.repository';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS_PER_IP = 20;
const MAX_WRONG_ATTEMPTS = 5;

// Lỗi 429 mang theo số giây chờ để filter của route ghi vào header Retry-After.
export class RateLimitedError extends ApplicationError {
  constructor(public readonly retryAfter: number) {
    super(429, 'TOO_MANY_REQUESTS', 'Quá nhiều lần thử. Vui lòng thử lại sau');
  }
}

@Injectable()
export class ChangePasswordLimiter {
  constructor(private readonly limits: AuthRateLimitsRepository) {}

  async consumeRequest(ip: string): Promise<void> {
    await this.consume(this.requestKey(ip), MAX_REQUESTS_PER_IP);
  }

  // Giữ chỗ TRƯỚC khi verify để nhiều yêu cầu chạy song song cũng không thử quá 5 lần (US-67-TC10).
  async reserveAttempt(accountId: string, ip: string): Promise<void> {
    await this.consume(this.attemptKey(accountId, ip), MAX_WRONG_ATTEMPTS);
  }

  // Trả lại chỗ đã giữ khi lần thử không phải là sai mật khẩu.
  async releaseAttempt(accountId: string, ip: string): Promise<void> {
    await this.limits.decrement(this.attemptKey(accountId, ip), this.currentBucket());
  }

  private async consume(key: string, max: number): Promise<void> {
    const now = Date.now();
    const bucket = this.currentBucket();
    const windowEnd = (bucket + 1) * WINDOW_MS;
    const count = await this.limits.increment(key, bucket, new Date(bucket * WINDOW_MS), new Date(windowEnd));
    if (count > max) {
      throw new RateLimitedError(Math.ceil((windowEnd - now) / 1000));
    }
  }

  private currentBucket(): number {
    return Math.floor(Date.now() / WINDOW_MS);
  }

  // Chỉ lưu giá trị băm, không lưu IP hay id tài khoản thô trong bộ đếm.
  private requestKey(ip: string): string {
    return createHash('sha256').update(`change-password:ip:${ip}`).digest('hex');
  }

  private attemptKey(accountId: string, ip: string): string {
    return createHash('sha256').update(`change-password:attempt:${accountId}:${ip}`).digest('hex');
  }
}
