// Tầng API (US-41 bước 2): Member xem giá và tạo đơn website từ giỏ của chính mình.
// Chỉ nhận dữ liệu, lấy actor từ token, gọi service và trả HTTP; luật nghiệp vụ nằm ở RetailQuoteService và RetailOrderFactory.
import { Body, Controller, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { EmptyOrderQueryDto } from './orders.dto';
import { RetailOrderFactory } from './retail-order.factory';
import { RetailQuoteService } from './retail-quote.service';
import { WebsiteCreateDto, WebsitePreviewDto } from './website-order.dto';

@ApiTags('My orders') @ApiBearerAuth() @Controller('me/orders')
export class WebsiteOrderController {
  constructor(private readonly quotes: RetailQuoteService, private readonly factory: RetailOrderFactory) {}

  // US-41-TC01: preview chỉ đọc, trả 200 (không phải 201 vì không tạo gì).
  @Post('preview') @HttpCode(200) @FixedPermission('orders.createOwn')
  preview(@CurrentUser() actor: AuthPrincipal, @Body() input: WebsitePreviewDto, @Query() _query: EmptyOrderQueryDto) {
    return this.quotes.previewWebsite(actor.id, input);
  }

  // US-41-TC01, TC13: bắt buộc Idempotency-Key; trả đúng status của lần commit gốc khi replay.
  @Post() @FixedPermission('orders.createOwn') @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@CurrentUser() actor: AuthPrincipal, @Body() input: WebsiteCreateDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyOrderQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.factory.createWebsite(actor.id, input, key);
    response.status(result.status);
    return result.body;
  }
}
