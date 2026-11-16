import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags, PickType } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CancelOrderService } from './cancel-order.service';
import { LateReceiptService } from './late-receipt.service';
import { CancelOrderDto, CancelOrderResponseDto, LateReceiptDto, LateReceiptResponseDto, OwnOrderPageResponseDto, OwnOrderResponseDto } from './order-cancellation.dto';
import { EmptyOrderQueryDto, OrderQueryDto } from './orders.dto';
import { MeOrdersService } from './me-orders.service';

@ApiTags('Order cancellation') @ApiBearerAuth() @Controller('orders')
export class OrderCancellationController {
  constructor(private readonly cancellation: CancelOrderService, private readonly late: LateReceiptService) {}
  @Post(':id/cancel') @FixedPermission('orders.cancelSupport') @ApiOkResponse({ type: CancelOrderResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async cancel(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: CancelOrderDto,
    @IdempotencyKey() key: string, @Query() _query: EmptyOrderQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.cancellation.cancel(actor.id, id, input, key); response.status(result.status); return result.body;
  }
  @Post(':id/late-receipts') @FixedPermission('transactions.confirmPayment') @ApiOkResponse({ type: LateReceiptResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async receipt(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: LateReceiptDto,
    @IdempotencyKey() key: string, @Query() _query: EmptyOrderQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.late.record(actor.id, id, input, key); response.status(result.status); return result.body;
  }
}
export class OwnOrderQueryDto extends PickType(OrderQueryDto, ['status', 'page', 'limit'] as const) {}
@ApiTags('My orders') @ApiBearerAuth() @Controller('me/orders')
export class MeOrdersController {
  constructor(private readonly cancellation: CancelOrderService, private readonly orders: MeOrdersService) {}
  @Get() @FixedPermission('orders.readOwn') @ApiOkResponse({ type: OwnOrderPageResponseDto }) list(@CurrentUser() actor: AuthPrincipal, @Query() query: OwnOrderQueryDto) { return this.orders.list(actor.id, query); }
  @Get(':id') @FixedPermission('orders.readOwn') @ApiOkResponse({ type: OwnOrderResponseDto }) detail(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Query() _query: EmptyOrderQueryDto) { return this.orders.detail(actor.id, id); }
  @Post(':id/cancel') @FixedPermission('orders.cancelOwn') @ApiOkResponse({ type: CancelOrderResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async cancel(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: CancelOrderDto,
    @IdempotencyKey() key: string, @Query() _query: EmptyOrderQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.cancellation.cancel(actor.id, id, input, key, true); response.status(result.status); return result.body;
  }
}
