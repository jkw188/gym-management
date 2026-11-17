// Tầng API (US-19 bước 1): Member tự xem trước/tạo kỳ gia hạn cho gói của mình.
// Biết ai gọi qua JwtAuthGuard toàn cục; chỉ MEMBER (FixedPermission); chuyển cho MeRenewalsService, không tự tính ngày/giá.
import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { MeRenewalDto } from './me-renewals.dto';
import { MeRenewalsService } from './me-renewals.service';
import { RenewalPreviewResponseDto } from './renewals.dto';

// US-19-TC02: không token → 401 (Guard); STAFF/ADMIN/TRAINER → 403 (FixedPermission chỉ MEMBER).
@ApiTags('me-service-renewals') @ApiBearerAuth() @Controller('me/service-renewals')
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto }) @ApiResponse({ status: 503, type: ErrorResponseDto })
export class MeRenewalsController {
  constructor(private readonly meRenewals: MeRenewalsService) {}

  // US-19-TC01, TC05: chỉ báo giá và ngày dự kiến, không tạo sale.
  @Post('preview') @HttpCode(200) @FixedPermission('serviceSales.renewOwn') @ApiOkResponse({ type: RenewalPreviewResponseDto })
  preview(@CurrentUser() user: AuthPrincipal, @Body() dto: MeRenewalDto) {
    return this.meRenewals.preview(user.id, dto);
  }

  // US-19-TC01: tạo kỳ gia hạn 201; replay cùng key trả lại status đã lưu nên status lấy từ kết quả.
  @Post() @FixedPermission('serviceSales.renewOwn') @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ description: 'SaleResult US-14, operation RENEW, previousSaleId và channel SELF_SERVICE' })
  async create(@CurrentUser() user: AuthPrincipal, @Body() dto: MeRenewalDto, @IdempotencyKey() key: string,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.meRenewals.create(user.id, dto, key);
    response.status(result.status);
    return result.body;
  }
}
