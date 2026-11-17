import { OperationsModule } from '../operations/operations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RefundAttemptSchema } from './refund-attempt.schema';
import { RefundPayoutService } from './refund-payout.service';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ServerClock } from '../../common/utils/business-date';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { RefundSchema } from './refund.schema';
import { RefundsService } from './refunds.service';
import { RefundsController } from './refunds.controller';

@Module({ imports: [TransactionModule, OperationsModule, NotificationsModule, MongooseModule.forFeature([{ name: 'Refund', schema: RefundSchema }, { name: 'RefundAttempt', schema: RefundAttemptSchema }])],
  controllers: [RefundsController], providers: [RefundsService, RefundPayoutService, ServerClock], exports: [RefundsService] })
export class RefundsModule {}
