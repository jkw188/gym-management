// Tầng nghiệp vụ: giới hạn số lần dùng chức năng quên mật khẩu theo US-05-F04, bộ đếm lưu trong MongoDB.
// Mỗi khung 10 phút: yêu cầu mã tối đa 10 request/IP và 3 request/định danh; xác nhận (reset) tối đa 20 request/IP.
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { RateLimitedError } from '../../common/errors/application-error';
import { AuthRateLimitsRepository } from './auth-rate-limits.repository';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_IP = 10;
const MAX_REQUESTS_PER_IDENTIFIER = 3;
const MAX_CONFIRMS_PER_IP = 20;

@Injectable()
export class PasswordResetLimiter {
  constructor(private readonly limits: AuthRateLimitsRepository, private readonly config: ConfigService) {}

  // US-05-TC04: vượt giới hạn IP thì trả 429 kèm Retry-After, vì giới hạn này không phụ thuộc account.
  async consumeRequestIp(ip: string): Promise<void> {
    await this.consumeOrThrow(`password-reset:ip:${ip}`, MAX_REQUESTS_PER_IP);
  }

  // US-05-TC04 (phần confirm): 20 lần reset/IP/10 phút, tính riêng với giới hạn 5 lần thử/challenge.
  async consumeConfirmIp(ip: string): Promise<void> {
    await this.consumeOrThrow(`password-reset:confirm-ip:${ip}`, MAX_CONFIRMS_PER_IP);
  }

  // US-05-TC03: vượt giới hạn định danh thì KHÔNG báo lỗi (trả false), để phản hồi vẫn là 202 chung, không lộ account.
  async consumeIdentifier(identifier: string): Promise<boolean> {
    const { count } = await this.limits.increment(this.key(`password-reset:identifier:${identifier}`), WINDOW_MS);
    return count <= MAX_REQUESTS_PER_IDENTIFIER;
  }

  private async consumeOrThrow(text: string, max: number): Promise<void> {
    const { count, expiresAt } = await this.limits.increment(this.key(text), WINDOW_MS);
    if (count > max) {
      const retryAfter = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
      throw new RateLimitedError(retryAfter);
    }
  }

  // Bảng "auth_rate_limits mới": key là HMAC nên DB không chứa phone, email hay IP thô.
  private key(text: string): string {
    return createHmac('sha256', this.config.getOrThrow<string>('resetOtpPepper')).update(text).digest('hex');
  }
}
