// Tầng API (US-18 bước 1–2): Member tự xem trước/tạo yêu cầu mua gói, tự hủy yêu cầu chờ và xem hướng dẫn thanh toán.
// Biết ai gọi qua JwtAuthGuard toàn cục; chỉ MEMBER (FixedPermission); không nhận memberId/channel từ body (US-18-F01).
import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { MeRegisterSaleDto } from './me-sales.dto';
import { MeSalesService } from './me-sales.service';
import { CancelSaleDto } from './sales.dto';

// US-18-TC02, TC07, TC11: không token → 401 (Guard); STAFF/ADMIN/TRAINER → 403 (FixedPermission chỉ MEMBER).
// Mọi route ở đây là đường dẫn tĩnh hoặc có hậu tố riêng (/cancel, /payment-instructions), không đè GET :id của US-17.
@ApiTags('me-service-registrations') @ApiBearerAuth() @Controller('me')
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto }) @ApiResponse({ status: 503, type: ErrorResponseDto })
export class MeSalesController {
  constructor(private readonly meSales: MeSalesService) {}

  // US-18-TC01: chỉ báo giá, không giữ giá và không tạo sale.
  @Post('service-registrations/preview') @HttpCode(200) @FixedPermission('serviceSales.registerOwn')
  preview(@CurrentUser() user: AuthPrincipal, @Body() dto: MeRegisterSaleDto) {
    return this.meSales.preview(user.id, dto);
  }

  // US-18-TC01, TC09: tạo yêu cầu 201; replay cùng key trả lại status đã lưu nên status lấy từ kết quả.
  @Post('service-registrations') @FixedPermission('serviceSales.registerOwn') @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@CurrentUser() user: AuthPrincipal, @Body() dto: MeRegisterSaleDto, @IdempotencyKey() key: string,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.meSales.create(user.id, dto, key);
    response.status(result.status);
    return result.body;
  }

  // US-18-TC11, TC12: Member tự hủy yêu cầu SELF_SERVICE đang chờ của mình (key SALE_CANCEL).
  @Post('service-sales/:id/cancel') @FixedPermission('serviceSales.cancelOwn') @ApiHeader({ name: 'Idempotency-Key', required: true })
  async cancel(@CurrentUser() user: AuthPrincipal, @Param('id') id: string, @Body() dto: CancelSaleDto,
    @IdempotencyKey() key: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.meSales.cancel(user.id, id, dto, key);
    response.status(result.status);
    return result.body;
  }

  // US-18-TC07, TC08: hướng dẫn thanh toán của giao dịch đang chờ của chính mình.
  @Get('transactions/:id/payment-instructions') @FixedPermission('transactions.instructionsOwn')
  paymentInstructions(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.meSales.paymentInstructions(user.id, id);
  }
}
