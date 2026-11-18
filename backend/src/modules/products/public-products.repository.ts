// Tầng dữ liệu (US-35 bước 1–2): nơi duy nhất module products đọc categories/products/inventory cho shop công khai. Chỉ đọc.
// Mỗi lần list/detail dùng một phiên snapshot nên catalog và tồn kho thấy cùng một ảnh chụp dữ liệu (US-35-F04).
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Decimal128, Document, ObjectId } from 'mongodb';
import { Connection } from 'mongoose';
import { CategoryRow, ProductRow, ProductSort, PublicProductFilter, StockRules } from './products.types';

// Sắp tên theo thứ tự chữ cái tiếng Việt (giống US-13).
const NAME_COLLATION = { locale: 'vi' };

// Tie-break luôn là _id tăng dần để phân trang không trùng, không sót (US-35-TC06).
// Giá lưu Decimal128 nên MongoDB sắp theo số: 9000 đứng trước 100000 (US-35-TC06).
const SORTS: Record<ProductSort, Document> = {
  NAME_ASC: { name: 1, _id: 1 },
  PRICE_ASC: { price: 1, _id: 1 },
  PRICE_DESC: { price: -1, _id: 1 },
};

// Projection allowlist: chỉ lấy field được công khai, không đọc status, created_by, số tồn, giá vốn… (US-35-F03, TC04).
const PRODUCT_FIELDS = {
  _id: 1, sku: 1, name: 1, description: 1, image_url: 1, price: 1, version: 1, availability: 1, stock_error: 1,
  category: { _id: '$category._id', name: '$category.name' },
};

// Nối bản ghi inventory (US-37) vào field "stock", rồi tính nhãn theo biểu thức service truyền xuống.
// Tính ngay trong MongoDB để lọc availability xong mới đếm total và phân trang.
function addAvailability(rules: StockRules): Document[] {
  return [
    { $lookup: { from: 'inventory', localField: '_id', foreignField: 'product_id', as: 'stock' } },
    { $set: { stock: { $first: '$stock' } } },
    { $set: { availability: rules.availability, stock_error: rules.stockError } },
  ];
}

// Thêm "\" trước ký tự đặc biệt để từ khóa được tìm nguyên văn, không chạy regex của client (US-35-TC05).
function literal(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

// Các bước nối danh mục và CHỈ giữ sản phẩm có danh mục ACTIVE (effectiveActive của US-34, US-35-F01).
const JOIN_ACTIVE_CATEGORY: Document[] = [
  { $lookup: { from: 'categories', localField: 'category_id', foreignField: '_id', as: 'category' } },
  { $unwind: '$category' },
  { $match: { 'category.status': 'ACTIVE' } },
];

interface PageResult<T> { items: T[]; total: { count: number }[] }

@Injectable()
export class PublicProductsRepository {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  // Mở phiên snapshot, chạy hàm đọc, rồi luôn đóng phiên.
  private async withSnapshot<T>(read: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.connection.getClient().startSession({ snapshot: true });
    try {
      return await read(session);
    } finally {
      await session.endSession();
    }
  }

  // GET /api/categories: chỉ danh mục ACTIVE, kể cả danh mục chưa có sản phẩm (US-35-F02).
  findCategoryPage(keyword: string | undefined, page: number, limit: number): Promise<{ items: CategoryRow[]; total: number }> {
    const match: Document = { status: 'ACTIVE' };
    if (keyword) match.name = literal(keyword);
    return this.withSnapshot(async session => {
      const [result] = await this.connection.db!.collection('categories').aggregate<PageResult<CategoryRow>>([
        { $match: match },
        { $sort: { name: 1, _id: 1 } },
        { $facet: {
          items: [{ $skip: (page - 1) * limit }, { $limit: limit }, { $project: { _id: 1, name: 1 } }],
          total: [{ $count: 'count' }],
        } },
      ], { session, collation: NAME_COLLATION, maxTimeMS: 5000 }).toArray();
      return { items: result.items, total: result.total[0]?.count ?? 0 };
    });
  }

  // GET /api/products: các điều kiện lọc kết hợp AND (US-35-TC05).
  findProductPage(filter: PublicProductFilter, rules: StockRules, sort: ProductSort, page: number, limit: number): Promise<{ items: ProductRow[]; total: number }> {
    const match: Document = { status: 'ACTIVE' };
    if (filter.categoryId) match.category_id = new ObjectId(filter.categoryId);
    // Giá so sánh bằng Decimal128, tính cả hai đầu khoảng.
    if (filter.minPrice !== undefined || filter.maxPrice !== undefined) {
      const price: Document = {};
      if (filter.minPrice !== undefined) price.$gte = Decimal128.fromString(filter.minPrice);
      if (filter.maxPrice !== undefined) price.$lte = Decimal128.fromString(filter.maxPrice);
      match.price = price;
    }
    // Tìm theo tên hoặc SKU, không phân biệt hoa/thường.
    if (filter.keyword) match.$or = [{ name: literal(filter.keyword) }, { sku: literal(filter.keyword) }];
    // US-35-TC05: lọc theo nhãn đã tính; bản UNAVAILABLE không khớp IN_STOCK lẫn OUT_OF_STOCK.
    const matchAvailability: Document[] = filter.availability ? [{ $match: { availability: filter.availability } }] : [];

    return this.withSnapshot(async session => {
      const [result] = await this.connection.db!.collection('products').aggregate<PageResult<ProductRow>>([
        { $match: match },
        ...JOIN_ACTIVE_CATEGORY,
        ...addAvailability(rules),
        ...matchAvailability,
        { $sort: SORTS[sort] },
        { $facet: {
          items: [{ $skip: (page - 1) * limit }, { $limit: limit }, { $project: PRODUCT_FIELDS }],
          total: [{ $count: 'count' }],
        } },
      ], { session, collation: NAME_COLLATION, maxTimeMS: 5000 }).toArray();
      return { items: result.items, total: result.total[0]?.count ?? 0 };
    });
  }

  // GET /api/products/:id: chỉ trả khi sản phẩm và danh mục đều ACTIVE, ngược lại null.
  findProduct(id: string, rules: StockRules): Promise<ProductRow | null> {
    return this.withSnapshot(async session => {
      const [row] = await this.connection.db!.collection('products').aggregate<ProductRow>([
        { $match: { _id: new ObjectId(id), status: 'ACTIVE' } },
        ...JOIN_ACTIVE_CATEGORY,
        ...addAvailability(rules),
        { $project: PRODUCT_FIELDS },
      ], { session, maxTimeMS: 5000 }).toArray();
      return row ?? null;
    });
  }
}
