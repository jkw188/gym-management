// Tầng giao diện – gọi API (US-13 bước 2): danh mục gói GYM/PT công khai, chỉ có lệnh GET.
// Dùng apiGet (không gắn access token) vì route public; Guest và Member nhận cùng dữ liệu (US-13-TC01).
import { apiGet } from '../../api/client';

// Đúng 9 field PublicPlanDto backend trả (US-13-F02).
export interface PublicPlan {
  id: string;
  code: string;
  name: string;
  kind: 'GYM' | 'PT';
  durationDays: number;
  sessionsQuota: number;
  price: string;
  benefits: string;
  version: number;
}

export interface PublicPlanPage {
  items: PublicPlan[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Giá trị rỗng nghĩa là "không lọc". Không có tham số status (US-13-F03).
export interface ServicesQuery {
  kind: string;
  q: string;
  minPrice: string;
  maxPrice: string;
  page: number;
}

export const servicesApi = {
  list(query: ServicesQuery) {
    // US-13-TC01: chỉ gửi tham số có giá trị, vì backend trả 400 cho "kind=" hay "minPrice=" rỗng.
    const params = new URLSearchParams();
    if (query.kind) params.set('kind', query.kind);
    if (query.q) params.set('q', query.q);
    if (query.minPrice) params.set('minPrice', query.minPrice);
    if (query.maxPrice) params.set('maxPrice', query.maxPrice);
    if (query.page > 1) params.set('page', String(query.page));
    const text = params.toString();
    return apiGet<PublicPlanPage>(text ? `/catalog/plans?${text}` : '/catalog/plans');
  },
  detail(id: string) {
    return apiGet<PublicPlan>(`/catalog/plans/${encodeURIComponent(id)}`);
  },
};
