import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { RenewalService } from './renewal.service';
import { RenewalDto, RenewalPreviewResponseDto } from './renewals.dto';

@ApiTags('service-renewals') @ApiBearerAuth() @Controller('service-renewals')
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto }) @ApiResponse({ status: 503, type: ErrorResponseDto })
export class RenewalsController {
  constructor(private readonly renewals: RenewalService) {}
  @Post('preview') @HttpCode(200) @FixedPermission('serviceSales.create')
  @ApiOkResponse({ type: RenewalPreviewResponseDto })
  preview(@Body() dto: RenewalDto) { return this.renewals.preview(dto); }

  @Post() @FixedPermission('serviceSales.create') @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ description: 'SaleResult US-14, operation RENEW, previousSaleId và channel COUNTER' })
  async create(@CurrentUser() actor: AuthPrincipal, @Body() dto: RenewalDto, @IdempotencyKey() key: string,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.renewals.create(actor.id, dto, key, 'COUNTER');
    response.status(result.status); return result.body;
  }
}
