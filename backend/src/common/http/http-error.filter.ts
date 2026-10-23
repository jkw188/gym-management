import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { ApplicationError, ErrorDetail } from '../errors/application-error';

const httpErrors: Record<number, [string, string]> = {
  400: ['VALIDATION_ERROR', 'Dữ liệu không hợp lệ'],
  401: ['UNAUTHORIZED', 'Cần xác thực'], 403: ['FORBIDDEN', 'Không có quyền truy cập'],
  404: ['NOT_FOUND', 'Không tìm thấy dữ liệu'], 409: ['CONFLICT', 'Dữ liệu xung đột'],
  413: ['PAYLOAD_TOO_LARGE', 'Dữ liệu quá lớn'], 429: ['TOO_MANY_REQUESTS', 'Quá nhiều yêu cầu'],
  503: ['DATABASE_UNAVAILABLE', 'Cơ sở dữ liệu chưa sẵn sàng'],
};

export function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

export function mapError(error: unknown): { status: number; code: string; message: string; details?: ErrorDetail[] } {
  if (error instanceof ApplicationError) return { status: error.status, code: error.code, message: error.message, details: error.details };
  if (isDuplicateKey(error)) return { status: 409, code: 'DUPLICATE_KEY', message: 'Số điện thoại, email hoặc định danh đã tồn tại' };
  const name = error instanceof Error ? error.name : '';
  if (['CastError', 'ValidationError', 'StrictModeError'].includes(name)) return { status: 400, code: 'VALIDATION_ERROR', message: 'Dữ liệu không hợp lệ' };
  if (/^(Mongo|Mongoose)/.test(name)) return { status: 503, code: 'DATABASE_UNAVAILABLE', message: 'Cơ sở dữ liệu chưa sẵn sàng' };
  const status = error instanceof HttpException ? error.getStatus() :
    (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.parse.failed' ? 400 :
      typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large' ? 413 : 500);
  const [code, message] = httpErrors[status] ?? ['INTERNAL_ERROR', 'Lỗi hệ thống'];
  return { status, code, message };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    const res = ctx.getResponse<Response>();
    const requestId = req.requestId ?? randomUUID();
    const { status, ...error } = mapError(exception);
    // An allowlist log record: never serialize exceptions, headers, query or body.
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), requestId, code: error.code, status }));
    res.setHeader('X-Request-Id', requestId);
    res.status(status).json({ error, requestId });
  }
}
