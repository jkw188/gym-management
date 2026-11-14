// Tầng API (US-13 bước 1): 2 endpoint công khai xem danh mục gói, KHÔNG cần đăng nhập, CHỈ có GET.
// @Public() bỏ qua JwtAuthGuard toàn cục; POST/PATCH quản trị vẫn chỉ ở /api/admin/plans (US-13-TC03).
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators';
import { CatalogPlanQueryDto } from './catalog.dto';
import { CatalogService } from './catalog.service';

@ApiTags('Catalog')
@Controller('catalog/plans')
@Public()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // US-13-TC01: Guest và Member đều xem được.
  @Get()
  list(@Query() query: CatalogPlanQueryDto) {
    return this.catalog.list(query);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.catalog.detail(id);
  }
}
