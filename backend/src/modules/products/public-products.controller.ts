// Tầng API (US-35 bước 1): endpoint công khai xem danh mục và sản phẩm bán lẻ, KHÔNG cần đăng nhập, CHỈ có GET.
// @Public() bỏ qua JwtAuthGuard toàn cục; Guest và Member nhận cùng dữ liệu (US-35-TC01).
import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators';
import { PublicCategoryQueryDto, PublicProductDetailQueryDto, PublicProductQueryDto } from './public-products.dto';
import { ProductPublicQueryService } from './product-public-query.service';

// no-store để sau khi Admin đổi giá/ngừng bán, người xem luôn thấy dữ liệu mới (spec mục Cache).
@ApiTags('Shop')
@Controller('categories')
@Public()
export class PublicCategoriesController {
  constructor(private readonly products: ProductPublicQueryService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: PublicCategoryQueryDto) {
    return this.products.listCategories(query);
  }
}

@ApiTags('Shop')
@Controller('products')
@Public()
export class PublicProductsController {
  constructor(private readonly products: ProductPublicQueryService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: PublicProductQueryDto) {
    return this.products.listProducts(query);
  }

  // Tham số query khai báo chỉ để ValidationPipe chặn ?status=... (US-35-TC02).
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  detail(@Param('id') id: string, @Query() _query: PublicProductDetailQueryDto) {
    return this.products.detail(id);
  }
}
