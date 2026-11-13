// Tầng kiểm tra dữ liệu (US-24 bước 2, theo EN-02-D01): đọc header Idempotency-Key của lệnh ghi.
// Thiếu header hoặc không phải UUID v4 thì 400; dùng: @IdempotencyKey() key: string trong controller.
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { ApplicationError } from '../errors/application-error';

// UUID v4: ký tự thứ 13 là 4, ký tự thứ 17 là 8, 9, a hoặc b (giống điều kiện của operation_requests.client_key).
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const value = context.switchToHttp().getRequest<Request>().headers['idempotency-key'];
  // US-24-TC03: thiếu key hoặc key không phải UUID thì từ chối trước khi ghi bất cứ thứ gì.
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new ApplicationError(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', [
      { field: 'Idempotency-Key', message: 'Header Idempotency-Key phải là UUID v4' },
    ]);
  }
  return value.toLowerCase();
});
