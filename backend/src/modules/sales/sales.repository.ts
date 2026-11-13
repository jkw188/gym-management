import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Model, Types } from 'mongoose';
import { ServiceSale } from '../memberships/schemas/service-sale.schema';
import { Membership } from '../memberships/schemas/membership.schema';
import { Transaction } from '../payments/schemas/transaction.schema';
import { Invoice } from '../payments/schemas/invoice.schema';
import { Payment } from '../payments/schemas/payment.schema';
import { FINANCIAL_INDEXES, hasFinancialIndex } from '../../infrastructure/transaction/financial-integrity';

@Injectable()
export class SalesRepository implements OnModuleInit {
  constructor(@InjectModel('ServiceSale') readonly sales: Model<ServiceSale>,
    @InjectModel('Membership') readonly memberships: Model<Membership>,
    @InjectModel('Transaction') readonly transactions: Model<Transaction>,
    @InjectModel('Invoice') readonly invoices: Model<Invoice>,
    @InjectModel('Payment') readonly payments: Model<Payment>, private readonly config: ConfigService) {}

  async onModuleInit() {
    for (const { collection, index } of FINANCIAL_INDEXES.filter(item =>
      ['transactions', 'service_sales', 'memberships', 'invoices', 'payments'].includes(item.collection))) {
      if (this.config.get('nodeEnv') !== 'production' && !await hasFinancialIndex(this.sales.db, collection, index)) {
        await this.sales.db.collection(collection).createIndexes([{ ...index, collation: { locale: 'simple' } }]);
      }
      if (!await hasFinancialIndex(this.sales.db, collection, index)) throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
    }
    // The owning PlansModule supplies its schema; validate its unique code alongside sale constraints.
    const planModel = this.sales.db.model('Plan');
    for (const model of [planModel, this.sales, this.memberships, this.transactions, this.invoices, this.payments]) {
      if (this.config.get('nodeEnv') !== 'production') await model.createIndexes();
      const actual = await model.collection.listIndexes().toArray();
      for (const [key, options] of model.schema.indexes()) {
        if (!actual.some(index => JSON.stringify(index.key) === JSON.stringify(key) && !!index.unique === !!options.unique &&
          !index.sparse && index.expireAfterSeconds === undefined && (!index.collation || index.collation.locale === 'simple'))) {
          throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
        }
      }
    }
  }

  // Legacy sales may lack kind_snapshot: transaction.kind remains the authoritative fallback.
  async blockingCode(memberId: Types.ObjectId, kind: 'GYM' | 'PT', today: string,
    session?: ClientSession, excludedTransactionId?: Types.ObjectId): Promise<string | undefined> {
    const transactions = await this.transactions.find({ member_id: memberId, kind,
      status: { $in: ['PENDING', 'SETTLED'] }, ...(excludedTransactionId ? { _id: { $ne: excludedTransactionId } } : {}) })
      .session(session ?? null).lean().exec();
    const pending = transactions.filter(row => row.status === 'PENDING').map(row => row._id);
    if (await this.sales.exists({ member_id: memberId, transaction_id: { $in: pending } }).session(session ?? null)) return 'PENDING_SALE_EXISTS';
    const settled = transactions.filter(row => row.status === 'SETTLED').map(row => row._id);
    const sales = await this.sales.find({ member_id: memberId, transaction_id: { $in: settled }, end_date: { $gte: today } }, { _id: 1 })
      .session(session ?? null).lean().exec();
    if (await this.memberships.exists({ service_sale_id: { $in: sales.map(row => row._id) }, status: 'ACTIVE' }).session(session ?? null)) {
      return 'CURRENT_SERVICE_EXISTS';
    }
    return undefined;
  }

  async notificationState(saleId: string, session?: ClientSession) {
    const event = await this.sales.db.collection('notifications').findOne({ event_key: `SERVICE_SALE_SETTLED:${saleId}` }, { session });
    if (!event) return 'NOT_CREATED';
    const recipient = await this.sales.db.collection('notification_recipients').findOne({ notification_id: event._id }, { session });
    return recipient ? 'STORED' : 'NO_LINKED_ACCOUNT';
  }

  async pending(memberId: Types.ObjectId, page: number) {
    const result = await this.sales.aggregate<{ items: { saleId: Types.ObjectId; transactionCode: string; kind: string }[]; count: { total: number }[] }>([
      { $match: { member_id: memberId } },
      { $lookup: { from: 'transactions', localField: 'transaction_id', foreignField: '_id', as: 'transaction' } },
      { $unwind: '$transaction' }, { $match: { 'transaction.status': 'PENDING', 'transaction.member_id': memberId } },
      { $sort: { created_at: -1, _id: -1 } },
      { $facet: { items: [{ $skip: (page - 1) * 20 }, { $limit: 20 },
        { $project: { _id: 0, saleId: '$_id', transactionCode: '$transaction.code', kind: '$transaction.kind' } }], count: [{ $count: 'total' }] } },
    ]).exec();
    return { items: (result[0]?.items ?? []).map(row => ({ ...row, saleId: row.saleId.toHexString() })),
      page, total: result[0]?.count[0]?.total ?? 0 };
  }
}
