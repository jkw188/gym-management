import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { FulfillOrderService } from './fulfill-order.service';
import { EmptyOrderQueryDto, FulfillOrderDto, FulfillOrderResponseDto } from './orders.dto';
import { PosCreateDto, PosPreviewDto, PosProductQueryDto } from './pos.dto';
import { RetailOrderFactory } from './retail-order.factory';
import { RetailQuoteService } from './retail-quote.service';

@ApiTags('POS') @ApiBearerAuth() @Controller('pos')
export class PosController {
  constructor(private readonly quotes: RetailQuoteService, private readonly factory: RetailOrderFactory, private readonly fulfillment: FulfillOrderService) {}
  @Get('products') @FixedPermission('pos.create')
  products(@Query() query: PosProductQueryDto) { return this.quotes.products(query); }
  @Post('orders/preview') @HttpCode(200) @FixedPermission('pos.create')
  preview(@CurrentUser() actor: AuthPrincipal, @Body() input: PosPreviewDto, @Query() _query: EmptyOrderQueryDto) { return this.quotes.preview(actor.id, input); }
  @Post('orders') @FixedPermission('pos.create') @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@CurrentUser() actor: AuthPrincipal, @Body() input: PosCreateDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyOrderQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.factory.createPos(actor.id, input, key); response.status(result.status); return result.body;
  }
  @Post('orders/:id/fulfill') @FixedPermission('pos.fulfill') @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiOkResponse({ type: FulfillOrderResponseDto })
  async fulfill(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: FulfillOrderDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyOrderQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.fulfillment.fulfill(actor.id, id, input, key, 'POS'); response.status(result.status); return result.body;
  }
}
