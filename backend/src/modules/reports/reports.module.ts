import { Module } from '@nestjs/common';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { MembershipReportsController } from './membership-reports.controller';
import { MembershipReportsRepository } from './membership-reports.repository';
import { MembershipReportsService } from './membership-reports.service';
import { CashFlowController } from './cash-flow.controller';
import { CashFlowRepository } from './cash-flow.repository';
import { CashFlowService } from './cash-flow.service';

@Module({ imports: [TransactionModule], controllers: [MembershipReportsController, CashFlowController],
  providers: [MembershipReportsRepository, MembershipReportsService, CashFlowRepository, CashFlowService] })
export class ReportsModule {}
