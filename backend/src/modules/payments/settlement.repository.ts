import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Model, Types } from 'mongoose';
import { Member } from '../members/schemas/member.schema';
import { Invoice } from './schemas/invoice.schema';
import { Payment } from './schemas/payment.schema';
import { Transaction } from './schemas/transaction.schema';

@Injectable()
export class SettlementRepository {
  constructor(@InjectModel('Payment') readonly payments: Model<Payment>, @InjectModel('Invoice') readonly invoices: Model<Invoice>,
    @InjectModel('Member') private readonly members: Model<Member>, @InjectModel('Transaction') private readonly transactions: Model<Transaction>) {}

  member(id: Types.ObjectId, session: ClientSession) {
    return this.members.findById(id, { _id: 1, member_code: 1, full_name: 1, phone: 1, account_id: 1 }).session(session).lean<Member>().exec();
  }
  insertPayment(payment: Payment, session: ClientSession) { return this.payments.create([payment], { session }); }
  insertInvoice(invoice: Invoice, session: ClientSession) { return this.invoices.create([invoice], { session }); }
  settle(id: Types.ObjectId, version: number, settledAt: Date, session: ClientSession) {
    return this.transactions.updateOne({ _id: id, status: 'PENDING', version },
      { $set: { status: 'SETTLED', settled_at: settledAt }, $inc: { version: 1 } }, { session, runValidators: true });
  }
  invoice(id: Types.ObjectId) {
    return this.invoices.findById(id, { _id: 1, transaction_id: 1, invoice_no: 1, issued_at: 1, total_amount: 1, buyer_snapshot: 1 })
      .maxTimeMS(5000).lean<Invoice>().exec();
  }
}
