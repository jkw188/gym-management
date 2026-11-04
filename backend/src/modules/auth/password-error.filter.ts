// Tầng API: lỗi của route đổi mật khẩu (US-67) và quên mật khẩu (US-05): 429 kèm Retry-After, 503 thành SERVICE_UNAVAILABLE.
// Chỉ gắn vào các route này, nên đăng nhập và refresh vẫn giữ mã DATABASE_UNAVAILABLE.
import { ArgumentsHost, Catch } from '@nestjs/common';
import { ApplicationError, RateLimitedError } from '../../common/errors/application-error';
import { HttpErrorFilter, mapError } from '../../common/http/http-error.filter';
import { Response } from 'express';

// US-67-TC11: dùng filter vì DB có thể lỗi ngay trong Guard, try/catch trong service không bắt được.
@Catch()
export class PasswordErrorFilter extends HttpErrorFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    // US-67-TC10, US-05-TC04: 429 phải kèm Retry-After.
    if (exception instanceof RateLimitedError) {
      host.switchToHttp().getResponse<Response>().setHeader('Retry-After', exception.retryAfter);
    }
    if (mapError(exception).status === 503) {
      exception = new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Dịch vụ chưa sẵn sàng, vui lòng thử lại');
    }
    super.catch(exception, host);
  }
}
