// Cấu hình NestJS (US-35): module xem sản phẩm công khai. Dữ liệu catalog do US-34 (CatalogModule) sở hữu; module này chỉ đọc.
import { Module } from '@nestjs/common';
import { PublicCategoriesController, PublicProductsController } from './public-products.controller';
import { PublicProductsRepository } from './public-products.repository';
import { ProductPublicQueryService } from './product-public-query.service';

@Module({
  controllers: [PublicCategoriesController, PublicProductsController],
  providers: [ProductPublicQueryService, PublicProductsRepository],
})
export class ProductsModule {}
