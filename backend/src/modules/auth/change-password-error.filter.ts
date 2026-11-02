// Tầng API: đổi lỗi 503 của route đổi mật khẩu thành SERVICE_UNAVAILABLE theo spec US-67.
// Chỉ gắn vào route này, nên đăng nhập và refresh vẫn giữ mã DATABASE_UNAVAILABLE.
import { ArgumentsHost, Catch } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/application-error';
import { HttpErrorFilter, mapError } from '../../common/http/http-error.filter';

// US-67-TC11: dùng filter vì DB có thể lỗi ngay trong Guard, try/catch trong service không bắt được.
@Catch()
export class ChangePasswordErrorFilter extends HttpErrorFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (mapError(exception).status === 503) {
      exception = new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Dịch vụ chưa sẵn sàng, vui lòng thử lại');
    }
    super.catch(exception, host);
  }
}
