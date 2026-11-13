// Tầng dữ liệu (US-13 bước 1): nơi duy nhất của module catalog đọc collection plans. Chỉ đọc, không ghi.
// Dùng schema Plan của PlansModule (US-12); select chỉ lấy đúng các field PublicPlanDto cần.
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types } from 'mongoose';
import { Plan } from '../plans/schemas/plan.schema';
import { CatalogPlanFilter } from './catalog.types';

// Projection allowlist ngay backend (US-13 mục 2): không đọc guard_revision, created_by, updated_by.
const PUBLIC_FIELDS = '_id code name kind duration_days session_quota price benefits version';

// Thêm "\" trước ký tự đặc biệt để từ khóa được tìm đúng nguyên văn, không chạy regex của client (US-13-TC08).
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class CatalogRepository {
  constructor(@InjectModel('Plan') private readonly plans: Model<Plan>) {}

  // Đổi điều kiện lọc của service thành câu query MongoDB.
  private toQuery(filter: CatalogPlanFilter): QueryFilter<Plan> {
    const query: QueryFilter<Plan> = { status: filter.status };
    if (filter.kind) query.kind = filter.kind;
    // Giá lưu Decimal128 nên so sánh bằng Decimal128, tính cả hai đầu khoảng.
    if (filter.minPrice !== undefined || filter.maxPrice !== undefined) {
      const price: { $gte?: Types.Decimal128; $lte?: Types.Decimal128 } = {};
      if (filter.minPrice !== undefined) price.$gte = Types.Decimal128.fromString(filter.minPrice);
      if (filter.maxPrice !== undefined) price.$lte = Types.Decimal128.fromString(filter.maxPrice);
      query.price = price;
    }
    if (filter.keyword) {
      const literal = new RegExp(escapeRegex(filter.keyword), 'i');
      query.$or = [{ code: literal }, { name: literal }];
    }
    return query;
  }

  // US-13-TC07: sắp name tăng dần rồi _id tăng dần để các trang ổn định khi trùng tên.
  async findPage(filter: CatalogPlanFilter, page: number, limit: number): Promise<{ items: Plan[]; total: number }> {
    const query = this.toQuery(filter);
    const [items, total] = await Promise.all([
      this.plans.find(query).select(PUBLIC_FIELDS).sort({ name: 1, _id: 1 })
        .skip((page - 1) * limit).limit(limit).lean<Plan[]>().exec(),
      this.plans.countDocuments(query).exec(),
    ]);
    return { items, total };
  }

  // Tìm một gói theo id và status; không thấy thì trả null.
  findOne(id: Types.ObjectId, status: 'ACTIVE'): Promise<Plan | null> {
    return this.plans.findOne({ _id: id, status }).select(PUBLIC_FIELDS).lean<Plan>().exec();
  }
}
