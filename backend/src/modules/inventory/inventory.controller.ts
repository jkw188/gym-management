import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { FixedPermission } from '../users/access.policy';
import { EmptyStockQueryDto } from '../stock/stock-receipts.dto';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryPageResponseDto, InventoryQueryDto, InventoryResponseDto, MovementPageResponseDto, MovementQueryDto, MovementResponseDto } from './inventory.dto';

@ApiTags('Inventory') @ApiBearerAuth() @FixedPermission('inventory.read')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly service: InventoryQueryService) {}
  @Get() @ApiOkResponse({ type: InventoryPageResponseDto })
  list(@Query() query: InventoryQueryDto) { return this.service.list(query); }
  @Get(':productId/movements') @ApiOkResponse({ type: MovementPageResponseDto })
  history(@Param('productId') id: string, @Query() query: MovementQueryDto) { return this.service.history(id, query); }
  @Get(':productId') @ApiOkResponse({ type: InventoryResponseDto })
  detail(@Param('productId') id: string, @Query() _query: EmptyStockQueryDto) { return this.service.detail(id); }
}
@ApiTags('Inventory') @ApiBearerAuth() @FixedPermission('inventory.read')
@Controller('stock-movements')
export class StockMovementsController {
  constructor(private readonly service: InventoryQueryService) {}
  @Get(':id') @ApiOkResponse({ type: MovementResponseDto })
  detail(@Param('id') id: string, @Query() _query: EmptyStockQueryDto) { return this.service.movementDetail(id); }
}
