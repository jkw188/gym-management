import { Module } from '@nestjs/common';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { MembershipReportsController } from './membership-reports.controller';
import { MembershipReportsRepository } from './membership-reports.repository';
import { MembershipReportsService } from './membership-reports.service';
import { CashFlowController } from './cash-flow.controller';
import { CashFlowRepository } from './cash-flow.repository';
import { CashFlowService } from './cash-flow.service';
import { TrainerPerformanceController } from './trainer-performance.controller';
import { TrainerPerformanceRepository } from './trainer-performance.repository';
import { TrainerPerformanceService } from './trainer-performance.service';

@Module({ imports: [TransactionModule], controllers: [MembershipReportsController, CashFlowController, TrainerPerformanceController],
  providers: [MembershipReportsRepository, MembershipReportsService, CashFlowRepository, CashFlowService, TrainerPerformanceRepository, TrainerPerformanceService] })
export class ReportsModule {}
