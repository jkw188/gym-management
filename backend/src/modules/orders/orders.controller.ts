import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { EmptyOrderQueryDto, OrderDetailResponseDto, OrderPageResponseDto, OrderQueryDto, PrepareOrderDto, PrepareOrderResponseDto } from './orders.dto';
import { OrdersService } from './orders.service';
import { FulfillOrderService } from './fulfill-order.service';
import { FulfillOrderDto, FulfillOrderResponseDto } from './orders.dto';

@ApiTags('Orders') @ApiBearerAuth() @Controller('orders')
export class OrdersController {
  constructor(private readonly service: OrdersService, private readonly fulfillment: FulfillOrderService) {}
  @Get() @FixedPermission('orders.read') @ApiOkResponse({ type: OrderPageResponseDto })
  list(@Query() query: OrderQueryDto) { return this.service.list(query); }
  @Get(':id') @FixedPermission('orders.read') @ApiOkResponse({ type: OrderDetailResponseDto })
  detail(@Param('id') id: string, @Query() _query: EmptyOrderQueryDto) { return this.service.detail(id); }
  @Post(':id/prepare') @FixedPermission('orders.prepare') @ApiOkResponse({ type: PrepareOrderResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async prepare(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: PrepareOrderDto,
    @IdempotencyKey() key: string, @Query() _query: EmptyOrderQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.prepare(actor.id, id, input, key); response.status(result.status); return result.body;
  }
  @Post(':id/fulfill') @FixedPermission('orders.fulfill') @ApiOkResponse({ type: FulfillOrderResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async fulfill(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: FulfillOrderDto,
    @IdempotencyKey() key: string, @Query() _query: EmptyOrderQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.fulfillment.fulfill(actor.id, id, input, key); response.status(result.status); return result.body;
  }
}
