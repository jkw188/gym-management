import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/auth.decorators';
import { ACCESS_POLICY } from '../users/access.policy';
import { ProductOptionsPageResponseDto, ProductOptionsQueryDto } from '../stock/stock-receipts.dto';
import { ProductOptionsService } from './product-options.service';

@ApiTags('Internal inventory product picker') @ApiBearerAuth()
@Controller('inventory')
@Roles(...new Set([...ACCESS_POLICY['inventory.read'].roles, ...ACCESS_POLICY['stockReceipts.manage'].roles, ...ACCESS_POLICY['stockIssues.manage'].roles]))
export class ProductOptionsController {
  constructor(private readonly service: ProductOptionsService) {}
  // Static route precedes future US-37 :productId routes. No costs, prices or balances.
  @Get('product-options') @ApiOkResponse({ type: ProductOptionsPageResponseDto })
  list(@Query() query: ProductOptionsQueryDto) { return this.service.list(query); }
}
