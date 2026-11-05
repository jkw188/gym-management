// Cấu hình NestJS (EN-02 bước 3): module chống xử lý lặp; module nghiệp vụ khác import để dùng IdempotencyService.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { IdempotencyService } from './idempotency.service';
import { OperationRequestsRepository } from './operation-requests.repository';
import { OperationsController } from './operations.controller';
import { OperationRequestSchema } from './schemas/operation-request.schema';

@Module({
  imports: [TransactionModule, MongooseModule.forFeature([{ name: 'OperationRequest', schema: OperationRequestSchema }])],
  controllers: [OperationsController],
  providers: [IdempotencyService, OperationRequestsRepository],
  exports: [IdempotencyService],
})
export class OperationsModule {}
