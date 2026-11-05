import { ApplicationError } from '../../common/errors/application-error';
import { isDuplicateKey } from '../../common/http/http-error.filter';

export function duplicateIdentifier(field: 'phone' | 'email') {
  const message = field === 'phone' ? 'Số điện thoại đã tồn tại' : 'Email đã tồn tại';
  return new ApplicationError(409, field === 'phone' ? 'PHONE_ALREADY_EXISTS' : 'EMAIL_ALREADY_EXISTS', message, [{ field, message }]);
}

export function rethrowDuplicate(error: unknown): never {
  if (isDuplicateKey(error) && typeof error === 'object' && error !== null && 'keyPattern' in error) {
    const pattern = error.keyPattern;
    if (pattern && typeof pattern === 'object') {
      if ('phone' in pattern) throw duplicateIdentifier('phone');
      if ('email' in pattern) throw duplicateIdentifier('email');
    }
  }
  throw error;
}

export function versionConflict() {
  return new ApplicationError(409, 'VERSION_CONFLICT', 'Tài khoản đã thay đổi. Hãy tải lại trước khi sửa tiếp.');
}
