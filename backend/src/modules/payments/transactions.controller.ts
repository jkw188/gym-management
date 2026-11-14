import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FixedPermission } from '../users/access.policy';
import { PaymentReviewDto, TransactionQueryDto } from './payment-review.dto';
import { PaymentReviewService } from './payment-review.service';
import { PaymentsQueryService } from './payments-query.service';

@ApiTags('transactions')
@ApiBearerAuth()
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly query: PaymentsQueryService, private readonly review: PaymentReviewService) {}

  @Get() @FixedPermission('transactions.read')
  list(@Query() query: TransactionQueryDto) { return this.query.list(query); }

  @Get(':id') @FixedPermission('transactions.read')
  detail(@Param('id') id: string) { return this.query.detail(id); }

  @Post(':id/payment-preview') @HttpCode(200) @FixedPermission('transactions.read')
  preview(@Param('id') id: string, @Body() input: PaymentReviewDto) { return this.review.review(id, input); }
}
