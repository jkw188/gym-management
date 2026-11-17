import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ServerClock } from '../../common/utils/business-date';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OperationsModule } from '../operations/operations.module';
import { OrdersModule } from '../orders/orders.module';
import { RefundSchema } from '../refunds/refund.schema';
import { RETURN_MODELS } from './return.schema';
import { OrderReturnsController, ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';

@Module({ imports: [OrdersModule, TransactionModule, OperationsModule, InventoryModule, NotificationsModule,
  MongooseModule.forFeature([...RETURN_MODELS, { name: 'Refund', schema: RefundSchema }])],
  controllers: [OrderReturnsController, ReturnsController], providers: [ReturnsService, ServerClock] })
export class ReturnsModule {}
