import { Injectable } from '@nestjs/common';
import { ClientSession, Types } from 'mongoose';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { isDuplicateKey } from '../../common/http/http-error.filter';
import { validateObjectId } from '../../common/utils/normalization';
import { fromVndDecimal, toVndDecimal } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { CreatePlanDto, CreatePolicyDto, PlanListQueryDto, PolicyListQueryDto, UpdatePlanDto, UpdatePolicyDto } from './plans.dto';
import { mapPlan, mapPolicy } from './plans.mapper';
import { PlansRepository } from './plans.repository';
import { Plan } from './schemas/plan.schema';
import { CONVERSION_RULE, PlanPolicy } from './schemas/plan-policy.schema';

export const planId = (id: string) => new Types.ObjectId(validateObjectId(id));
const notFound = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy gói hoặc chính sách');
const versionConflict = () => new ApplicationError(409, 'VERSION_CONFLICT', 'Dữ liệu đã thay đổi. Hãy tải lại trước khi lưu');

@Injectable()
export class PlansService {
  constructor(private readonly repository: PlansRepository, private readonly transactions: TransactionRunner,
    private readonly guards: DataGuardsService) {}

  async list(query: PlanListQueryDto) {
    const result = await this.repository.listPlans(query);
    return { ...result, items: result.items.map(mapPlan) };
  }
  async detail(id: string) {
    const plan = await this.repository.plan(planId(id));
    if (!plan) throw notFound();
    return mapPlan(plan);
  }
  async create(actor: string, input: CreatePlanDto) {
    this.validateQuota(input.kind, input.sessionsQuota);
    try {
      const plan = await this.repository.plans.create({ code: input.code, name: input.name, kind: input.kind,
        duration_days: input.durationDays, session_quota: input.sessionsQuota, price: toVndDecimal(input.price), benefits: input.benefits,
        status: 'ACTIVE', version: 0, guard_revision: 0n, created_by: planId(actor), updated_by: planId(actor) });
      return mapPlan(plan);
    } catch (error) { return this.rethrowDuplicate(error, 'PLAN_CODE_EXISTS', 'Mã gói đã tồn tại'); }
  }

  async update(actor: string, id: string, input: UpdatePlanDto) {
    const target = planId(id);
    return this.transactions.run(async session => {
      // Discover the lock set inside the retry callback. Every edge mutation also writes BOTH endpoints.
      // A new/changed edge racing this snapshot conflicts on target and restarts the entire discovery.
      const edges = await this.repository.related(target, session);
      await this.lockPlans(session, [target, ...edges.flatMap(edge => [edge.from_plan_id, edge.to_plan_id])]);
      const plan = (await this.repository.plan(target, session))!;
      if (plan.version !== input.version) throw versionConflict();
      const candidate: Plan = { ...plan.toObject(), name: input.name ?? plan.name, benefits: input.benefits ?? plan.benefits,
        duration_days: input.durationDays ?? plan.duration_days, session_quota: input.sessionsQuota ?? plan.session_quota,
        price: input.price === undefined ? plan.price : toVndDecimal(input.price), status: input.status ?? plan.status };
      this.validateQuota(candidate.kind, candidate.session_quota);
      const before = mapPlan(plan), after = mapPlan(candidate);
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      if (!changed) return { plan: before, changed: false };
      // F05 rechecks product terms when price/quota changes. Stopping a plan never changes policy status.
      if (before.price !== after.price || before.sessionsQuota !== after.sessionsQuota) {
        for (const edge of edges) {
          const from = edge.from_plan_id.equals(target) ? candidate : (await this.repository.plan(edge.from_plan_id, session))!;
          const to = edge.to_plan_id.equals(target) ? candidate : (await this.repository.plan(edge.to_plan_id, session))!;
          this.assertPolicy(from, to, edge, false);
        }
      }
      if (plan.version === 2147483647) throw versionConflict();
      const updated = await this.repository.plans.findOneAndUpdate({ _id: target, version: input.version },
        { $set: { name: candidate.name, benefits: candidate.benefits, duration_days: candidate.duration_days,
          session_quota: candidate.session_quota, price: candidate.price, status: candidate.status, updated_by: planId(actor) },
          $inc: { version: 1 } }, { session, returnDocument: 'after' }).exec();
      if (!updated) throw versionConflict();
      return { plan: mapPlan(updated), changed: true };
    });
  }

