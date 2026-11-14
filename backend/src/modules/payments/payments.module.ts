import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { MemberSchema } from '../members/schemas/member.schema';
import { MembershipSchema } from '../memberships/schemas/membership.schema';
import { ServiceSaleSchema } from '../memberships/schemas/service-sale.schema';
import { SalesModule } from '../sales/sales.module';
import { PaymentReviewService } from './payment-review.service';
import { PaymentsQueryRepository } from './payments-query.repository';
import { PaymentsQueryService } from './payments-query.service';
import { InvoiceSchema } from './schemas/invoice.schema';
import { PaymentSchema } from './schemas/payment.schema';
import { TransactionSchema } from './schemas/transaction.schema';
import { TransactionsController } from './transactions.controller';

@Module({
  imports: [TransactionModule, SalesModule, MongooseModule.forFeature([
    { name: 'Member', schema: MemberSchema },
    { name: 'Transaction', schema: TransactionSchema }, { name: 'Payment', schema: PaymentSchema },
    { name: 'Invoice', schema: InvoiceSchema }, { name: 'ServiceSale', schema: ServiceSaleSchema },
    { name: 'Membership', schema: MembershipSchema },
  ])],
  controllers: [TransactionsController],
  providers: [PaymentsQueryRepository, PaymentsQueryService, PaymentReviewService],
  exports: [PaymentReviewService],
})
export class PaymentsModule {}
