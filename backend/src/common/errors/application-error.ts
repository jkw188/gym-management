export interface ErrorDetail { field: string; message: string }

export class ApplicationError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: ErrorDetail[]) {
    super(message);
  }
}

export function invalidField(field: string, message: string): never {
  throw new ApplicationError(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', [{ field, message }]);
}
