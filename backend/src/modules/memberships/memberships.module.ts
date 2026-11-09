// Cấu hình NestJS (US-17 bước 1): module gói tập – khai báo API cá nhân /api/me/*, service và repository chỉ đọc.
// Đăng ký model service_sales, memberships, transactions, payments, invoices; tra chủ thể qua MembersDataModule.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { PtBookingSchema } from '../bookings/schemas/pt-booking.schema';
import { MembersDataModule } from '../members/members-data.module';
import { InvoiceSchema } from '../payments/schemas/invoice.schema';
import { PaymentSchema } from '../payments/schemas/payment.schema';
import { TransactionSchema } from '../payments/schemas/transaction.schema';
import { MeMembershipsController } from './me-memberships.controller';
import { MeMembershipsRepository } from './me-memberships.repository';
import { MeMembershipsService } from './me-memberships.service';
import { MembershipSchema } from './schemas/membership.schema';
import { ServiceSaleSchema } from './schemas/service-sale.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'ServiceSale', schema: ServiceSaleSchema },
      { name: 'Membership', schema: MembershipSchema },
      { name: 'Transaction', schema: TransactionSchema },
      { name: 'Payment', schema: PaymentSchema },
      { name: 'Invoice', schema: InvoiceSchema },
      // US-17 bước 2: đếm buổi PT BOOKED (US-28 chưa có nên khai báo tại đây, chỉ đọc).
      { name: 'PtBooking', schema: PtBookingSchema },
    ]),
    MembersDataModule,
    // ServerClock (EN-02): ngày hôm nay theo giờ Việt Nam để lọc timeState.
    TransactionModule,
  ],
  controllers: [MeMembershipsController],
  providers: [MeMembershipsService, MeMembershipsRepository],
})
export class MembershipsModule {}
