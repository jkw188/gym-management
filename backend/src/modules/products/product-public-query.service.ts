// Tầng nghiệp vụ (US-35 bước 1–2): Guest/Member tìm và xem sản phẩm đang bán (effectiveActive của US-34).
// Chỉ đọc: không tạo giỏ, đơn, thanh toán, không giữ hàng hay giữ giá (US-35-F04).
// Lỗi MongoDB không bắt ở đây: HttpErrorFilter chung đổi thành 503 DATABASE_UNAVAILABLE, lỗi code thành 500.
import { Injectable } from '@nestjs/common';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { PublicCategoryQueryDto, PublicProductQueryDto } from './public-products.dto';
import { toPublicCategory, toPublicProduct } from './public-products.mapper';
import { PublicProductsRepository } from './public-products.repository';
import { PublicCategoryDto, PublicPage, PublicProductDto, StockRules } from './products.types';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

// US-35-F03: luật đổi số tồn thành nhãn công khai. "$stock" là bản ghi inventory repository đã nối vào.
// Viết thành biểu thức MongoDB để repository lọc theo nhãn trước khi đếm total và phân trang.
function stockRules(): StockRules {
  return {
    availability: { $switch: {
      branches: [
        // US-35-TC03: thiếu inventory (hoặc số tồn không phải số) là dữ liệu lỗi → UNAVAILABLE, không giả định còn hàng.
        { case: { $not: [{ $and: [{ $isNumber: '$stock.on_hand' }, { $isNumber: '$stock.reserved' }] }] }, then: 'UNAVAILABLE' },
        // Số dư âm hoặc reserved > onHand là lỗi toàn vẹn → cũng UNAVAILABLE để chặn bán hàng đó.
        { case: { $or: [{ $lt: ['$stock.reserved', 0] }, { $gt: ['$stock.reserved', '$stock.on_hand'] }] }, then: 'UNAVAILABLE' },
        // US-35-TC08: available = onHand − reserved; > 0 là còn hàng.
        { case: { $gt: ['$stock.on_hand', '$stock.reserved'] }, then: 'IN_STOCK' },
      ],
      // Còn lại: onHand = reserved, tức available = 0.
      default: 'OUT_OF_STOCK',
    } },
  };
}

@Injectable()
export class ProductPublicQueryService {
  constructor(private readonly repository: PublicProductsRepository) {}

  // GET /api/categories
  async listCategories(query: PublicCategoryQueryDto): Promise<PublicPage<PublicCategoryDto>> {
    const { items, total } = await this.repository.findCategoryPage(keywordOf(query.q), query.page, query.limit);
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
    const { items, total } = await this.repository.findProductPage({
      keyword: keywordOf(query.q),
      categoryId: query.categoryId,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
      availability: query.availability,
    }, stockRules(), query.sort, query.page, query.limit);
    return toPage(items.map(row => toPublicProduct(row, asOf)), query.page, query.limit, total);
  }

  // GET /api/products/:id
  async detail(id: string): Promise<PublicProductDto> {
    // US-35-TC07: id sai cú pháp → 400.
    if (!OBJECT_ID.test(id)) invalidField('id', 'Mã sản phẩm không hợp lệ');
    const asOf = new Date().toISOString();
    const row = await this.repository.findProduct(id, stockRules());
    // US-35-TC02: sản phẩm/danh mục INACTIVE và id không tồn tại trả cùng một lỗi, không lộ tên/giá.
    if (!row) throw new ApplicationError(404, 'PRODUCT_NOT_AVAILABLE', 'Sản phẩm không còn được bán');
    return toPublicProduct(row, asOf);
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
