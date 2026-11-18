// Tầng nghiệp vụ (US-35 bước 1): Guest/Member tìm và xem sản phẩm đang bán (effectiveActive của US-34).
// Chỉ đọc: không tạo giỏ, đơn, thanh toán, không giữ hàng hay giữ giá (US-35-F04).
import { Injectable } from '@nestjs/common';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { PublicCategoryQueryDto, PublicProductQueryDto } from './public-products.dto';
import { toPublicCategory, toPublicProduct } from './public-products.mapper';
import { PublicProductsRepository } from './public-products.repository';
import { PublicCategoryDto, PublicPage, PublicProductDto } from './products.types';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

@Injectable()
export class ProductPublicQueryService {
  constructor(private readonly repository: PublicProductsRepository) {}

  // GET /api/categories
  async listCategories(query: PublicCategoryQueryDto): Promise<PublicPage<PublicCategoryDto>> {
    const { items, total } = await this.read(() => this.repository.findCategoryPage(keywordOf(query.q), query.page, query.limit));
    return toPage(items.map(toPublicCategory), query.page, query.limit, total);
  }

  // GET /api/products
  async listProducts(query: PublicProductQueryDto): Promise<PublicPage<PublicProductDto>> {
    // US-35-TC07: minPrice > maxPrice → 400. So bằng BigInt vì so chuỗi sẽ sai ("9" > "10").
    if (query.minPrice !== undefined && query.maxPrice !== undefined && BigInt(query.minPrice) > BigInt(query.maxPrice)) {
      invalidField('minPrice', 'minPrice không được lớn hơn maxPrice');
    }
    // asOf là thời điểm đọc (US-35-F04).
    const asOf = new Date().toISOString();
    const { items, total } = await this.read(() => this.repository.findProductPage({
      keyword: keywordOf(query.q),
      categoryId: query.categoryId,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
    }, query.sort, query.page, query.limit));
    return toPage(items.map(row => toPublicProduct(row, asOf)), query.page, query.limit, total);
  }

  // GET /api/products/:id
  async detail(id: string): Promise<PublicProductDto> {
    // US-35-TC07: id sai cú pháp → 400.
    if (!OBJECT_ID.test(id)) invalidField('id', 'Mã sản phẩm không hợp lệ');
    const asOf = new Date().toISOString();
    const row = await this.read(() => this.repository.findProduct(id));
    // US-35-TC02: sản phẩm/danh mục INACTIVE và id không tồn tại trả cùng một lỗi, không lộ tên/giá.
    if (!row) throw new ApplicationError(404, 'PRODUCT_NOT_AVAILABLE', 'Sản phẩm không còn được bán');
    return toPublicProduct(row, asOf);
  }

  // DB không đọc được → 503, không trả danh sách rỗng giả và không lộ lỗi thô của MongoDB.
  private async read<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Cửa hàng tạm thời không tải được, vui lòng thử lại');
    }
  }
}

// q đã trim ở DTO; q rỗng thì không lọc. Chuẩn hóa NFC để chữ có dấu so khớp đúng với tên đã lưu.
function keywordOf(q: string | undefined): string | undefined {
  return q ? q.normalize('NFC') : undefined;
}

// Không có kết quả thì totalPages = 0.
function toPage<T>(items: T[], page: number, limit: number, total: number): PublicPage<T> {
  return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
}
