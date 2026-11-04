export interface ErrorDetail { field: string; message: string }

export class ApplicationError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: ErrorDetail[]) {
    super(message);
  }
}

// Lỗi 429 mang theo số giây chờ để filter của route ghi vào header Retry-After (US-67, US-05).
export class RateLimitedError extends ApplicationError {
  constructor(public readonly retryAfter: number) {
    super(429, 'TOO_MANY_REQUESTS', 'Quá nhiều lần thử. Vui lòng thử lại sau');
  }
}

export function invalidField(field: string, message: string): never {
  throw new ApplicationError(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', [{ field, message }]);
}
