import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ApplicationError, invalidField } from '../errors/application-error';

@Injectable()
export class PasswordService {
  validate(password: string, field = 'password'): void {
    if (typeof password !== 'string' || Array.from(password).length < 12 || Array.from(password).length > 128) {
      invalidField(field, 'Mật khẩu phải từ 12 đến 128 ký tự');
    }
  }

  async hash(password: string): Promise<string> {
    this.validate(password);
    return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      this.validate(password);
      if (!hash.startsWith('$argon2id$')) return false;
      return await argon2.verify(hash, password);
    } catch { return false; }
  }

  // US-67-TC11: khác verify ở chỗ phân biệt "sai mật khẩu" (false) với "hệ thống hỏng" (503).
  // Giữ nguyên verify vì đăng nhập (US-02) đang dùng hàm đó.
  async verifyOrThrow(hash: string, password: string): Promise<boolean> {
    const length = Array.from(password).length;
    if (length < 12 || length > 128) return false;

    const unavailable = () => new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Dịch vụ chưa sẵn sàng, vui lòng thử lại');
    if (!hash.startsWith('$argon2id$')) throw unavailable();
    try {
      return await argon2.verify(hash, password);
    } catch {
      throw unavailable();
    }
  }
}
