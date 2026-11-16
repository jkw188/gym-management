import { fromVndDecimal } from '../../common/utils/vnd-money';
import { RetailCategory, RetailProduct } from './retail-catalog.schema';

export function mapRetailCategory(row: RetailCategory, affectedActiveProductCount: number) {
  return { id: String(row._id), name: row.name, status: row.status, version: row.version, affectedActiveProductCount,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
export function mapRetailProduct(row: RetailProduct, category: RetailCategory) {
  return { id: String(row._id), categoryId: String(row.category_id), categoryName: category.name, categoryStatus: category.status,
    sku: row.sku, name: row.name, description: row.description ?? null, imageUrl: row.image_url ?? null,
    price: fromVndDecimal(row.price), status: row.status, effectiveActive: row.status === 'ACTIVE' && category.status === 'ACTIVE',
    version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
