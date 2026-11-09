// Cấu hình NestJS (EN-02 bước 1): khai báo TransactionRunner để module nghiệp vụ nào cần transaction thì import module này.
import { Module } from '@nestjs/common';
import { TransactionRunner } from './transaction-runner';
import { DataGuardsService } from './data-guards.service';
import { ServerClock } from '../../common/utils/business-date';
import { ReceivingAccountPolicy } from '../../common/utils/receiving-account';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [TransactionRunner, DataGuardsService, ServerClock, ReceivingAccountPolicy],
  exports: [TransactionRunner, DataGuardsService, ServerClock, ReceivingAccountPolicy],
})
export class TransactionModule {}
