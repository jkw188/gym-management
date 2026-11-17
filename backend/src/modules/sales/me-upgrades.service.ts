// Tầng nghiệp vụ (US-20 bước 1–2): adapter cho Member tự nâng cấp – tìm hồ sơ của chính account đang đăng nhập
// rồi gọi lại đúng UpgradeService của US-16 (UPGRADE_V1), không tự tính credit/phải thu/điều kiện nguồn (US-20-F02).
// Bước 2: ghi kênh SELF_SERVICE + cách trả dự kiến; theo dõi/hủy dùng lại endpoint của US-18 (MeSalesController).
import { Injectable } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/application-error';
import { ReceivingAccountPolicy } from '../../common/utils/receiving-account';
import { MemberOwnerReader } from '../members/member-owner.reader';
import { MeUpgradeDto } from './me-upgrades.dto';
import { UpgradeService } from './upgrade.service';
import { UpgradeDto } from './upgrades.dto';

@Injectable()
export class MeUpgradesService {
  constructor(private readonly owners: MemberOwnerReader, private readonly upgrades: UpgradeService,
    private readonly accounts: ReceivingAccountPolicy) {}

  // US-20-TC01: chỉ đích có cạnh policy ACTIVE, gói đích ACTIVE, cùng kind – UpgradeService.targets đã lọc sẵn.
  // US-20-TC02: nguồn của người khác/không tồn tại → targets tìm theo (memberId, membershipId) nên trả 404.
  async options(accountId: string, membershipId: string) {
    const memberId = await this.requireMemberId(accountId);
    const result = await this.upgrades.targets({ memberId, sourceMembershipId: membershipId });
    // Chỉ trả các field hợp đồng US-20 mục 2 cần, không trả policyId hay thông tin nội bộ khác.
    const items = result.items.map(item => ({
      targetPlanId: item.planId,
      targetPlanVersion: item.planVersion,
      policyVersion: item.policyVersion,
      name: item.name,
      price: item.price,
      durationDays: item.durationDays,
      sessionsQuota: item.sessions,
    }));
    return { items, sourceVersion: result.source.version, asOf: result.asOf };
  }

  // US-20-TC05: preview giống hệt quầy vì dùng chung UpgradeService.preview; chỉ đọc, không tạo gì.
  async preview(accountId: string, dto: MeUpgradeDto) {
    const input = await this.toCounterInput(accountId, dto);
    return this.upgrades.preview(input);
  }

  // US-20-TC01: actorId = account Member nên created_by là principal; kênh SELF_SERVICE do server đặt, không lấy từ body.
  // US-20-TC04: version/policy đổi → UpgradeService kiểm và trả cùng mã 409 như quầy.
  // US-20-TC09: lưu cách trả dự kiến; phải thu > 0 vẫn PENDING tới khi Staff/Admin xác nhận thu (US-22).
  // US-20-TC10: owner được kiểm lại TRƯỚC khi tra key, nên replay sau khi gỡ liên kết vẫn bị 409.
  async create(accountId: string, dto: MeUpgradeDto, key: string) {
    const input = await this.toCounterInput(accountId, dto);
    return this.upgrades.create(accountId, input, key, 'SELF_SERVICE', dto.preferredPaymentMethod);
  }

  // US-20-F01: memberId chỉ lấy từ members.account_id = principal (resolver US-17), không lấy từ body.
  private async toCounterInput(accountId: string, dto: MeUpgradeDto): Promise<UpgradeDto> {
    const memberId = await this.requireMemberId(accountId);
    // US-20-TC09: chọn TRANSFER khi chưa cấu hình tài khoản nhận → 503 ngay ở preview/tạo (giống US-18, US-19).
    if (dto.preferredPaymentMethod === 'TRANSFER') this.accounts.assertTransferAvailable();
    return { memberId, sourceMembershipId: dto.sourceMembershipId, sourceVersion: dto.sourceVersion,
      targetPlanId: dto.targetPlanId, targetPlanVersion: dto.targetPlanVersion, policyVersion: dto.policyVersion };
  }

  // US-20-TC02: account chưa liên kết hồ sơ → 409, không tự nối hồ sơ.
  private async requireMemberId(accountId: string): Promise<string> {
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    if (!memberId) throw new ApplicationError(409, 'MEMBER_PROFILE_REQUIRED', 'Tài khoản chưa được liên kết hồ sơ hội viên. Hãy liên hệ quầy');
    return memberId.toHexString();
  }
}
