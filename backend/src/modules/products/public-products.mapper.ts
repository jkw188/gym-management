// Tầng kiểu dữ liệu (US-35 bước 1): đổi dòng MongoDB (snake_case) thành dữ liệu công khai (camelCase).
// Chỉ chép field trong allowlist nên field nội bộ không thể lọt ra ngoài (US-35-TC01).
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { CategoryRow, ProductRow, PublicCategoryDto, PublicProductDto } from './products.types';

export function toPublicCategory(row: CategoryRow): PublicCategoryDto {
  return { id: row._id.toHexString(), name: row.name };
}

export function toPublicProduct(row: ProductRow, asOf: string): PublicProductDto {
  const product: PublicProductDto = {
    id: row._id.toHexString(),
    sku: row.sku,
    name: row.name,
    category: toPublicCategory(row.category),
    // Decimal128 → chuỗi VND chính xác, không qua Number (US-35-TC01).
    price: fromVndDecimal(row.price),
    version: row.version,
    // Chỉ nhãn IN_STOCK/OUT_OF_STOCK/UNAVAILABLE, không chép số tồn (US-35-TC04).
    availability: row.availability,
    asOf,
  };
  // description?, imageUrl? chỉ có khi sản phẩm có dữ liệu.
  if (row.description) product.description = row.description;
  if (row.image_url) product.imageUrl = row.image_url;
  return product;
}
