// Tầng giao diện – gọi API (US-35 bước 3): xem danh mục/sản phẩm bán lẻ công khai, chỉ có lệnh GET.
// Dùng apiGet (không gắn access token) vì route public; Guest và Member nhận cùng dữ liệu (US-35-TC01).
import { apiGet } from '../../api/client';

export type Availability = 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNAVAILABLE';

// Đúng các field ProductPublicDto backend trả (US-35-F03).
export interface PublicProduct {
  id: string;
  sku: string;
  name: string;
  category: { id: string; name: string };
  description?: string;
  imageUrl?: string;
  price: string;
  version: number;
  availability: Availability;
  asOf: string;
}

export interface PublicCategory {
  id: string;
  name: string;
}

export interface PublicPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Giá trị rỗng nghĩa là "không lọc".
export interface ShopQuery {
  q: string;
  categoryId: string;
  availability: string;
}

export const shopApi = {
  listProducts(query: ShopQuery) {
    // US-35-TC12: chỉ gửi tham số có giá trị, vì backend trả 400 cho "q=" hay "availability=" rỗng.
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.categoryId) params.set('categoryId', query.categoryId);
    if (query.availability) params.set('availability', query.availability);
    const text = params.toString();
    return apiGet<PublicPage<PublicProduct>>(text ? `/products?${text}` : '/products');
  },
  // Lấy tối đa 100 danh mục cho ô chọn (limit tối đa của API).
  listCategories() {
    return apiGet<PublicPage<PublicCategory>>('/categories?limit=100');
  },
  detail(id: string) {
    return apiGet<PublicProduct>(`/products/${encodeURIComponent(id)}`);
  },
};
