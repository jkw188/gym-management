import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { EmptyOrderQueryDto } from '../orders/orders.dto';
import { FixedPermission } from '../users/access.policy';
import { ReceiveReturnDto, ReceiveReturnResultDto, ReturnDetailDto, ReturnEligibilityDto, ReturnPageDto, ReturnQueryDto } from './returns.dto';
import { ReturnsService } from './returns.service';

@ApiTags('Returns') @ApiBearerAuth() @Controller('orders')
export class OrderReturnsController {
  constructor(private readonly service: ReturnsService) {}
  @Get(':id/return-eligibility') @FixedPermission('returns.manage') @ApiOkResponse({ type: ReturnEligibilityDto, description: 'Số lượng còn trả và hạn trả theo snapshot đơn' })
  eligibility(@Param('id') id: string, @Query() _query: EmptyOrderQueryDto) { return this.service.eligibility(id); }
  @Post(':id/returns') @FixedPermission('returns.manage') @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiCreatedResponse({ type: ReceiveReturnResultDto, description: 'Đã nhận hàng; nghĩa vụ hoàn được tạo riêng' })
  async receive(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: ReceiveReturnDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyOrderQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.receive(actor.id, id, input, key); response.status(result.status); return result.body;
  }
}
@ApiTags('Returns') @ApiBearerAuth() @Controller('returns')
export class ReturnsController {
  constructor(private readonly service: ReturnsService) {}
  @Get() @FixedPermission('returns.manage') @ApiOkResponse({ type: ReturnPageDto, description: 'Lịch sử nhận trả và nghĩa vụ/thực chi trên cùng snapshot' })
  list(@Query() query: ReturnQueryDto) { return this.service.list(query); }
  @Get(':id') @FixedPermission('returns.manage') @ApiOkResponse({ type: ReturnDetailDto, description: 'Chi tiết phiếu nhận trả bất biến, các dòng snapshot và khoản hoàn' })
  detail(@Param('id') id: string, @Query() _query: EmptyOrderQueryDto) { return this.service.detail(id); }
}
