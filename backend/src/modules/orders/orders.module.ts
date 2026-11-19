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
import { WebsiteOrderController } from './website-order.controller';
import { CartModule } from '../cart/cart.module';
import { MembersDataModule } from '../members/members-data.module';

// Cấu hình NestJS (US-41, dùng chung US-42–45/53): module đơn hàng – model orders/items/events, báo giá, tạo đơn POS/WEBSITE, thu RETAIL, hủy, bàn giao.
// US-41 cần CartModule (đọc/xóa giỏ) và MembersDataModule (tìm Member của account đang đăng nhập).
@Module({ imports: [TransactionModule, OperationsModule, NotificationsModule, InventoryModule, RefundsModule, CartModule, MembersDataModule,
  JwtModule.register({}), MongooseModule.forFeature([...ORDER_MODELS, { name: 'Payment', schema: PaymentSchema },
    { name: 'Transaction', schema: TransactionSchema }, { name: 'Invoice', schema: InvoiceSchema }])],
  controllers: [OrdersController, OrderCancellationController, MeOrdersController, PosController, WebsiteOrderController],
  providers: [OrdersRepository, OrdersService, FulfillOrderService, CancelOrderService, LateReceiptService, OrderExpiryWorker, MeOrdersService, ReceivingAccountPolicy, ServerClock,
    RetailQuoteService, RetailOrderFactory, RetailSettlementService],
  exports: [FulfillOrderService, RetailSettlementService, OrdersRepository] })
export class OrdersModule {}
