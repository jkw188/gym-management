import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApplicationError } from '../../common/errors/application-error';

@Injectable()
export class RegistrationLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  consume(ip: string, now = Date.now()): number {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
    const window = this.windows.get(ip) ?? { count: 0, resetAt: now + 60_000 };
    if (window.count >= 5) return Math.ceil((window.resetAt - now) / 1000);
    window.count++;
    this.windows.set(ip, window);
    return 0;
  }
}

@Injectable()
export class RegistrationGuard implements CanActivate {
  constructor(private readonly limiter: RegistrationLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const retryAfter = this.limiter.consume(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    if (retryAfter) {
      context.switchToHttp().getResponse<Response>().setHeader('Retry-After', retryAfter);
      throw new ApplicationError(429, 'TOO_MANY_REQUESTS', 'Quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau');
    }
    if (!req.is('application/json') || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new ApplicationError(400, 'VALIDATION_ERROR', 'Yêu cầu phải có body JSON object');
    }
    return true;
  }
}
