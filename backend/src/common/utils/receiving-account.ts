import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApplicationError } from '../errors/application-error';

@Injectable()
export class ReceivingAccountPolicy {
  constructor(private readonly config: ConfigService) {}

  assertTransferAllowed(receivingAccountCode: string): void {
    const codes = this.config.get<string[]>('receivingAccounts') ?? [];
    if (codes.length === 0) throw new ApplicationError(503, 'RECEIVING_ACCOUNTS_NOT_CONFIGURED', 'Chưa cấu hình tài khoản nhận chuyển khoản');
    if (!codes.includes(receivingAccountCode)) throw new ApplicationError(400, 'RECEIVING_ACCOUNT_INVALID', 'Mã tài khoản nhận không hợp lệ');
  }
}
