import { ArgumentsHost, Catch } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/application-error';
import { HttpErrorFilter, mapError } from '../../common/http/http-error.filter';

// US-06 error codes are scoped to Users; the existing Auth/Health contracts stay intact.
@Catch()
export class UsersHttpErrorFilter extends HttpErrorFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    const error = mapError(exception);
    if (error.status === 401) exception = new ApplicationError(401, 'UNAUTHENTICATED', 'Cần đăng nhập lại');
    if (error.status === 503) exception = new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Dịch vụ chưa sẵn sàng, vui lòng thử lại');
    super.catch(exception, host);
  }
}
