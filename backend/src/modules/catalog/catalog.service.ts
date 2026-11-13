// Tầng nghiệp vụ (US-13 bước 1): Guest/Member xem danh mục gói GYM/PT đang bán.
// Chỉ đọc: không tạo giao dịch, không cấp gói, không giữ giá (US-13-F04).
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { CatalogPlanQueryDto } from './catalog.dto';
import { toPublicPlan } from './catalog.mapper';
import { CatalogRepository } from './catalog.repository';
import { PublicPlanDto, PublicPlanPage } from './catalog.types';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

@Injectable()
export class CatalogService {
  constructor(private readonly repository: CatalogRepository) {}

  // GET /api/catalog/plans
  async list(query: CatalogPlanQueryDto): Promise<PublicPlanPage> {
    // US-13-TC05: q bỏ khoảng trắng đầu/cuối; q rỗng thì không lọc theo từ khóa.
    const keyword = query.q?.trim() || undefined;
    const { items, total } = await this.repository.findPage({
      // US-13-TC02: public chỉ thấy gói ACTIVE, client không chọn được status.
      status: 'ACTIVE',
      kind: query.kind,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
      keyword,
    }, query.page, query.limit);
    return {
      items: items.map(toPublicPlan),
      page: query.page,
      limit: query.limit,
      total,
      // US-13-TC07: không có kết quả thì totalPages = 0.
      totalPages: Math.ceil(total / query.limit),
    };
  }

  // GET /api/catalog/plans/:id
  async detail(id: string): Promise<PublicPlanDto> {
    // US-13-TC02: id sai định dạng là dữ liệu sai → 400.
    if (!OBJECT_ID.test(id)) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Mã gói không hợp lệ');
    const plan = await this.repository.findOne(new Types.ObjectId(id), 'ACTIVE');
    // US-13-TC02, TC09: gói INACTIVE và gói không tồn tại trả cùng một lỗi, không lộ gói đó có hay không.
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'Dịch vụ không còn khả dụng');
    return toPublicPlan(plan);
  }
}
