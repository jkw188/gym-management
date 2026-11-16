import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CreateRetailCategoryDto, CreateRetailProductDto, EmptyRetailQueryDto, RetailCategoryQueryDto, RetailProductQueryDto,
  RetailCategoryPageDto, RetailCategoryResponseDto, RetailProductPageDto, RetailProductResponseDto,
  UpdateRetailCategoryDto, UpdateRetailProductDto } from './retail-catalog.dto';
import { RetailCatalogService } from './retail-catalog.service';

@ApiTags('Admin retail categories') @ApiBearerAuth()
@Controller('admin/categories') @FixedPermission('categories.manage')
export class RetailCategoriesController {
  constructor(private readonly service: RetailCatalogService) {}
  @Get() @ApiOkResponse({ type: RetailCategoryPageDto })
  list(@Query() query: RetailCategoryQueryDto) { return this.service.categories(query); }
  @Get(':id') @ApiOkResponse({ type: RetailCategoryResponseDto })
  detail(@Param('id') id: string, @Query() _query: EmptyRetailQueryDto) { return this.service.category(id); }
  @Post() @ApiCreatedResponse({ type: RetailCategoryResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@CurrentUser() actor: AuthPrincipal, @Body() input: CreateRetailCategoryDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyRetailQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.saveCategory(actor.id, input, key); response.status(result.status); return result.body;
  }
  @Patch(':id') @ApiOkResponse({ type: RetailCategoryResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async update(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: UpdateRetailCategoryDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyRetailQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.saveCategory(actor.id, input, key, id); response.status(result.status); return result.body;
  }
}
@ApiTags('Admin retail products') @ApiBearerAuth()
@Controller('admin/products') @FixedPermission('products.manage')
export class RetailProductsController {
  constructor(private readonly service: RetailCatalogService) {}
  @Get() @ApiOkResponse({ type: RetailProductPageDto })
  list(@Query() query: RetailProductQueryDto) { return this.service.products(query); }
  @Get(':id') @ApiOkResponse({ type: RetailProductResponseDto })
  detail(@Param('id') id: string, @Query() _query: EmptyRetailQueryDto) { return this.service.product(id); }
  @Post() @ApiCreatedResponse({ type: RetailProductResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@CurrentUser() actor: AuthPrincipal, @Body() input: CreateRetailProductDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyRetailQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.saveProduct(actor.id, input, key); response.status(result.status); return result.body;
  }
  @Patch(':id') @ApiOkResponse({ type: RetailProductResponseDto }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  async update(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Body() input: UpdateRetailProductDto, @IdempotencyKey() key: string,
    @Query() _query: EmptyRetailQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.saveProduct(actor.id, input, key, id); response.status(result.status); return result.body;
  }
}
