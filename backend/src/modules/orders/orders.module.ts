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
import { JwtModule } from '@nestjs/jwt';
import { TransactionSchema } from '../payments/schemas/transaction.schema';
import { InvoiceSchema } from '../payments/schemas/invoice.schema';
import { RetailQuoteService } from './retail-quote.service';
import { RetailOrderFactory } from './retail-order.factory';
import { RetailSettlementService } from './retail-settlement.service';
import { PosController } from './pos.controller';

@Module({ imports: [TransactionModule, OperationsModule, NotificationsModule, InventoryModule, RefundsModule,
  JwtModule.register({}), MongooseModule.forFeature([...ORDER_MODELS, { name: 'Payment', schema: PaymentSchema },
    { name: 'Transaction', schema: TransactionSchema }, { name: 'Invoice', schema: InvoiceSchema }])],
  controllers: [OrdersController, OrderCancellationController, MeOrdersController, PosController],
  providers: [OrdersRepository, OrdersService, FulfillOrderService, CancelOrderService, LateReceiptService, OrderExpiryWorker, MeOrdersService, ReceivingAccountPolicy, ServerClock,
    RetailQuoteService, RetailOrderFactory, RetailSettlementService],
  exports: [FulfillOrderService, RetailSettlementService, OrdersRepository] })
export class OrdersModule {}
