// Tầng kiểu dữ liệu (US-13 bước 1): đổi document plans (snake_case) thành PublicPlanDto (camelCase).
// Chỉ chép 9 field được phép, nên field nội bộ không thể lọt ra ngoài (US-13-TC04).
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { Plan } from '../plans/schemas/plan.schema';
import { PublicPlanDto } from './catalog.types';

export function toPublicPlan(plan: Plan): PublicPlanDto {
  return {
    id: plan._id.toHexString(),
    code: plan.code,
    name: plan.name,
    kind: plan.kind,
    durationDays: plan.duration_days,
    sessionsQuota: plan.session_quota,
    // Decimal128 → chuỗi VND chính xác, không qua Number.
    price: fromVndDecimal(plan.price),
    benefits: plan.benefits,
    version: plan.version,
  };
}
