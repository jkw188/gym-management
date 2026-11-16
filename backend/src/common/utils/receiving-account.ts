// Tầng nghiệp vụ dùng chung (US-22, US-18): chính sách tài khoản nhận chuyển khoản lấy từ biến môi trường.
// Chỉ có mã và thông tin công khai (ngân hàng, số tài khoản, tên), không bao giờ có credential ngân hàng.
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReceivingAccountDetail } from '../../config/configuration';
import { ApplicationError } from '../errors/application-error';

@Injectable()
export class ReceivingAccountPolicy {
  constructor(private readonly config: ConfigService) {}

  assertTransferAllowed(receivingAccountCode: string): void {
    const codes = this.config.get<string[]>('receivingAccounts') ?? [];
    if (codes.length === 0) throw notConfigured();
    if (!codes.includes(receivingAccountCode)) throw new ApplicationError(400, 'RECEIVING_ACCOUNT_INVALID', 'Mã tài khoản nhận không hợp lệ');
  }

  // US-18 mục 2: tài khoản Member có thể chuyển khoản tới (RECEIVING_ACCOUNT_DETAILS). Rỗng = chưa cấu hình.
  transferAccounts(): ReceivingAccountDetail[] {
    return this.config.get<ReceivingAccountDetail[]>('receivingAccountDetails') ?? [];
  }

  // US-18-TC08: thiếu cấu hình thì chặn TRANSFER ngay từ lúc tạo, để người dùng chọn CASH trước.
  assertTransferAvailable(): void {
    if (this.transferAccounts().length === 0) throw notConfigured();
  }
}

function notConfigured() {
  return new ApplicationError(503, 'RECEIVING_ACCOUNTS_NOT_CONFIGURED', 'Chưa cấu hình tài khoản nhận chuyển khoản');
}
