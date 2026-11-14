import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Model, Types } from 'mongoose';
import { Member } from '../members/schemas/member.schema';
import { Membership } from '../memberships/schemas/membership.schema';
import { ServiceSale } from '../memberships/schemas/service-sale.schema';
import { Invoice } from './schemas/invoice.schema';
import { Payment } from './schemas/payment.schema';
import { Transaction } from './schemas/transaction.schema';

// Allowlist at the database boundary as well as in response mapping.
const transactionFields = { _id: 1, member_id: 1, code: 1, kind: 1, amount_due: 1, status: 1, created_at: 1,
  version: 1, settled_at: 1, cancelled_at: 1, cancel_reason: 1 };
const saleFields = { _id: 1, transaction_id: 1, member_id: 1, plan_id: 1, operation: 1, start_date: 1, end_date: 1,
  plan_name_snapshot: 1, benefits_snapshot: 1, list_price_snapshot: 1, credit_amount: 1, sessions_snapshot: 1,
  policy_snapshot: 1, requested_start_date: 1, duration_days_snapshot: 1, kind_snapshot: 1 };

@Injectable()
export class PaymentsQueryRepository {
  constructor(@InjectModel('Transaction') private readonly transactions: Model<Transaction>,
    @InjectModel('ServiceSale') private readonly sales: Model<ServiceSale>,
    @InjectModel('Member') private readonly members: Model<Member>,
    @InjectModel('Payment') private readonly payments: Model<Payment>,
    @InjectModel('Invoice') private readonly invoices: Model<Invoice>,
    @InjectModel('Membership') private readonly memberships: Model<Membership>) {}

  async page(filter: Record<string, unknown>, page: number, limit: number) {
    const [result] = await this.transactions.aggregate<{ items: (Transaction & { sale_id?: Types.ObjectId })[]; count: { total: number }[] }>([
      { $match: filter }, { $sort: { created_at: -1, _id: -1 } },
      { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }, { $project: transactionFields },
        { $lookup: { from: 'service_sales', localField: '_id', foreignField: 'transaction_id', pipeline: [{ $project: { _id: 1 } }], as: 'sale' } },
        { $set: { sale_id: { $first: '$sale._id' } } }, { $unset: 'sale' }], count: [{ $count: 'total' }] } },
    ]).option({ maxTimeMS: 5000 }).exec();
    return { rows: result?.items ?? [], total: result?.count[0]?.total ?? 0 };
  }

  transaction(id: Types.ObjectId, session?: ClientSession) {
    return this.transactions.findById(id, transactionFields).session(session ?? null).maxTimeMS(5000).lean<Transaction>().exec();
  }
  member(id: Types.ObjectId, session?: ClientSession) {
    return this.members.findById(id, { _id: 1, member_code: 1, full_name: 1, phone: 1 })
      .session(session ?? null).maxTimeMS(5000).lean<Member>().exec();
  }
  memberRows(ids: Types.ObjectId[]) {
    return this.members.find({ _id: { $in: ids } }, { _id: 1, member_code: 1, full_name: 1, phone: 1 }).maxTimeMS(5000).lean<Member[]>().exec();
  }
  sale(id: Types.ObjectId, session?: ClientSession) {
    return this.sales.findOne({ transaction_id: id }, saleFields).session(session ?? null).maxTimeMS(5000).lean<ServiceSale>().exec();
  }
  paymentRows(id: Types.ObjectId, session?: ClientSession) {
    return this.payments.find({ transaction_id: id }, { _id: 1, method: 1, reference: 1, amount: 1, status: 1,
      paid_at: 1, verified_by: 1, verified_at: 1, evidence_note: 1, receiving_account_code: 1, bank_reference: 1 })
      .session(session ?? null).sort({ _id: -1 }).maxTimeMS(5000).lean<Payment[]>().exec();
  }
  referenceUsed(reference: string, session?: ClientSession) {
    // Any payment, including historical FAILED/PENDING, owns its reference (global unique index).
    return this.payments.exists({ reference }).collation({ locale: 'simple' }).session(session ?? null).maxTimeMS(5000).exec();
  }
  invoice(id: Types.ObjectId) {
    return this.invoices.findOne({ transaction_id: id }, { _id: 1, invoice_no: 1, issued_at: 1, total_amount: 1, buyer_snapshot: 1 })
      .maxTimeMS(5000).lean<Invoice>().exec();
  }
  membership(saleId: Types.ObjectId, session?: ClientSession) {
    return this.memberships.findOne({ service_sale_id: saleId }, { _id: 1 }).session(session ?? null).maxTimeMS(5000).lean<Membership>().exec();
  }
}
