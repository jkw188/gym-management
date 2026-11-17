import { Body, Controller, Get, Param, Post, Patch, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CreateAdjustmentDto, AdjustmentResponseDto, UpdateAdjustmentDto } from './stock-adjustments.dto';
import { EmptyStockQueryDto, PostReceiptDto, PostedReceiptResponseDto, ReceiptPageResponseDto, ReceiptQueryDto } from './stock-receipts.dto';
import { StockAdjustmentsService } from './stock-adjustments.service';

@ApiTags('Stock adjustments') @ApiBearerAuth()
@Controller('stock-adjustments') @FixedPermission('stockAdjustments.manage')
export class StockAdjustmentsController {
  constructor(private readonly service: StockAdjustmentsService) {}
  @Get() @ApiOkResponse({ type: ReceiptPageResponseDto })
  list(@Query() query: ReceiptQueryDto) { return this.service.list(query); }
  @Get(':id') @ApiOkResponse({ type: AdjustmentResponseDto })
  detail(@Param('id') id: string, @Query() _query: EmptyStockQueryDto) { return this.service.detail(id); }
  @Post() @ApiCreatedResponse({ type: AdjustmentResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@CurrentUser() actor: AuthPrincipal, @Body() input: CreateAdjustmentDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyStockQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.save(actor.id, input, key); response.status(result.status); return result.body;
  }
  @Patch(':id') @ApiOkResponse({ type: AdjustmentResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async update(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: UpdateAdjustmentDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyStockQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.save(actor.id, input, key, id); response.status(result.status); return result.body;
  }
  @Post(':id/post') @ApiOkResponse({ type: PostedReceiptResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async post(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: PostReceiptDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyStockQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.post(actor.id, id, input, key); response.status(result.status); return result.body;
  }
}
