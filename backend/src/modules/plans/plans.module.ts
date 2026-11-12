// Tầng cấu hình NestJS: khai báo controller, service, repository của module gói tập (US-12).
// PlansReader được export để SalesModule (US-14) đọc gói khi bán.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { PlanReaderService } from './plan-reader.service';
import { PlanPoliciesController, PlansController } from './plans.controller';
import { PlansReader } from './plans.reader';
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
    PlansReader,
  ],
  exports: [PlanReaderService, PlansReader],
})
export class PlansModule {}
