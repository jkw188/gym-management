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
import { FulfillOrderService } from './fulfill-order.service';
import { InventoryModule } from '../inventory/inventory.module';
import { RefundsModule } from '../refunds/refunds.module';
import { CancelOrderService } from './cancel-order.service';
import { LateReceiptService } from './late-receipt.service';
import { OrderExpiryWorker } from './order-expiry.worker';
import { MeOrdersController, OrderCancellationController } from './order-cancellation.controller';
import { MeOrdersService } from './me-orders.service';
import { PaymentSchema } from '../payments/schemas/payment.schema';
import { ReceivingAccountPolicy } from '../../common/utils/receiving-account';

@Module({ imports: [TransactionModule, OperationsModule, NotificationsModule, InventoryModule, RefundsModule,
  MongooseModule.forFeature([...ORDER_MODELS, { name: 'Payment', schema: PaymentSchema }])],
  controllers: [OrdersController, OrderCancellationController, MeOrdersController],
  providers: [OrdersRepository, OrdersService, FulfillOrderService, CancelOrderService, LateReceiptService, OrderExpiryWorker, MeOrdersService, ReceivingAccountPolicy, ServerClock],
  exports: [FulfillOrderService] })
export class OrdersModule {}
