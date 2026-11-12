import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Model } from 'mongoose';
import { Plan } from './schemas/plan.schema';

// Shared internal projection for US-14. Administration/policies remain a separate US-12 implementation.
@Injectable()
export class PlansReader {
  constructor(@InjectModel('Plan') private readonly plans: Model<Plan>) {}
  findById(id: string, session?: ClientSession) {
    return this.plans.findById(id).session(session ?? null).lean().exec();
  }
  activeCatalog() { return this.plans.find({ status: 'ACTIVE' }).sort({ name: 1, _id: 1 }).lean().exec(); }
}
