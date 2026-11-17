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
import { SaleReader } from './sale-reader.service';
import { RenewalService } from './renewal.service';
import { RenewalsRepository } from './renewals.repository';
import { RenewalsController } from './renewals.controller';
import { UpgradeService } from './upgrade.service';
import { UpgradesRepository } from './upgrades.repository';
import { UpgradesController } from './upgrades.controller';
import { UpgradeBookingsAdapter } from './upgrade-bookings.adapter';
import { PtBookingSchema } from '../bookings/schemas/pt-booking.schema';
import { MeSalesController } from './me-sales.controller';
import { MeSalesService } from './me-sales.service';
import { MeRenewalsController } from './me-renewals.controller';
import { MeRenewalsService } from './me-renewals.service';

@Module({
  imports: [TransactionModule, MembersDataModule, OperationsModule, NotificationsModule, PlansModule, MongooseModule.forFeature([
    { name: 'ServiceSale', schema: ServiceSaleSchema },
    { name: 'Membership', schema: MembershipSchema }, { name: 'Transaction', schema: TransactionSchema },
    { name: 'Invoice', schema: InvoiceSchema }, { name: 'Payment', schema: PaymentSchema },
    { name: 'PtBooking', schema: PtBookingSchema },
  ])],
  // US-18 bước 1: MeSalesController/MeSalesService cho Member tự đăng ký, dùng MemberOwnerReader của MembersDataModule.
  // US-19 bước 1: MeRenewalsController/MeRenewalsService cho Member tự gia hạn, gọi chung RenewalService.
  controllers: [SalesController, RenewalsController, UpgradesController, MeSalesController, MeRenewalsController],
  providers: [MeSalesService, MeRenewalsService,SalesRepository, SaleReader, SalesService, RenewalService, RenewalsRepository, SaleActivationService, UpgradeService, UpgradesRepository, UpgradeBookingsAdapter,
    { provide: SaleActivation, useExisting: SaleActivationService }, { provide: ZeroSettlement, useClass: ZeroSettlementService }],
  exports: [SaleActivation, SalesRepository, RenewalService, RenewalsRepository, UpgradeService],
})
export class SalesModule {}
