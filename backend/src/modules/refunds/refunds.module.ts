import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ServerClock } from '../../common/utils/business-date';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { RefundSchema } from './refund.schema';
import { RefundsService } from './refunds.service';
import { RefundsController } from './refunds.controller';

@Module({ imports: [TransactionModule, MongooseModule.forFeature([{ name: 'Refund', schema: RefundSchema }])],
  controllers: [RefundsController], providers: [RefundsService, ServerClock], exports: [RefundsService] })
export class RefundsModule {}
