// Tầng API (US-20 bước 1): Member xem gói đích được phép và xem trước/tạo đề nghị nâng cấp gói của mình.
// Biết ai gọi qua JwtAuthGuard toàn cục; chỉ MEMBER (FixedPermission); chuyển cho MeUpgradesService, không tự tính tiền.
import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { MeUpgradeDto } from './me-upgrades.dto';
import { MeUpgradesService } from './me-upgrades.service';

// US-20-TC02: không token → 401 (Guard); STAFF/ADMIN/TRAINER → 403 (FixedPermission chỉ MEMBER).
@ApiTags('me-service-upgrades') @ApiBearerAuth() @Controller('me')
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto }) @ApiResponse({ status: 503, type: ErrorResponseDto })
export class MeUpgradesController {
  constructor(private readonly meUpgrades: MeUpgradesService) {}

  // US-20-TC01: danh sách gói đích hiện được phép cho kỳ gói của chính Member; không có thì items = [].
  @Get('memberships/:id/upgrade-options') @FixedPermission('serviceSales.upgradeOwn')
  @ApiOkResponse({ description: '{items:[{targetPlanId,targetPlanVersion,policyVersion,name,price,durationDays,sessionsQuota}],sourceVersion,asOf}' })
  options(@CurrentUser() user: AuthPrincipal, @Param('id') membershipId: string) {
    return this.meUpgrades.options(user.id, membershipId);
  }

  // US-20-TC01, TC05: chỉ báo giá UPGRADE_V1, không tạo sale.
  @Post('service-upgrades/preview') @HttpCode(200) @FixedPermission('serviceSales.upgradeOwn')
  @ApiOkResponse({ description: 'Báo giá UPGRADE_V1 gồm credit/expiry/quotaSummary/canProceed, giống quầy' })
  preview(@CurrentUser() user: AuthPrincipal, @Body() dto: MeUpgradeDto) {
    return this.meUpgrades.preview(user.id, dto);
  }

  // US-20-TC01: tạo đề nghị 201; replay cùng key trả lại status đã lưu nên status lấy từ kết quả.
  @Post('service-upgrades') @FixedPermission('serviceSales.upgradeOwn') @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ description: 'SaleResult operation UPGRADE, channel SELF_SERVICE, sourceMembershipId, previousSaleId' })
  async create(@CurrentUser() user: AuthPrincipal, @Body() dto: MeUpgradeDto, @IdempotencyKey() key: string,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.meUpgrades.create(user.id, dto, key);
    response.status(result.status);
    return result.body;
  }
}