  async listPolicies(query: PolicyListQueryDto) {
    const result = await this.repository.listPolicies(query);
    return { ...result, items: result.items.map(mapPolicy) };
  }
  async createPolicy(actor: string, input: CreatePolicyDto) {
    const fromId = planId(input.fromPlanId), toId = planId(input.toPlanId);
    if (fromId.equals(toId)) invalidField('toPlanId', 'Gói đích phải khác gói nguồn');
    try {
      return await this.transactions.run(async session => {
        await this.lockPolicyPlans(session, fromId, toId);
        const from = (await this.repository.plan(fromId, session))!, to = (await this.repository.plan(toId, session))!;
        if (input.status === 'ACTIVE') this.assertPolicy(from, to);
        const [policy] = await this.repository.policies.create([{ from_plan_id: fromId, to_plan_id: toId,
          status: input.status, note: input.note ?? '', rule_code: CONVERSION_RULE, version: 0,
          created_by: planId(actor), updated_by: planId(actor) }], { session });
        return mapPolicy(policy);
      });
    } catch (error) { return this.rethrowDuplicate(error, 'POLICY_EXISTS', 'Cặp chính sách đã tồn tại'); }
  }
  async updatePolicy(actor: string, id: string, input: UpdatePolicyDto) {
    const target = planId(id);
    return this.transactions.run(async session => {
      const edge = await this.repository.policyEndpoints(target, session);
      if (!edge) throw notFound();
      await this.lockPolicyPlans(session, edge.from_plan_id, edge.to_plan_id);
      const policy = (await this.repository.policy(target, session))!;
      if (policy.version !== input.version) throw versionConflict();
      const note = input.note ?? policy.note;
      if (policy.status === input.status && policy.note === note) return { policy: mapPolicy(policy), changed: false };
      if (input.status === 'ACTIVE' && policy.status !== 'ACTIVE') this.assertPolicy((await this.repository.plan(policy.from_plan_id, session))!,
        (await this.repository.plan(policy.to_plan_id, session))!, policy);
      if (policy.version === 2147483647) throw versionConflict();
      const updated = await this.repository.policies.findOneAndUpdate({ _id: target, version: input.version },
        { $set: { status: input.status, note, updated_by: planId(actor) }, $inc: { version: 1 } }, { session, returnDocument: 'after' }).exec();
      if (!updated) throw versionConflict();
      return { policy: mapPolicy(updated), changed: true };
    });
  }

  private async lockPolicyPlans(session: ClientSession, from: Types.ObjectId, to: Types.ObjectId) {
    const fromEdges = await this.repository.related(from, session);
    const toEdges = await this.repository.related(to, session);
    await this.lockPlans(session, [from, to, ...[...fromEdges, ...toEdges].flatMap(edge => [edge.from_plan_id, edge.to_plan_id])]);
  }
  private async lockPlans(session: ClientSession, ids: Types.ObjectId[]) {
    for (const id of ids) if (!await this.repository.planExists(id, session)) throw notFound();
    await this.guards.acquire(session, { plans: ids });
  }
  private validateQuota(kind: Plan['kind'], quota: number) {
    if (kind === 'GYM' ? quota !== 0 : quota < 1) invalidField('sessionsQuota', 'GYM có quota 0; PT cần từ 1 đến 10000 buổi');
  }
  private assertPolicy(from: Plan, to: Plan, edge?: PlanPolicy, requireActivePlans = true) {
    if (from.kind === to.kind && (!requireActivePlans || (from.status === 'ACTIVE' && to.status === 'ACTIVE')) &&
      BigInt(fromVndDecimal(to.price)) > BigInt(fromVndDecimal(from.price)) &&
      (from.kind !== 'PT' || to.session_quota >= from.session_quota)) return;
    const label = `${from.code} → ${to.code}`;
    throw new ApplicationError(409, 'POLICY_CONFLICT', `Chính sách ${label} không hợp lệ. Ngừng chính sách liên quan trước khi đổi gói`,
      [{ field: 'policy', message: `${edge ? edge._id.toHexString() + ': ' : ''}${label}: cần cùng loại, hai gói đang bán, giá đích cao hơn và quota PT không thấp hơn` }]);
  }
  private rethrowDuplicate(error: unknown, code: string, message: string): never {
    if (isDuplicateKey(error)) throw new ApplicationError(409, code, message);
    throw error;
  }
}
