import { Module } from '@nestjs/common';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { MembershipReportsController } from './membership-reports.controller';
import { MembershipReportsRepository } from './membership-reports.repository';
import { MembershipReportsService } from './membership-reports.service';

@Module({ imports: [TransactionModule], controllers: [MembershipReportsController],
  providers: [MembershipReportsRepository, MembershipReportsService] })
export class ReportsModule {}
