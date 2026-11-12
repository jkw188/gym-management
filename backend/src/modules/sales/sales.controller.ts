import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CancelSaleDto, PendingSalesQueryDto, RegisterSaleDto } from './sales.dto';
import { SalesService } from './sales.service';

@ApiTags('service-sales') @ApiBearerAuth() @Controller('service-sales')
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto }) @ApiResponse({ status: 503, type: ErrorResponseDto })
export class SalesController {
  constructor(private readonly sales: SalesService) {}
  @Get('plans') @FixedPermission('serviceSales.read')
  catalog() { return this.sales.catalog(); }
  @Get() @FixedPermission('serviceSales.read')
  pending(@Query() query: PendingSalesQueryDto) { return this.sales.pending(query.memberId, query.page); }
  @Post('preview') @HttpCode(200) @FixedPermission('serviceSales.create')
  preview(@Body() dto: RegisterSaleDto) { return this.sales.preview(dto); }
  @Post() @FixedPermission('serviceSales.create') @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@CurrentUser() actor: AuthPrincipal, @Body() dto: RegisterSaleDto, @IdempotencyKey() key: string,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.sales.create(actor.id, dto, key); response.status(result.status); return result.body;
  }
  @Get(':id') @FixedPermission('serviceSales.read')
  detail(@Param('id') id: string) { return this.sales.detail(id); }
  @Post(':id/cancel') @FixedPermission('serviceSales.cancel') @ApiHeader({ name: 'Idempotency-Key', required: true })
  async cancel(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() dto: CancelSaleDto, @IdempotencyKey() key: string,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.sales.cancel(actor.id, id, dto, key); response.status(result.status); return result.body;
  }
}
