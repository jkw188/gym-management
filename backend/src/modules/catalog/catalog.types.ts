// Tầng kiểu dữ liệu (US-13 bước 1): kiểu trả về của API public danh mục gói.
import { PlanKind } from '../plans/schemas/plan.schema';

// US-13-F02: PublicPlanDto chỉ có đúng 9 field này, không có status, người tạo, guard_revision.
export interface PublicPlanDto {
  id: string;
  code: string;
  name: string;
  kind: PlanKind;
  durationDays: number;
  sessionsQuota: number;
  price: string;
  benefits: string;
  version: number;
}

export interface PublicPlanPage {
  items: PublicPlanDto[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Điều kiện lọc service gửi xuống repository (đã trim, đã chọn status).
export interface CatalogPlanFilter {
  status: 'ACTIVE';
  kind?: PlanKind;
  minPrice?: string;
  maxPrice?: string;
  keyword?: string;
}
