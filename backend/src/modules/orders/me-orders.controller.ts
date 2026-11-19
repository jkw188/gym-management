// Tầng API (US-42): route /api/me/orders của Member – xem danh sách/chi tiết đơn, hướng dẫn thanh toán, hóa đơn qua đơn và hủy.
// Actor luôn lấy từ principal (guard US-02); controller chỉ gọi MeOrdersService, không gọi thẳng nghiệp vụ US-45.
import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { OwnInvoiceResponseDto, OwnOrderDetailResponseDto, OwnOrderPageResponseDto, OwnOrderQueryDto, OwnPaymentInstructionsResponseDto } from './me-orders.dto';
import { MeOrdersService } from './me-orders.service';
import { CancelOrderDto, CancelOrderResponseDto } from './order-cancellation.dto';
import { EmptyOrderQueryDto } from './orders.dto';

@ApiTags('My orders') @ApiBearerAuth() @Controller('me/orders')
export class MeOrdersController {
  constructor(private readonly orders: MeOrdersService) {}

  // US-42-TC01, TC03, TC06: danh sách đơn của mình.
  @Get() @FixedPermission('orders.readOwn') @ApiOkResponse({ type: OwnOrderPageResponseDto })
  list(@CurrentUser() actor: AuthPrincipal, @Query() query: OwnOrderQueryDto) {
    return this.orders.list(actor.id, query);
  }

  // US-42-TC02, TC05–TC08: chi tiết một đơn của mình.
  @Get(':id') @FixedPermission('orders.readOwn') @ApiOkResponse({ type: OwnOrderDetailResponseDto })
  detail(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Query() _query: EmptyOrderQueryDto) {
    return this.orders.detail(actor.id, id);
  }

  // US-42-TC07: hướng dẫn thanh toán khi đơn còn chờ thu.
  @Get(':id/payment-instructions') @FixedPermission('orders.readOwn') @ApiOkResponse({ type: OwnPaymentInstructionsResponseDto })
  paymentInstructions(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Query() _query: EmptyOrderQueryDto) {
    return this.orders.paymentInstructions(actor.id, id);
  }

  // US-42-TC06: hóa đơn của đơn (mở qua đơn của mình, không qua invoiceId).
  @Get(':id/invoice') @FixedPermission('orders.readOwn') @ApiOkResponse({ type: OwnInvoiceResponseDto })
  invoice(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Query() _query: EmptyOrderQueryDto) {
    return this.orders.invoice(actor.id, id);
  }

  // US-42-TC09–TC11 (bước 2): Member hủy đơn của mình; Idempotency-Key bắt buộc; HTTP status lấy từ kết quả (200 hoặc body gốc khi replay).
  @Post(':id/cancel') @FixedPermission('orders.cancelOwn') @ApiOkResponse({ type: CancelOrderResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async cancel(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: CancelOrderDto,
    @IdempotencyKey() key: string, @Query() _query: EmptyOrderQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.orders.cancel(actor.id, id, input, key); response.status(result.status); return result.body;
  }
}
