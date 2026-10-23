import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { invalidField } from '../errors/application-error';

@Injectable()
export class PasswordService {
  validate(password: string): void {
    if (typeof password !== 'string' || Array.from(password).length < 12 || Array.from(password).length > 128) {
      invalidField('password', 'Mật khẩu phải từ 12 đến 128 ký tự');
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
}
