// Cấu hình NestJS (EN-02 bước 1): khai báo TransactionRunner để module nghiệp vụ nào cần transaction thì import module này.
import { Module } from '@nestjs/common';
import { TransactionRunner } from './transaction-runner';

@Module({
  providers: [TransactionRunner],
  exports: [TransactionRunner],
})
export class TransactionModule {}
