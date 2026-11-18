// Tầng kiểu dữ liệu (US-35 bước 1–2): kiểu trả về và kiểu lọc dùng chung của API sản phẩm công khai.
import { Decimal128, Document, ObjectId } from 'mongodb';

export const PRODUCT_SORTS = ['NAME_ASC', 'PRICE_ASC', 'PRICE_DESC'] as const;
export type ProductSort = typeof PRODUCT_SORTS[number];

// US-35-F03: tình trạng kho công khai. UNAVAILABLE = thiếu hoặc lỗi inventory, client không lọc được theo giá trị này.
export const AVAILABILITY_FILTERS = ['IN_STOCK', 'OUT_OF_STOCK'] as const;
export type AvailabilityFilter = typeof AVAILABILITY_FILTERS[number];
export type Availability = AvailabilityFilter | 'UNAVAILABLE';

// US-35-F03: danh mục công khai chỉ có {id,name}.
export interface PublicCategoryDto {
  id: string;
  name: string;
}

// US-35-F03: ProductPublicDto chỉ có các field này; không có onHand/reserved/giá vốn (US-35-TC04).
export interface PublicProductDto {
  id: string;
  sku: string;
  name: string;
  category: PublicCategoryDto;
  description?: string;
  imageUrl?: string;
  price: string;
  version: number;
  availability: Availability;
  asOf: string;
}

// Envelope phân trang chung {items,page,limit,total,totalPages}.
export interface PublicPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Điều kiện lọc service gửi xuống repository (đã trim, đã kiểm min ≤ max).
export interface PublicProductFilter {
  keyword?: string;
  categoryId?: string;
  minPrice?: string;
  maxPrice?: string;
  availability?: AvailabilityFilter;
}

// Luật tình trạng kho do service tạo (biểu thức MongoDB đọc field "stock" = bản ghi inventory), repository chỉ áp dụng.
export interface StockRules {
  availability: Document;
  stockError: Document;
}

// Dòng repository trả về: chỉ gồm các field nằm trong allowlist (projection ngay ở MongoDB).
export interface CategoryRow {
  _id: ObjectId;
  name: string;
}
export interface ProductRow {
  _id: ObjectId;
  sku: string;
  name: string;
  description?: string;
  image_url?: string;
  price: Decimal128;
  version: number;
  category: CategoryRow;
  availability: Availability;
  // true khi tồn âm hoặc reserved > onHand; chỉ dùng để báo vận hành, không trả ra response.
  stock_error: boolean;
}
