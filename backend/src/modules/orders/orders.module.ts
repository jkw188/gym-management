import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ServerClock } from '../../common/utils/business-date';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { OperationsModule } from '../operations/operations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ORDER_MODELS } from './order.schema';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';

@Module({ imports: [TransactionModule, OperationsModule, NotificationsModule, MongooseModule.forFeature(ORDER_MODELS)],
  controllers: [OrdersController], providers: [OrdersRepository, OrdersService, ServerClock] })
export class OrdersModule {}
