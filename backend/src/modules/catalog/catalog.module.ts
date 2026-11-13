// Cấu hình NestJS (US-13 bước 1): module danh mục gói công khai /api/catalog/plans.
// Đăng ký lại model Plan bằng chính PlanSchema của PlansModule (US-12) để đọc cùng collection plans.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PlanSchema } from '../plans/schemas/plan.schema';
import { CatalogController } from './catalog.controller';
import { CatalogRepository } from './catalog.repository';
import { CatalogService } from './catalog.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: 'Plan', schema: PlanSchema }])],
  controllers: [CatalogController],
  providers: [CatalogService, CatalogRepository],
})
export class CatalogModule {}
