import { ArgumentsHost, Catch } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/application-error';
import { HttpErrorFilter, mapError } from '../../common/http/http-error.filter';

// Includes infrastructure failures in JWT guards before GET/PATCH reaches the service.
@Catch()
export class MemberProfileErrorFilter extends HttpErrorFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (mapError(exception).status === 503) {
      exception = new ApplicationError(503, 'SERVICE_UNAVAILABLE',
        'Chưa xác định được kết quả. Hãy tải lại hồ sơ để đối chiếu trước khi sửa tiếp');
    }
    super.catch(exception, host);
  }
}
