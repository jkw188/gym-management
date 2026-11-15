// US-13: đọc gói công khai bằng PlanSchema hiện có. US-34: quản trị danh mục/sản phẩm bán lẻ riêng.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PlanSchema } from '../plans/schemas/plan.schema';
import { CatalogController } from './catalog.controller';
import { CatalogRepository } from './catalog.repository';
import { CatalogService } from './catalog.service';
import { OperationsModule } from '../operations/operations.module';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { RetailCategoriesController, RetailProductsController } from './retail-catalog.controller';
import { RetailCatalogRepository } from './retail-catalog.repository';
import { RetailCatalogService } from './retail-catalog.service';
import { RETAIL_MODELS } from './retail-catalog.schema';

@Module({
  imports: [OperationsModule, TransactionModule, MongooseModule.forFeature([{ name: 'Plan', schema: PlanSchema }, ...RETAIL_MODELS])],
  controllers: [CatalogController, RetailCategoriesController, RetailProductsController],
  providers: [CatalogService, CatalogRepository, RetailCatalogRepository, RetailCatalogService],
})
export class CatalogModule {}
