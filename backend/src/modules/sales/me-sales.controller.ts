// Tầng API (US-18 bước 1): Member tự xem trước/tạo yêu cầu mua gói cho chính mình qua /api/me/service-registrations.
// Biết ai gọi qua JwtAuthGuard toàn cục; chỉ MEMBER (FixedPermission); không nhận memberId từ body (US-18-F01).
import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { MeRegisterSaleDto } from './me-sales.dto';
import { MeSalesService } from './me-sales.service';

// US-18-TC02: không token → 401 (Guard); STAFF/ADMIN/TRAINER → 403 (FixedPermission chỉ MEMBER).
@ApiTags('me-service-registrations') @ApiBearerAuth() @Controller('me/service-registrations')
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 409, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
export class MeSalesController {
  constructor(private readonly meSales: MeSalesService) {}

  // US-18-TC01: chỉ báo giá, không giữ giá và không tạo sale.
  @Post('preview') @HttpCode(200) @FixedPermission('serviceSales.registerOwn')
  preview(@CurrentUser() user: AuthPrincipal, @Body() dto: MeRegisterSaleDto) {
    return this.meSales.preview(user.id, dto);
  }

  // US-18-TC01: tạo yêu cầu 201; replay cùng key trả lại status đã lưu nên status lấy từ kết quả.
  @Post() @FixedPermission('serviceSales.registerOwn') @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@CurrentUser() user: AuthPrincipal, @Body() dto: MeRegisterSaleDto, @IdempotencyKey() key: string,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.meSales.create(user.id, dto, key);
    response.status(result.status);
    return result.body;
  }
}
