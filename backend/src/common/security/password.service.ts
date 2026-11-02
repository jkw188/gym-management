import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ApplicationError, invalidField } from '../errors/application-error';

@Injectable()
export class PasswordService {
  // Một nơi duy nhất giữ policy độ dài. Array.from đếm theo ký tự, nên một emoji tính là 1.
  private hasValidLength(password: string): boolean {
    const length = Array.from(password).length;
    return length >= 12 && length <= 128;
  }

  validate(password: string, field = 'password'): void {
    if (typeof password !== 'string' || !this.hasValidLength(password)) {
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
    if (!this.hasValidLength(password)) return false;

    // Hash mất, hash hỏng hay argon2 lỗi đều ném lỗi trong try và cùng thành 503.
    try {
      if (!hash.startsWith('$argon2id$')) throw new Error('Hash không hợp lệ');
      return await argon2.verify(hash, password);
    } catch {
      throw new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Dịch vụ chưa sẵn sàng, vui lòng thử lại');
    }
  }
}
