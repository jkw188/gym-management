// Tầng nghiệp vụ: giới hạn số lần yêu cầu mã quên mật khẩu theo US-05-F04, bộ đếm lưu trong MongoDB.
// Tối đa 10 request/IP và 3 request/định danh (phone hoặc email) trong mỗi khung 10 phút.
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { RateLimitedError } from '../../common/errors/application-error';
import { AuthRateLimitsRepository } from './auth-rate-limits.repository';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_IP = 10;
const MAX_REQUESTS_PER_IDENTIFIER = 3;

@Injectable()
export class PasswordResetLimiter {
  constructor(private readonly limits: AuthRateLimitsRepository, private readonly config: ConfigService) {}

  // US-05-TC04: vượt giới hạn IP thì trả 429 kèm Retry-After, vì giới hạn này không phụ thuộc account.
  async consumeIp(ip: string): Promise<void> {
    const { count, expiresAt } = await this.limits.increment(this.key(`password-reset:ip:${ip}`), WINDOW_MS);
    if (count > MAX_REQUESTS_PER_IP) {
      const retryAfter = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
      throw new RateLimitedError(retryAfter);
    }
  }

  // US-05-TC03: vượt giới hạn định danh thì KHÔNG báo lỗi (trả false), để phản hồi vẫn là 202 chung, không lộ account.
  async consumeIdentifier(identifier: string): Promise<boolean> {
    const { count } = await this.limits.increment(this.key(`password-reset:identifier:${identifier}`), WINDOW_MS);
    return count <= MAX_REQUESTS_PER_IDENTIFIER;
  }

  // Bảng "auth_rate_limits mới": key là HMAC nên DB không chứa phone, email hay IP thô.
  private key(text: string): string {
    return createHmac('sha256', this.config.getOrThrow<string>('resetOtpPepper')).update(text).digest('hex');
  }
}
