import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { PaymentReviewDto, TransactionQueryDto } from './payment-review.dto';
import { PaymentReviewService } from './payment-review.service';
import { PaymentsQueryService } from './payments-query.service';
import { SettlementService } from './settlement.service';

@ApiTags('transactions')
@ApiBearerAuth()
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly query: PaymentsQueryService, private readonly review: PaymentReviewService, private readonly settlement: SettlementService) {}

  @Get() @FixedPermission('transactions.read')
  list(@Query() query: TransactionQueryDto) { return this.query.list(query); }

  @Get(':id') @FixedPermission('transactions.read')
  detail(@Param('id') id: string) { return this.query.detail(id); }

  @Post(':id/payment-preview') @HttpCode(200) @FixedPermission('transactions.read')
  preview(@Param('id') id: string, @Body() input: PaymentReviewDto) { return this.review.review(id, input); }

  @Post(':id/confirm-payment') @HttpCode(200) @FixedPermission('transactions.confirmPayment')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async confirm(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: PaymentReviewDto, @IdempotencyKey() key: string) {
    return (await this.settlement.confirm(actor.id, id, input, key)).body;
  }
}
