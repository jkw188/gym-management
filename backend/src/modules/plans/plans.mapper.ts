import { fromVndDecimal } from '../../common/utils/vnd-money';
import { PlanDto, PolicyDto } from './plans.dto';
import { Plan } from './schemas/plan.schema';
import { PlanPolicy } from './schemas/plan-policy.schema';

export function mapPlan(plan: Plan): PlanDto {
  return { id: plan._id.toHexString(), code: plan.code, name: plan.name, kind: plan.kind,
    durationDays: plan.duration_days, sessionsQuota: plan.session_quota, price: fromVndDecimal(plan.price),
    benefits: plan.benefits, status: plan.status, version: plan.version,
    createdAt: plan.created_at.toISOString(), updatedAt: plan.updated_at.toISOString() };
}
export function mapPolicy(policy: PlanPolicy): PolicyDto {
  return { id: policy._id.toHexString(), fromPlanId: policy.from_plan_id.toHexString(), toPlanId: policy.to_plan_id.toHexString(),
    status: policy.status, ruleCode: policy.rule_code, note: policy.note, version: policy.version,
    createdAt: policy.created_at.toISOString(), updatedAt: policy.updated_at.toISOString() };
}
