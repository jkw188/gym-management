// Tầng nghiệp vụ (US-18 bước 1): adapter cho Member tự đăng ký gói – tìm hồ sơ của chính account đang đăng nhập
// rồi gọi lại đúng REGISTER_V1 của SalesService (US-14), không viết lại công thức giá/ngày/điều kiện cấp gói (US-18-F02).
import { Injectable } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/application-error';
import { MemberOwnerReader } from '../members/member-owner.reader';
import { MeRegisterSaleDto } from './me-sales.dto';
import { RegisterSaleDto } from './sales.dto';
import { SalesService } from './sales.service';

@Injectable()
export class MeSalesService {
  constructor(private readonly owners: MemberOwnerReader, private readonly sales: SalesService) {}

  // US-18-TC01: quote giống hệt quầy vì dùng chung SalesService.preview.
  async preview(accountId: string, dto: MeRegisterSaleDto) {
    const input = await this.toCounterInput(accountId, dto);
    return this.sales.preview(input);
  }

  // US-18-TC01: actorId = account Member nên created_by của giao dịch là principal.
  // US-18-TC03, TC04: mọi kiểm tra và snapshot giá do SalesService.create làm, giống quầy.
  async create(accountId: string, dto: MeRegisterSaleDto, key: string) {
    const input = await this.toCounterInput(accountId, dto);
    return this.sales.create(accountId, input, key);
  }

  // US-18-F01: memberId chỉ lấy từ members.account_id = principal (resolver US-17), không lấy từ body.
  // preferredPaymentMethod chưa lưu ở bước này (bước 2 mới thêm cột preferred_payment_method và channel).
  private async toCounterInput(accountId: string, dto: MeRegisterSaleDto): Promise<RegisterSaleDto> {
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    // US-18-TC02: chưa liên kết → 409, không tự nối hồ sơ dù trùng số điện thoại.
    if (!memberId) throw new ApplicationError(409, 'MEMBER_PROFILE_REQUIRED', 'Tài khoản chưa được liên kết hồ sơ hội viên. Hãy liên hệ quầy');
    return { memberId: memberId.toHexString(), planId: dto.planId, planVersion: dto.planVersion, startDate: dto.startDate };
  }
}
