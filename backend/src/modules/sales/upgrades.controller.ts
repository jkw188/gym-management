import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { UpgradeService } from './upgrade.service';
import { UpgradeDto, UpgradeSourceDto } from './upgrades.dto';

@ApiTags('service-upgrades') @ApiBearerAuth() @Controller('service-upgrades')
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto }) @ApiResponse({ status: 503, type: ErrorResponseDto })
export class UpgradesController {
  constructor(private readonly upgrades: UpgradeService) {}
  @Get('targets') @FixedPermission('serviceSales.create')
  targets(@Query() dto: UpgradeSourceDto) { return this.upgrades.targets(dto); }
  @Post('preview') @HttpCode(200) @FixedPermission('serviceSales.create')
  @ApiOkResponse({ description: 'Báo giá UPGRADE_V1 gồm credit/expiry/quotaSummary/canProceed' })
  preview(@Body() dto: UpgradeDto) { return this.upgrades.preview(dto); }
  @Post() @FixedPermission('serviceSales.create') @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ description: 'SaleResult operation UPGRADE, sourceMembershipId, previousSaleId và quote' })
  async create(@CurrentUser() actor: AuthPrincipal, @Body() dto: UpgradeDto, @IdempotencyKey() key: string, @Res({ passthrough: true }) res: Response) {
    const result = await this.upgrades.create(actor.id, dto, key, 'COUNTER'); res.status(result.status); return result.body;
  }
}
