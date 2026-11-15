import { Body, Controller, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CreateReceiptDto, EmptyStockQueryDto, PostReceiptDto, PostedReceiptResponseDto, ReceiptPageResponseDto, ReceiptQueryDto, ReceiptResponseDto, UpdateReceiptDto } from './stock-receipts.dto';
import { StockReceiptsService } from './stock-receipts.service';

@ApiTags('Stock receipts') @ApiBearerAuth()
@Controller('stock-receipts') @FixedPermission('stockReceipts.manage')
export class StockReceiptsController {
  constructor(private readonly service: StockReceiptsService) {}
  @Get() @ApiOkResponse({ type: ReceiptPageResponseDto })
  list(@Query() query: ReceiptQueryDto) { return this.service.list(query); }
  @Get(':id') @ApiOkResponse({ type: ReceiptResponseDto })
  detail(@Param('id') id: string, @Query() _query: EmptyStockQueryDto) { return this.service.detail(id); }
  @Post() @ApiCreatedResponse({ type: ReceiptResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@CurrentUser() actor: AuthPrincipal, @Body() input: CreateReceiptDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyStockQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.save(actor.id, input, key); response.status(result.status); return result.body;
  }
  @Put(':id') @ApiOkResponse({ type: ReceiptResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async update(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: UpdateReceiptDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyStockQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.save(actor.id, input, key, id); response.status(result.status); return result.body;
  }
  @Post(':id/post') @ApiOkResponse({ type: PostedReceiptResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async post(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: PostReceiptDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyStockQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.post(actor.id, id, input, key); response.status(result.status); return result.body;
  }
}
