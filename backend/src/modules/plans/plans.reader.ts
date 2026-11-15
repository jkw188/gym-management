import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Model } from 'mongoose';
import { Plan } from './schemas/plan.schema';
import { PlanPolicy } from './schemas/plan-policy.schema';

// Shared internal projection for US-14. Administration/policies remain a separate US-12 implementation.
@Injectable()
export class PlansReader {
  constructor(@InjectModel('Plan') private readonly plans: Model<Plan>,
    @InjectModel('PlanPolicy') private readonly policies: Model<PlanPolicy>) {}
  findById(id: string, session?: ClientSession) {
    return this.plans.findById(id).session(session ?? null).lean().exec();
  }
  activeCatalog() { return this.plans.find({ status: 'ACTIVE' }).sort({ name: 1, _id: 1 }).lean().exec(); }
  conversionPolicy(from: string, to: string, session?: ClientSession) {
    return this.policies.findOne({ from_plan_id: from, to_plan_id: to }).session(session ?? null).lean().exec();
  }
  activeConversions(from: string, session: ClientSession) {
    return this.policies.find({ from_plan_id: from, status: 'ACTIVE' }).session(session).lean().exec();
  }
}
