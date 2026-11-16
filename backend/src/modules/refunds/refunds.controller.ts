import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { FixedPermission } from '../users/access.policy';
import { EmptyOrderQueryDto } from '../orders/orders.dto';
import { RefundDetailDto, RefundPageDto, RefundQueryDto } from './refunds.dto';
import { RefundsService } from './refunds.service';

@ApiTags('Refund obligations') @ApiBearerAuth() @Controller('refunds')
export class RefundsController {
  constructor(private readonly service: RefundsService) {}
  @Get() @FixedPermission('refunds.read') @ApiOkResponse({ type: RefundPageDto }) list(@Query() query: RefundQueryDto) { return this.service.list(query); }
  @Get(':id') @FixedPermission('refunds.read') @ApiOkResponse({ type: RefundDetailDto }) detail(@Param('id') id: string, @Query() _query: EmptyOrderQueryDto) { return this.service.detail(id); }
}
