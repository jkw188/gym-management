import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { MembersDataModule } from '../members/members-data.module';
import { MembershipSchema } from '../memberships/schemas/membership.schema';
import { ServiceSaleSchema } from '../memberships/schemas/service-sale.schema';
import { NotificationsModule } from '../notifications/notifications.module';
import { OperationsModule } from '../operations/operations.module';
import { InvoiceSchema } from '../payments/schemas/invoice.schema';
import { PaymentSchema } from '../payments/schemas/payment.schema';
import { TransactionSchema } from '../payments/schemas/transaction.schema';
import { SaleActivation, SaleActivationService } from './sale-activation.service';
import { SalesController } from './sales.controller';
import { SalesRepository } from './sales.repository';
import { SalesService } from './sales.service';
import { PlansModule } from '../plans/plans.module';
import { ZeroSettlement, ZeroSettlementService } from './zero-settlement.service';

@Module({
  imports: [TransactionModule, MembersDataModule, OperationsModule, NotificationsModule, PlansModule, MongooseModule.forFeature([
    { name: 'ServiceSale', schema: ServiceSaleSchema },
    { name: 'Membership', schema: MembershipSchema }, { name: 'Transaction', schema: TransactionSchema },
    { name: 'Invoice', schema: InvoiceSchema }, { name: 'Payment', schema: PaymentSchema },
  ])],
  controllers: [SalesController],
  providers: [SalesRepository, SalesService, SaleActivationService,
    { provide: SaleActivation, useExisting: SaleActivationService }, { provide: ZeroSettlement, useClass: ZeroSettlementService }],
  exports: [SaleActivation, SalesRepository],
})
export class SalesModule {}
