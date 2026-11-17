import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { ConfirmRefundDto, FailRefundDto, PayoutResultDto } from './refunds.dto';
import { RefundPayoutService } from './refund-payout.service';
import { FixedPermission } from '../users/access.policy';
import { EmptyOrderQueryDto } from '../orders/orders.dto';
import { RefundDetailDto, RefundPageDto, RefundQueryDto } from './refunds.dto';
import { RefundsService } from './refunds.service';

@ApiTags('Refund obligations') @ApiBearerAuth() @Controller('refunds')
export class RefundsController {
  constructor(private readonly service: RefundsService, private readonly payout: RefundPayoutService) {}
  @Post(':id/confirm') @FixedPermission('refunds.confirmPayout') @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiOkResponse({ type: PayoutResultDto, description: 'Đã xác minh thực chi đủ nghĩa vụ' })
  async confirm(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: ConfirmRefundDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyOrderQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.payout.execute(actor.id, id, input, key, true); response.status(result.status); return result.body;
  }
  @Post(':id/fail') @FixedPermission('refunds.confirmPayout') @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiOkResponse({ type: PayoutResultDto, description: 'Đã ghi nhận xác minh chưa chi thành công; giữ nghĩa vụ' })
  async fail(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: FailRefundDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyOrderQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.payout.execute(actor.id, id, input, key, false); response.status(result.status); return result.body;
  }
  @Get() @FixedPermission('refunds.read') @ApiOkResponse({ type: RefundPageDto }) list(@Query() query: RefundQueryDto) { return this.service.list(query); }
  @Get(':id') @FixedPermission('refunds.read') @ApiOkResponse({ type: RefundDetailDto }) detail(@Param('id') id: string, @Query() _query: EmptyOrderQueryDto) { return this.service.detail(id); }
}
