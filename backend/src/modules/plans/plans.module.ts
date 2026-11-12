
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { PlanReaderService } from './plan-reader.service';
import { PlanPoliciesController, PlansController } from './plans.controller';
import { PlansRepository } from './plans.repository';
import { PlansService } from './plans.service';
import { PlanSchema } from './schemas/plan.schema';
import { PlanPolicySchema } from './schemas/plan-policy.schema';

@Module({
  imports: [
    TransactionModule,
    MongooseModule.forFeature([
      { name: 'Plan', schema: PlanSchema },
      { name: 'PlanPolicy', schema: PlanPolicySchema },
    ]),
  ],
  controllers: [PlansController, PlanPoliciesController],
  providers: [
    PlansRepository,
    PlansService,
    PlanReaderService,
  ],
  exports: [PlanReaderService],
})
export class PlansModule {}
