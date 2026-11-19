// Tầng API (US-45): Staff/Admin hủy đơn hỗ trợ và ghi nhận tiền đến sau khi hủy. Route own của Member nằm ở me-orders.controller.ts (US-42).
import { Body, Controller, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CancelOrderService } from './cancel-order.service';
import { LateReceiptService } from './late-receipt.service';
import { CancelOrderDto, CancelOrderResponseDto, LateReceiptDto, LateReceiptResponseDto } from './order-cancellation.dto';
import { EmptyOrderQueryDto } from './orders.dto';

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
