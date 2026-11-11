import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PlansReader } from './plans.reader';
import { PlanSchema } from './schemas/plan.schema';

@Module({ imports: [MongooseModule.forFeature([{ name: 'Plan', schema: PlanSchema }])],
  providers: [PlansReader], exports: [PlansReader] })
export class PlansModule {}
