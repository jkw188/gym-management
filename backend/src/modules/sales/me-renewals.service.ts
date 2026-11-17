// Tầng nghiệp vụ (US-19 bước 1–2): adapter cho Member tự gia hạn – tìm hồ sơ của chính account đang đăng nhập
// rồi gọi lại đúng RenewalService của US-15 (RENEW_V1), không tự tính ngày/giá/điều kiện nguồn (US-19-F02).
// Bước 2: ghi kênh SELF_SERVICE + cách trả dự kiến; theo dõi/hủy dùng lại endpoint của US-18 (MeSalesController).
import { Injectable } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/application-error';
import { ReceivingAccountPolicy } from '../../common/utils/receiving-account';
import { MemberOwnerReader } from '../members/member-owner.reader';
import { MeRenewalDto } from './me-renewals.dto';
import { RenewalService } from './renewal.service';
import { RenewalDto } from './renewals.dto';

@Injectable()
export class MeRenewalsService {
  constructor(private readonly owners: MemberOwnerReader, private readonly renewals: RenewalService,
    private readonly accounts: ReceivingAccountPolicy) {}

  // US-19-TC01, TC05: preview giống hệt quầy vì dùng chung RenewalService.preview; chỉ đọc, không tạo gì.
  async preview(accountId: string, dto: MeRenewalDto) {
    const input = await this.toCounterInput(accountId, dto);
    return this.renewals.preview(input);
  }

  // US-19-TC01: actorId = account Member nên created_by là principal; kênh SELF_SERVICE do server đặt, không lấy từ body.
  // US-19-TC03: điều kiện nguồn/gói/PENDING do RenewalService.create kiểm, nên mã lỗi giống quầy.
  // US-19-TC08: lưu cách trả dự kiến; giá > 0 vẫn PENDING tới khi Staff/Admin xác nhận thu (US-22).
  // US-19-TC09: owner được kiểm lại TRƯỚC khi tra key, nên replay sau khi gỡ liên kết vẫn bị 409.
  async create(accountId: string, dto: MeRenewalDto, key: string) {
    const input = await this.toCounterInput(accountId, dto);
    return this.renewals.create(accountId, input, key, 'SELF_SERVICE', dto.preferredPaymentMethod);
  }

  // US-19-F01: memberId chỉ lấy từ members.account_id = principal (resolver US-17), không lấy từ body.
  // US-19-TC02: previousSaleId của người khác → RenewalService tìm nguồn theo (memberId, previousSaleId) nên trả 404.
  private async toCounterInput(accountId: string, dto: MeRenewalDto): Promise<RenewalDto> {
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    // US-19-TC02: chưa liên kết hồ sơ → 409, không tự nối hồ sơ.
    if (!memberId) throw new ApplicationError(409, 'MEMBER_PROFILE_REQUIRED', 'Tài khoản chưa được liên kết hồ sơ hội viên. Hãy liên hệ quầy');
    // US-19-TC08: chọn TRANSFER khi chưa cấu hình tài khoản nhận → 503 ngay ở preview/tạo (giống US-18-TC08).
    if (dto.preferredPaymentMethod === 'TRANSFER') this.accounts.assertTransferAvailable();
    return { memberId: memberId.toHexString(), previousSaleId: dto.previousSaleId, planVersion: dto.planVersion };
  }
}
