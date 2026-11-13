import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, QueryFilter, Types } from 'mongoose';
import { CatalogPaginationDto, PlanListQueryDto, PolicyListQueryDto } from './plans.dto';
import { Plan } from './schemas/plan.schema';
import { PlanPolicy } from './schemas/plan-policy.schema';

@Injectable()
export class PlansRepository implements OnModuleInit {
  constructor(@InjectModel('Plan') readonly plans: Model<Plan>,
    @InjectModel('PlanPolicy') readonly policies: Model<PlanPolicy>, private readonly config: ConfigService) {}

  async onModuleInit() {
    for (const model of [this.plans, this.policies]) {
      if (this.config.get('nodeEnv') !== 'production') await model.createIndexes();
      const actual = await model.collection.listIndexes().toArray();
      for (const [key, options] of model.schema.indexes()) {
        if (!actual.some(index => JSON.stringify(index.key) === JSON.stringify(key) &&
          Boolean(index.unique) === Boolean(options.unique) && !index.sparse && !index.partialFilterExpression && index.expireAfterSeconds === undefined &&
          // US-13: collation của index thật phải đúng collation khai báo trong schema (không khai báo = 'simple').
          (index.collation?.locale ?? 'simple') === (options.collation?.locale ?? 'simple'))) {
          throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
        }
      }
    }
  }

  plan(id: Types.ObjectId, session?: ClientSession) { return this.plans.findById(id).session(session ?? null).exec(); }
  planExists(id: Types.ObjectId, session: ClientSession) { return this.plans.exists({ _id: id }).session(session).exec(); }
  policy(id: Types.ObjectId, session?: ClientSession) { return this.policies.findById(id).session(session ?? null).exec(); }
  policyEndpoints(id: Types.ObjectId, session: ClientSession) {
    return this.policies.findById(id).select('from_plan_id to_plan_id').session(session).exec();
  }
  related(id: Types.ObjectId, session: ClientSession) {
    return this.policies.find({ status: 'ACTIVE', $or: [{ from_plan_id: id }, { to_plan_id: id }] })
      .select('from_plan_id to_plan_id').session(session).exec();
  }
  async listPlans(query: PlanListQueryDto, publicOnly = false) {
    const filter: QueryFilter<Plan> = {};
    if (query.kind) filter.kind = query.kind;
    if (publicOnly) filter.status = 'ACTIVE';
    else if (query.status) filter.status = query.status;
    const term = query.q?.trim();
    if (term) {
      const literal = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ code: literal }, { name: literal }];
    }
    return this.page(this.plans, filter, query);
  }
  listPolicies(query: PolicyListQueryDto) {
    return this.page(this.policies, query.fromPlanId ? { from_plan_id: new Types.ObjectId(query.fromPlanId) } : {}, query);
  }
  private async page<T>(model: Model<T>, filter: QueryFilter<T>, query: CatalogPaginationDto) {
    const [items, total] = await Promise.all([
      model.find(filter).sort({ created_at: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).maxTimeMS(5000).exec(),
      model.countDocuments(filter).maxTimeMS(5000).exec(),
    ]);
    return { items, total, page: query.page, limit: query.limit, totalPages: Math.ceil(total / query.limit) };
  }
}
