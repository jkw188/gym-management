import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { ApplicationError } from '../../common/errors/application-error';
import { DataGuardsService, DataGuardTargets } from '../../infrastructure/transaction/data-guards.service';
import { PlanListQueryDto } from './plans.dto';
import { mapPlan } from './plans.mapper';
import { PlansRepository } from './plans.repository';
import { planId } from './plans.service';

@Injectable()
export class PlanReaderService {
  constructor(private readonly repository: PlansRepository, private readonly guards: DataGuardsService) {}

  // US-13 projection only. The caller owns its HTTP permission policy; no public write endpoint.
  async publicCatalog(query: PlanListQueryDto) {
    const page = await this.repository.listPlans(query, true);
    return { ...page, items: page.items.map(plan => {
      const { id, code, name, kind, durationDays, sessionsQuota, price, benefits, version } = mapPlan(plan);
      return { id, code, name, kind, durationDays, sessionsQuota, price, benefits, version };
    }) };
  }

  // US-14 calls this ONCE before protected reads, inside every transaction retry.
  // Supply ALL other EN-02 targets here; never acquire member/transaction locks first.
  async readForSale(session: ClientSession, id: string, expectedVersion: number, targets: DataGuardTargets = {}) {
    if (!session.inTransaction()) throw new Error('PLAN_TRANSACTION_REQUIRED');
    const ids = [planId(id), ...(targets.plans ?? [])];
    for (const target of ids) if (!await this.repository.planExists(target, session)) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy gói');
    await this.guards.acquire(session, { ...targets, plans: ids });
    const plan = await this.repository.plan(planId(id), session);
    if (!plan) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy gói');
    if (plan.version !== expectedVersion || plan.status !== 'ACTIVE') {
      throw new ApplicationError(409, 'PLAN_CHANGED', 'Gói đã thay đổi hoặc ngừng bán. Hãy tải lại danh mục');
    }
    const { id: planIdValue, code, name, kind, durationDays, sessionsQuota, price, benefits, version } = mapPlan(plan);
    return { planId: planIdValue, code, name, kind, durationDays, sessionsQuota, price, benefits, version };
  }
}
